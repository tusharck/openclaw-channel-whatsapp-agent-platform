/**
 * Setup entry for the WhatsApp Agent Platform channel.
 *
 * The channel has no QR/pairing flow — "pairing" is simply pasting the agent's
 * API key in channel settings. When this plugin is not installed at onboarding,
 * `optionalSetupSurface` gives the host a wizard/adapter that points operators
 * to install it and where to find the key.
 */
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { createOptionalChannelSetupSurface } from "openclaw/plugin-sdk/channel-setup";
import { whatsappAgentPlatformChannel } from "./src/channel.js";
import { CHANNEL_ID, CHANNEL_LABEL, DOCS_PATH, NPM_SPEC } from "./src/config-schema.js";
/** Install-guidance surface used when the channel plugin is not yet installed. */
export const optionalSetupSurface = createOptionalChannelSetupSurface({
    channel: CHANNEL_ID,
    label: CHANNEL_LABEL,
    npmSpec: NPM_SPEC,
    docsPath: DOCS_PATH,
});
export default defineSetupPluginEntry(whatsappAgentPlatformChannel);
//# sourceMappingURL=setup-entry.js.map