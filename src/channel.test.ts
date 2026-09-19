/**
 * Contract tests (spec-required): config validation, text chunking at the 4000
 * soft limit, outbound payload shapes, and error-code mapping.
 *
 * These import the pure modules directly so the suite runs without loading the
 * OpenClaw host runtime. The channel binding is verified by `tsc` against the
 * real SDK types (see `npm run typecheck`).
 */

import { describe, expect, it } from "vitest";
import {
  patchAccountConfigBlock,
  readAccountConfigBlock,
  resolveAccountConfig,
  resolveAccountFromCfg,
  whatsappChannelConfigSchema,
} from "./config.js";
import { chunkText, DEFAULT_CHUNK_LIMIT, WHATSAPP_TEXT_HARD_LIMIT } from "./whatsapp/chunk.js";
import { buildMediaMessage, buildReactionMessage, buildTextMessage, normalizeRecipient } from "./whatsapp/payloads.js";
import { classifyError, describeError, errorFromResponse, WhatsAppErrorCode } from "./whatsapp/errors.js";
import { deriveSessionKey } from "./session.js";
import { MIN_BACKOFF_MS, backoffDelay } from "./whatsapp/rate-limit.js";

describe("config validation", () => {
  it("rejects a config with an empty api key when parsed as a full account", () => {
    const res = whatsappChannelConfigSchema.safeParse({ apiKey: "" });
    // apiKey is min(1) at the account level; the channel block is partial, so an
    // empty string still fails the string min check.
    expect(res.success).toBe(false);
  });

  it("applies defaults through resolveAccountConfig", () => {
    const acct = resolveAccountConfig({ apiKey: "secret-token" });
    expect(acct.configured).toBe(true);
    expect(acct.pollTimeout).toBe(15);
    expect(acct.pollLimit).toBe(50);
    expect(acct.sessionKeyPrefix).toBe("whatsapp-agent");
    expect(acct.sendReadReceipts).toBe(true);
    expect(acct.chunkLimit).toBe(DEFAULT_CHUNK_LIMIT);
    expect(acct.baseUrl).toBe("https://api.whatsapp.com/agent/v1");
  });

  it("marks an account without a key as not configured", () => {
    const acct = resolveAccountConfig({});
    expect(acct.configured).toBe(false);
    expect(acct.apiKey).toBe("");
  });

  it("merges a named account over the default block", () => {
    const acct = resolveAccountConfig(
      { apiKey: "base", pollTimeout: 5, accounts: { work: { apiKey: "work-key", pollTimeout: 20 } } },
      "work",
    );
    expect(acct.apiKey).toBe("work-key");
    expect(acct.pollTimeout).toBe(20);
  });

  it("clamps out-of-range poll settings via schema validation", () => {
    const res = whatsappChannelConfigSchema.safeParse({ apiKey: "k", pollTimeout: 99 });
    expect(res.success).toBe(false);
  });
});

describe("text chunking", () => {
  it("returns a single chunk under the limit", () => {
    expect(chunkText("hello")).toEqual(["hello"]);
  });

  it("splits text longer than 4000 chars into <=4000 chunks", () => {
    const long = "a".repeat(9500);
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect([...c].length).toBeLessThanOrEqual(DEFAULT_CHUNK_LIMIT);
    expect(chunks.join("")).toBe(long);
  });

  it("never exceeds the 4096 hard cap even with a custom limit", () => {
    const chunks = chunkText("b".repeat(20000), 5000);
    for (const c of chunks) expect([...c].length).toBeLessThanOrEqual(WHATSAPP_TEXT_HARD_LIMIT);
  });

  it("prefers paragraph boundaries", () => {
    const para = "x".repeat(2500);
    const chunks = chunkText(`${para}\n\n${para}`, 3000);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(para);
  });

  it("does not split a surrogate pair (emoji) across chunks", () => {
    const emoji = "😀"; // 2 UTF-16 units, 1 code point
    const chunks = chunkText(emoji.repeat(10), 4);
    for (const c of chunks) {
      expect(c.includes("\uD83D") === c.includes("\uDE00")).toBe(true);
    }
    expect(chunks.join("")).toBe(emoji.repeat(10));
  });
});

describe("outbound payload shapes", () => {
  it("normalizes a bare id to user:<id>", () => {
    expect(normalizeRecipient("12345")).toBe("user:12345");
    expect(normalizeRecipient("user:12345")).toBe("user:12345");
  });

  it("builds a text message body per the manual", () => {
    expect(buildTextMessage("12345", "hi")).toEqual({
      messaging_product: "whatsapp",
      to: "user:12345",
      type: "text",
      text: { body: "hi", preview_url: false },
    });
  });

  it("builds a media message referencing a media id", () => {
    const msg = buildMediaMessage("user:9", "image", { id: "media-1", caption: "cap" });
    expect(msg.type).toBe("image");
    expect(msg.image).toEqual({ id: "media-1", caption: "cap" });
    expect(msg.messaging_product).toBe("whatsapp");
  });

  it("builds a reaction message", () => {
    const msg = buildReactionMessage("user:9", "wamid.1", "👍");
    expect(msg.type).toBe("reaction");
    expect(msg.reaction).toEqual({ message_id: "wamid.1", emoji: "👍" });
  });
});

