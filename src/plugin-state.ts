/**
 * File-backed persistence for poller offset/dedupe state and inbound media.
 *
 * Offsets are stored as JSON keyed by account+agent so a gateway restart
 * resumes cleanly. This is deliberately swappable: if a future OpenClaw plugin
 * SDK exposes a typed plugin-state store, the `OffsetStore` interface can be
 * re-backed onto it without touching the poller.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OffsetStore, PollerState } from "./whatsapp/offset-store.js";
import type { InboundAttachment } from "./poller.js";

/** Root dir for this channel's state + media. Defaults under the OS temp dir. */
export function resolveStateRoot(mediaDir?: string): string {
  return mediaDir && mediaDir.trim().length > 0
    ? mediaDir
    : path.join(os.tmpdir(), "openclaw-whatsapp-agent-platform");
}

function sanitize(part: string): string {
  return part.replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
}

/** JSON-file OffsetStore keyed by account id. */
export class FileOffsetStore implements OffsetStore {
  private readonly file: string;

  constructor(stateRoot: string, accountId: string | null) {
    this.file = path.join(stateRoot, "state", `${sanitize(accountId ?? "default")}.offset.json`);
  }

  async load(): Promise<PollerState> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<PollerState>;
      return {
        nextOffset: typeof parsed.nextOffset === "string" ? parsed.nextOffset : undefined,
        seenMessageIds: Array.isArray(parsed.seenMessageIds) ? parsed.seenMessageIds.filter((x): x is string => typeof x === "string") : [],
      };
    } catch {
      return { seenMessageIds: [] };
    }
  }

  async save(state: PollerState): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state), "utf8");
    await fs.rename(tmp, this.file); // atomic replace
  }
}

/** Persist an inbound attachment under the media dir; returns its local path. */
export async function saveInboundMedia(stateRoot: string, attachment: InboundAttachment): Promise<string> {
  const dir = path.join(stateRoot, "media");
  await fs.mkdir(dir, { recursive: true });
  const safeName = attachment.filename ? sanitize(attachment.filename) : `${sanitize(attachment.mediaId)}.${extForMime(attachment.mimeType)}`;
  const dest = path.join(dir, `${sanitize(attachment.mediaId)}-${safeName}`);
  await fs.writeFile(dest, attachment.data);
  return dest;
}

/** Default retention for saved inbound media. */
export const MEDIA_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
/** Default ceiling for the whole media directory. */
export const MEDIA_MAX_TOTAL_BYTES = 256 * 1024 * 1024; // 256MB

/** Best-effort delete of a file we wrote; never throws. */
export async function deleteLocalFile(filePath: string | undefined): Promise<void> {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch {
    /* already gone, or not ours to delete */
  }
}

/**
 * Bound the media directory: drop anything older than `maxAgeMs`, then, if the
 * remainder still exceeds `maxTotalBytes`, drop oldest-first until it fits.
 * Inbound attachments can be up to 100MB each, so without this the directory
 * grows without limit. Best-effort: never throws.
 */
export async function gcMediaDir(
  stateRoot: string,
  opts: { maxAgeMs?: number; maxTotalBytes?: number; now?: number } = {},
): Promise<{ removed: number; freedBytes: number }> {
  const maxAgeMs = opts.maxAgeMs ?? MEDIA_MAX_AGE_MS;
  const maxTotalBytes = opts.maxTotalBytes ?? MEDIA_MAX_TOTAL_BYTES;
  const now = opts.now ?? Date.now();
  const dir = path.join(stateRoot, "media");

  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return { removed: 0, freedBytes: 0 };
  }

  const files: Array<{ file: string; mtimeMs: number; size: number }> = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = await fs.stat(file);
      if (st.isFile()) files.push({ file, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* raced with another delete */
    }
  }

  let removed = 0;
  let freedBytes = 0;
  const survivors: typeof files = [];
  for (const f of files) {
    if (now - f.mtimeMs > maxAgeMs) {
      await deleteLocalFile(f.file);
      removed++;
      freedBytes += f.size;
    } else {
      survivors.push(f);
    }
  }

  let total = survivors.reduce((sum, f) => sum + f.size, 0);
  if (total > maxTotalBytes) {
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    for (const f of survivors) {
      if (total <= maxTotalBytes) break;
      await deleteLocalFile(f.file);
      removed++;
      freedBytes += f.size;
      total -= f.size;
    }
  }

  return { removed, freedBytes };
}

function extForMime(mime?: string): string {
  if (!mime) return "bin";
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
