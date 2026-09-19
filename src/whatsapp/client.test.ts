import { describe, expect, it, vi } from "vitest";
import { WhatsAppAgentClient } from "./client.js";
import { WhatsAppApiError } from "./errors.js";
import type { Clock } from "./rate-limit.js";

/** A deterministic clock: sleeps resolve immediately but advance virtual time. */
function fakeClock(): Clock {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeClient(fetchImpl: typeof fetch, apiKey = "sk-test-token") {
  return new WhatsAppAgentClient({ apiKey, fetchImpl, clock: fakeClock(), maxRetries: 3 });
}

describe("WhatsAppAgentClient", () => {
  it("rejects an empty api key", () => {
    expect(() => new WhatsAppAgentClient({ apiKey: "" })).toThrow();
  });

  it("sends text with the bearer header and correct body", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.whatsapp.com/agent/v1/messages");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer sk-test-token");
      expect(headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        messaging_product: "whatsapp",
        to: "user:42",
        type: "text",
        text: { body: "hi", preview_url: false },
      });
      return jsonResponse(200, { messaging_product: "whatsapp", messages: [{ id: "wamid.out.1" }] });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const res = await client.sendText("42", "hi");
    expect(res.messages[0].id).toBe("wamid.out.1");
  });

  it("passes offset/limit/timeout as query params on getUpdates", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = new URL(String(url));
      expect(u.pathname).toBe("/agent/v1/updates");
      expect(u.searchParams.get("offset")).toBe("cursor-1");
      expect(u.searchParams.get("limit")).toBe("50");
      expect(u.searchParams.get("timeout")).toBe("15");
      return jsonResponse(200, { object: "whatsapp_agent_platform", entry: [], next_offset: "cursor-2" });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const res = await client.getUpdates({ offset: "cursor-1", limit: 50, timeout: 15 });
    expect(res.next_offset).toBe("cursor-2");
  });

  it("treats an empty long-poll body (idle timeout) as no updates", async () => {
    // WhatsApp returns 200 with an empty body when the long-poll times out with
    // nothing new. That must be 'no updates', not a JSON-parse crash.
    const emptyBody = new Response("", { status: 200 });
    const client = makeClient((async () => emptyBody) as unknown as typeof fetch);
    const res = await client.getUpdates({ timeout: 0 });
    expect(res.entry).toEqual([]);
    expect(res.object).toBe("whatsapp_agent_platform");
  });

  it("treats a 204 poll response as no updates", async () => {
    const client = makeClient((async () => new Response(null, { status: 204 })) as unknown as typeof fetch);
    const res = await client.getUpdates({ timeout: 0 });
    expect(res.entry).toEqual([]);
  });

  it("retries on 429 then succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) return jsonResponse(429, { error: { code: 130429 } });
      return jsonResponse(200, { messaging_product: "whatsapp", messages: [{ id: "ok" }] });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const res = await client.sendText("42", "hi");
    expect(res.messages[0].id).toBe("ok");
    expect(calls).toBe(2);
  });

  it("does NOT retry a 500 (indeterminate) send", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return jsonResponse(500, { error: { code: 2 } });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    await expect(client.sendText("42", "hi")).rejects.toMatchObject({ kind: "server" });
    expect(calls).toBe(1);
  });

  it("maps a 403 to a forbidden error with an actionable message", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(403, { error: { code: 131005, message: "not creator" } }),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(client.sendText("42", "hi")).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("never leaks the api key in a thrown error", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { error: { code: 190, message: "Bearer sk-test-token invalid" } }),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    const err = (await client.sendText("42", "hi").catch((e) => e)) as WhatsAppApiError;
    expect(err).toBeInstanceOf(WhatsAppApiError);
    expect(err.message).not.toContain("sk-test-token");
  });

  it("validates media size before uploading", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: "m" })) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    const tooBig = new Uint8Array(6 * 1024 * 1024); // 6MB > 5MB image cap
    await expect(client.uploadMedia({ type: "image", data: tooBig, mimeType: "image/png" })).rejects.toMatchObject({
      kind: "bad-request",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uploads valid media as multipart and returns the id", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.whatsapp.com/agent/v1/media");
      expect(init?.body).toBeInstanceOf(FormData);
      return jsonResponse(200, { id: "media-123" });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    const id = await client.uploadMedia({ type: "image", data: new Uint8Array([1, 2, 3]), mimeType: "image/png" });
    expect(id).toBe("media-123");
  });

  // --- B1 / S6a: indeterminate network outcomes must not be replayed on sends ---

  it("does NOT retry a send when the connection is reset (indeterminate outcome)", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const err = (await client.sendText("42", "hi").catch((e) => e)) as WhatsAppApiError;

    // Surfaced to the caller, exactly once — the message may already have been
    // delivered and there is no idempotency key to make a replay safe.
    expect(calls).toBe(1);
    expect(err).toBeInstanceOf(WhatsAppApiError);
    expect(err.kind).toBe("network");
    expect(err.indeterminate).toBe(true);
  });

  it("does NOT retry a media upload when the connection is reset", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      throw new Error("ETIMEDOUT");
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    await expect(
      client.uploadMedia({ type: "image", data: new Uint8Array([1, 2, 3]), mimeType: "image/png" }),
    ).rejects.toMatchObject({ kind: "network" });
    expect(calls).toBe(1);
  });

  it("DOES retry an idempotent GET after a network exception", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("ECONNRESET");
      return jsonResponse(200, { url: "https://example.invalid/media.bin" });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const info = await client.getMediaInfo("media-1");
    expect(info.url).toBe("https://example.invalid/media.bin");
    expect(calls).toBe(2);
  });

  // --- S6c: 503 / 131016 is "not accepted for delivery" → resend after backoff ---

  it("retries a 503/131016 send and succeeds on the resend", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) return jsonResponse(503, { error: { code: 131016 } });
      return jsonResponse(200, { messaging_product: "whatsapp", messages: [{ id: "after-503" }] });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const res = await client.sendText("42", "hi");
    expect(res.messages[0].id).toBe("after-503");
    expect(calls).toBe(2);
  });

  it("exposes no polling readiness probe (readiness must never compete with the live poller)", () => {
    const client = makeClient((async () => jsonResponse(200, {})) as unknown as typeof fetch);
    // `GET /updates` is the only auth-verifying endpoint and it replaces the
    // active poller, so the client must not offer a probe that calls it.
    expect((client as unknown as Record<string, unknown>).checkReady).toBeUndefined();
  });

  it("gives up on 503 after maxRetries and surfaces an unavailable error", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return jsonResponse(503, { error: { code: 131016 } });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl); // maxRetries = 3
    await expect(client.sendText("42", "hi")).rejects.toMatchObject({ kind: "unavailable" });
    expect(calls).toBe(4); // initial + 3 retries
  });
});
