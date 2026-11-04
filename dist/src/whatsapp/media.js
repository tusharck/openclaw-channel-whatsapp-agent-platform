/**
 * Media constraints from the Agent Platform developer manual (v1, Aug 25 2026,
 * §4 "Accepted media types"), used to validate uploads before spending a
 * request (and a rate-limit slot) on one the platform would reject with 131053.
 *
 * MIME types are derived from the file extension through the explicit map
 * below — never sniffed, never defaulted. `application/octet-stream` is
 * deliberately absent: the platform would accept it as a "generic binary", but
 * the recipient gets an unopenable blob, so we refuse it instead.
 */
const KB = 1024;
const MB = 1024 * KB;
/** Extension (lowercase, no dot) → MIME type, for every type the platform accepts. */
export const SENDABLE_EXTENSION_MIME = {
    // image
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    // document
    pdf: "application/pdf",
    txt: "text/plain",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    // audio
    aac: "audio/aac",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    amr: "audio/amr",
    ogg: "audio/ogg",
    opus: "audio/opus",
    // video
    mp4: "video/mp4",
    "3gp": "video/3gpp",
    // sticker (only when a sticker is explicitly requested; see attachments.ts)
    webp: "image/webp",
};
/** Image formats we convert to PNG/JPEG before upload. Extension → MIME. */
export const CONVERTIBLE_IMAGE_EXTENSION_MIME = {
    webp: "image/webp",
    gif: "image/gif",
    bmp: "image/bmp",
    tif: "image/tiff",
    tiff: "image/tiff",
    avif: "image/avif",
    heic: "image/heic",
    heif: "image/heif",
};
export const MEDIA_CONSTRAINTS = {
    image: { maxBytes: 5 * MB, mimeTypes: ["image/jpeg", "image/png"] },
    sticker: { maxBytes: 500 * KB, mimeTypes: ["image/webp"] },
    audio: {
        maxBytes: 16 * MB,
        mimeTypes: ["audio/aac", "audio/mp4", "audio/mpeg", "audio/amr", "audio/ogg", "audio/opus"],
    },
    video: { maxBytes: 16 * MB, mimeTypes: ["video/mp4", "video/3gpp"] },
    document: {
        // The manual caps documents at 16 MB ("16 MB for a video, audio file,
        // document or generic binary file"), not the Cloud API's 100 MB.
        maxBytes: 16 * MB,
        mimeTypes: [
            "application/pdf",
            "text/plain",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.ms-powerpoint",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ],
    },
};
/** Lowercase extension of a filename/path without the dot, or "" if none. */
export function extensionOf(name) {
    const base = name.split(/[\\/]/).pop() ?? "";
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}
/** MIME type for an extension the platform accepts as-is, or undefined. */
export function mimeForExtension(ext) {
    return SENDABLE_EXTENSION_MIME[ext.toLowerCase().replace(/^\./, "")];
}
/** Canonical extension for an accepted MIME type (e.g. "application/pdf" → "pdf"). */
export function extensionForMime(mimeType) {
    const m = mimeType.toLowerCase();
    if (m === "image/jpeg")
        return "jpg";
    return Object.keys(SENDABLE_EXTENSION_MIME).find((ext) => SENDABLE_EXTENSION_MIME[ext] === m);
}
export function formatBytes(n) {
    if (n >= MB)
        return `${(n / MB).toFixed(1)}MB`;
    return `${Math.ceil(n / KB)}KB`;
}
/** Validate a media buffer against its type's constraints. Returns an error string, or null if OK. */
export function validateMedia(type, byteLength, mimeType) {
    const c = MEDIA_CONSTRAINTS[type];
    if (!mimeType || !c.mimeTypes.includes(mimeType.toLowerCase())) {
        return `${type} MIME type "${mimeType ?? "(none)"}" is not accepted by WhatsApp (allowed: ${c.mimeTypes.join(", ")}).`;
    }
    if (byteLength > c.maxBytes) {
        return `${type} is ${formatBytes(byteLength)}, over WhatsApp's ${formatBytes(c.maxBytes)} limit for ${type}s.`;
    }
    return null;
}
/** Mapping from an accepted MIME type to the WhatsApp message category. */
export function mediaTypeForMime(mimeType) {
    const m = mimeType.toLowerCase();
    // WebP defaults to a regular image (converted before upload); stickers must
    // be requested explicitly.
    if (m.startsWith("image/"))
        return "image";
    if (m.startsWith("audio/"))
        return "audio";
    if (m.startsWith("video/"))
        return "video";
    return "document";
}
//# sourceMappingURL=media.js.map