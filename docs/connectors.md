# Connectors: one tap, or ask

Settings → Connectors shows one tile per service. Tap **Connect**, sign in on the phone, come back: the tile says **Connected** and the assistant can use the service. Or say "connect my Notion" in the thread: the assistant shows a card with one button that does the same. **Disconnect** is one tap; the token is deleted. Nothing is typed: no key, no address, no setting name. Advanced, at the bottom, keeps the old path (a folder on the computer, any MCP server by command or address).

## Which services work with one tap today

| Service | Remote MCP URL | Registers any client? | Here |
|---|---|---|---|
| Notion | https://mcp.notion.com/mcp | Yes: `/.well-known/oauth-authorization-server` has `registration_endpoint` and `client_id_metadata_document_supported: true` | One tap |
| Linear | https://mcp.linear.app/mcp | Yes: docs say "uses OAuth 2.1 with dynamic client registration"; metadata has `registration_endpoint` | One tap |
| Jira / Confluence (Atlassian) | https://mcp.atlassian.com/v2/mcp | Yes: the authorization server at auth.atlassian.com has a `dcr/register` endpoint; "Atlassian MCP supports any app with MCP support". Org admins can block redirect domains ("You can add domains you trust to enable integrations with specific AI tools.") | One tap, unless the org blocks the bot's domain |
| GitHub | https://api.githubcopilot.com/mcp/ | No: "Dynamic Client Registration is NOT supported by Remote GitHub MCP Server at this time." "Each MCP host application needs to configure a GitHub App or OAuth App" | Host registers an OAuth App |
| Slack | https://mcp.slack.com/mcp | No: "We do not support SSE-based connections or Dynamic Client Registration at this time." "MCP clients must be backed by a registered Slack app" | Host registers a Slack app (Marketplace-published to serve other workspaces) |
| Gmail / Google Calendar / Google Drive | https://gmailmcp.googleapis.com/mcp/v1, …calendarmcp…, …drivemcp… | No: "Google Workspace offers remote Model Context Protocol (MCP) servers" (Developer Preview); "When creating your OAuth 2.0 client, select Use this client for an AI-powered agent." Gmail scopes are restricted: verification and a CASA assessment "at least every 12 months" | Host registers a Google Cloud OAuth client; Gmail also needs Google's verification |

Pages: https://developers.notion.com/docs/get-started-with-mcp, https://linear.app/docs/mcp, https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/, https://support.atlassian.com/security-and-access-policies/docs/control-atlassian-rovo-mcp-server-settings/, https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md, https://docs.slack.dev/ai/mcp-server/, https://developers.google.com/workspace/guides/configure-mcp-servers, https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification. The metadata claims were checked by fetching each service's `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` the same day.

For the three that need a host-registered client, the host sets two environment variables on the bot (names in `src/connectors.ts`, `clientEnv`: `DEEPSEEK_BOT_OAUTH_GITHUB`, `DEEPSEEK_BOT_OAUTH_SLACK`, `DEEPSEEK_BOT_OAUTH_GOOGLE`, each with `_CLIENT_ID` and `_CLIENT_SECRET`). Until then the tile says "Not available on this computer yet." The redirect URI to register at the service is `<bot's public URL>/connectors/callback`; for a hosted bot that is `<host>/s/<sandbox id>/connectors/callback`.

## What was built

```
phone                     bot (src/)                                  service
Connect ───POST /connectors/<id>/connect──▶ oauth.ts: discover (RFC 9728 → 8414)
                                            client: host's env, cached DCR, or register (RFC 7591)
                                            PKCE S256 + state, resource = MCP URL
        ◀── { url } ─────────────────────── 
openUrl(url) ────────────────────────────────────────────────────────▶ sign-in page
                                                                       person taps Allow
        GET /connectors/callback?code&state ◀──────────────────────── redirect
                                            exchange code → tokens → connector-secrets.json (0600)
                                            connectors.json: { id, auth: 'oauth', enabled }
                                            profile patch: one mcp-client row → http://127.0.0.1:<proxy>/<id>
                                            dsh reloads the patch (HMR) and connects (~2 s)
                                            phones: { type: 'connector' }; main thread: "[Connected Notion] …"
tile: Connected
assistant ── mcp__notion__* ──▶ connector-proxy.ts adds Bearer, refreshes on 401 ──▶ service
Disconnect ── DELETE /connectors/<id> ──▶ token deleted, row removed, patch rewritten, dsh drops the server
```

Files:

| Piece | Where |
|---|---|
| Catalog (one-tap services, advanced presets), store, routes | `src/connectors.ts` |
| Discovery, registration, PKCE, callback, tokens (0600), refresh, the callback page | `src/oauth.ts` |
| Loopback proxy DSH talks to; adds the bearer, retries once after a refresh | `src/connector-proxy.ts` |
| Patch row for a one-tap connector points at the proxy; AGENTS.md tells the assistant about `connect` cards | `src/home.ts` |
| Card kind `connect` (`show` tool) | `src/cards.ts`, `mobile/src/cards.tsx`, `mobile/src/fold.ts` |
| Callback passes the bot's device check and the host's account check (state is the proof); hosted bots get `DEEPSEEK_BOT_PUBLIC_URL` | `src/server.ts`, `src/host/server.ts` |
| Wiring, live apply, "[Connected …]" message to the assistant 5 s after the patch write | `src/main.ts` |
| Gallery, Connect, polling until Connected, Advanced | `mobile/src/connectors.tsx`, `mobile/src/i18n.ts` |

