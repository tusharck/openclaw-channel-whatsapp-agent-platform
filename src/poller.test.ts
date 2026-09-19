import { describe, expect, it, vi } from "vitest";
import { Poller, type InboundMessage, type InboundSink } from "./poller.js";
import { MemoryOffsetStore } from "./whatsapp/offset-store.js";
import { WhatsAppApiError } from "./whatsapp/errors.js";
import type { Clock } from "./whatsapp/rate-limit.js";
import type { WhatsAppAgentClient, DownloadedMedia } from "./whatsapp/client.js";
import type { WhatsAppUpdatesResponse } from "./whatsapp/types.js";

function fakeClock(): Clock {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

interface FakeClientOptions {
  batches: WhatsAppUpdatesResponse[];
  downloads?: Record<string, DownloadedMedia>;
  throwOnPoll?: WhatsAppApiError;
}

/** Minimal fake exposing only what the poller calls. */
function makeFakeClient(controller: AbortController, opts: FakeClientOptions): WhatsAppAgentClient {
  let idx = 0;
  const fake = {
    async getUpdates(): Promise<WhatsAppUpdatesResponse> {
      if (opts.throwOnPoll) throw opts.throwOnPoll;
      if (idx >= opts.batches.length) {
        controller.abort();
        return { object: "whatsapp_agent_platform", entry: [] };
      }
      return opts.batches[idx++];
    },
    async downloadMedia(id: string): Promise<DownloadedMedia> {
      const d = opts.downloads?.[id];
      if (!d) throw new Error(`no download for ${id}`);
      return d;
    },
  };
  return fake as unknown as WhatsAppAgentClient;
}

function textBatch(nextOffset: string, messages: Array<{ id: string; from: string; body: string }>): WhatsAppUpdatesResponse {
  return {
    object: "whatsapp_agent_platform",
    next_offset: nextOffset,
    entry: [
      {
        id: "agent-1",
        changes: [
          {
            field: "messages",
            value: {
              messages: messages.map((m) => ({ id: m.id, from: m.from as `${string}:${string}`, type: "text", text: { body: m.body } })),
            },
          },
        ],
      },
    ],
  };
}

function collectSink(): { sink: InboundSink; received: InboundMessage[]; fatal: WhatsAppApiError[] } {
  const received: InboundMessage[] = [];
  const fatal: WhatsAppApiError[] = [];
  const sink: InboundSink = {
    onMessage: async (m) => void received.push(m),
    onFatal: (e) => void fatal.push(e),
  };
  return { sink, received, fatal };
}

describe("Poller", () => {
  it("dispatches text messages and persists the offset", async () => {
    const controller = new AbortController();
    const client = makeFakeClient(controller, {
      batches: [textBatch("cursor-2", [{ id: "wamid.1", from: "user:9", body: "hello" }])],
    });
    const store = new MemoryOffsetStore();
    const { sink, received } = collectSink();
    const poller = new Poller({ client, store, sink, clock: fakeClock() });

    await poller.run(controller.signal);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ messageId: "wamid.1", from: "user:9", text: "hello" });
    const persisted = await store.load();
    expect(persisted.nextOffset).toBe("cursor-2");
    expect(persisted.seenMessageIds).toContain("wamid.1");
  });

  it("dedupes a message id repeated across batches", async () => {
    const controller = new AbortController();
    const client = makeFakeClient(controller, {
      batches: [
        textBatch("c2", [{ id: "dup", from: "user:9", body: "one" }]),
        textBatch("c3", [{ id: "dup", from: "user:9", body: "one-again" }]),
      ],
    });
    const { sink, received } = collectSink();
    const poller = new Poller({ client, store: new MemoryOffsetStore(), sink, clock: fakeClock() });

    await poller.run(controller.signal);
    expect(received.filter((m) => m.messageId === "dup")).toHaveLength(1);
  });

  it("resumes from a persisted offset and skips already-seen ids", async () => {
    const controller = new AbortController();
    const store = new MemoryOffsetStore();
    await store.save({ nextOffset: "resume-cursor", seenMessageIds: ["seen-1"] });

    let capturedOffset: string | undefined;
    const client = {
      async getUpdates(params: { offset?: string }): Promise<WhatsAppUpdatesResponse> {
        capturedOffset = params.offset;
        controller.abort();
        return textBatch("resume-cursor", [{ id: "seen-1", from: "user:9", body: "again" }]);
      },
    } as unknown as WhatsAppAgentClient;

    const { sink, received } = collectSink();
    const poller = new Poller({ client, store, sink, clock: fakeClock() });
    await poller.run(controller.signal);

    expect(capturedOffset).toBe("resume-cursor");
    expect(received).toHaveLength(0); // seen-1 was already processed
  });

  it("downloads media and passes bytes to the sink", async () => {
    const controller = new AbortController();
    const batch: WhatsAppUpdatesResponse = {
      object: "whatsapp_agent_platform",
      next_offset: "c2",
      entry: [
        {
          id: "agent-1",
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  { id: "wamid.img", from: "user:9", type: "image", image: { id: "media-1", caption: "look" } },
                ],
              },
            },
          ],
        },
      ],
    };
    const client = makeFakeClient(controller, {
      batches: [batch],
      downloads: { "media-1": { data: new Uint8Array([1, 2, 3]), mimeType: "image/png" } },
    });
    const { sink, received } = collectSink();
    const poller = new Poller({ client, store: new MemoryOffsetStore(), sink, clock: fakeClock() });

    await poller.run(controller.signal);
    expect(received).toHaveLength(1);
    expect(received[0].attachment).toMatchObject({ mediaType: "image", mediaId: "media-1", caption: "look" });
    expect(received[0].attachment?.data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("surfaces reactions to the sink", async () => {
    const controller = new AbortController();
    const batch: WhatsAppUpdatesResponse = {
      object: "whatsapp_agent_platform",
      next_offset: "c2",
      entry: [
        {
          id: "agent-1",
          changes: [
            {
              field: "messages",
              value: { messages: [{ id: "wamid.r", from: "user:9", type: "reaction", reaction: { message_id: "wamid.1", emoji: "👍" } }] },
            },
          ],
        },
      ],
    };
    const client = makeFakeClient(controller, { batches: [batch] });
    const { sink, received } = collectSink();
    const poller = new Poller({ client, store: new MemoryOffsetStore(), sink, clock: fakeClock() });

    await poller.run(controller.signal);
    expect(received[0].reaction).toEqual({ messageId: "wamid.1", emoji: "👍" });
  });

  it("stops cleanly on a fatal auth error instead of throwing (no crash loop)", async () => {
    const controller = new AbortController();
    const authErr = new WhatsAppApiError({
      kind: "auth",
      status: 401,
      code: 190,
      message: "API key invalid",
      retryable: false,
      indeterminate: false,
    });
    const client = makeFakeClient(controller, { batches: [], throwOnPoll: authErr });
    const { sink, fatal } = collectSink();
    const onFatal = vi.spyOn(sink, "onFatal");
    const poller = new Poller({ client, store: new MemoryOffsetStore(), sink, clock: fakeClock() });

    // Resolves rather than rejecting: a rejected run() would let the gateway
    // restart us straight into another 401.
    await expect(poller.run(controller.signal)).resolves.toBeUndefined();
    expect(onFatal).toHaveBeenCalledOnce();
    expect(fatal[0].kind).toBe("auth");
    // The reason is retained so readiness can report it.
    expect(poller.stoppedBy?.kind).toBe("auth");
  });

  it("stops polling after a fatal auth error rather than looping", async () => {
    const controller = new AbortController();
    const authErr = new WhatsAppApiError({
      kind: "auth",
      status: 401,
      message: "API key invalid",
      retryable: false,
      indeterminate: false,
    });
    let polls = 0;
    const client = {
      async getUpdates(): Promise<never> {
        polls++;
        throw authErr;
      },
    } as unknown as WhatsAppAgentClient;

    const poller = new Poller({ client, store: new MemoryOffsetStore(), sink: collectSink().sink, clock: fakeClock() });
    await poller.run(controller.signal);
    expect(polls).toBe(1); // one attempt, then a clean stop
  });

  it("wakes immediately from backoff when aborted (no shutdown delay)", async () => {
    const controller = new AbortController();
    // A clock whose sleep never resolves: only the abort can end the backoff.
    const neverClock = { now: () => 0, sleep: () => new Promise<void>(() => {}) };
    const client = {
      async getUpdates(): Promise<never> {
        throw new Error("boom"); // generic error -> backoff path
      },
    } as unknown as WhatsAppAgentClient;

    const poller = new Poller({ client, store: new MemoryOffsetStore(), sink: collectSink().sink, clock: neverClock });
    const run = poller.run(controller.signal);
    // Let the first poll fail and enter backoff, then abort.
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await expect(run).resolves.toBeUndefined();
  });

  it("refuses to run two loops on one instance (single-poller guarantee)", async () => {
    const controller = new AbortController();
    const client = makeFakeClient(controller, { batches: [textBatch("c", [{ id: "x", from: "user:9", body: "hi" }])] });
    const poller = new Poller({ client, store: new MemoryOffsetStore(), sink: collectSink().sink, clock: fakeClock() });
    const first = poller.run(controller.signal);
    await expect(poller.run(new AbortController().signal)).rejects.toThrow(/already running/);
    await first;
  });
});
