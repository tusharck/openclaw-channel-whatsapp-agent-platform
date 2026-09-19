/**
 * Session-key derivation.
 *
 * The OpenClaw session key is derived deterministically from the sender so that
 * conversation context is per-user and stable across gateway restarts. Because
 * a WhatsApp agent can only talk to its single creator, in practice there is one
 * session per account, but keying on the sender keeps the mapping explicit and
 * future-proof.
 */
export function deriveSessionKey(prefix, accountId, from) {
    const account = accountId && accountId.length > 0 ? accountId : "default";
    return `${prefix}:${account}:${from}`;
}
//# sourceMappingURL=session.js.map