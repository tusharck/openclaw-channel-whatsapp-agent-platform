/**
 * The long-poll ingress loop, as a self-contained background service.
 *
 * Responsibilities (all SDK-independent so the loop is fully unit-testable):
 *  - Poll `GET /updates` continuously with the single-poller guarantee.
 *  - Persist `next_offset` after each batch so a restart resumes without gaps
 *    or reprocessing; dedupe on WhatsApp message id.
 *  - Download inbound media and hand bytes to the sink; surface reactions.
 *  - Handle 409 (poll replaced), 429 (rate limited), auth failures, and
 *    transient/network errors with the manual's retry rules.
 *
 * The loop stops promptly when its AbortSignal fires (gateway shutdown).
 */
import { WhatsAppApiError } from "./whatsapp/errors.js";
import { DedupeTracker } from "./whatsapp/offset-store.js";
import { backoffDelay, systemClock } from "./whatsapp/rate-limit.js";
const MEDIA_FIELDS = ["image", "audio", "video", "document", "sticker"];
export class Poller {
    client;
    sink;
    tracker;
    pollTimeout;
    pollLimit;
    logger;
    clock;
    agentIdHint;
    downloadMedia;
    running = false;
    errorStreak = 0;
    fatalError;
    constructor(opts) {
        this.client = opts.client;
        this.sink = opts.sink;
        this.tracker = new DedupeTracker(opts.store);
        this.pollTimeout = clamp(opts.pollTimeout ?? 15, 0, 25);
        this.pollLimit = clamp(opts.pollLimit ?? 50, 1, 100);
        this.logger = opts.logger;
        this.clock = opts.clock ?? systemClock;
        this.agentIdHint = opts.agentIdHint;
        this.downloadMedia = opts.downloadMedia ?? true;
    }
    /**
     * Run the poll loop until `signal` aborts. Enforces a single active loop per
     * instance so a mis-wired caller can't start two competing pollers.
     */
    async run(signal) {
        if (this.running)
            throw new Error("Poller is already running (single-poller guarantee).");
        this.running = true;
        this.clearFatal();
        try {
            await this.tracker.init();
            this.logger?.info?.(`WhatsApp poller started (offset=${this.tracker.nextOffset ?? "<new>"}, timeout=${this.pollTimeout}s).`);
            // Use the getter so the backing field isn't control-flow narrowed away.
            while (!signal.aborted && this.stoppedBy === undefined) {
                await this.pollOnce(signal);
            }
        }
        finally {
            this.running = false;
            // Explicitly widened: the loop condition narrows the property to `never`.
            const fatal = this.fatalError;
            this.logger?.info?.(fatal ? `WhatsApp poller stopped: ${fatal.message}` : "WhatsApp poller stopped.");
        }
    }
    /** The error that stopped the loop, if it ended for a fatal reason. */
    get stoppedBy() {
        return this.fatalError;
    }
    clearFatal() {
        this.fatalError = undefined;
    }
    async pollOnce(signal) {
        try {
            const res = await this.client.getUpdates({
                offset: this.tracker.nextOffset,
                limit: this.pollLimit,
                timeout: this.pollTimeout,
                signal,
            });
            this.errorStreak = 0;
            for (const entry of res.entry ?? []) {
                const agentId = entry.id ?? this.agentIdHint ?? "unknown";
                for (const change of entry.changes ?? []) {
                    if (change.field !== "messages")
                        continue;
                    const value = change.value ?? {};
                    const contactName = value.contacts?.[0]?.profile?.name;
                    for (const status of value.statuses ?? []) {
                        await this.safeStatus(status);
                    }
                    for (const message of value.messages ?? []) {
                        await this.handleMessage(message, agentId, contactName, signal);
                        if (signal.aborted)
                            break;
                    }
                }
            }
            // Persist the cursor only after the whole batch is processed, so a crash
            // mid-batch resumes and re-delivers (dedupe drops the ones already done).
            await this.tracker.commit(res.next_offset ?? this.tracker.nextOffset);
        }
        catch (err) {
            await this.handleError(err, signal);
        }
    }
    async handleMessage(message, agentId, contactName, signal) {
        if (!message.id || this.tracker.has(message.id))
            return;
        const base = {
            messageId: message.id,
            from: message.from,
            agentId,
            timestamp: parseTs(message.timestamp),
            contactName,
            raw: message,
        };
        try {
            if (message.type === "text" && message.text?.body !== undefined) {
                await this.sink.onMessage({ ...base, text: message.text.body });
            }
            else if (message.type === "reaction" && message.reaction) {
                await this.sink.onMessage({
                    ...base,
                    reaction: { messageId: message.reaction.message_id, emoji: message.reaction.emoji },
                });
            }
            else {
                const attachment = await this.resolveAttachment(message, signal);
                if (attachment) {
                    await this.sink.onMessage({ ...base, attachment });
                }
                else if (message.text?.body !== undefined) {
                    await this.sink.onMessage({ ...base, text: message.text.body });
                }
                else {
                    this.logger?.debug?.(`Skipping unsupported inbound type "${message.type}" (${message.id}).`);
                }
            }
            this.tracker.markSeen(message.id);
        }
        catch (err) {
            // A per-message failure must not wedge the loop; log and move on. The id
            // is NOT marked seen, so a later poll can retry it.
            this.logger?.warn?.(`Failed to process inbound ${message.id}: ${describe(err)}`);
        }
    }
    async resolveAttachment(message, signal) {
        for (const field of MEDIA_FIELDS) {
            const ref = message[field];
            if (!ref)
                continue;
            const caption = ref.caption;
            if (!this.downloadMedia) {
                return { mediaType: field, mediaId: ref.id, data: new Uint8Array(0), mimeType: ref.mime_type, caption, filename: ref.filename };
            }
            const media = await this.client.downloadMedia(ref.id, signal);
            return {
                mediaType: field,
                mediaId: ref.id,
                data: media.data,
                mimeType: media.mimeType ?? ref.mime_type,
                filename: ref.filename ?? media.filename,
                caption,
            };
        }
        return undefined;
    }
    async safeStatus(status) {
        try {
            await this.sink.onStatus?.(status);
        }
        catch (err) {
            this.logger?.debug?.(`onStatus handler threw: ${describe(err)}`);
        }
    }
    async handleError(err, signal) {
        if (signal.aborted)
            return;
        if (err instanceof WhatsAppApiError) {
            switch (err.kind) {
                case "auth":
                    // Fatal: the loop cannot make progress until the key is fixed. Stop
                    // cleanly and report it — throwing here would let the gateway restart
                    // us straight into another 401, i.e. a crash loop.
                    this.logger?.error?.(err.message);
                    this.fatalError = err;
                    this.sink.onFatal?.(err);
                    return;
                case "poll-replaced":
                    // Another poll replaced ours; back off using the running streak (so
                    // repeated fights widen the gap) and then reclaim.
                    this.logger?.warn?.("Poll replaced by another poller; reclaiming after backoff.");
                    await this.backoff(signal);
                    return;
                case "rate-limited":
                    await this.backoff(signal);
                    return;
                default:
                    await this.backoff(signal);
                    return;
            }
        }
        // Unknown/network error: back off and continue.
        this.logger?.warn?.(`Poll error: ${describe(err)}`);
        await this.backoff(signal);
    }
    async backoff(signal) {
        const ms = backoffDelay(++this.errorStreak);
        await this.sleepAbortable(ms, signal);
    }
    /**
     * Sleep that resolves as soon as `signal` aborts, so shutdown is not delayed
     * by up to the full backoff cap.
     */
    sleepAbortable(ms, signal) {
        if (signal.aborted)
            return Promise.resolve();
        return new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled)
                    return;
                settled = true;
                signal.removeEventListener("abort", finish);
                resolve();
            };
            signal.addEventListener("abort", finish, { once: true });
            void this.clock.sleep(ms).then(finish);
        });
    }
}
function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
}
function parseTs(ts) {
    if (!ts)
        return undefined;
    const n = Number(ts);
    return Number.isFinite(n) ? n : undefined;
}
function describe(err) {
    return err instanceof Error ? err.message : String(err);
}
//# sourceMappingURL=poller.js.map