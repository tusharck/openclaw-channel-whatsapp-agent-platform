/**
 * Error taxonomy for the WhatsApp Agent Platform API.
 *
 * Maps HTTP status + API error code into a small set of typed, actionable
 * outcomes the transport and poller can branch on, following the manual's
 * retry rules:
 *   - 2xx  = sent (record id, do not retry)
 *   - 4xx  = not sent (fix request/token); except 429 → retry with backoff
 *   - 503 / 131016 = not accepted, resend after backoff
 *   - 500 / connection reset / timeout = unknown outcome (idempotency decided in advance)
 */

import { redactSecret } from "./redact.js";
import type { WhatsAppErrorEnvelope } from "./types.js";

/** How the caller should react to a failure. */
export type WhatsAppErrorKind =
  | "auth" //        190 / 401 — bad or missing auth header. Not retryable.
  | "bad-request" //   100 / 131009 / 131053 — malformed or rejected. Not retryable.
  | "forbidden" //     131005 / 403 — recipient is not the agent's creator. Not retryable.
  | "rate-limited" //  130429 / 429 — retry after backoff.
  | "poll-replaced" // 1752041 / 409 — another poller took over. Not retryable here.
  | "unavailable" //   131016 / 503 — not accepted for delivery. Resend after backoff.
  | "server" //        2 / 500 — internal error. Unknown outcome; retry cautiously.
  | "network" //       connection reset / timeout / fetch failure. Unknown outcome.
  | "unknown";

/** Known API error codes from the manual. */
export const WhatsAppErrorCode = {
  INTERNAL: 2,
  TOKEN_OR_MEDIA_OR_LENGTH: 100,
  BAD_AUTH_HEADER: 190,
  RATE_LIMITED: 130429,
  RECIPIENT_NOT_CREATOR: 131005,
  MALFORMED_REQUEST: 131009,
  NOT_ACCEPTED_FOR_DELIVERY: 131016,
  MEDIA_REJECTED_AT_UPLOAD: 131053,
  POLL_REPLACED: 1752041,
} as const;

/** A structured error raised by the WhatsApp transport. Never contains the token. */
export class WhatsAppApiError extends Error {
  readonly kind: WhatsAppErrorKind;
  readonly status: number;
  readonly code?: number;
  /** Whether a retry (with backoff) can plausibly succeed for the same request. */
  readonly retryable: boolean;
  /** True when the outcome of the request is unknown (may or may not have applied). */
  readonly indeterminate: boolean;

  constructor(params: {
    kind: WhatsAppErrorKind;
    status: number;
    code?: number;
    message: string;
    retryable: boolean;
    indeterminate: boolean;
  }) {
    super(params.message);
    this.name = "WhatsAppApiError";
    this.kind = params.kind;
    this.status = params.status;
    this.code = params.code;
    this.retryable = params.retryable;
    this.indeterminate = params.indeterminate;
  }
}

/** Map an HTTP status + optional API error code to a kind. */
export function classifyError(status: number, code?: number): WhatsAppErrorKind {
  switch (code) {
    case WhatsAppErrorCode.BAD_AUTH_HEADER:
      return "auth";
    case WhatsAppErrorCode.RECIPIENT_NOT_CREATOR:
      return "forbidden";
    case WhatsAppErrorCode.RATE_LIMITED:
      return "rate-limited";
    case WhatsAppErrorCode.POLL_REPLACED:
      return "poll-replaced";
    case WhatsAppErrorCode.NOT_ACCEPTED_FOR_DELIVERY:
      return "unavailable";
    case WhatsAppErrorCode.MALFORMED_REQUEST:
    case WhatsAppErrorCode.MEDIA_REJECTED_AT_UPLOAD:
    case WhatsAppErrorCode.TOKEN_OR_MEDIA_OR_LENGTH:
      return "bad-request";
    case WhatsAppErrorCode.INTERNAL:
      return "server";
    default:
      break;
  }
  // Fall back to HTTP status when the code is absent or unrecognized.
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 409) return "poll-replaced";
  if (status === 429) return "rate-limited";
  if (status === 503) return "unavailable";
  if (status >= 500) return "server";
  if (status >= 400) return "bad-request";
  return "unknown";
}

/** A human-readable, actionable message per kind (never includes the token). */
export function describeError(kind: WhatsAppErrorKind, fallback?: string): string {
  switch (kind) {
    case "auth":
      return "API key invalid or missing — regenerate it in the WhatsApp agent chat (Chat info > API key) and update the channel config.";
    case "forbidden":
      return "Recipient is not the agent's creator. A WhatsApp agent can only message the account that created it.";
    case "rate-limited":
      return "Rate limited by WhatsApp (rolling 60s window). Backing off before retrying.";
    case "poll-replaced":
      return "Update poll was replaced by another poller (only one poll may run at a time).";
    case "unavailable":
      return "Message was not accepted for delivery. Resending after a short backoff.";
    case "bad-request":
      return fallback ?? "Request was malformed or rejected by WhatsApp.";
    case "server":
      return "WhatsApp returned an internal error; outcome is unknown.";
    case "network":
      return "Network error talking to WhatsApp; outcome is unknown.";
    default:
      return fallback ?? "Unknown error talking to WhatsApp.";
  }
}

/** Whether a kind is worth retrying with backoff. */
export function isRetryable(kind: WhatsAppErrorKind): boolean {
  return kind === "rate-limited" || kind === "unavailable" || kind === "server" || kind === "network";
}

/** Whether the request's outcome is unknown (idempotency matters). */
export function isIndeterminate(kind: WhatsAppErrorKind): boolean {
  return kind === "server" || kind === "network";
}

/**
 * Build a WhatsAppApiError from an HTTP response body. The `secret` is used only
 * to scrub it from any echoed error text; it is never stored on the error.
 */
export function errorFromResponse(status: number, body: unknown, secret?: string): WhatsAppApiError {
  const envelope = (body ?? {}) as WhatsAppErrorEnvelope;
  const code = envelope.error?.code;
  const kind = classifyError(status, code);
  const detail = envelope.error?.error_data?.details ?? envelope.error?.message;
  const message = redactSecret(`${describeError(kind, detail)} (HTTP ${status}${code ? `, code ${code}` : ""})`, secret);
  return new WhatsAppApiError({
    kind,
    status,
    code,
    message,
    retryable: isRetryable(kind),
    indeterminate: isIndeterminate(kind),
  });
}

/** Wrap a low-level fetch/network failure as an indeterminate network error. */
export function networkError(cause: unknown, secret?: string): WhatsAppApiError {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return new WhatsAppApiError({
    kind: "network",
    status: 0,
    message: redactSecret(`Network error: ${raw}`, secret),
    retryable: true,
    indeterminate: true,
  });
}
