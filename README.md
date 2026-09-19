# WhatsApp Agent Platform — OpenClaw channel plugin

Connect OpenClaw to a **WhatsApp third-party agent** through WhatsApp's official
**Agent Platform API**. This is the sanctioned path: no QR pairing, no
unofficial libraries (no Baileys anywhere in the tree), and no account-ban risk.
Inbound is long-poll only (no webhooks); outbound goes through the official
`/messages` endpoint.

- **Channel id:** `whatsapp-agent-platform`
- **Runtime deps:** Node stdlib + the OpenClaw plugin SDK + `zod` only.
- **Base URL:** `https://api.whatsapp.com/agent/v1`

---

## Setup

### 1. Create the agent in WhatsApp

In the WhatsApp app: **Settings > Agents > Create an agent**. Give it a name and
finish the flow. WhatsApp issues an API key for this agent.

### 2. Copy the API key

Open the agent chat, then **Chat info > API key**. Copy it. Treat it like a
password — anyone with it can send/receive as your agent. If it leaks, regenerate
it from the same screen (this invalidates the old one). Uninstalling WhatsApp
also invalidates the key.

### 3. Install the plugin and paste the key

```bash
openclaw plugins install clawhub:<package-slug>
```

> `<package-slug>` is a placeholder — replace it with the slug ClawHub returns
> once this plugin is published.

**Local development** (or before the ClawHub publish lands) — install from the
working copy instead:

```bash
openclaw plugins install <path-to-this-folder>   # or the packed .tgz
```

Then in **Dashboard > Channels > WhatsApp Agent Platform**, paste the key into
the **API key** field and save. The channel should show as **connected**.

The API key field is marked *sensitive*, so it is stored via OpenClaw's secret
handling and is **never written to logs at any level**.

### 4. Know the limits

- **Only the agent's creator can chat with the agent.** Messages to anyone else
  return 403 (`131005`).
- **Outbound is capped at 12 messages/min** (rolling 60s window, per agent).
  Read receipts, update polls, and media each have their own limits
  (12, 15, 12 per minute). The plugin throttles client-side to stay under them.
- Chats are processed through Meta's secure service and are **not
  end-to-end encrypted**.
- **Uninstalling WhatsApp invalidates the key.**

---

## Configuration

All fields live under `channels.whatsapp-agent-platform` (a `default` account),
with optional named accounts under `accounts.<name>`.

| Field | Default | Notes |
|---|---|---|
| `apiKey` | — | **Required.** Secret bearer token from the agent chat. |
| `enabled` | `true` | Turn the account on/off. |
| `pollTimeout` | `15` | Long-poll wait seconds (0–25). |
| `pollLimit` | `50` | Updates per poll (1–100). |
| `sessionKeyPrefix` | `whatsapp-agent` | Prefix for the derived session key. |
| `sendReadReceipts` | `true` | Send a read receipt on inbound (best effort; never fails the turn). |
| `mediaDir` | OS temp dir | Where inbound media and offset state are stored. |
| `chunkLimit` | `4000` | Soft limit for outbound text (hard cap is 4096). |
| `previewUrl` | `false` | Enable WhatsApp link previews. |
| `creatorId` | — | Optional `user:<id>`; inbound from anyone else is dropped. |
| `baseUrl` | official URL | Advanced override for testing/staging. |

---

## How it works

- **Inbound** — a single background poll loop (`gateway.startAccount`) calls
  `GET /updates` continuously. Each inbound item becomes one channel message:
  text → message text; image/audio/video/document/sticker → downloaded via
  `GET /media/<id>`, saved under `mediaDir`, delivered as an attachment with any
  caption; reactions → a lightweight debug event. Messages are de-duped on the
  WhatsApp message id, and `next_offset` is persisted so a gateway restart
  resumes without gaps or re-processing.
- **Sessions** — the OpenClaw session key is derived from the sender
  (`user:<id>`), so context is per-user and stable across restarts.
- **Outbound** — `sendText` chunks replies at the soft limit and sends them
  **in order** (never concurrently to the same recipient); `sendMedia` uploads
  the file first, then sends it by media id. Failures map to clear errors: 401 →
  "API key invalid, regenerate it"; 403/`131005` → "recipient is not the agent's
  creator"; 429 → backoff and retry.
- **Presence** — with `sendReadReceipts` on, the plugin sends a read receipt on
  inbound (best effort; never fails the turn). The API has no typing indicator.
- **Readiness** — the heartbeat reports the account's own poll-loop liveness and
  issues no request of its own. `GET /updates` is the only endpoint that could
  verify auth, and calling it would replace the live poller (409 / `1752041`).
- **Security** — the API key is a secret and is never logged. When `creatorId`
  is set, inbound from any other sender is dropped as defense in depth (the API
  also enforces creator-only).
- **Setup screen** — `src/setup-wizard.ts` exports a declarative
  `ChannelSetupWizard` (`status` + `credentials`) attached to the plugin as
  `setupWizard`. That property is the *only* thing the host checks when deciding
  whether a channel has an interactive setup screen; `setup-entry.ts` and
  `package.json > openclaw.setupEntry` belong to the bundled-plugin loader and
  do not feed it.

### Media retention

Inbound attachments are written under `<mediaDir>/media/` only for as long as the
turn needs them:

- the file is deleted as soon as the agent turn that consumed it finishes;
- a GC pass runs when the channel starts, removing anything older than **24h**
  and then trimming oldest-first until the directory is under **256MB**;
- media uploaded for an outbound send is deleted from WhatsApp's media store
  once the message referencing it has been sent.

`mediaDir` defaults to a directory under the OS temp dir; point it somewhere
durable if you want attachments to outlive a reboot.

### Retry rules (per the manual)