describe("error-code mapping", () => {
  it.each([
    [190, 401, "auth"],
    [131005, 403, "forbidden"],
    [130429, 429, "rate-limited"],
    [1752041, 409, "poll-replaced"],
    [131016, 503, "unavailable"],
    [131009, 400, "bad-request"],
    [131053, 400, "bad-request"],
    [100, 400, "bad-request"],
    [2, 500, "server"],
  ])("maps code %i (HTTP %i) to %s", (code, status, expected) => {
    expect(classifyError(status, code)).toBe(expected);
  });

  it("falls back to HTTP status when code is unknown", () => {
    expect(classifyError(429)).toBe("rate-limited");
    expect(classifyError(503)).toBe("unavailable");
    expect(classifyError(401)).toBe("auth");
  });

  it("produces an actionable auth message and scrubs the token", () => {
    const err = errorFromResponse(
      401,
      { error: { code: 190, message: "Bearer sk-super-secret bad" } },
      "sk-super-secret",
    );
    expect(err.kind).toBe("auth");
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain("sk-super-secret");
    expect(describeError("auth")).toMatch(/regenerate/i);
  });

  it("treats 429 as retryable but not indeterminate", () => {
    const err = errorFromResponse(429, { error: { code: 130429 } });
    expect(err.retryable).toBe(true);
    expect(err.indeterminate).toBe(false);
  });

  it("treats 500 as indeterminate (unknown outcome)", () => {
    const err = errorFromResponse(500, { error: { code: 2 } });
    expect(err.indeterminate).toBe(true);
  });
});

describe("setup-wizard config persistence", () => {
  // These are the helpers the declarative setup wizard writes the API key
  // through (defineTokenCredential -> patchAccount).
  const cfgWith = (channelBlock: unknown): Parameters<typeof readAccountConfigBlock>[0] =>
    ({ channels: { "whatsapp-agent-platform": channelBlock } }) as never;

  it("reads the default account from the top-level channel block", () => {
    const cfg = cfgWith({ apiKey: "k1", pollTimeout: 20 });
    expect(readAccountConfigBlock(cfg, "default")).toEqual({ apiKey: "k1", pollTimeout: 20 });
  });

  it("reads a named account from accounts.<name>", () => {
    const cfg = cfgWith({ apiKey: "base", accounts: { work: { apiKey: "w" } } });
    expect(readAccountConfigBlock(cfg, "work")).toEqual({ apiKey: "w" });
  });

  it("returns an empty block for a missing channel or account", () => {
    expect(readAccountConfigBlock({} as never, "default")).toEqual({});
    expect(readAccountConfigBlock(cfgWith({ apiKey: "k" }), "nope")).toEqual({});
  });

  it("writes the default account key without disturbing siblings", () => {
    const cfg = { channels: { other: { x: 1 }, "whatsapp-agent-platform": { pollTimeout: 20 } } } as never;
    const next = patchAccountConfigBlock(cfg, "default", { apiKey: "secret" });
    const channels = (next as unknown as { channels: Record<string, Record<string, unknown>> }).channels;
    expect(channels["whatsapp-agent-platform"]).toEqual({ pollTimeout: 20, apiKey: "secret" });
    expect(channels.other).toEqual({ x: 1 });
  });

  it("writes a named account under accounts.<name>", () => {
    const next = patchAccountConfigBlock(cfgWith({ apiKey: "base" }), "work", { apiKey: "w" });
    const block = (next as unknown as { channels: Record<string, Record<string, unknown>> }).channels[
      "whatsapp-agent-platform"
    ];
    expect(block.apiKey).toBe("base"); // default untouched
    expect(block.accounts).toEqual({ work: { apiKey: "w" } });
  });

  it("honours clearFields (used when switching to an env-var credential)", () => {
    const cfg = cfgWith({ apiKey: "old", keep: true });
    const next = patchAccountConfigBlock(cfg, "default", {}, ["apiKey"]);
    const block = (next as unknown as { channels: Record<string, Record<string, unknown>> }).channels[
      "whatsapp-agent-platform"
    ];
    expect(block).toEqual({ keep: true });
  });

  it("does not mutate the input config", () => {
    const cfg = cfgWith({ pollTimeout: 20 });
    const snapshot = JSON.stringify(cfg);
    patchAccountConfigBlock(cfg, "default", { apiKey: "x" });
    expect(JSON.stringify(cfg)).toBe(snapshot);
  });

  it("creates the channel block when config is empty", () => {
    const next = patchAccountConfigBlock({} as never, "default", { apiKey: "fresh" });
    const channels = (next as unknown as { channels: Record<string, Record<string, unknown>> }).channels;
    expect(channels["whatsapp-agent-platform"]).toEqual({ apiKey: "fresh" });
  });

  it("resolveAccountFromCfg reports configured only once a key is written", () => {
    expect(resolveAccountFromCfg({} as never).configured).toBe(false);
    const next = patchAccountConfigBlock({} as never, "default", { apiKey: "k" });
    expect(resolveAccountFromCfg(next).configured).toBe(true);
    expect(resolveAccountFromCfg(next).apiKey).toBe("k");
  });
});

describe("backoff jitter floor", () => {
  it("never returns a near-zero delay (no hot retry spin)", () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      for (let i = 0; i < 50; i++) {
        expect(backoffDelay(attempt)).toBeGreaterThanOrEqual(MIN_BACKOFF_MS);
      }
    }
  });

  it("stays within the cap", () => {
    for (let i = 0; i < 100; i++) {
      expect(backoffDelay(20)).toBeLessThanOrEqual(30_000);
    }
  });
});

describe("session keys", () => {
  it("derives a stable per-sender session key", () => {
    expect(deriveSessionKey("whatsapp-agent", null, "user:42")).toBe("whatsapp-agent:default:user:42");
    expect(deriveSessionKey("whatsapp-agent", "work", "user:42")).toBe("whatsapp-agent:work:user:42");
  });
});
