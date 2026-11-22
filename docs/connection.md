# How the phone reaches the computer

Settings' Computer section says this to you (`mobile/src/route.ts`). It is worked out from the address the phone uses.

## Local use: what happens, step by step

Local means the Mac app or `npm start` on your own computer. Your own server and Fly keep HTTPS (the table below).

1. The bot listens on `127.0.0.1` only and starts TailPocket's helper (`vendor/tailpocket/bin/tailpocket-host-*`, `src/pocket.ts`), which forwards each paired phone's connection to that port. Without the helper it still listens on `127.0.0.1` only, so no phone can connect, and it says so: install the helper first (`scripts/tailpocket-sync.sh` in a checkout, or the installer package). It no longer falls back to plain HTTP on the local network.
2. The bot opens a pairing window of up to 15 minutes with its own 6-digit code as the payload, and shows the invite as a QR (terminal and Mac window, also `pairing.txt`, mode 0600): `tailpocket2:…`, the v2 invite with every route and the computer's key (TailPocket v0.3.0-pre.4 and later, `src/pocket.ts` `window`).
3. In the phone app the person taps Scan the code. The native bridge (`TailPocketNSH` on iOS, `tailpocket-nsh` on Android) pairs over the first route it reaches among those the computer lists and the phone allows: Tailcat, the local network, or your relay (below).
4. Before anything is saved, both screens show the same four emoji, derived from the Noise handshake. The phone shows them with "Check that your computer shows the same emoji, then confirm there". The computer shows the phone's name and the emoji: the terminal asks for `y` or `n`, the Mac window has two buttons. No answer within 55 s, a no, or a phone that leaves ends the window, and its code pairs nobody; a new one comes up. A refused phone says the computer did not pair it (`unauthorized`). The refusal reaches the phone at once on every route (TailPocket v0.3.0; measured in this orb: under a second over Tailcat).
5. The phone receives the 6-digit code inside the tunnel. The bridge gives the app `http://127.0.0.1:<random port>/_tailpocket/<token>` on the phone. Every request and WebSocket goes under that base; any other program on the phone that finds the port gets 403 without the token. The app keeps the token in memory only: the saved address has it removed (`mobile/src/api.ts` `saveSession`), and so do the names of the per-computer trust stores the shells keep for interfaces (`UiBridge`). The app posts the code to `/pair` through it and keeps the device token it gets back. A tunnel without a device token gets 401.
6. Each launch opens the tunnel again and gets a new port and forward token. When a tunnel stops answering, the app opens it again (`mobile/src/state.ts`, `mobile/src/liveness.ts`).
7. Removing a device or unpairing also removes that phone's key from the helper, so its tunnel stops too.

### Routes (TailPocket v0.3.2 and later; Boop ships v0.3.6)

There are three routes. Each is end-to-end encrypted between the phone and the computer:

- **Tailcat**: WireGuard between the phone and the computer over Tailcat's network, peer to peer or through Tailcat's DERP relays. Works from any network. The helper talks to `tailcat.dev` (relay list) and its relays (`docs/tracking.md`).
- **The local network** (`lan`): the helper listens on the computer's private addresses and accepts only a Noise handshake there, so a phone on the same Wi-Fi goes straight to the computer. Nothing leaves the network, and a phone away from it cannot use this route.
- **Your own tailpocket-relay** (`relay`), when the bot starts with both `DEEPSEEK_BOT_RELAY_URL` (`wss://…`) and `DEEPSEEK_BOT_RELAY_TOKEN`. The helper registers with it, and the phone's session through it is a Noise session end to end, pinned to the computer's key (TailPocket `docs/PROTOCOL.md`, "v2: routes"). The relay sees only ciphertext: not the device token, not the pairing code, not the phone's name. Setting only one of the two variables leaves the relay off, and the bot says so.

**On the computer**, `--routes` (or `"routes"` in `config.json`) says exactly which routes run: any of `tailcat`, `lan`, `relay`, comma-separated. `--routes all` goes back to the default. Without it the computer runs Tailcat and the local network, plus the relay when it is set, as in TailPocket v0.3.1.

