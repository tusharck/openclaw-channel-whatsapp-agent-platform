/**
 * Pure builders for outbound message payloads (POST /messages bodies).
 * No I/O, no SDK — trivially unit-testable.
 */
/**
 * Normalize a recipient into the `<type>:<id>` form the API expects. If the
 * value already carries a `type:` prefix it is preserved; a bare id is treated
 * as a `user:` recipient (the only party an agent can message).
 */
export function normalizeRecipient(to) {
    const trimmed = to.trim();
    if (/^[a-z_]+:.+/i.test(trimmed))
        return trimmed;
    return `user:${trimmed}`;
}
/** Build a text message body. `preview_url` defaults to false per the spec. */
export function buildTextMessage(to, body, previewUrl = false) {
    return {
        messaging_product: "whatsapp",
        to: normalizeRecipient(to),
        type: "text",
        text: { body, preview_url: previewUrl },
    };
}
/** Build a media message body referencing an already-uploaded media id. */
export function buildMediaMessage(to, mediaType, media) {
    const message = {
        messaging_product: "whatsapp",
        to: normalizeRecipient(to),
        type: mediaType,
    };
    // Only text/document carry a caption/filename; stickers carry neither.
    message[mediaType] = media;
    return message;
}
/** Build a reaction message body (emoji reaction to a prior message id). */
export function buildReactionMessage(to, messageId, emoji) {
    return {
        messaging_product: "whatsapp",
        to: normalizeRecipient(to),
        type: "reaction",
        reaction: { message_id: messageId, emoji },
    };
}
//# sourceMappingURL=payloads.js.map