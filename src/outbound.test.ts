/**
 * S6d: outbound chunking — multi-chunk ordering and inter-chunk pacing —
 * plus the media release added for S3 (deferred until delivery status).
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { releaseMediaForStatus, sendBytesMedia, sendChunkedText, sendLocalMedia } from "./outbound.js";
import { WhatsAppAgentClient } from "./whatsapp/client.js";
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
  it("keeps the upload until the message is settled, then deletes it", async () => {
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
    // Accepted is not processed: deleting now would fail the send with 131053.
    expect(deleted).toEqual([]);
    await releaseMediaForStatus("sent-1", "sent");
    expect(deleted).toEqual([]);
    await releaseMediaForStatus("sent-1", "delivered");
    expect(deleted).toEqual(["media-99"]);
    // Released once only.
    await releaseMediaForStatus("sent-1", "read");
    expect(deleted).toEqual(["media-99"]);
  });

  it("releases the upload when the message fails", async () => {
    const deleted: string[] = [];
    const client = {
      async uploadMedia(): Promise<string> {
        return "media-f";
      },
      async sendMedia(): Promise<WhatsAppSendResponse> {
        return { messaging_product: "whatsapp", messages: [{ id: "sent-f" }] };
      },
      async deleteMedia(id: string): Promise<void> {
        deleted.push(id);
      },
    } as unknown as WhatsAppAgentClient;

    await sendBytesMedia(client, "user:1", new Uint8Array([1]), "image/png");
    await releaseMediaForStatus("sent-f", "failed");
    expect(deleted).toEqual(["media-f"]);
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
    await expect(releaseMediaForStatus("sent-2", "delivered")).resolves.toBeUndefined();
  });
});

describe("outbound PDF document (131053 regression)", () => {
  // A minimal but well-formed one-page PDF, standing in for a Puppeteer invoice.
  const PDF_FIXTURE = [
    "%PDF-1.4",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj",
    "trailer<</Root 1 0 R>>",
    "%%EOF",
  ].join("\n");

  interface Captured {
    method: string;
    url: string;
    form?: FormData;
    json?: Record<string, unknown>;
  }

  async function sendFixturePdf(fileName: string) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-pdf-"));
    const filePath = path.join(dir, fileName);
    await fs.writeFile(filePath, PDF_FIXTURE);
    const calls: Captured[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const c: Captured = { method: String(init?.method), url: String(url) };
      if (init?.body instanceof FormData) c.form = init.body;
      else if (typeof init?.body === "string") c.json = JSON.parse(init.body);
      calls.push(c);
      if (c.url.endsWith("/media") && c.method === "POST") return Response.json({ id: "media-pdf" });
      if (c.url.endsWith("/messages")) return Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.pdf" }] });
      return Response.json({ success: true });
    }) as unknown as typeof fetch;
    const client = new WhatsAppAgentClient({ apiKey: "sk-test-token", fetchImpl });
    const res = await sendLocalMedia(client, "user:1", filePath, { caption: "Invoice" });
    await fs.rm(dir, { recursive: true, force: true });
    return { res, calls };
  }

  it("uploads with the PDF mime type in the multipart `type` field, then attaches by id", async () => {
    const { res, calls } = await sendFixturePdf("invoice.pdf");
    const upload = calls.find((c) => c.method === "POST" && c.url.endsWith("/media"));
    expect(upload?.form?.get("messaging_product")).toBe("whatsapp");
    // The manual's upload `type` is the file's MIME type, not the message category.
    expect(upload?.form?.get("type")).toBe("application/pdf");
    const file = upload?.form?.get("file") as File;
    expect(file.type).toBe("application/pdf");
    expect(file.name).toBe("invoice.pdf");
    expect(new TextDecoder().decode(await file.arrayBuffer())).toBe(PDF_FIXTURE);

    const send = calls.find((c) => c.url.endsWith("/messages"));
    expect(send?.json).toMatchObject({
      type: "document",
      document: { id: "media-pdf", filename: "invoice.pdf", caption: "Invoice" },
    });
    expect(res.messageIds).toEqual(["wamid.pdf"]);
    // No DELETE /media until the message reaches a terminal status.
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await releaseMediaForStatus("wamid.pdf", "delivered");
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      "https://api.whatsapp.com/agent/v1/media/media-pdf",
    ]);
  });

  it("infers application/pdf from an upper-case extension", async () => {
    const { calls } = await sendFixturePdf("INVOICE-42.PDF");
    const upload = calls.find((c) => c.method === "POST" && c.url.endsWith("/media"));
    expect(upload?.form?.get("type")).toBe("application/pdf");
    expect((upload?.form?.get("file") as File).type).toBe("application/pdf");
  });
});
