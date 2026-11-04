import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ImageMagick, MagickColor, MagickFormat, MagickImage, NoiseType, initializeImageMagick } from "@imagemagick/magick-wasm";
import { beforeAll, describe, expect, it } from "vitest";
import { assertSupportedAttachment, prepareAttachment, resolveAttachmentMime } from "./attachments.js";
import { convertImageForWhatsApp } from "./image-convert.js";
import { MEDIA_CONSTRAINTS, SENDABLE_EXTENSION_MIME, extensionForMime, mimeForExtension, validateMedia } from "./media.js";

const MiB = 1024 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

// A real 64×64 HEIC (HEVC) produced by macOS `sips`; magick-wasm can read HEIC but not write it.
const HEIC_64 =
  "AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAABhW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAA" +
  "AAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAAjaWluZgAAAAAAAQAAABVp" +
  "bmZlAgAAAAABAABodmMxAAAAAOVpcHJwAAAAxGlwY28AAAATY29scm5jbHgAAgACAAaAAAAADGNsbGkAywBAAAAAFGlzcGUAAAAA" +
  "AAAAQAAAAEAAAAAJaXJvdAAAAAAQcGl4aQAAAAADCAgIAAAAcGh2Y0MBA3AAAACwAAAAAAAe8AD8/fj4AAALA6AAAQAXQAEMAf//" +
  "A3AAAAMAsAAAAwAAAwAecCShAAEAIkIBAQNwAAADALAAAAMAAAMAHqAUIEHBj4h7kWVTcCAgYAiiAAEACUQBwGFyyERTZAAAABlp" +
  "cG1hAAAAAAAAAAEAAQaBAgMFhoQAAAAeaWxvYwAAAABEAAABAAEAAAABAAABuQAAAJ0AAAABbWRhdAAAAAAAAACtAAAAmSgBr6PS" +
  "gEZ+CyoLYPvY8r2DAPwJyCp+54O+OoVOdm2njIajMjq23XXQiuDyWFmGDaKcX9hV55quoNA2fQP1dIzJWrbhNZWyBoWw8h5rBf/X" +
  "Bn/7k4EKBf6ARS8Hkfvk7FVyQbf1zlwLmcCuIqm0ol/9X9U3w0hG/fO+1Nqd+rlszwqY20JDKOYc4rpxN+nN4fP8dc+fXK4/wA==";

const startsWith = (data: Uint8Array, magic: number[]) => magic.every((b, i) => data[i] === b);

/** Encode a test image in `format` using ImageMagick itself (optionally full of random noise). */
function encodeSample(format: MagickFormat, size = 32, noisy = false): Uint8Array {
  const img = MagickImage.create(new MagickColor("#3366cc"), size, size);
  try {
    if (noisy) img.addNoise(NoiseType.Random, 50);
    return img.write(format, (d) => new Uint8Array(d));
  } finally {
    img.dispose();
  }
}

function dimensionsOf(data: Uint8Array): { width: number; height: number; depth: number } {
  return ImageMagick.read(data, (img) => ({ width: img.width, height: img.height, depth: img.depth }));
}

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  await initializeImageMagick(readFileSync(require.resolve("@imagemagick/magick-wasm/magick.wasm")));
});

describe("MIME map", () => {
  it.each([
    ["jpg", "image/jpeg"],
    ["JPEG", "image/jpeg"],
    ["png", "image/png"],
    ["pdf", "application/pdf"],
    ["txt", "text/plain"],
    ["doc", "application/msword"],
    ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["xls", "application/vnd.ms-excel"],
    ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["ppt", "application/vnd.ms-powerpoint"],
    ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["mp4", "video/mp4"],
    ["mp3", "audio/mpeg"],
  ])("maps .%s to %s", (ext, mime) => {
    expect(mimeForExtension(ext)).toBe(mime);
  });

  it("has no entry for zip/archives and never yields application/octet-stream", () => {
    for (const ext of ["zip", "rar", "7z", "exe", "bin", "json", "csv", "html"]) {
      expect(mimeForExtension(ext)).toBeUndefined();
    }
    expect(Object.values(SENDABLE_EXTENSION_MIME)).not.toContain("application/octet-stream");
    expect(Object.values(SENDABLE_EXTENSION_MIME)).not.toContain("application/zip");
  });

  it("round-trips MIME → canonical extension", () => {
    expect(extensionForMime("application/pdf")).toBe("pdf");
    expect(extensionForMime("image/jpeg")).toBe("jpg");
    expect(extensionForMime("image/png")).toBe("png");
  });

  it("derives MIME from the extension, not a declared MIME", () => {
    expect(resolveAttachmentMime("/tmp/invoice.PDF", "application/octet-stream")).toBe("application/pdf");
    expect(resolveAttachmentMime("preview.webp")).toBe("image/webp");
    expect(resolveAttachmentMime("photo.HEIC")).toBe("image/heic");
    // No extension: a recognised declared MIME is used; octet-stream is not.
    expect(resolveAttachmentMime("blob", "application/pdf")).toBe("application/pdf");
    expect(resolveAttachmentMime("blob", "application/octet-stream")).toBeUndefined();
    expect(resolveAttachmentMime(undefined, undefined)).toBeUndefined();
  });
});

