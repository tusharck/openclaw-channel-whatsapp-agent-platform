/**
 * Shared outbound helpers used by both the channel `outbound` adapter and the
 * inbound reply deliverer. Text is chunked at the configured soft limit and
 * sent sequentially (never concurrently to the same recipient, whose ordering
 * the API does not guarantee); media is uploaded before it is referenced.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { chunkText } from "./whatsapp/chunk.js";
import { mediaTypeForMime } from "./whatsapp/media.js";
/**
 * Send text, chunked, in order. Returns every message id produced.
 * Empty/whitespace-only input produces zero chunks and therefore zero ids —
 * callers must treat an empty `messageIds` as "nothing sent" rather than
 * reporting a delivery with a blank id.
 */
export async function sendChunkedText(client, to, text, opts = {}) {
    const chunks = chunkText(text, opts.chunkLimit);
    const messageIds = [];
    for (let i = 0; i < chunks.length; i++) {
        if (opts.signal?.aborted)
            break;
        const res = await client.sendText(to, chunks[i], opts.previewUrl ?? false, opts.signal);
        for (const m of res.messages)
            messageIds.push(m.id);
        if (i < chunks.length - 1)
            await sleep(opts.interChunkDelayMs ?? 250);
    }
    return { messageIds };
}
/** Upload a local file then send it as media. */
export async function sendLocalMedia(client, to, filePath, opts = {}) {
    const data = new Uint8Array(await fs.readFile(filePath));
    const mimeType = opts.mimeType ?? guessMime(filePath);
    const mediaType = opts.mediaType ?? mediaTypeForMime(mimeType);
    const filename = opts.filename ?? path.basename(filePath);
    const mediaId = await client.uploadMedia({ type: mediaType, data, mimeType, filename }, opts.signal);
    const res = await client.sendMedia(to, mediaType, { id: mediaId, caption: opts.caption, filename: mediaType === "document" ? filename : undefined }, opts.signal);
    // The uploaded object is referenced by the delivered message; releasing it
    // keeps the agent's media store from growing without bound. Best-effort.
    await releaseUploadedMedia(client, mediaId, opts.logger);
    return { messageIds: res.messages.map((m) => m.id) };
}
/** Send already-in-memory bytes as media (upload then send). */
export async function sendBytesMedia(client, to, data, mimeType, opts = {}) {
    const mediaType = opts.mediaType ?? mediaTypeForMime(mimeType);
    const mediaId = await client.uploadMedia({ type: mediaType, data, mimeType, filename: opts.filename }, opts.signal);
    const res = await client.sendMedia(to, mediaType, { id: mediaId, caption: opts.caption, filename: mediaType === "document" ? opts.filename : undefined }, opts.signal);
    await releaseUploadedMedia(client, mediaId, opts.logger);
    return { messageIds: res.messages.map((m) => m.id) };
}
/** Delete an uploaded media object after it has been sent. Never throws. */
async function releaseUploadedMedia(client, mediaId, logger) {
    try {
        await client.deleteMedia(mediaId);
    }
    catch (err) {
        logger?.debug?.(`Could not delete uploaded media ${mediaId}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function guessMime(filePath) {
    const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");
    const map = {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        webp: "image/webp",
        ogg: "audio/ogg",
        mp3: "audio/mpeg",
        m4a: "audio/mp4",
        aac: "audio/aac",
        amr: "audio/amr",
        mp4: "video/mp4",
        "3gp": "video/3gpp",
        pdf: "application/pdf",
        txt: "text/plain",
        zip: "application/zip",
    };
    return map[ext] ?? "application/octet-stream";
}
//# sourceMappingURL=outbound.js.map