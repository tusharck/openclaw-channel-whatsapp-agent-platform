/**
 * WhatsApp Agent Platform API client.
 *
 * Transport-only: no OpenClaw dependency. Handles auth, JSON encoding, media
 * upload/download, client-side rate limiting, retry/backoff per the manual's
 * rules, and error mapping. The API key is only ever placed in the
 * Authorization header and is never logged or attached to thrown errors.
 */

import { WhatsAppApiError, errorFromResponse, networkError } from "./errors.js";
import { validateMedia } from "./media.js";
import { buildMediaMessage, buildReactionMessage, buildTextMessage } from "./payloads.js";
import { RollingWindowLimiter, backoffDelay, systemClock, type Clock } from "./rate-limit.js";
import type {
  WhatsAppMediaBody,
  WhatsAppMediaInfoResponse,
  WhatsAppMediaType,
  WhatsAppMediaUploadResponse,
  WhatsAppOutboundMessage,
  WhatsAppSendResponse,
  WhatsAppUpdatesResponse,
} from "./types.js";

export const DEFAULT_BASE_URL = "https://api.whatsapp.com/agent/v1";

/** A logger that receives already-redacted strings only. */
export interface RedactingLogger {
  debug?(msg: string): void;
  info?(msg: string): void;
  warn?(msg: string): void;
  error?(msg: string): void;
}

export interface WhatsAppClientOptions {
  apiKey: string;
  baseUrl?: string;
  clock?: Clock;
  logger?: RedactingLogger;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Max retry attempts for retryable, non-indeterminate failures (429/503). */
  maxRetries?: number;
}

interface RequestOptions {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string | number | undefined>;
  jsonBody?: unknown;
  formBody?: FormData;
  category: RateCategory;
  signal?: AbortSignal;
  /** Whether a retryable failure may be retried (false for indeterminate sends). */
  allowRetry?: boolean;
  /**
   * Whether replaying this exact request is safe when the outcome is unknown.
   * A thrown network exception (connection reset, ETIMEDOUT) leaves the request
   * in an indeterminate state: it may already have been applied server-side.
   * Only requests marked idempotent — GETs and DELETEs — may be retried in that
   * case. Sends (`POST /messages`, `POST /media`) carry no idempotency key, so
   * they must surface the error rather than risk duplicate delivery.
   */
  idempotent?: boolean;
  /** Do not throw on these HTTP statuses; return the Response for the caller. */
  passthroughStatuses?: number[];
}

type RateCategory = "message" | "status" | "poll" | "media";

export interface UploadMediaParams {
  type: WhatsAppMediaType;
  data: Uint8Array;
  mimeType: string;
  filename?: string;
}

export interface DownloadedMedia {
  data: Uint8Array;
  mimeType?: string;
  filename?: string;
}

