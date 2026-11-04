/**
 * OpenClaw Doctor contract for this plugin.
 *
 * The host loads this artifact (built to dist/doctor-contract-api.js) to check
 * whether a new plugin version needs state or config migrations before it is
 * activated. Without it, a host update records a pending
 * "data/settings upgrade" that nothing can clear, and `openclaw plugins
 * install --force` refuses to replace the plugin.
 *
 * This plugin has no migrations. Its only persisted state is the poll offset
 * file and transient media under `mediaDir`, and no version has changed their
 * format. Its config is validated as-is by the channel schema. The manifest
 * declares the same empty list (`doctorContract.stateMigrations: []`), and the
 * host requires the two to match.
 */
export const stateMigrations = [];
export default { stateMigrations };
//# sourceMappingURL=doctor-contract-api.js.map