/**
 * Channel plugin entry for the WhatsApp Agent Platform.
 *
 * `openclaw plugins build` imports this built entry, reads its channel
 * metadata, and writes/aligns `openclaw.plugin.json`.
 */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { whatsappAgentPlatformChannel } from "./src/channel.js";
import { buildConfigSchema, CHANNEL_ID, CHANNEL_LABEL } from "./src/config-schema.js";

export default defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: CHANNEL_LABEL,
  description:
    "Connect OpenClaw to a WhatsApp third-party agent through WhatsApp's official Agent Platform API (long-poll ingress, no webhooks, no unofficial libraries).",
  plugin: whatsappAgentPlatformChannel,
  configSchema: buildConfigSchema(),
});

export { whatsappAgentPlatformChannel } from "./src/channel.js";
export { CHANNEL_ID } from "./src/config-schema.js";
