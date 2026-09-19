/**
 * The dashboard / `openclaw onboard` interactive setup screen.
 *
 * The host decides whether a channel has an interactive setup by looking at
 * `channelPlugin.setupWizard` only (see `resolveChannelSetupWizardAdapterForPlugin`
 * in the host's onboard-channels module). It accepts either:
 *   - an imperative adapter: `{ getStatus(), configure() }`, or
 *   - a DECLARATIVE wizard: an object carrying both `status` and `credentials`.
 *
 * This is the declarative form, modelled on the bundled Telegram channel.
 * Neither `setup-entry.ts` nor `package.json > openclaw.setupEntry` feeds this
 * screen — those belong to the bundled-plugin loader — which is why the channel
 * previously reported "does not have an interactive setup screen yet".
 */
import { defineTokenCredential } from "openclaw/plugin-sdk/channel-setup";
import { CHANNEL_ID, CHANNEL_LABEL, patchAccountConfigBlock, readAccountConfigBlock, resolveAccountFromCfg, } from "./config.js";
function resolveWizardAccount(params) {
    return {
        accountId: params.accountId,
        config: readAccountConfigBlock(params.cfg, params.accountId),
    };
}
const API_KEY_HELP_LINES = [
    "In WhatsApp: Settings > Agents > create (or open) your agent.",
    "Open the agent chat, then Chat info > API key, and copy it.",
    "The key is stored as a secret and is never written to logs.",
    "If it leaks, regenerate it from the same screen — that invalidates the old one.",
];
export const whatsappAgentPlatformSetupWizard = {
    channel: CHANNEL_ID,
    status: {
        configuredLabel: "API key configured",
        unconfiguredLabel: "Needs an agent API key",
        configuredHint: "Polling for messages from the agent's creator.",
        unconfiguredHint: "Paste the key from the WhatsApp agent chat to connect.",
        configuredScore: 1,
        unconfiguredScore: 10,
        resolveConfigured: ({ cfg, accountId }) => resolveAccountFromCfg(cfg, accountId).configured,
        resolveStatusLines: ({ cfg, accountId, configured }) => {
            if (!configured)
                return ["No API key set."];
            const account = resolveAccountFromCfg(cfg, accountId);
            return [
                `Poll timeout ${account.pollTimeout}s, up to ${account.pollLimit} updates per poll.`,
                account.creatorId ? `Restricted to creator ${account.creatorId}.` : "Creator-only (enforced by WhatsApp).",
            ];
        },
    },
    credentials: [
        defineTokenCredential({
            inputKey: "apiKey",
            configKey: "apiKey",
            providerHint: CHANNEL_ID,
            credentialLabel: `${CHANNEL_LABEL} API key`,
            preferredEnvVar: "WHATSAPP_AGENT_API_KEY",
            helpTitle: "WhatsApp agent API key",
            helpLines: API_KEY_HELP_LINES,
            envPrompt: "Use the API key from WHATSAPP_AGENT_API_KEY?",
            keepPrompt: "Keep the existing WhatsApp agent API key?",
            inputPrompt: "Paste the agent API key (Chat info > API key)",
            resolveAccount: resolveWizardAccount,
            resolvedValue: (account) => {
                const value = account.config.apiKey;
                return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
            },
            envValue: () => {
                const value = process.env.WHATSAPP_AGENT_API_KEY;
                return value && value.trim().length > 0 ? value.trim() : undefined;
            },
            patchAccount: ({ cfg, accountId, patch, clearFields }) => patchAccountConfigBlock(cfg, accountId, patch, clearFields),
            set: { value: "input" },
            useEnv: {},
        }),
    ],
    completionNote: {
        title: `${CHANNEL_LABEL} connected`,
        lines: [
            "Message your agent from the WhatsApp account that created it — only the",
            "creator can talk to it. Replies are sent back through the same chat.",
            "Note: outbound is capped at 12 messages/min, and chats are not",
            "end-to-end encrypted (they go through Meta's agent service).",
        ],
    },
};
//# sourceMappingURL=setup-wizard.js.map