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
    const messageIds = res.messages.map((m) => m.id);
    deferRelease(client, mediaId, messageIds, opts.logger);
    return { messageIds };
}
/** Send already-in-memory bytes as media (upload then send). */
export async function sendBytesMedia(client, to, data, mimeType, opts = {}) {
    const mediaType = opts.mediaType ?? mediaTypeForMime(mimeType);
    const mediaId = await client.uploadMedia({ type: mediaType, data, mimeType, filename: opts.filename }, opts.signal);
    const res = await client.sendMedia(to, mediaType, { id: mediaId, caption: opts.caption, filename: mediaType === "document" ? opts.filename : undefined }, opts.signal);
    const messageIds = res.messages.map((m) => m.id);
    deferRelease(client, mediaId, messageIds, opts.logger);
    return { messageIds };
}
/**
 * Uploaded media awaiting its message's delivery status, keyed by message id.
 * A 2xx from `POST /messages` only means "accepted": the platform processes the
 * referenced media afterwards, so deleting it right away races that work and
 * the message fails with 131053. Release once the message reaches a terminal
 * status instead. Bounded; anything evicted or never acknowledged is left to
 * the platform's own 30-day media expiry.
 */
const pendingReleases = new Map();
const MAX_PENDING_RELEASES = 500;
const TERMINAL_STATUSES = new Set(["delivered", "read", "failed"]);
function deferRelease(client, mediaId, messageIds, logger) {
    const messageId = messageIds[messageIds.length - 1];
    if (messageId === undefined)
        return; // nothing references it; let it expire
    pendingReleases.set(messageId, () => releaseUploadedMedia(client, mediaId, logger));
    if (pendingReleases.size > MAX_PENDING_RELEASES) {
        const oldest = pendingReleases.keys().next().value;
        if (oldest !== undefined)
            pendingReleases.delete(oldest);
    }
}
/**
 * Release the media uploaded for `messageId` once its status is terminal.
 * Wired to the poller's status updates. Never throws.
 */
export async function releaseMediaForStatus(messageId, status) {
    if (!TERMINAL_STATUSES.has(status))
        return;
    const release = pendingReleases.get(messageId);
    if (!release)
        return;
    pendingReleases.delete(messageId);
    await release();
}
/** Delete an uploaded media object once its message is settled. Never throws. */
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