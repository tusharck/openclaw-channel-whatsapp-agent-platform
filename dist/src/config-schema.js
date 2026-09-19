/**
 * Thin wrapper that turns the pure Zod schema in `config.ts` into an OpenClaw
 * `ChannelConfigSchema` (with UI hints). This is the only config module that
 * loads the OpenClaw SDK runtime; keep it out of unit tests.
 */
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-core";
import { uiHints, whatsappChannelConfigSchema } from "./config.js";
export * from "./config.js";
/** Build the OpenClaw channel config schema with UI hints. */
export function buildConfigSchema() {
    return buildChannelConfigSchema(whatsappChannelConfigSchema, { uiHints });
}
//# sourceMappingURL=config-schema.js.map