| Start with | Phones come in over | What it costs |
|---|---|---|
| nothing (default) | Tailcat, the local network, your relay if set | Talks to `tailcat.dev` and its relays |
| `--routes lan` | the local network only | No Tailcat: nothing goes to `tailcat.dev` or DERP. A phone away from that network cannot connect. |
| `--routes relay` | your relay only | No Tailcat. Needs the relay variables. Everything goes through your relay. |
| `--routes lan,relay` | the local network, else your relay | No Tailcat. Needs the relay variables. |
| `--routes tailcat` | Tailcat only | No local network listener and no relay, as `--tailcat-only` |

The bot prints the routes it runs and what they cost when it starts (`[bot] TailPocket routes: …`) and saves the choice in `config.json` for the next start. A wrong set stops it before anything starts, with one sentence that says what to change (`src/pocket.ts` `checkRoutes`): an empty list, an unknown or repeated name, `relay` without the relay variables, or `routes` together with `--no-lan` or `--tailcat-only`, which it replaces. `--no-lan` and `--tailcat-only` keep working; whichever of them or `--routes` is on the command line replaces what was saved before. If the routes leave out `relay` while the relay variables are set, the relay is off and the bot says so.

Without Tailcat the helper starts no Tailcat node at all, and the pairing QR (an emoji window, `tailpocket2:`) lists only the routes that run. Pairing, the four emoji, the 6-digit code inside the encrypted session, removing a device and restarting work as with Tailcat (`test/pocket.e2e.test.ts`, "LAN only"). A computer without Tailcat forgets, at start, every phone it has no end-to-end key for: phones paired over Tailcat before v0.3 that never synced their key. The bot counts them when it starts ("… phone(s) … scan a new code with each"); each pairs again.

**On the phone**, Settings › Computer › Connection opens the routes this phone may use (`mobile/src/pages.tsx` `ConnectionPage`, TailPocket `setRoutes`):

- **All routes** (default): whatever the computer lists; works from anywhere.
- **Local network only**: never Tailcat or a relay; the phone starts no Tailcat client. Away from the computer's network it does not connect.
- **Relay only**: only your relay; works from anywhere if the computer has one, and every message goes through it.
- **Tailcat only**: never the relay or the local network; works from anywhere, and at home the way may be longer.

Each option says this on the page. A choice applies at once: the tunnel opens again, Status shows Reconnecting until the new way answers, and the line under it says which way it went. If the chosen route reaches nothing (the computer does not offer it, or the phone is away from home on Local network only), the page says so after a few seconds and suggests All routes. The choice is kept per phone (`pocketRoutes` in Storage) and set before every tunnel; the Tailcat-only switch of earlier versions becomes Tailcat only. Pairing works in every mode as long as the computer offers a route the phone allows; a phone set to All routes that scans the QR of a computer without Tailcat starts no Tailcat client either, because the QR lists none.

The phone tries the route that worked last first. Settings says which one it is using: directly or through a relay over Tailcat, through your relay (with its name), or straight over the local network.

Phones paired before v0.3 do not scan again. When the new app opens a saved link that has no computer key (`pk`), it calls TailPocket's `sync()` once over the Tailcat tunnel it already has. That gives it the computer's key and routes, and gives the computer the phone's end-to-end key (saved in `tailpocket.json` as `keys` and passed back to the helper on every start). A computer that is not on v0.3 yet does not answer, and the phone keeps using Tailcat without showing an error. When the computer removes the phone, TailPocket tells the app (`revoked`), and the app signs out just as it does when its token is refused.

Compatibility (TailPocket v0.3.0-pre.4 and later on the computer): an app from before pre.4 still connects over its saved link, but cannot pair with a new QR. Pairing needs the new app. Boop does not use TailPocket's same-Wi-Fi pairing without a camera (`pairing.local`), so its `local-too-many-attempts` (pre.5) and `ErrLocalUsed` (pre.6) never reach the person.

