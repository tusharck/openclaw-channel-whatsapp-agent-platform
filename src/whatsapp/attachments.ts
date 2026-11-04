/**
 * Client-side attachment preparation: decide what an outbound file is, convert
 * it if needed, and reject anything the Agent Platform would refuse — before
 * any upload is attempted. Every rejection is a clear local error instead of a
 * platform 131053.
 */

import { WhatsAppApiError } from "./errors.js";
import { convertImageForWhatsApp } from "./image-convert.js";
import {
  CONVERTIBLE_IMAGE_EXTENSION_MIME,
  MEDIA_CONSTRAINTS,
  SENDABLE_EXTENSION_MIME,
  extensionForMime,
  extensionOf,
  mediaTypeForMime,
  validateMedia,
} from "./media.js";
import type { WhatsAppMediaType } from "./types.js";

export interface AttachmentInput {
  data: Uint8Array;
  /** Original filename or path; its extension decides the MIME type. */
  filename?: string;
  /** Caller-declared MIME type; only consulted when the filename has no usable extension. */
  mimeType?: string;
  /** Force a category (e.g. "sticker"); otherwise inferred from the MIME type. */
  mediaType?: WhatsAppMediaType;
}

export interface PreparedAttachment {
  data: Uint8Array;
  mimeType: string;
  mediaType: WhatsAppMediaType;
  /** Filename to upload/send, with an extension that matches `mimeType`. */
  filename: string;
  /** Set when the image was re-encoded, e.g. "image/webp". */
  convertedFrom?: string;
}

const SUPPORTED_SUMMARY =
  "WhatsApp accepts images (JPEG, PNG; WebP/GIF/BMP/TIFF/AVIF/HEIC are converted), " +
  "documents (PDF, DOC/DOCX, PPT/PPTX, XLS/XLSX, TXT), audio (AAC, M4A, MP3, AMR, OGG, OPUS) and video (MP4, 3GP).";

/** An error raised locally, before any request is made. */
export function attachmentError(message: string): WhatsAppApiError {
  return new WhatsAppApiError({ kind: "bad-request", status: 0, message, retryable: false, indeterminate: false });
}

/** Reverse lookup for a declared MIME type, restricted to types we know. */
function knownMime(mimeType: string | undefined): string | undefined {
  if (!mimeType) return undefined;
  const m = mimeType.toLowerCase().split(";")[0].trim();
  const all = [...Object.values(SENDABLE_EXTENSION_MIME), ...Object.values(CONVERTIBLE_IMAGE_EXTENSION_MIME)];
  return all.includes(m) ? m : undefined;
}

/**
 * Resolve the attachment's MIME type from its extension (explicit map), or —
 * only when there is no usable extension — from a recognised declared MIME.
 */
export function resolveAttachmentMime(filename: string | undefined, declaredMime?: string): string | undefined {
  const ext = filename ? extensionOf(filename) : "";
  if (ext) return SENDABLE_EXTENSION_MIME[ext] ?? CONVERTIBLE_IMAGE_EXTENSION_MIME[ext];
  return knownMime(declaredMime);
}

function withExtension(filename: string | undefined, mimeType: string): string {
  const ext = extensionForMime(mimeType) ?? "bin";
  const base = (filename ?? "").split(/[\\/]/).pop() ?? "";
  if (!base) return `attachment.${ext}`;
  if (extensionOf(base) && SENDABLE_EXTENSION_MIME[extensionOf(base)] === mimeType) return base;
  const dot = base.lastIndexOf(".");
  return `${dot > 0 ? base.slice(0, dot) : base}.${ext}`;
}

function labelFor(filename: string | undefined): string {
  return filename ? `"${filename.split(/[\\/]/).pop()}"` : "attachment";
}

/**
 * Name-only check, cheap enough to run before reading the file: returns the
 * resolved MIME type, or throws "Unsupported attachment type" (e.g. for .zip).
 */
export function assertSupportedAttachment(filename: string | undefined, declaredMime?: string): string {
  const mime = resolveAttachmentMime(filename, declaredMime);
  if (mime) return mime;
  const ext = filename ? extensionOf(filename) : "";
  const what = ext ? `.${ext}` : declaredMime ? declaredMime : "no file extension";
  throw attachmentError(`Unsupported attachment type: ${labelFor(filename)} (${what}). ${SUPPORTED_SUMMARY}`);
}

/**
 * Validate (and if needed convert) an attachment for upload. Throws a
 * non-retryable `bad-request` WhatsAppApiError with an actionable message for
 * anything WhatsApp would reject; never returns `application/octet-stream`.
 */
export async function prepareAttachment(input: AttachmentInput): Promise<PreparedAttachment> {
  const label = labelFor(input.filename);
  const mime = assertSupportedAttachment(input.filename, input.mimeType);

  let data = input.data;
  let mimeType = mime;
  let convertedFrom: string | undefined;
  const mediaType = input.mediaType ?? mediaTypeForMime(mime);

  if (mediaType === "sticker") {
    if (mime !== "image/webp") throw attachmentError(`Stickers must be WebP; ${label} is ${mime}.`);
  } else if (mediaType === "image" && !MEDIA_CONSTRAINTS.image.mimeTypes.includes(mime)) {
    if (!Object.values(CONVERTIBLE_IMAGE_EXTENSION_MIME).includes(mime)) {
      throw attachmentError(`Unsupported attachment type: ${label} (${mime}) cannot be sent as an image. ${SUPPORTED_SUMMARY}`);
    }
    try {
      const converted = await convertImageForWhatsApp(data);
      data = converted.data;
      mimeType = converted.mimeType;
      convertedFrom = mime;
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw attachmentError(`Could not convert ${label} (${mime}) to PNG/JPEG for WhatsApp: ${why}`);
    }
  }

  const problem = validateMedia(mediaType, data.byteLength, mimeType);
  if (problem) throw attachmentError(`Cannot send ${label}: ${problem}`);

  return { data, mimeType, mediaType, filename: withExtension(input.filename, mimeType), convertedFrom };
}
