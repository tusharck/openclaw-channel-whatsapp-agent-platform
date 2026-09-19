/**
 * Media constraints from the Agent Platform manual, used to validate uploads
 * before spending a request (and a rate-limit slot) on a doomed one.
 */

import type { WhatsAppMediaType } from "./types.js";

export interface MediaConstraint {
  maxBytes: number;
  mimeTypes: readonly string[];
}

const MB = 1024 * 1024;

export const MEDIA_CONSTRAINTS: Record<WhatsAppMediaType, MediaConstraint> = {
  sticker: { maxBytes: 1 * MB, mimeTypes: ["image/webp"] },
  image: { maxBytes: 5 * MB, mimeTypes: ["image/jpeg", "image/png", "image/webp"] },
  audio: {
    maxBytes: 16 * MB,
    mimeTypes: ["audio/ogg", "audio/aac", "audio/amr", "audio/mpeg", "audio/mp4"],
  },
  video: { maxBytes: 16 * MB, mimeTypes: ["video/mp4", "video/3gpp"] },
  document: {
    maxBytes: 100 * MB,
    mimeTypes: [
      "text/plain",
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/zip",
      "application/x-rar-compressed",
      "application/vnd.rar",
      "application/x-7z-compressed",
    ],
  },
};

/** Validate a media buffer against its type's constraints. Returns an error string, or null if OK. */
export function validateMedia(type: WhatsAppMediaType, byteLength: number, mimeType?: string): string | null {
  const c = MEDIA_CONSTRAINTS[type];
  if (byteLength > c.maxBytes) {
    return `${type} exceeds the ${(c.maxBytes / MB).toFixed(0)}MB limit (${(byteLength / MB).toFixed(1)}MB).`;
  }
  if (mimeType && !c.mimeTypes.includes(mimeType.toLowerCase())) {
    return `${type} mime type "${mimeType}" is not accepted (allowed: ${c.mimeTypes.join(", ")}).`;
  }
  return null;
}

/** Best-effort mapping from a mime type to the WhatsApp media category. */
export function mediaTypeForMime(mimeType: string): WhatsAppMediaType {
  const m = mimeType.toLowerCase();
  // WebP defaults to a regular image; stickers must be requested explicitly.
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  return "document";
}
