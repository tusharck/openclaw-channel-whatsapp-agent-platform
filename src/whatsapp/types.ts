/**
 * Type definitions for the WhatsApp Agent Platform API (v1).
 *
 * Reference: "WhatsApp Agent Platform – Developer Manual" v1.0 (Aug 25, 2026).
 * Base URL: https://api.whatsapp.com/agent/v1
 *
 * These types describe the wire shapes only; they intentionally have no
 * dependency on the OpenClaw SDK so the transport layer can be unit-tested in
 * isolation.
 */

/** Message/media kinds the Agent Platform supports for outbound sends. */
export type WhatsAppMessageType =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "sticker"
  | "reaction";

/** Media kinds that must be uploaded before they can be referenced in a send. */
export type WhatsAppMediaType = "image" | "audio" | "video" | "document" | "sticker";

/** A `<type>:<id>` sender/recipient identifier, e.g. `user:12345`. */
export type WhatsAppParty = `${string}:${string}`;

/** ---- Outbound message bodies ---- */

export interface WhatsAppTextBody {
  body: string;
  preview_url?: boolean;
}

export interface WhatsAppMediaBody {
  /** Id returned by POST /media. Exactly one of `id` or `link` is used. */
  id?: string;
  /** Publicly reachable URL. `id` is preferred and used by this plugin. */
  link?: string;
  caption?: string;
  filename?: string;
}

export interface WhatsAppReactionBody {
  message_id: string;
  emoji: string;
}

/** Outbound message envelope sent to POST /messages. */
export interface WhatsAppOutboundMessage {
  messaging_product: "whatsapp";
  to: WhatsAppParty;
  type: WhatsAppMessageType;
  text?: WhatsAppTextBody;
  image?: WhatsAppMediaBody;
  audio?: WhatsAppMediaBody;
  video?: WhatsAppMediaBody;
  document?: WhatsAppMediaBody;
  sticker?: WhatsAppMediaBody;
  reaction?: WhatsAppReactionBody;
}

/** Response from POST /messages. */
export interface WhatsAppSendResponse {
  messaging_product: "whatsapp";
  contacts?: Array<{ input?: string; wa_id?: string }>;
  messages: Array<{ id: string }>;
}

/** Response from POST /media (upload). */
export interface WhatsAppMediaUploadResponse {
  id: string;
}

/** Response from GET /media/<id> (metadata / download url). */
export interface WhatsAppMediaInfoResponse {
  url: string;
  mime_type?: string;
  sha256?: string;
  file_size?: number;
  id?: string;
}

/** ---- Inbound (long-poll updates) ---- */

export interface WhatsAppInboundMediaRef {
  id: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  filename?: string;
  /** Only present on stickers. */
  animated?: boolean;
  /** Only present on voice notes. */
  voice?: boolean;
}

export interface WhatsAppInboundMessage {
  /** WhatsApp message id (wamid…). Used for dedupe. */
  id: string;
  /** `<type>:<id>` sender, e.g. `user:12345`. */
  from: WhatsAppParty;
  /** Unix seconds as a string, per the manual. */
  timestamp?: string;
  type: WhatsAppMessageType | string;
  text?: { body: string };
  image?: WhatsAppInboundMediaRef;
  audio?: WhatsAppInboundMediaRef;
  video?: WhatsAppInboundMediaRef;
  document?: WhatsAppInboundMediaRef;
  sticker?: WhatsAppInboundMediaRef;
  reaction?: { message_id: string; emoji?: string };
  /** Present when the message is a reply/quote. */
  context?: { id?: string; from?: string };
}

export interface WhatsAppInboundStatus {
  id: string;
  status: "sent" | "delivered" | "read" | "failed" | string;
  timestamp?: string;
  recipient_id?: string;
}

export interface WhatsAppInboundContact {
  wa_id?: string;
  profile?: { name?: string };
}

export interface WhatsAppChangeValue {
  messages?: WhatsAppInboundMessage[];
  statuses?: WhatsAppInboundStatus[];
  contacts?: WhatsAppInboundContact[];
}

export interface WhatsAppChange {
  field: "messages" | string;
  value: WhatsAppChangeValue;
}

export interface WhatsAppEntry {
  /** Agent numeric id. */
  id: string;
  changes: WhatsAppChange[];
}

/** Response from GET /updates. */
export interface WhatsAppUpdatesResponse {
  object: "whatsapp_agent_platform" | string;
  entry: WhatsAppEntry[];
  /** Opaque cursor to pass as `offset` on the next poll. */
  next_offset?: string;
}

/** Error envelope returned by the API on non-2xx. */
export interface WhatsAppErrorEnvelope {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_data?: { details?: string };
    fbtrace_id?: string;
  };
}
