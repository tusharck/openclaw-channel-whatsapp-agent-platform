/**
 * Pure config: constants, Zod schema, defaults, and account resolution.
 *
 * This module has NO runtime dependency on the OpenClaw SDK (only a type-only
 * import, which is erased at build time), so the transport, poller, and config
 * validation can be unit-tested without loading the host bundle.
 */

import { z } from "zod";
import type { ChannelConfigUiHint, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { DEFAULT_BASE_URL } from "./whatsapp/client.js";
import { DEFAULT_CHUNK_LIMIT } from "./whatsapp/chunk.js";

export const CHANNEL_ID = "whatsapp-agent-platform";
export const CHANNEL_LABEL = "WhatsApp Agent Platform";
export const DOCS_PATH = "/plugins/whatsapp-agent-platform";
export const NPM_SPEC = "whatsapp-agent-platform";
/** Account id used when config lives directly under `channels.<id>`. */
export const DEFAULT_ACCOUNT_ID = "default";

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

export type WhatsAppAccountConfig = z.infer<typeof accountSchema>;

/** Full channel config: a default account, plus optional named accounts. */
export const whatsappChannelConfigSchema = accountSchema.partial().extend({
  accounts: z.record(z.string(), accountSchema.partial()).optional(),
});

export type WhatsAppChannelConfig = z.infer<typeof whatsappChannelConfigSchema>;

/** A fully-resolved account the adapters operate on. */
export interface ResolvedWhatsAppAccount {
  accountId: string | null;
  apiKey: string;
  enabled: boolean;
  pollTimeout: number;
  pollLimit: number;
  sessionKeyPrefix: string;
  sendReadReceipts: boolean;
  mediaDir?: string;
  chunkLimit: number;
  previewUrl: boolean;
  creatorId?: string;
  baseUrl: string;
  configured: boolean;
}

const FIELD_DEFAULTS = {
  enabled: true,
  pollTimeout: 15,
  pollLimit: 50,
  sessionKeyPrefix: "whatsapp-agent",
  sendReadReceipts: true,
  chunkLimit: DEFAULT_CHUNK_LIMIT,
  previewUrl: false,
  baseUrl: DEFAULT_BASE_URL,
} as const;

/**
 * Merge a raw channel config block + optional named account override into a
 * resolved account. Unknown/missing fields fall back to schema defaults.
 */
export function resolveAccountConfig(raw: unknown, accountId?: string | null): ResolvedWhatsAppAccount {
  const parsed = whatsappChannelConfigSchema.safeParse(raw ?? {});
  const data: WhatsAppChannelConfig = parsed.success ? parsed.data : {};
  const { accounts, ...base } = data;
  const named = accountId ? accounts?.[accountId] ?? {} : {};
  const merged = { ...base, ...named } as Partial<WhatsAppAccountConfig>;
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

/** ---- raw config-tree access (used by the adapters and the setup wizard) ---- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** This channel's raw config block: `channels.<CHANNEL_ID>`. */
export function readChannelConfigBlock(cfg: OpenClawConfig): unknown {
  const channels = (cfg as { channels?: Record<string, unknown> }).channels;
  return channels?.[CHANNEL_ID];
}

/** Resolve an account straight from the host config. */
export function resolveAccountFromCfg(cfg: OpenClawConfig, accountId?: string | null): ResolvedWhatsAppAccount {
  return resolveAccountConfig(readChannelConfigBlock(cfg), accountId ?? null);
}

/**
 * The raw (unmerged) config object for one account. The default account lives
 * at `channels.<id>`; named accounts live at `channels.<id>.accounts.<name>`.
 */
export function readAccountConfigBlock(cfg: OpenClawConfig, accountId: string): Record<string, unknown> {
  const block = readChannelConfigBlock(cfg);
  if (!isRecord(block)) return {};
  if (accountId === DEFAULT_ACCOUNT_ID) return block;
  const accounts = block.accounts;
  const named = isRecord(accounts) ? accounts[accountId] : undefined;
  return isRecord(named) ? named : {};
}

/**
 * Immutably apply `patch` to one account's config block, deleting `clearFields`.
 * This is how the setup wizard persists the API key.
 */
export function patchAccountConfigBlock(
  cfg: OpenClawConfig,
  accountId: string,
  patch: Record<string, unknown>,
  clearFields: readonly string[] = [],
): OpenClawConfig {
  const root = cfg as unknown as Record<string, unknown>;
  const channels = isRecord(root.channels) ? { ...root.channels } : {};
  const existing = channels[CHANNEL_ID];
  const block: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};

  const applyTo = (target: Record<string, unknown>): Record<string, unknown> => {
    const next = { ...target, ...patch };
    for (const field of clearFields) delete next[field];
    return next;
  };

  if (accountId === DEFAULT_ACCOUNT_ID) {
    channels[CHANNEL_ID] = applyTo(block);
  } else {
    const rawAccounts = block.accounts;
    const accounts: Record<string, unknown> = isRecord(rawAccounts) ? { ...rawAccounts } : {};
    const named = accounts[accountId];
    accounts[accountId] = applyTo(isRecord(named) ? named : {});
    block.accounts = accounts;
    channels[CHANNEL_ID] = block;
  }

  return { ...root, channels } as unknown as OpenClawConfig;
}

/** UI hints shown in the dashboard for each field. */
export const uiHints: Record<string, ChannelConfigUiHint> = {
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