export class WhatsAppAgentClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly clock: Clock;
  private readonly logger?: RedactingLogger;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;

  private readonly limiters: Record<RateCategory, RollingWindowLimiter>;

  constructor(opts: WhatsAppClientOptions) {
    if (!opts.apiKey || opts.apiKey.trim().length === 0) {
      throw new Error("WhatsAppAgentClient requires a non-empty apiKey.");
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.clock = opts.clock ?? systemClock;
    this.logger = opts.logger;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.maxRetries = opts.maxRetries ?? 4;

    // Per-agent rolling 60s windows from the manual.
    this.limiters = {
      message: new RollingWindowLimiter(12, 60_000, this.clock),
      status: new RollingWindowLimiter(12, 60_000, this.clock),
      poll: new RollingWindowLimiter(15, 60_000, this.clock),
      media: new RollingWindowLimiter(12, 60_000, this.clock),
    };
  }

  /** Long-poll for updates. Omit `offset` on the first poll to skip the backlog. */
  async getUpdates(params: {
    offset?: string;
    limit?: number;
    timeout?: number;
    signal?: AbortSignal;
  }): Promise<WhatsAppUpdatesResponse> {
    const res = await this.request({
      method: "GET",
      path: "/updates",
      query: {
        offset: params.offset,
        limit: params.limit,
        timeout: params.timeout,
      },
      category: "poll",
      signal: params.signal,
      allowRetry: false, // the poll loop owns its own retry/backoff policy
    });
    // On an idle long-poll timeout the API returns 204 / an empty body — that is
    // "no updates", not an error. Reading it as JSON would throw
    // "Unexpected end of JSON input", so handle the empty case explicitly.
    if (res.status === 204) return { object: "whatsapp_agent_platform", entry: [] };
    const text = await res.text();
    if (text.trim().length === 0) return { object: "whatsapp_agent_platform", entry: [] };
    return JSON.parse(text) as WhatsAppUpdatesResponse;
  }

  /** Send a fully-built message. 429/503 are retried; 5xx/network are not (indeterminate). */
  async sendMessage(message: WhatsAppOutboundMessage, signal?: AbortSignal): Promise<WhatsAppSendResponse> {
    const res = await this.request({
      method: "POST",
      path: "/messages",
      jsonBody: message,
      category: "message",
      signal,
      allowRetry: true,
    });
    return (await res.json()) as WhatsAppSendResponse;
  }

  /** Convenience: build + send a text message. */
  sendText(to: string, body: string, previewUrl = false, signal?: AbortSignal): Promise<WhatsAppSendResponse> {
    return this.sendMessage(buildTextMessage(to, body, previewUrl), signal);
  }

  /** Convenience: send media that has already been uploaded (media id known). */
  sendMedia(
    to: string,
    type: WhatsAppMediaType,
    media: WhatsAppMediaBody,
    signal?: AbortSignal,
  ): Promise<WhatsAppSendResponse> {
    return this.sendMessage(buildMediaMessage(to, type, media), signal);
  }

  /** Convenience: react to a message with an emoji. */
  sendReaction(to: string, messageId: string, emoji: string, signal?: AbortSignal): Promise<WhatsAppSendResponse> {
    return this.sendMessage(buildReactionMessage(to, messageId, emoji), signal);
  }

  /** Upload media (multipart) and return its media id. Validates size/mime first. */
  async uploadMedia(params: UploadMediaParams, signal?: AbortSignal): Promise<string> {
    const validationError = validateMedia(params.type, params.data.byteLength, params.mimeType);
    if (validationError) {
      throw new WhatsAppApiError({
        kind: "bad-request",
        status: 0,
        message: validationError,
        retryable: false,
        indeterminate: false,
      });
    }
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", params.type);
    const blob = new Blob([toArrayBuffer(params.data)], { type: params.mimeType });
    form.append("file", blob, params.filename ?? `upload.${extForMime(params.mimeType)}`);

    const res = await this.request({
      method: "POST",
      path: "/media",
      formBody: form,
      category: "media",
      signal,
      allowRetry: true,
    });
    const body = (await res.json()) as WhatsAppMediaUploadResponse;
    return body.id;
  }

  /** Get an inbound media's metadata, including a (redirecting) download URL. */
  async getMediaInfo(mediaId: string, signal?: AbortSignal): Promise<WhatsAppMediaInfoResponse> {
    const res = await this.request({
      method: "GET",
      path: `/media/${encodeURIComponent(mediaId)}`,
      category: "media",
      signal,
      allowRetry: true,
      idempotent: true, // GET: safe to replay on an unknown outcome
    });
    return (await res.json()) as WhatsAppMediaInfoResponse;
  }

  /** Download inbound media by id: resolve its URL then follow the redirect. */
  async downloadMedia(mediaId: string, signal?: AbortSignal): Promise<DownloadedMedia> {
    const info = await this.getMediaInfo(mediaId, signal);
    if (!info.url) {
      throw new WhatsAppApiError({
        kind: "bad-request",
        status: 0,
        message: `Media ${mediaId} has no download URL.`,
        retryable: false,
        indeterminate: false,
      });
    }
    let res: Response;
    try {
      res = await this.fetchImpl(info.url, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        redirect: "follow",
        signal,
      });
    } catch (cause) {
      throw networkError(cause, this.apiKey);
    }
    if (!res.ok) {
      const body = await safeJson(res);
      throw errorFromResponse(res.status, body, this.apiKey);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      data: buf,
      mimeType: info.mime_type ?? res.headers.get("content-type") ?? undefined,
      filename: undefined,
    };
  }

  /** Delete an uploaded media object by id. */
  async deleteMedia(mediaId: string, signal?: AbortSignal): Promise<void> {
    await this.request({
      method: "DELETE",
      path: `/media/${encodeURIComponent(mediaId)}`,
      category: "media",
      signal,
      allowRetry: true,
      idempotent: true, // DELETE: replaying only re-deletes
    });
  }

  /** Mark an inbound message as read. Best-effort; caller decides whether to await. */
  async markRead(messageId: string, signal?: AbortSignal): Promise<void> {
    await this.request({
      method: "POST",
      path: "/statuses",
      jsonBody: { messaging_product: "whatsapp", status: "read", message_id: messageId },
      category: "status",
      signal,
      allowRetry: false,
    });
  }

  // NOTE: there is deliberately no readiness probe here. `GET /updates` is the
  // only endpoint that can verify auth without side effects, but issuing one
  // replaces the live poller (409 / 1752041). Readiness is therefore derived
  // from the account's own poller liveness in the channel adapter.

  /** Core request pipeline: rate-limit → fetch → map errors → retry policy. */
  private async request(opts: RequestOptions): Promise<Response> {
    const url = this.buildUrl(opts.path, opts.query);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    let body: string | FormData | undefined;
    if (opts.jsonBody !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.jsonBody);
    } else if (opts.formBody !== undefined) {
      body = opts.formBody; // fetch sets the multipart boundary Content-Type
    }

    let attempt = 0;
    for (;;) {
      await this.limiters[opts.category].acquire();
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method: opts.method, headers, body, signal: opts.signal });
      } catch (cause) {
        const netErr = networkError(cause, this.apiKey);
        // A thrown network exception is an INDETERMINATE outcome: the request
        // may already have been applied. Mirror the HTTP-status policy below and
        // only replay requests explicitly marked idempotent — never a send.
        const canRetryNetwork =
          opts.allowRetry === true &&
          opts.idempotent === true &&
          attempt < this.maxRetries &&
          !isAbort(cause);
        if (canRetryNetwork) {
          await this.waitBackoff(++attempt, opts.signal);
          continue;
        }
        throw netErr;
      }

      if (opts.passthroughStatuses?.includes(res.status)) return res;
      if (res.ok) return res;

      const parsed = await safeJson(res);
      const apiErr = errorFromResponse(res.status, parsed, this.apiKey);
      this.logger?.warn?.(`WhatsApp ${opts.method} ${opts.path} failed: ${apiErr.message}`);

      // 429/503 are "definitely not delivered" → safe to retry with backoff.
      // 5xx/network are indeterminate → do not auto-retry non-idempotent sends.
      const canRetry = opts.allowRetry && apiErr.retryable && !apiErr.indeterminate && attempt < this.maxRetries;
      if (canRetry) {
        await this.waitBackoff(++attempt, opts.signal);
        continue;
      }
      throw apiErr;
    }
  }

  private async waitBackoff(attempt: number, signal?: AbortSignal): Promise<void> {
    const ms = backoffDelay(attempt);
    this.logger?.debug?.(`Backing off ${ms}ms before retry #${attempt}.`);
    await this.clock.sleep(ms);
    if (signal?.aborted) throw networkError(new Error("aborted"), this.apiKey);
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }
}

function isAbort(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  // Copy into a standalone ArrayBuffer so Blob never sees a SharedArrayBuffer view.
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

function extForMime(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/amr": "amr",
    "video/mp4": "mp4",
    "video/3gpp": "3gp",
    "application/pdf": "pdf",
    "text/plain": "txt",
  };
  return map[mime.toLowerCase()] ?? "bin";
}
