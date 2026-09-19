/**
 * Generate openclaw.plugin.json for this channel plugin.
 *
 * `openclaw plugins build` only understands tool/feature plugins (it looks for a
 * symbol that `defineToolPlugin` sets), so a channel plugin authors its own
 * runtime manifest. We derive it from the built entry's `configSchema`
 * (a ChannelConfigSchema = { schema, uiHints }) so the manifest always matches
 * the Zod source of truth.
 *
 * Run after `tsc` (needs ./dist/index.js): `node scripts/generate-manifest.mjs`.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const entryMod = await import(path.join(root, "dist/index.js"));
const entry = entryMod.default;

if (!entry?.id || !entry?.configSchema?.schema) {
  throw new Error("built entry is missing id or configSchema.schema — run `tsc` first.");
}

const { schema, uiHints } = entry.configSchema;
const id = entry.id;

const manifest = {
  id,
  name: entry.name ?? id,
  // Kept in lockstep with package.json so the manifest can never drift from
  // the published package version.
  version: pkg.version,
  description: entry.description ?? "",
  categories: ["channels"],
  // Plugin-level config schema (dashboard + validation). For a channel plugin
  // this is the channel's own config object.
  configSchema: schema,
  channels: [id],
  channelConfigs: {
    [id]: {
      label: entry.name ?? id,
      schema,
      ...(uiHints ? { uiHints } : {}),
    },
  },
};

const out = path.join(root, "openclaw.plugin.json");
await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(
  `Wrote ${path.relative(root, out)} (channel: ${id}, v${pkg.version}, ${Object.keys(schema.properties ?? {}).length} config fields).`,
);
