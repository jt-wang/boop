# How the phone reaches the computer

Settings' Computer section says this to you (`mobile/src/route.ts`). It is worked out from the address the phone uses.

## Local use: what happens, step by step

Local means the Mac app or `npm start` on your own computer. Your own server and Fly keep HTTPS (the table below).

1. The bot listens on `127.0.0.1` only and starts TailPocket's helper (`vendor/tailpocket/bin/tailpocket-host-*`, `src/pocket.ts`), which forwards each paired phone's connection to that port.
2. The bot opens a pairing window of up to 15 minutes with its own 6-digit code as the payload, and shows the invite as a QR (`tailpocket1:…`, terminal and Mac window, also `pairing.txt`, mode 0600).
3. In the phone app the person taps Scan the code. The native bridge (`TailPocketNSH` on iOS, `tailpocket-nsh` on Android) joins the computer's Tailcat network, directly when the two networks allow it and through a relay otherwise, and receives the 6-digit code inside the tunnel.
4. The bridge gives the app `http://127.0.0.1:<random port>` on the phone. The app posts the code to `/pair` through it and keeps the device token it gets back. A tunnel without a token gets 401.
5. Each launch opens the tunnel again and gets a new port. When a tunnel stops answering, the app opens it again (`mobile/src/state.ts`, `mobile/src/liveness.ts`).
6. Removing a device or unpairing also removes that phone's key from the helper, so its tunnel stops too.

Between the phone and the computer the traffic is WireGuard. [TailPocket's README](https://github.com/jt-wang/tailpocket) says "Relays only see encrypted WireGuard packets", and its `docs/PROTOCOL.md` agrees: the phone makes its long-term key and sends the computer only the public half; the private key in the invite is a one-time key that reaches the pairing node and nothing else. Both loopback hops are plain HTTP inside one device. Tailcat's default relays are free and rate-limited; TailPocket's `derpMapUrl` option points at others.

The helper connects to `tailcat.dev` for the relay list and to a relay (`docs/tracking.md`).

## Limits

- Settings says "Through TailPocket to your computer"; it does not say whether the path is direct or through a relay yet.
- A removed phone keeps showing Reconnecting: once its key is gone nothing answers it.

`test/pocket.e2e.test.ts` runs this path with TailPocket's test phone; `ios/DeepSeekBotUITests/PocketTripTests.swift` runs it on the iOS simulator.

## All routes

| How it is set up | Address | Who can read the traffic | Source |
|---|---|---|---|
| Mac app, or `npm start` | `http://127.0.0.1:<port>` on the phone, through TailPocket | The phone and the computer. Relays carry only WireGuard packets. Settings says "End-to-end encrypted". | `src/pocket.ts`, `src/main.ts` `pocketWanted`; above |
| `npm start -- --host 0.0.0.0`, `--no-tailpocket` or a config host, a browser, or no helper installed | `http://<LAN IP>:3850` | Anyone able to capture traffic on that network. Plain HTTP and plain WebSocket, the token included. | `src/main.ts` `lanOrigin`; the shells allow it: `android/app/src/main/AndroidManifest.xml` `usesCleartextTraffic`, `ios/DeepSeekBot/Info.plist` `NSAllowsArbitraryLoads` |
| `--tunnel cloudflared` | `https://*.trycloudflare.com` | Cloudflare. | `src/main.ts` `startTunnel` runs `cloudflared tunnel --url http://127.0.0.1:<port>`. [Tunnel](https://developers.cloudflare.com/tunnel/): "all traffic to your origins flows through Cloudflare — where CDN caching, WAF, Bot Management, and DDoS protection are applied". [HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/): Cloudflare "adds additional headers" to what reaches the origin. That it reads the traffic is drawn from these two pages. |
| Your own server, `deploy/` | `https://<your domain>` | The server. Caddy ends TLS and passes plain HTTP to the bot container. | `deploy/Caddyfile`: `{$DOMAIN} { reverse_proxy bot:3850 }`; `README.md` "On a server" |
| Hosted on Fly | `https://<app>.fly.dev/s/<id>` | Fly's proxy and the host. | Fly's [tls handler](https://docs.fly.io/networking/services) "terminates TLS" and "forwards a plaintext connection to the application process" (`fly.toml` `[http_service]`, `force_https`). `src/host/server.ts` `proxyHttp` then forwards plain HTTP and WebSocket to the sandbox over the [6PN](https://docs.fly.io/networking/private-networking) (`src/sandbox/fly.ts`), "a mesh of WireGuard tunnels". |

A VPN under a plain `http://` address would encrypt it without the phone knowing; the phone says what the address says.
