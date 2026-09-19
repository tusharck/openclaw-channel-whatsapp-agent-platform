/**
 * The OpenClaw channel plugin for the WhatsApp Agent Platform.
 *
 * Built with `createChannelPluginBase()` (id/meta/capabilities/config/schema)
 * wrapped by `createChatChannelPlugin()` (security/pairing/threading/outbound),
 * plus a `gateway` adapter that runs the long-poll ingress loop and a
 * `heartbeat` adapter for read receipts / typing.
 *
 * Deviations from the original task spec (which described a simplified SDK) are
 * documented in the README and PR notes; this file targets the installed
 * OpenClaw plugin SDK (v2026.9.x).
 */

import {
  createChannelPluginBase,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type {
  ChannelCapabilities,
  ChannelGatewayContext,
  ChannelLogSink,
  ChannelMeta,
  ChannelOutboundContext,
} from "openclaw/plugin-sdk/channel-contract";
import type { OutboundDeliveryResult } from "openclaw/plugin-sdk/channel-send-result";

import {
  CHANNEL_ID,
  CHANNEL_LABEL,
  DOCS_PATH,
  buildConfigSchema,
  resolveAccountConfig,
  type ResolvedWhatsAppAccount,
} from "./config-schema.js";
import { WhatsAppAgentClient, type RedactingLogger } from "./whatsapp/client.js";
import { redactSecret } from "./whatsapp/redact.js";
import { normalizeRecipient } from "./whatsapp/payloads.js";
import { DEFAULT_CHUNK_LIMIT } from "./whatsapp/chunk.js";
import { FileOffsetStore, deleteLocalFile, gcMediaDir, resolveStateRoot, saveInboundMedia } from "./plugin-state.js";
import { Poller, type InboundMessage, type InboundSink } from "./poller.js";
import { dispatchDirectMessage, type NormalizedReply } from "./inbound-dispatch.js";
import { sendChunkedText, sendLocalMedia } from "./outbound.js";

type Account = ResolvedWhatsAppAccount;
type WhatsAppChannelPlugin = ChannelPlugin<Account>;

/**
 * Per-account poller liveness. Readiness is derived from this rather than from
 * a probe request, because the only endpoint that could verify auth
 * (`GET /updates`) would replace the live poller on every heartbeat.
 */
interface PollerHealth {
  running: boolean;
  startedAt: number;
  /** Set when the loop stopped for a reason the operator must fix (bad key). */
  fatalReason?: string;
}

interface ActiveRun {
  controller: AbortController;
  done: Promise<void>;
}

const pollerHealth = new Map<string, PollerHealth>();
const activeRuns = new Map<string, ActiveRun>();

function accountKey(accountId: string | null): string {
  return accountId && accountId.length > 0 ? accountId : "default";
}

/** Read this channel's config block from the opaque OpenClawConfig. */
function readChannelBlock(cfg: OpenClawConfig): unknown {
  const channels = (cfg as { channels?: Record<string, unknown> }).channels;
  return channels?.[CHANNEL_ID];
}

function resolve(cfg: OpenClawConfig, accountId?: string | null): Account {
  return resolveAccountConfig(readChannelBlock(cfg), accountId ?? null);
}

/** Build a per-turn client + a logger that redacts the API key from all output. */
function makeClient(account: Account, log?: ChannelLogSink): { client: WhatsAppAgentClient; logger: RedactingLogger } {
  const logger: RedactingLogger = {
    debug: (m) => log?.debug?.(redactSecret(m, account.apiKey)),
    info: (m) => log?.info?.(redactSecret(m, account.apiKey)),
    warn: (m) => log?.warn?.(redactSecret(m, account.apiKey)),
    error: (m) => log?.error?.(redactSecret(m, account.apiKey)),
  };
  const client = new WhatsAppAgentClient({
    apiKey: account.apiKey,
    baseUrl: account.baseUrl,
    logger,
  });
  return { client, logger };
}

/** ---- meta + capabilities ---- */

const meta: ChannelMeta = {
  id: CHANNEL_ID,
  label: CHANNEL_LABEL,
  selectionLabel: "WhatsApp (Agent Platform)",
  docsPath: DOCS_PATH,
  docsLabel: "WhatsApp Agent Platform setup",
  blurb: "Connect OpenClaw to a WhatsApp third-party agent via the official Agent Platform API.",
  markdownCapable: true,
  systemImage: "message.fill",
};

const capabilities: ChannelCapabilities = {
  chatTypes: ["direct"],
  media: true,
  reactions: true,
  reply: false,
  threads: false,
  edit: false,
  unsend: false,
  polls: false,
  nativeCommands: false,
};

/** ---- config adapter ---- */

const config: WhatsAppChannelPlugin["config"] = {
  listAccountIds: (cfg) => {
    const block = readChannelBlock(cfg) as { accounts?: Record<string, unknown> } | undefined;
    const named = block?.accounts ? Object.keys(block.accounts) : [];
    return ["default", ...named];
  },
  resolveAccount: (cfg, accountId) => resolve(cfg, accountId),
  inspectAccount: (cfg, accountId) => {
    const a = resolve(cfg, accountId);
    // Never expose the key material in inspection output.
    return { accountId: a.accountId, configured: a.configured, enabled: a.enabled, baseUrl: a.baseUrl };
  },
  defaultAccountId: () => "default",
  isEnabled: (account) => account.enabled,
  isConfigured: (account) => account.configured,
  disabledReason: (account) => (account.enabled ? "" : "Account is disabled in config."),
  unconfiguredReason: () => "No API key set. Paste the agent's API key in channel settings.",
};

/** Abort the in-flight poll loop for an account and wait for it to settle. */
async function stopActiveRun(key: string, log?: ChannelLogSink): Promise<void> {
  const prev = activeRuns.get(key);
  if (!prev) return;
  log?.info?.(`Stopping previous WhatsApp poll loop for "${key}" before starting a new one.`);
  prev.controller.abort();
  try {
    await prev.done;
  } catch {
    /* a failed previous run must not block the new one */
  }
  activeRuns.delete(key);
}

/** ---- gateway ingress (the long-poll loop) ---- */

const gateway: NonNullable<WhatsAppChannelPlugin["gateway"]> = {
  startAccount: async (ctx: ChannelGatewayContext<Account>) => {
    const account = ctx.account;
    if (!account.configured) {
      ctx.log?.warn?.("WhatsApp Agent Platform account has no API key; not starting.");
      return;
    }
    if (!account.enabled) {
      ctx.log?.info?.("WhatsApp Agent Platform account is disabled; not starting.");
      return;
    }

    const key = accountKey(account.accountId);

    // Never let two loops race: abort any previous run for this account and
    // wait for it to actually finish before starting a new one. The API keeps
    // only one poller alive, so overlapping loops would 409-fight each other.
    await stopActiveRun(key, ctx.log);

    const { client, logger } = makeClient(account, ctx.log);
    const stateRoot = resolveStateRoot(account.mediaDir);
    const store = new FileOffsetStore(stateRoot, account.accountId);
    const creator = account.creatorId ? normalizeRecipient(account.creatorId) : undefined;

    // Bound the media directory before we start adding to it again.
    void gcMediaDir(stateRoot)
      .then((r) => {
        if (r.removed > 0) logger.info?.(`Media GC removed ${r.removed} file(s), freed ${Math.round(r.freedBytes / 1024)}KB.`);
      })
      .catch(() => undefined);

    const sink: InboundSink = {
      onMessage: async (message) => {
        await handleInbound({ ctx, client, account, stateRoot, creator, logger, message });
      },
      onFatal: (err) => {
        ctx.log?.error?.(err.message);
        const health = pollerHealth.get(key);
        if (health) health.fatalReason = err.message;
        try {
          ctx.setStatus({ ...ctx.getStatus(), state: "error", detail: err.message } as never);
        } catch {
          /* status shape is host-defined; ignore if unavailable */
        }
      },
    };

    const poller = new Poller({
      client,
      store,
      sink,
      agentIdHint: account.accountId ?? undefined,
      pollTimeout: account.pollTimeout,
      pollLimit: account.pollLimit,
      logger,
    });

    // Our own controller, chained to the host signal, so a later startAccount
    // can stop this loop deterministically.
    const controller = new AbortController();
    const onHostAbort = (): void => controller.abort();
    if (ctx.abortSignal.aborted) controller.abort();
    else ctx.abortSignal.addEventListener("abort", onHostAbort, { once: true });

    pollerHealth.set(key, { running: true, startedAt: Date.now() });

    const done = poller
      .run(controller.signal)
      .finally(() => {
        ctx.abortSignal.removeEventListener("abort", onHostAbort);
        const health = pollerHealth.get(key);
        if (health) {
          health.running = false;
          if (poller.stoppedBy) health.fatalReason = poller.stoppedBy.message;
        }
        if (activeRuns.get(key)?.controller === controller) activeRuns.delete(key);
      });

    activeRuns.set(key, { controller, done });
    await done;
  },
  stopAccount: async (ctx: ChannelGatewayContext<Account>) => {
    await stopActiveRun(accountKey(ctx.account?.accountId ?? null), ctx.log);
  },
};

interface HandleInboundParams {
  ctx: ChannelGatewayContext<Account>;
  client: WhatsAppAgentClient;
  account: Account;
  stateRoot: string;
  creator?: string;
  logger: RedactingLogger;
  message: InboundMessage;
}

async function handleInbound(p: HandleInboundParams): Promise<void> {
  const { ctx, client, account, message, logger } = p;

  // Defense in depth: only the agent creator may be served (API also enforces).
  if (p.creator && normalizeRecipient(message.from) !== p.creator) {
    logger.warn?.(`Dropping inbound from non-creator sender ${message.from}.`);
    return;
  }

  // Reactions: surface as a debug event; do not run a full turn.
  if (message.reaction) {
    logger.debug?.(`Reaction ${message.reaction.emoji ?? "?"} on ${message.reaction.messageId} from ${message.from}.`);
    return;
  }

  const to = message.from; // replies go back to the sender (the creator)
  const senderId = message.from.includes(":") ? message.from.slice(message.from.indexOf(":") + 1) : message.from;

  // Best-effort read receipt. Never fail the turn on it. (The Agent Platform
  // /statuses endpoint only supports read receipts, not a typing indicator.)
  if (account.sendReadReceipts) {
    void client.markRead(message.messageId).catch(() => undefined);
  }

  // Persist inbound media so the agent can reference a local file path.
  let mediaPath: string | undefined;
  if (message.attachment) {
    try {
      mediaPath = await saveInboundMedia(p.stateRoot, message.attachment);
    } catch (err) {
      logger.warn?.(`Failed to save inbound media: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // What the agent sees: the message text, a caption, or an attachment note.
  const rawBody =
    message.text ??
    message.attachment?.caption ??
    (mediaPath ? `[${message.attachment?.mediaType ?? "media"} attachment saved to ${mediaPath}]` : "");

  logger.info?.(`Inbound ${message.attachment ? message.attachment.mediaType : "text"} from ${message.from}; dispatching to agent.`);

  const deliver = async (reply: NormalizedReply): Promise<void> => {
    if (reply.mediaUrl) {
      const filePath = reply.mediaUrl.startsWith("file://") ? new URL(reply.mediaUrl).pathname : reply.mediaUrl;
      const res = await sendLocalMedia(client, to, filePath, { caption: reply.text, signal: ctx.abortSignal });
      logger.info?.(`Sent media reply (${res.messageIds.length} msg) to ${message.from}.`);
      return;
    }
    if (reply.text) {
      const res = await sendChunkedText(client, to, reply.text, {
        chunkLimit: account.chunkLimit,
        previewUrl: account.previewUrl,
        signal: ctx.abortSignal,
        logger,
      });
      logger.info?.(`Sent reply (${res.messageIds.length} msg) to ${message.from}.`);
    }
  };

  try {
    await dispatchDirectMessage({
      channelRuntime: ctx.channelRuntime,
      cfg: ctx.cfg,
      channel: CHANNEL_ID,
      channelLabel: CHANNEL_LABEL,
      accountId: account.accountId ?? "default",
      senderId,
      senderAddress: message.from,
      recipientAddress: `agent:${message.agentId}`,
      conversationLabel: message.contactName ?? message.from,
      rawBody,
      messageId: message.messageId,
      timestamp: message.timestamp,
      deliver,
      logger,
    });
  } finally {
    // The turn has consumed the attachment; don't leave it on disk (inbound
    // media can be up to 100MB each). The periodic GC is the backstop.
    await deleteLocalFile(mediaPath);
  }
}

/** ---- heartbeat (readiness) ---- */
// Note: the Agent Platform /statuses endpoint only supports read receipts, not
// a typing indicator, so no sendTyping/clearTyping is exposed here.

const heartbeat: NonNullable<WhatsAppChannelPlugin["heartbeat"]> = {
  // Readiness is derived from the account's own poll loop. It deliberately
  // issues NO request: the only auth-verifying endpoint is `GET /updates`,
  // which would replace the live poller (409 / 1752041) on every heartbeat.
  checkReady: async ({ cfg, accountId }) => {
    const account = resolve(cfg, accountId);
    if (!account.configured) return { ok: false, reason: "No API key configured." };
    if (!account.enabled) return { ok: false, reason: "Account is disabled in config." };

    const health = pollerHealth.get(accountKey(account.accountId));
    if (!health) return { ok: true, reason: "Configured; poll loop not started yet." };
    if (health.fatalReason) return { ok: false, reason: health.fatalReason };
    return health.running
      ? { ok: true, reason: "Poll loop running." }
      : { ok: false, reason: "Poll loop is not running." };
  },
};

/** ---- outbound adapter ---- */

const outbound: NonNullable<WhatsAppChannelPlugin["outbound"]> = {
  deliveryMode: "direct",
  // Advertise the limit we actually chunk at (WhatsApp's hard cap is 4096; we
  // chunk at the configured soft limit, 4000 by default, to keep headroom).
  textChunkLimit: DEFAULT_CHUNK_LIMIT,
  // Account-aware override, so a configured chunkLimit is reported accurately.
  resolveEffectiveTextChunkLimit: ({ cfg, accountId }) => resolve(cfg, accountId).chunkLimit,
  sendText: async (ctx: ChannelOutboundContext): Promise<OutboundDeliveryResult> => {
    const account = resolve(ctx.cfg, ctx.accountId);
    const { client } = makeClient(account);
    const result = await sendChunkedText(client, ctx.to, ctx.text, {
      chunkLimit: account.chunkLimit,
      previewUrl: account.previewUrl,
      signal: ctx.signal,
    });
    const messageId = result.messageIds[result.messageIds.length - 1];
    if (messageId === undefined) {
      // Nothing was sent (empty text). Reporting success with a blank id would
      // make the host record a delivery that never happened.
      throw new Error("WhatsApp sendText: no message was sent (text was empty).");
    }
    return {
      channel: CHANNEL_ID,
      messageId,
      meta: { messageIds: result.messageIds },
    };
  },
  sendMedia: async (ctx: ChannelOutboundContext): Promise<OutboundDeliveryResult> => {
    const account = resolve(ctx.cfg, ctx.accountId);
    const { client } = makeClient(account);
    if (!ctx.mediaUrl) {
      throw new Error("sendMedia called without mediaUrl.");
    }
    // ctx.mediaUrl is a local path or file:// URL produced by the agent runtime.
    const filePath = ctx.mediaUrl.startsWith("file://") ? new URL(ctx.mediaUrl).pathname : ctx.mediaUrl;
    const result = await sendLocalMedia(client, ctx.to, filePath, {
      caption: ctx.text || undefined,
      signal: ctx.signal,
    });
    return {
      channel: CHANNEL_ID,
      messageId: result.messageIds[result.messageIds.length - 1] ?? "",
      meta: { messageIds: result.messageIds },
    };
  },
};

/** ---- assemble the plugin ---- */

const base = createChannelPluginBase<Account>({
  id: CHANNEL_ID,
  meta,
  capabilities,
  config,
  configSchema: buildConfigSchema(),
});

export const whatsappAgentPlatformChannel: WhatsAppChannelPlugin = createChatChannelPlugin<Account>({
  base: {
    ...base,
    config,
    gateway,
    heartbeat,
  },
  threading: { topLevelReplyToMode: "off" },
  security: {
    dm: {
      channelKey: CHANNEL_ID,
      // A WhatsApp agent can only ever message its creator, so the effective
      // policy is a single-party allowlist when a creatorId is configured.
      resolvePolicy: (account) => (account.creatorId ? "allowlist" : "owner"),
      resolveAllowFrom: (account) => (account.creatorId ? [account.creatorId] : undefined),
    },
  },
  outbound,
});
