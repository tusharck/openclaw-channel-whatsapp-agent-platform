/**
 * Convert images WhatsApp won't accept as an `image` (WebP, GIF, BMP, TIFF,
 * AVIF, HEIC/HEIF) into the PNG/JPEG the Agent Platform requires: 8-bit RGB or
 * RGBA, at most 25 megapixels, at most 5 MB.
 *
 * Uses ImageMagick compiled to WebAssembly so it works on every OS the plugin
 * runs on without a native build (sharp's prebuilt binaries read neither BMP
 * nor HEIC). The ~15 MB wasm module is loaded lazily on the first conversion.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const MAX_PIXELS = 25_000_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const JPEG_QUALITIES = [85, 70, 55];
let magick;
function loadMagick() {
    magick ??= (async () => {
        const mod = await import("@imagemagick/magick-wasm");
        const require = createRequire(import.meta.url);
        const wasm = await readFile(require.resolve("@imagemagick/magick-wasm/magick.wasm"));
        await mod.initializeImageMagick(wasm);
        return mod;
    })();
    // A failed init (e.g. a missing wasm file) must not poison every later call.
    magick.catch(() => {
        magick = undefined;
    });
    return magick;
}
/**
 * Decode `data` (any format ImageMagick reads; animated inputs use the first
 * frame) and re-encode it as PNG, falling back to JPEG when the PNG would be
 * over 5 MB and the image has no transparency. Throws if decoding fails or no
 * encoding fits under 5 MB.
 */
export async function convertImageForWhatsApp(data) {
    const m = await loadMagick();
    return m.ImageMagick.read(data, (img) => {
        img.autoOrient(); // bake EXIF/HEIF rotation into the pixels
        const pixels = img.width * img.height;
        if (pixels > MAX_PIXELS) {
            const scale = Math.sqrt(MAX_PIXELS / pixels);
            img.resize(Math.max(1, Math.floor(img.width * scale)), Math.max(1, Math.floor(img.height * scale)));
        }
        if (img.colorSpace !== m.ColorSpace.sRGB)
            img.colorSpace = m.ColorSpace.sRGB;
        img.depth = 8;
        img.strip(); // drop metadata (location etc.) along with any odd profiles
        // PNG24/PNG32 force 8-bit RGB / RGBA, as the manual requires.
        const png = img.write(img.hasAlpha ? m.MagickFormat.Png32 : m.MagickFormat.Png24, (d) => new Uint8Array(d));
        if (png.byteLength <= MAX_IMAGE_BYTES)
            return { data: png, mimeType: "image/png" };
        if (img.hasAlpha) {
            throw new Error(`converted PNG is ${(png.byteLength / 1024 / 1024).toFixed(1)}MB, over WhatsApp's 5MB image limit`);
        }
        for (const q of JPEG_QUALITIES) {
            img.quality = q;
            const jpeg = img.write(m.MagickFormat.Jpeg, (d) => new Uint8Array(d));
            if (jpeg.byteLength <= MAX_IMAGE_BYTES)
                return { data: jpeg, mimeType: "image/jpeg" };
        }
        throw new Error("image is still over WhatsApp's 5MB limit after converting to JPEG");
    });
}
//# sourceMappingURL=image-convert.js.map