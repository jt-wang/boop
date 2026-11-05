# What Boop sends to others on its own

Measured 2026-11-03 on DSH 0.2.0-rc.2 and Chrome 156 on macOS.

| What | State | How it is known |
|---|---|---|
| DSH session log after feedback (`dsh-otel-collector.deepseeksvc.com`) | Off: `DSH_TELEMETRY_MODE=DISABLED` in `src/dsh.ts` | `test/telemetry.e2e.test.ts`: a real `dsh web` and a local collector. With the upload on, feedback posts to `/v1/logs`; as Boop starts it, nothing arrives. |
| DSH session log with each official API request (`dsh_session_log`) | Off: `session-log-deepseek` `enabled: false` in `src/home.ts` | A local upstream behind `src/model-proxy.ts`: the request body has `model, stream, messages, max_tokens, thinking, output_config, system, tools`. |
| DSH product analytics | Off: `dsh-web-app/cordis.patch.yml` mounts it only for the `desktop` profile; Boop starts `web` | Same run: `lsof` on the whole DSH process tree shows no connection beyond the computer in 75 s. |
| The assistant's browser | Off until a page asks | `test/browser-quiet.e2e.test.ts` |
| `x-deepseek-harness-user-id`, `x-deepseek-harness-session-id` on model requests | **Still sent** | See below |
| TailPocket's helper, local use only (`tailcat.dev` for the relay list; a relay) | On: it is how the phone reaches the computer (`docs/connection.md`). Nothing Boop says passes in the clear; the relay sees WireGuard packets. The helper discards its own logs (TailPocket `connecthost/node.go`). | `lsof` on the helper: two relay addresses on port 443, plus loopback to the bot |

## The two headers

DSH's DeepSeek adapter sets both on every request (`dsh-llm-deepseek/lib/index.js:2200`). The config schema has no field for them and `resolveUserId` is fixed at registration (`:2253`), so DSH has no switch. Measured: both reach the upstream through Boop's model proxy, which forwards every header it does not replace (`src/model-proxy.ts:28`). The user id equals `<DSH home>/.anonymous-user-id`, a random UUID per DSH home (`dsh-anonymous-user-id`); the session id is DSH's session id. They go only to the configured DeepSeek endpoint; a custom provider uses a different adapter.