- `2xx` = sent (record id, no retry).
- `4xx` = not sent (fix request/token); `429` → retry with backoff.
- `503`/`131016` = not accepted → resend after backoff.
- `500`/connection reset/timeout = **unknown outcome** → not auto-retried for
  sends, to avoid duplicate delivery.
- `409`/`1752041` = poll replaced (only one poller may run) → the loop backs off
  and reclaims.

---

## Development

```bash
npm install          # installs the OpenClaw SDK (dev), zod, typescript, vitest
npm run typecheck    # tsc --noEmit against the real SDK types
npm test             # vitest — transport, poller, and contract tests
npm run build        # tsc -> dist/
npm run plugin:build # build + regenerate openclaw.plugin.json from the built entry
openclaw plugins install .
```

> **Why not `openclaw plugins build`?** That command is the *tool/feature* build
> path — it looks for metadata that only `defineToolPlugin` sets, so it rejects a
> channel entry. Channel plugins ship their own runtime manifest instead;
> `scripts/generate-manifest.mjs` derives `openclaw.plugin.json`
> (`configSchema` + `channelConfigs`) from the built entry's Zod schema, so it
> always matches the source of truth. Re-run `npm run plugin:build` whenever the
> config schema changes.

> **Node version:** the OpenClaw host (and its CLI `plugins build`/`validate`)
> requires **Node ≥ 24.16** (a `node:sqlite` fix). `npm test` and `tsc` run on
> Node ≥ 22, but run the OpenClaw CLI steps on Node 24.16+.

### File layout

```
index.ts              defineChannelPluginEntry(...)
setup-entry.ts        defineSetupPluginEntry (bundled-plugin loader only)
openclaw.plugin.json  manifest (regenerated by `npm run plugin:build`)
src/
  channel.ts          the ChannelPlugin (createChatChannelPlugin/createChannelPluginBase)
  setup-wizard.ts     the declarative dashboard setup screen (plugin.setupWizard)
  config.ts           zod schema, defaults, account resolution (SDK-free)
  config-schema.ts    buildChannelConfigSchema wrapper (loads the SDK)
  session.ts          session-key derivation
  poller.ts           the long-poll ingress service (SDK-free, fully tested)
  outbound.ts         chunked/ordered text + media upload helpers
  inbound-dispatch.ts the host reply-pipeline seam (see deviations)
  plugin-state.ts     file-backed offset store + inbound media saver
  whatsapp/           the Agent Platform transport (client, errors, chunk,
                      payloads, media, rate-limit, offset-store) — no SDK, no
                      WhatsApp libraries
```

---

## Deviations from the original task spec

The task described a simplified SDK; this plugin targets the **installed**
OpenClaw plugin SDK (v2026.9.x), as the spec instructed. Confirmed differences:

1. **Import path.** Builders come from `openclaw/plugin-sdk/channel-core`
   (not `openclaw/plugin-sdk`); adapter types from `.../channel-contract`,
   `.../channel-send-result`; `createOptionalChannelSetupSurface` from
   `.../channel-setup`.
2. **No lifecycle "poller" hook.** The long-poll loop runs in the
   `gateway.startAccount(ctx)` hook and stops via `ctx.abortSignal`
   (`gateway.stopAccount`). `ChannelLifecycleAdapter` has no background-service
   hook.
3. **Replies are generated by the host** via `dispatchInboundDirectDmWithRuntime`
   (`openclaw/plugin-sdk/channel-inbound`). The poller hands each inbound direct
   message to that helper, which builds the inbound context
   (`runtime.channel.reply.finalizeInboundContext`), runs the agent turn, and
   calls our `deliver` callback with the reply — we send it back over the
   WhatsApp transport. This is isolated in `src/inbound-dispatch.ts`.
4. **Outbound surface is `sendText`/`sendMedia`** (plus optional `sendPoll`),
   not a single `send`; the adapter also requires `deliveryMode`.
5. **Presence is a `heartbeat` adapter** exposing `checkReady`. The live
   `/statuses` endpoint only accepts read receipts (`status: "read"` +
   `message_id`) — it rejects a typing indicator — so, contrary to the task
   spec, there is no typing indicator; read receipts are sent on inbound.
6. **Idle long-poll returns an empty body.** `GET /updates` returns 200 with an
   empty body (or 204) when it times out with nothing new; the client treats
   that as "no updates" rather than a parse error.
7. **`package.json > openclaw.channel` is `{ id, label, blurb }`.**
8. **zod v4.** The SDK builds config schemas with zod v4 (4.4.x); this plugin
   pins `zod` to match so the schema types unify.
9. **Offset persistence is file-backed** (`src/plugin-state.ts`) because the
   SDK's plugin-state store is not typed for external use; the `OffsetStore`
   interface makes it swappable.
10. **No declaration emit.** A channel plugin is loaded from compiled JS;
    shipping `.d.ts` would require naming the SDK's internal bundle types, so
    `declaration` is off.
11. **Manifest is generated, not built by the CLI.** `openclaw plugins build`
    only handles tool/feature plugins, and `kind` accepts only
    `memory`/`context-engine` (a channel plugin has no `kind` — it's recognized
    via `channelConfigs`). So the manifest is generated by
    `scripts/generate-manifest.mjs`.
12. **The interactive setup screen comes from `plugin.setupWizard`.** The host
    resolves it with `resolveChannelSetupWizardAdapterForPlugin`, which accepts
    either an imperative adapter (`getStatus` + `configure`) or a declarative
    wizard (`status` + `credentials`) — and reads nothing else. A plugin without
    it reports "does not have an interactive setup screen yet". Notably
    `createOptionalChannelSetupSurface` is *not* the right builder: it produces
    an always-unconfigured wizard whose finalize step tells operators to install
    the plugin, which is for a not-yet-installed ClawHub stub.
