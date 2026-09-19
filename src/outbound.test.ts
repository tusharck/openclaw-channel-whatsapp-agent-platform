/**
 * S6d: outbound chunking — multi-chunk ordering and inter-chunk pacing —
 * plus the post-send media release added for S3.
 */

import { describe, expect, it, vi } from "vitest";
import { sendBytesMedia, sendChunkedText } from "./outbound.js";
import type { WhatsAppAgentClient } from "./whatsapp/client.js";
import type { WhatsAppSendResponse } from "./whatsapp/types.js";

interface SentText {
  to: string;
  body: string;
  at: number;
}

function makeTextClient(): { client: WhatsAppAgentClient; sent: SentText[] } {
  const sent: SentText[] = [];
  let n = 0;
  const client = {
    async sendText(to: string, body: string): Promise<WhatsAppSendResponse> {
      sent.push({ to, body, at: Date.now() });
      n++;
      return { messaging_product: "whatsapp", messages: [{ id: `m${n}` }] };
    },
  } as unknown as WhatsAppAgentClient;
  return { client, sent };
}

describe("sendChunkedText", () => {
  it("sends a long reply as ordered chunks and returns every id", async () => {
    const { client, sent } = makeTextClient();
    // Three distinct paragraphs, each just under the limit, so chunking is
    // deterministic and order is observable.
    const p = (c: string) => c.repeat(90);
    const text = `${p("a")}\n\n${p("b")}\n\n${p("c")}`;

    const res = await sendChunkedText(client, "user:1", text, { chunkLimit: 100, interChunkDelayMs: 0 });

    expect(sent.map((s) => s.body)).toEqual([p("a"), p("b"), p("c")]);
    expect(res.messageIds).toEqual(["m1", "m2", "m3"]);
    // Reassembling the chunks reproduces every character of the source.
    expect(sent.map((s) => s.body).join("")).toBe(text.replace(/\n\n/g, ""));
  });

  it("sends chunks sequentially, never concurrently (ordering is not guaranteed server-side)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const client = {
      async sendText(): Promise<WhatsAppSendResponse> {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return { messaging_product: "whatsapp", messages: [{ id: "x" }] };
      },
    } as unknown as WhatsAppAgentClient;

    await sendChunkedText(client, "user:1", "z".repeat(500), { chunkLimit: 100, interChunkDelayMs: 0 });
    expect(maxInFlight).toBe(1);
  });

  it("paces chunks with the configured inter-chunk delay", async () => {
    const { client } = makeTextClient();
    const sleepSpy = vi.spyOn(globalThis, "setTimeout");
    await sendChunkedText(client, "user:1", "y".repeat(300), { chunkLimit: 100, interChunkDelayMs: 40 });
    // 3 chunks -> 2 gaps; a delay must be scheduled between them, not after the last.
    const delays = sleepSpy.mock.calls.map((c) => c[1]).filter((d) => d === 40);
    expect(delays.length).toBe(2);
    sleepSpy.mockRestore();
  });

  it("returns no ids for empty text (caller must not report a delivery)", async () => {
    const { client, sent } = makeTextClient();
    const res = await sendChunkedText(client, "user:1", "", {});
    expect(res.messageIds).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("stops early once the abort signal fires", async () => {
    const controller = new AbortController();
    const { client, sent } = makeTextClient();
    controller.abort();
    const res = await sendChunkedText(client, "user:1", "q".repeat(500), {
      chunkLimit: 100,
      signal: controller.signal,
    });
    expect(sent).toHaveLength(0);
    expect(res.messageIds).toEqual([]);
  });
});

describe("outbound media release (S3)", () => {
  it("deletes the uploaded media object after a successful send", async () => {
    const deleted: string[] = [];
    const client = {
      async uploadMedia(): Promise<string> {
        return "media-99";
      },
      async sendMedia(): Promise<WhatsAppSendResponse> {
        return { messaging_product: "whatsapp", messages: [{ id: "sent-1" }] };
      },
      async deleteMedia(id: string): Promise<void> {
        deleted.push(id);
      },
    } as unknown as WhatsAppAgentClient;

    const res = await sendBytesMedia(client, "user:1", new Uint8Array([1, 2, 3]), "image/png");
    expect(res.messageIds).toEqual(["sent-1"]);
    expect(deleted).toEqual(["media-99"]);
  });

  it("still reports success if the cleanup delete fails", async () => {
    const client = {
      async uploadMedia(): Promise<string> {
        return "media-1";
      },
      async sendMedia(): Promise<WhatsAppSendResponse> {
        return { messaging_product: "whatsapp", messages: [{ id: "sent-2" }] };
      },
      async deleteMedia(): Promise<void> {
        throw new Error("delete failed");
      },
    } as unknown as WhatsAppAgentClient;

    const res = await sendBytesMedia(client, "user:1", new Uint8Array([1]), "image/png");
    expect(res.messageIds).toEqual(["sent-2"]);
  });
});