describe("validation", () => {
  it("rejects a ZIP locally as an unsupported attachment type", async () => {
    expect(() => assertSupportedAttachment("bundle.zip")).toThrow(/Unsupported attachment type: "bundle.zip" \(\.zip\)/);
    await expect(prepareAttachment({ data: new Uint8Array([0x50, 0x4b, 3, 4]), filename: "bundle.zip" })).rejects.toMatchObject({
      kind: "bad-request",
      status: 0, // never reached the network
      retryable: false,
      message: expect.stringMatching(/^Unsupported attachment type/),
    });
  });

  it("rejects a ZIP even when the caller declares application/zip or octet-stream", async () => {
    for (const mimeType of ["application/zip", "application/octet-stream"]) {
      await expect(prepareAttachment({ data: new Uint8Array(4), filename: "x", mimeType })).rejects.toThrow(
        /Unsupported attachment type/,
      );
    }
  });

  it("rejects other unsupported types (exe, csv, no extension)", async () => {
    for (const filename of ["setup.exe", "data.csv", "README"]) {
      await expect(prepareAttachment({ data: new Uint8Array(4), filename })).rejects.toThrow(/Unsupported attachment type/);
    }
  });

  it("accepts every supported document type at the 16MB limit and rejects one byte over", async () => {
    for (const ext of ["pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "txt"]) {
      const ok = await prepareAttachment({ data: new Uint8Array(16 * MiB), filename: `f.${ext}` });
      expect(ok.mediaType).toBe("document");
      expect(ok.mimeType).toBe(mimeForExtension(ext));
      expect(ok.filename).toBe(`f.${ext}`);
      await expect(prepareAttachment({ data: new Uint8Array(16 * MiB + 1), filename: `f.${ext}` })).rejects.toThrow(
        /over WhatsApp's 16\.0MB limit for documents/,
      );
    }
  });

  it("accepts JPEG/PNG images up to 5MB as-is and rejects larger ones", async () => {
    const png = await prepareAttachment({ data: new Uint8Array(5 * MiB), filename: "a.png" });
    expect(png).toMatchObject({ mediaType: "image", mimeType: "image/png", filename: "a.png" });
    expect(png.convertedFrom).toBeUndefined();
    const jpg = await prepareAttachment({ data: new Uint8Array(10), filename: "a.jpeg" });
    expect(jpg).toMatchObject({ mediaType: "image", mimeType: "image/jpeg" });
    await expect(prepareAttachment({ data: new Uint8Array(5 * MiB + 1), filename: "a.jpg" })).rejects.toThrow(
      /over WhatsApp's 5\.0MB limit for images/,
    );
  });

  it("only allows the manual's image MIME types and limits", () => {
    expect(MEDIA_CONSTRAINTS.image).toEqual({ maxBytes: 5 * MiB, mimeTypes: ["image/jpeg", "image/png"] });
    expect(MEDIA_CONSTRAINTS.document.maxBytes).toBe(16 * MiB);
    expect(validateMedia("image", 10, "image/webp")).toMatch(/not accepted/);
    expect(validateMedia("document", 10, "application/zip")).toMatch(/not accepted/);
    expect(validateMedia("document", 10, "application/octet-stream")).toMatch(/not accepted/);
    expect(validateMedia("document", 10, undefined)).toMatch(/not accepted/);
  });

  it("names a document file with a matching extension when there is none", async () => {
    const a = await prepareAttachment({ data: new Uint8Array(10), filename: "invoice", mimeType: "application/pdf" });
    expect(a.filename).toBe("invoice.pdf");
  });
});

describe("image conversion", () => {
  const cases: Array<[string, MagickFormat | "heic"]> = [
    ["webp", MagickFormat.WebP],
    ["gif", MagickFormat.Gif],
    ["bmp", MagickFormat.Bmp],
    ["tiff", MagickFormat.Tiff],
    ["avif", MagickFormat.Avif],
    ["heic", "heic"],
  ];

  it.each(cases)("converts .%s to an 8-bit PNG before upload", async (ext, format) => {
    const data = format === "heic" ? new Uint8Array(Buffer.from(HEIC_64, "base64")) : encodeSample(format);
    const out = await prepareAttachment({ data, filename: `preview.${ext}` });
    expect(out.mediaType).toBe("image");
    expect(out.mimeType).toBe("image/png");
    expect(out.filename).toBe("preview.png");
    expect(out.convertedFrom).toBe(ext === "tiff" ? "image/tiff" : `image/${ext}`);
    expect(startsWith(out.data, PNG_MAGIC)).toBe(true);
    const dims = dimensionsOf(out.data);
    expect(dims.depth).toBe(8);
    expect(dims.width).toBeGreaterThan(0);
  });

  it("falls back to JPEG when the PNG would exceed 5MB", async () => {
    // Random noise doesn't compress: a 2000×2000 RGB PNG is ~12MB.
    const noisy = encodeSample(MagickFormat.Bmp, 2000, true);
    const out = await convertImageForWhatsApp(noisy);
    expect(out.mimeType).toBe("image/jpeg");
    expect(startsWith(out.data, JPEG_MAGIC)).toBe(true);
    expect(out.data.byteLength).toBeLessThanOrEqual(5 * MiB);
  }, 60_000);

  it("fails fast with a clear message when the bytes are not a decodable image", async () => {
    await expect(prepareAttachment({ data: new Uint8Array([1, 2, 3, 4]), filename: "broken.webp" })).rejects.toThrow(
      /Could not convert "broken.webp" \(image\/webp\) to PNG\/JPEG/,
    );
  });

  it("keeps WebP untouched when a sticker is explicitly requested", async () => {
    const webp = encodeSample(MagickFormat.WebP);
    const out = await prepareAttachment({ data: webp, filename: "s.webp", mediaType: "sticker" });
    expect(out).toMatchObject({ mediaType: "sticker", mimeType: "image/webp" });
    expect(out.data).toBe(webp);
  });
});
