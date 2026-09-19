/**
 * Offset + dedupe persistence for the long-poll loop.
 *
 * The poller persists `next_offset` so a gateway restart resumes exactly where
 * it left off (no reprocessing, no gaps), and keeps a bounded set of recently
 * seen WhatsApp message ids to drop duplicates the API may re-deliver.
 *
 * The interface is storage-agnostic. An in-memory implementation is provided
 * for tests; the channel binding supplies one backed by OpenClaw's plugin state
 * store so it survives restarts.
 */

export interface PollerState {
  /** Cursor to send as `offset` on the next poll; undefined on first poll. */
  nextOffset?: string;
  /** Recently processed message ids, newest last (bounded). */
  seenMessageIds: string[];
}

export interface OffsetStore {
  load(): Promise<PollerState>;
  save(state: PollerState): Promise<void>;
}

/** Max message ids retained for dedupe. Comfortably above one poll's `limit`. */
export const DEFAULT_SEEN_CAPACITY = 500;

/** Tracks offset + a bounded dedupe window on top of an OffsetStore. */
export class DedupeTracker {
  private state: PollerState = { seenMessageIds: [] };
  private loaded = false;
  private readonly seen = new Set<string>();

  constructor(
    private readonly store: OffsetStore,
    private readonly capacity: number = DEFAULT_SEEN_CAPACITY,
  ) {}

  async init(): Promise<void> {
    if (this.loaded) return;
    const loaded = await this.store.load();
    this.state = { nextOffset: loaded.nextOffset, seenMessageIds: [...(loaded.seenMessageIds ?? [])] };
    for (const id of this.state.seenMessageIds) this.seen.add(id);
    this.loaded = true;
  }

  get nextOffset(): string | undefined {
    return this.state.nextOffset;
  }

  /** True if this message id was already processed. */
  has(messageId: string): boolean {
    return this.seen.has(messageId);
  }

  /** Record a processed id, evicting the oldest when over capacity. */
  markSeen(messageId: string): void {
    if (this.seen.has(messageId)) return;
    this.seen.add(messageId);
    this.state.seenMessageIds.push(messageId);
    while (this.state.seenMessageIds.length > this.capacity) {
      const evicted = this.state.seenMessageIds.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
  }

  /** Update the cursor and persist the whole state atomically. */
  async commit(nextOffset: string | undefined): Promise<void> {
    this.state.nextOffset = nextOffset;
    await this.store.save({ nextOffset: this.state.nextOffset, seenMessageIds: [...this.state.seenMessageIds] });
  }
}

/** Simple in-memory OffsetStore for tests and ephemeral runs. */
export class MemoryOffsetStore implements OffsetStore {
  private state: PollerState = { seenMessageIds: [] };

  async load(): Promise<PollerState> {
    return { nextOffset: this.state.nextOffset, seenMessageIds: [...this.state.seenMessageIds] };
  }

  async save(state: PollerState): Promise<void> {
    this.state = { nextOffset: state.nextOffset, seenMessageIds: [...state.seenMessageIds] };
  }
}