Routes added: `POST /connectors/:service/connect` (device token) → `{ url }`; `GET /connectors/callback?code&state` (no token; a one-time `state` with a 10-minute life) → an HTML page "<Service> is connected. You can go back to the app." `GET /connectors` now carries `connected` per connector and `available` per catalog entry. `DELETE /connectors/:id` on a one-tap connector also deletes its token.

No restart. A running `dsh web` watches its profile patch (the base bundle enables `dsh-hmr` with `root: []`, "Profile configuration reloads by default"). Measured with a stub MCP server: a row appended to `cordis.patch.yml` at runtime was connected 2.1 s later (initialize, tools/list), a removed row's stream was closed 2.1 s later; with `- id: hmr` `disabled: true` in the patch neither happened. The `restartNeeded` flag and its banner remain for profiles where HMR is off.

Secrets: tokens in `~/.deepseek-bot/connector-secrets.json` (0600) only. `connectors.json` has the id, the service URL and `enabled`. The patch has the proxy's address and this process's secret, like the bot's own tools row. The app receives booleans and the sign-in URL; tests assert no token appears in any response, in `connectors.json`, in the patch, or on the callback page.

Palette: the gallery uses the existing tokens (`bg-primary`, `text-primary`, `text-destructive`, the grey captions); the old green switch on advanced connectors is now `checked:bg-primary`.

## Which redirect addresses the services take

A real dynamic registration at each service (no account needed), 2026-10-27 03:58 UTC, body `{"client_name":"DeepSeek Bot","redirect_uris":[<one URI>],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none"}`. Registration endpoints from each service's metadata: `https://mcp.notion.com/register`, `https://mcp.linear.app/register`, `https://auth.atlassian.com/<tenant>/dcr/register`.

| redirect_uris | Notion | Linear | Atlassian |
|---|---|---|---|
| `http://192.168.1.20:3850/connectors/callback` (LAN, plain http) | **400** `invalid_redirect_uri`: "Redirect URI must use HTTPS unless it is a loopback HTTP URI" | **400** `invalid_redirect_uri`: "…plaintext HTTP is allowed only for loopback addresses." | 201 |
| `https://example-host.fly.dev/s/abc/connectors/callback` (hosted) | 201 | 201 | 201 |
| `http://127.0.0.1:3850/connectors/callback` | 201 | 201 | 201 |
| `http://localhost:3850/connectors/callback` | 201 | 201 | 201 |

Every 201 echoed the redirect URI and a `client_id`; Atlassian also returned a `client_secret` (kept like the rest, never shown).

What the bot does with that (`ConnectorAuth.start` in `src/oauth.ts`):

- An https address (hosted, or `--tunnel`) is always the redirect.
- Plain http, and the person taps Connect on the computer the bot runs on (the request reaches the bot from loopback, not relayed): the redirect is `http://127.0.0.1:<port>/connectors/callback`, which all three take.
- Plain http, from the phone: the LAN address is tried; if the service refuses it, Connect answers "Notion only connects over a secure address. Open Connectors on the computer the assistant runs on and connect it there." The phone shows that line. Pairing over `--tunnel` (https) removes the case.

Measured with a real bot bound to the LAN (`--host 0.0.0.0`), `POST /connectors/<id>/connect`, 2026-10-27 04:00 UTC:

| | from 127.0.0.1 | from the LAN address |
|---|---|---|
| Notion | 200, `mcp.notion.com`, redirect `http://127.0.0.1:<port>/connectors/callback` | 400, the line above |
| Linear | 200, `mcp.linear.app`, loopback redirect | 400, the line above |
| Atlassian | 200, `auth.atlassian.com`, loopback redirect | 200, redirect `http://<LAN IP>:<port>/connectors/callback` |

Tests: `test/oauth.test.ts` ("redirect URI: …", "routes: … from this computer"); the fake service refuses non-loopback http when started with `httpsOrLoopback`.

## Try a service end to end


1. On the phone, open the app paired to a hosted computer, or to a bot started with `npm start -- --tunnel`, so the address is https.
2. Settings → Connectors → Notion → **Connect**. Notion's page opens; sign in, pick the pages to share, tap **Allow**.
3. The browser shows "Notion is connected. You can go back to the app." The tile says **Connected**.
4. In the thread, ask: "Search my Notion for <a word in one of your page titles> and tell me the page title."

Pass: the reply names that page, and the thread shows a Notion step. If step 3 shows "Not connected", the line under it says why.

Without a phone, on the computer the bot runs on: `curl -s -X POST http://127.0.0.1:<port>/connectors/notion/connect -H "authorization: Bearer <a device token>"` prints `{"url": …}`; open that URL in the computer's browser and continue from step 2 (the redirect comes back over loopback, which Notion accepts; section 4).

Linear and Atlassian take the same step. For an Atlassian site whose admin limits which domains may connect, the admin adds the bot's address (the host's domain, or the tunnel's) first.

GitHub, Slack, Gmail, Google Calendar and Google Drive are not one-tap until the host registers an OAuth app at each (they register no clients themselves; the table above): create the app on an account you hold, set its redirect URI to `<bot's public URL>/connectors/callback`, and set `DEEPSEEK_BOT_OAUTH_<GITHUB|SLACK|GOOGLE>_CLIENT_ID` / `_CLIENT_SECRET` on the bot; the tile then turns on and the four steps above apply. For Google, whether its MCP servers accept the scopes in the catalog is answered at that first sign-in.
