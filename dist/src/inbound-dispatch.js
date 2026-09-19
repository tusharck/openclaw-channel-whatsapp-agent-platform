/**
 * Inbound turn dispatch.
 *
 * Uses OpenClaw's purpose-built direct-DM entry point
 * `dispatchInboundDirectDmWithRuntime`, which builds the inbound context
 * (`runtime.channel.reply.finalizeInboundContext`), runs the agent turn, and
 * calls our `deliver` callback with the normalized outbound reply. A WhatsApp
 * agent only ever talks to its single creator, so every inbound is a direct DM.
 */
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
/**
 * Run one inbound direct-message turn through the host and deliver the reply.
 * `channelRuntime` is the gateway's full plugin runtime `.channel` surface; the
 * public SDK types it minimally, so it is adapted to `PluginRuntime` here.
 */
export async function dispatchDirectMessage(params) {
    const runtime = { channel: params.channelRuntime };
    await dispatchInboundDirectDmWithRuntime({
        cfg: params.cfg,
        channel: params.channel,
        channelLabel: params.channelLabel,
        accountId: params.accountId,
        peer: { kind: "direct", id: params.senderId },
        senderId: params.senderId,
        senderAddress: params.senderAddress,
        recipientAddress: params.recipientAddress,
        conversationLabel: params.conversationLabel,
        rawBody: params.rawBody,
        messageId: params.messageId,
        timestamp: params.timestamp,
        // The API only delivers messages from the agent's creator, so an inbound
        // event is authorized by construction.
        commandAuthorized: true,
        inboundAccessAuthorized: true,
        provider: params.channel,
        surface: params.channel,
        runtime,
        deliver: async (payload) => {
            const text = typeof payload.text === "string" && payload.text.length > 0 ? payload.text : undefined;
            const mediaUrl = (typeof payload.mediaUrl === "string" && payload.mediaUrl.length > 0 ? payload.mediaUrl : undefined) ??
                payload.mediaUrls?.find((u) => typeof u === "string" && u.length > 0);
            if (text || mediaUrl) {
                await params.deliver({ text, mediaUrl });
            }
        },
        onRecordError: (err) => params.logger?.warn?.(`inbound record error: ${describe(err)}`),
        onDispatchError: (err, info) => params.logger?.warn?.(`inbound dispatch error (${info.kind}): ${describe(err)}`),
    });
}
function describe(err) {
    return err instanceof Error ? err.message : String(err);
}
//# sourceMappingURL=inbound-dispatch.js.map