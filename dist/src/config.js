/**
 * Pure config: constants, Zod schema, defaults, and account resolution.
 *
 * This module has NO runtime dependency on the OpenClaw SDK (only a type-only
 * import, which is erased at build time), so the transport, poller, and config
 * validation can be unit-tested without loading the host bundle.
 */
import { z } from "zod";
import { DEFAULT_BASE_URL } from "./whatsapp/client.js";
import { DEFAULT_CHUNK_LIMIT } from "./whatsapp/chunk.js";
export const CHANNEL_ID = "whatsapp-agent-platform";
export const CHANNEL_LABEL = "WhatsApp Agent Platform";
export const DOCS_PATH = "/plugins/whatsapp-agent-platform";
export const NPM_SPEC = "whatsapp-agent-platform";
/** One account = one WhatsApp third-party agent (identified by its API key). */
export const accountSchema = z.object({
    apiKey: z.string().min(1, "API key is required"),
    enabled: z.boolean().default(true),
    pollTimeout: z.number().int().min(0).max(25).default(15),
    pollLimit: z.number().int().min(1).max(100).default(50),
    sessionKeyPrefix: z.string().min(1).default("whatsapp-agent"),
    sendReadReceipts: z.boolean().default(true),
    mediaDir: z.string().optional(),
    chunkLimit: z.number().int().min(1).max(4096).default(DEFAULT_CHUNK_LIMIT),
    previewUrl: z.boolean().default(false),
    creatorId: z.string().optional(),
    baseUrl: z.string().url().default(DEFAULT_BASE_URL),
});
/** Full channel config: a default account, plus optional named accounts. */
export const whatsappChannelConfigSchema = accountSchema.partial().extend({
    accounts: z.record(z.string(), accountSchema.partial()).optional(),
});
const FIELD_DEFAULTS = {
    enabled: true,
    pollTimeout: 15,
    pollLimit: 50,
    sessionKeyPrefix: "whatsapp-agent",
    sendReadReceipts: true,
    chunkLimit: DEFAULT_CHUNK_LIMIT,
    previewUrl: false,
    baseUrl: DEFAULT_BASE_URL,
};
/**
 * Merge a raw channel config block + optional named account override into a
 * resolved account. Unknown/missing fields fall back to schema defaults.
 */
export function resolveAccountConfig(raw, accountId) {
    const parsed = whatsappChannelConfigSchema.safeParse(raw ?? {});
    const data = parsed.success ? parsed.data : {};
    const { accounts, ...base } = data;
    const named = accountId ? accounts?.[accountId] ?? {} : {};
    const merged = { ...base, ...named };
    const apiKey = (merged.apiKey ?? "").trim();
    return {
        accountId: accountId ?? null,
        apiKey,
        configured: apiKey.length > 0,
        enabled: merged.enabled ?? FIELD_DEFAULTS.enabled,
        pollTimeout: merged.pollTimeout ?? FIELD_DEFAULTS.pollTimeout,
        pollLimit: merged.pollLimit ?? FIELD_DEFAULTS.pollLimit,
        sessionKeyPrefix: merged.sessionKeyPrefix ?? FIELD_DEFAULTS.sessionKeyPrefix,
        sendReadReceipts: merged.sendReadReceipts ?? FIELD_DEFAULTS.sendReadReceipts,
        mediaDir: merged.mediaDir,
        chunkLimit: merged.chunkLimit ?? FIELD_DEFAULTS.chunkLimit,
        previewUrl: merged.previewUrl ?? FIELD_DEFAULTS.previewUrl,
        creatorId: merged.creatorId,
        baseUrl: merged.baseUrl ?? FIELD_DEFAULTS.baseUrl,
    };
}
/** UI hints shown in the dashboard for each field. */
export const uiHints = {
    apiKey: {
        label: "API key",
        help: "From the WhatsApp agent chat: Chat info > API key. Stored as a secret and never logged.",
        sensitive: true,
        placeholder: "paste the agent API key",
    },
    enabled: { label: "Enabled" },
    pollTimeout: { label: "Poll timeout (s)", help: "Long-poll wait, 0–25 seconds.", advanced: true },
    pollLimit: { label: "Updates per poll", help: "1–100.", advanced: true },
    sessionKeyPrefix: { label: "Session key prefix", advanced: true },
    sendReadReceipts: { label: "Send read receipts & typing" },
    mediaDir: {
        label: "Media directory",
        help: "Where inbound attachments and offset state are stored. Defaults to the OS temp dir.",
        advanced: true,
    },
    chunkLimit: { label: "Text chunk limit", help: "Soft limit for outbound text; the hard cap is 4096.", advanced: true },
    previewUrl: { label: "Enable link previews", advanced: true },
    creatorId: {
        label: "Creator id",
        help: "Optional user:<id> of the agent creator; inbound from anyone else is ignored.",
        advanced: true,
    },
    baseUrl: { label: "API base URL", help: "Advanced: override the Agent Platform base URL.", advanced: true },
};
//# sourceMappingURL=config.js.map