Over Tailcat the traffic between the phone and the computer is WireGuard. [TailPocket's README](https://github.com/jt-wang/tailpocket) says "Relays only see encrypted WireGuard packets", and its `docs/PROTOCOL.md` agrees: the phone makes its long-term key and sends the computer only the public half; the private key in the invite is a one-time key that reaches the pairing node and nothing else. Over the local network and your relay it is a Noise session pinned to the computer's key, which the phone learns from the QR; the four emoji come from that handshake. Both loopback hops are plain HTTP inside one device. Tailcat's default relays are free and rate-limited; TailPocket's `derpMapUrl` option points at others.

### When the phone cannot connect (TailPocket v0.3.4 and later)

After a request through the tunnel fails, the phone asks TailPocket why (`lastFailure()`) and Settings shows one of:

| TailPocket says | Settings shows |
|---|---|
| `refused`, `handshake-closed` | Boop is not running on the computer, or the computer was reset. A Pair again button appears. |
| `no-answer` | The computer is off or asleep, or this network blocks the connection. |
| `relay-down` | Your relay server cannot be reached. |

Status and that line come from the same state, and both clear as soon as the computer answers. TailPocket's dial may take
max(20 s, routes × 10 s) to fail; when the phone's own request gave up first, it reads the reason again after that.

The reason is not authenticated: a device on the same Wi-Fi can refuse the computer's address and make the phone show the
first line. So it only picks the words. The phone never unpairs, deletes the link or changes the computer's key because
of it. Pair again runs only when you tap it, asks you to scan only the code on your own computer's screen, and keeps the
old pairing until the new one has worked: a failed or cancelled pairing leaves everything as it was.

## Limits

- A removed phone keeps showing Reconnecting: once its key is gone nothing answers it.

- Local network only on the phone, or `--routes lan` on the computer, does not reach the computer from another network. The phone says so on the Connection page; nothing switches routes behind the person's back.

`test/pocket.e2e.test.ts` runs this path with TailPocket's test phone (`DEEPSEEK_BOT_POCKET_E2E=1`): over Tailcat, and with `--routes lan` and a phone limited to `lan`, where it watches every socket of the helper and the phone with `lsof` and checks that none leaves the local network, that neither uses UDP (Tailcat's WireGuard runs over UDP), and that no Tailcat state is written under a fresh HOME. A control run with Tailcat shows the same probe seeing the helper reach beyond the network. `ios/DeepSeekBotUITests/PocketTripTests.swift` runs it on the iOS simulator.

## All routes

| How it is set up | Address | Who can read the traffic | Source |
|---|---|---|---|
| Mac app, or `npm start` (any `--routes`) | `http://127.0.0.1:<port>` on the phone, through TailPocket | The phone and the computer. Tailcat relays carry only WireGuard packets; your own tailpocket-relay carries only Noise ciphertext; the local network sees only Noise ciphertext. Settings says "End-to-end encrypted". | `src/pocket.ts`, `src/main.ts` `pocketWanted`, `listenPlan`; above |
| Mac app, or `npm start`, without the TailPocket helper | nothing: the bot is on `127.0.0.1` | Nobody, because no phone can connect. The bot says to install the helper. | `src/pocket.ts` `listenPlan` |
| `npm start -- --host 0.0.0.0`, `--no-tailpocket` or a config host, chosen explicitly | `http://<LAN IP>:3850` | Anyone able to capture traffic on that network. Plain HTTP and plain WebSocket, the token included. The bot prints a warning saying so when it starts. | `src/main.ts` `lanOrigin`; the shells allow it: `android/app/src/main/AndroidManifest.xml` `usesCleartextTraffic`, `ios/DeepSeekBot/Info.plist` `NSAllowsArbitraryLoads` |
| `--tunnel cloudflared` | `https://*.trycloudflare.com` | Cloudflare. | `src/main.ts` `startTunnel` runs `cloudflared tunnel --url http://127.0.0.1:<port>`. [Tunnel](https://developers.cloudflare.com/tunnel/): "all traffic to your origins flows through Cloudflare — where CDN caching, WAF, Bot Management, and DDoS protection are applied". [HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/): Cloudflare "adds additional headers" to what reaches the origin. That it reads the traffic is drawn from these two pages. |
| Your own server, `deploy/` | `https://<your domain>` | The server. Caddy ends TLS and passes plain HTTP to the bot container. | `deploy/Caddyfile`: `{$DOMAIN} { reverse_proxy bot:3850 }`; `README.md` "On a server" |
| Hosted on Fly | `https://<app>.fly.dev/s/<id>` | Fly's proxy and the host. | Fly's [tls handler](https://docs.fly.io/networking/services) "terminates TLS" and "forwards a plaintext connection to the application process" (`fly.toml` `[http_service]`, `force_https`). `src/host/server.ts` `proxyHttp` then forwards plain HTTP and WebSocket to the sandbox over the [6PN](https://docs.fly.io/networking/private-networking) (`src/sandbox/fly.ts`), "a mesh of WireGuard tunnels". |

A VPN under a plain `http://` address would encrypt it without the phone knowing; the phone says what the address says.
