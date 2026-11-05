# Run a host for other people

People who install the app should not have to own a server. A host gives each account its own assistant computer — a container with the bot and DeepSeek Harness, a persistent `/data` volume for its memory, files and browser logins — and forwards the phone's requests to it. The container is stopped when nobody talks to it and started again on the next message or when a reminder is due. The code is the same one that runs on your own Mac; the host only adds accounts, a proxy and a notification relay.

## What you need

- A Linux machine with Docker (anything that runs one container per user; measured 2026-10-27: a fresh sandbox is ready 2 s after the request and uses about 300 MB of memory while idle).
- A domain pointing at it. Caddy in the compose file gets the certificate.
- A DeepSeek API key, or any OpenAI-compatible gateway (`--model provider/model --base-url … --api-key-env NAME`). Every sandbox is handed the same key; metering per account is yours to add.
- Only if you publish the iOS app: Apple's APNs key for your app, and the app's bundle id for Sign in with Apple. Without it the host still works; sandboxes just cannot notify iPhones. Web clients get Web Push from their sandbox directly.

## The one command

```sh
git clone https://github.com/jt-wang/boop.git && cd boop
docker build -t deepseek-bot:slim .                                   # the sandbox image, 686 MB on amd64 (2026-10-29)
docker build -t deepseek-bot:host -f deploy/host.Dockerfile .          # + the Docker CLI
cd deploy && DOMAIN=host.example.com DEEPSEEK_API_KEY=sk-… docker compose -f host.compose.yml up -d
```

Check it: `curl https://host.example.com/host/health` → `{"ok":true,"provider":"docker","accounts":0}`.

Then open `https://host.example.com/` on a phone: the host serves the app itself (its browser build, the same one the iOS shell runs), and **Start** signs in, brings the account's computer up and drops into the chat — measured 2026-10-27 on a laptop: computer ready 2.3 s after sign-in, first words from the assistant 8.7 s. For the iOS build, set `DEEPSEEK_BOT_HOST_URL` in `ios/project.yml` to this address.

The compose file starts with `--dev-sign-in`, which lets any email sign in without verification, so you can try the flow in the browser or with curl:

```sh
H=https://host.example.com
ACCT=$(curl -s -X POST $H/host/sign-in -H 'content-type: application/json' -d '{"email":"you@example.com"}' | jq -r .accountToken)
curl -s -X POST $H/host/sandbox -H "authorization: Bearer $ACCT"
# → {"state":"ready","origin":"https://host.example.com/s/<id>","token":"<device token>","sandboxId":"<id>"}
```

`origin` and `token` are exactly what the app uses for a self-hosted bot; from here on nothing differs: the device token as `authorization: Bearer` is enough at the host's gate (the app sends nothing else), WebSockets carry the bot's one-time `?ticket=`. Scripts can also send `x-account: $ACCT` (or `?account=` on WebSockets).

Before real users: remove `--dev-sign-in` and add `--apple-bundle-id <your bundle id>`; the app then signs in with `{apple: identityToken}`. Put your APNs key under the `host-data` volume and `{"apns": {"keyId", "teamId", "keyPath", "bundleId"}}` in its `config.json` (same shape as [docs/ios.md](ios.md)).

## What the host does, step by step

1. `POST /host/sign-in` → an account token (stored hashed in `accounts.json`).
2. `POST /host/sandbox` → `docker run -d --name dsb-<id> -v dsb-<id>-data:/data … deepseek-bot:slim`, waits for the bot's `/health` to report its harness, pairs two devices through `POST /pair {hostSecret}` (one for the phone, one for the host itself), answers `ready`.
3. `/s/<id>/*` → forwarded to that container, HTTP and WebSocket. The host checks the account owns `<id>`; the bot inside checks the device token as always.
4. No request and no open WebSocket for `--idle-minutes` (default 30) → the host reads the sandbox's `GET /schedules`, stops the container, and remembers the earliest reminder. A request starts it again (measured: 1.4 s until the bot answers). A reminder starts it a minute early; the bot's scheduler then fires what is due.
5. A sandbox's bot sends notifications to `POST /host/push` with the shared host secret; the host sends them to Apple with its key.

The host needs the Docker socket. Whoever can run commands as the host can run any container on that machine, so give the host its own machine and keep `host-data` (account records, sandbox tokens, host secret) to yourself.

## Rotate an account's tokens

`accounts.json` keeps two device tokens per account in plain text: the phone's and the host's own. If either one leaks, run this on the host machine. It pairs a new host and phone device on the account's computer, saves them, revokes the old two on the bot (other devices the person paired stay), and closes the WebSockets open through the host. It refuses a computer that is not ready and starts a stopped one first. It prints no token.

```sh
node src/host-main.ts rotate --email you@example.com      # or --account <id>; --home <dir> if not the default
# on Fly, against the host machine:
fly ssh console -a <your app> -g host -C "node /opt/deepseek-bot/src/host-main.ts rotate --home /host-data --email you@example.com"
```

It calls the running host's `POST /host/admin/rotate-tokens {account} | {email}` on `127.0.0.1:3860` (`--port` or `--url` to change) with the admin token from `DEEPSEEK_BOT_HOST_ADMIN_TOKEN` or `<home>/admin-token`. Afterwards the old phone token gets 401 from the host. The app treats that as unpaired: on its next launch it drops the saved pairing and shows the start screen, and signing in again hands it the new token. An app that stays open keeps trying to reconnect until it is relaunched.

## Browser inside a sandbox

The image ships without Chromium (it is 450 MB with fonts). When an assistant first needs its browser it calls its `install_browser` tool; the bot runs `scripts/install-browser.sh` (the assistant's own shell is sandboxed and cannot install system packages), installs Chromium, starts the browser and adds its tools while that call waits, so the turn that asked for it goes on to use it (`test/browser-mount.e2e.test.ts`); the browser profile lives in `/data` and survives stops. One install runs at a time: a call waits for the install, up to about 4 minutes (the bot gives its own tools 5, `BOT_TOOL_TIMEOUT_MS` in `src/home.ts`; the harness's default is 60 s), and says which step the install is on if it is still going, and the next call waits for the same install instead of starting a second apt-get (`src/browser-install.ts`; the script also holds a file lock and lets apt wait for dpkg's). Guarded by `test/browser-install.test.ts` and `test/image-tools.e2e.test.ts`.

## On Fly.io, in one command

Three commands give you a host where each person's assistant is its own Firecracker microVM: a new account has its computer 1.4 s after sign-in, an idle one is suspended and comes back in about a second, and you pay for volumes while they sleep. Measured on 2026-10-27 (`test/sandbox-fly.e2e.test.ts`).

```sh
git clone https://github.com/jt-wang/boop.git && cd boop
fly launch --copy-config --yes --name <your app> --region <region>   # reads fly.toml: one app for the host and every sandbox
fly secrets set FLY_API_TOKEN="$(fly tokens create deploy -a <your app>)" DEEPSEEK_API_KEY=sk-… -a <your app>
fly deploy --image-label slim -a <your app>                      # builds the image on Fly (163 MB compressed), starts the host
```

From a clean clone this took 11 s for `fly launch` and 58 s for `fly deploy`. `fly launch` writes your app name into `fly.toml`; commit it.

Check it: `curl https://<your app>.fly.dev/host/health` → `{"ok":true,"provider":"fly","accounts":0}`. If the name does not resolve, `fly ips allocate-v4 --shared -a <your app>` and `fly ips allocate-v6 -a <your app>` (`fly launch` does this; `fly apps create` does not).

What `fly.toml` sets up: the host runs as process group `host` on a 512 MB machine with a `host_data` volume; every sandbox is a machine the host creates in the same app through the Machines API, from the same image (`FLY_IMAGE_REF`), with a 1 GB volume at `/data`; sandboxes reach the host at `host.process.<app>.internal`. One `fly deploy` updates the host now and sandboxes at their next create. Before real users: replace `--dev-sign-in` in `[processes]` with `--apple-bundle-id <id>`, and put the APNs key on the `host_data` volume.

## On a Mac with Apple's `container`

`--provider apple-container --port-range 3890-3899` uses Apple's container CLI (macOS 26+, Apple silicon). Not run yet.

## Safety guard

The bot ships with a server-side outbound guard, on by default. It checks every
request the bot itself makes on a person's behalf, before the real model key or
a connector token is added:

- loopback, RFC 1918, link-local, IPv6 unique-local, multicast, documentation
  and cloud-metadata addresses are refused (`169.254.169.254`,
  `metadata.google.internal`, Fly's `fdaa::/16` included);
- a public hostname that resolves to one of them is refused, not just an IP
  literal;
- a hosted account cannot change the model provider or base URL: the host pays
  for the key, so `PUT /model` is 403 unless the operator opts in; and
- web-push endpoints must be `https` and public, and are checked again before
  every send; and
- in a hosted sandbox a new thread's `cwd` and project folder must resolve
  inside the workspace, so the agent cannot point its file tools at DSH's own
  home or the bot's data.

The agent's own shell and browser go through the cell proxy (`src/egress.ts`). It applies the same rules and the same `isBlockedAddress`
function as this guard: one destination policy, two enforcement points, no
second proxy. The proxy also pins the validated address and allows only the
cell's own loopback service ports even for an allow-listed host.

A self-hoster can change the policy without editing code:

```
DEEPSEEK_BOT_GUARD=off                 # turn every check off (accept the risk)
DEEPSEEK_BOT_GUARD_ALLOW=ollama.lan,*.home.arpa   # allow these hosts, even on a LAN
DEEPSEEK_BOT_GUARD_ALLOW_PRIVATE=1     # allow every private destination
DEEPSEEK_BOT_GUARD_ONLY=api.deepseek.com          # strict allowlist (bot and cell)
DEEPSEEK_BOT_EGRESS_RATE=600            # per-cell requests/minute (default 3000)
DEEPSEEK_BOT_ALLOW_MODEL_CHANGE=1      # hosted: let the app change the model
```

A local model gateway passed with `--base-url` is trusted as operator
configuration. A gateway stored from the app is refused unless its host is in
`DEEPSEEK_BOT_GUARD_ALLOW` (or `DEEPSEEK_BOT_GUARD_ALLOW_PRIVATE=1` is set).
The host passes the same variables to every sandbox when they are set in the
host's environment. Docker sandboxes get the narrow set described under
`--docker-seccomp` below (no `--privileged`). Fly's microVM is the stronger boundary.

## Flags

```
--home <dir>              host state (default ~/.deepseek-bot-host): accounts.json, host-secret, config.json
--port 3860 --host        bind address;  --public-url  where phones reach the host
--provider docker|fly|apple-container   --image <ref> (fly: defaults to the host's own image)
--docker-seccomp <path>   docker provider: host path to deploy/seccomp-bwrap.json; the provider adds SYS_ADMIN/NET_ADMIN, the loop-control device and the loop block range (no --privileged) and the sandbox fails closed without the profile
--warm N                  sandboxes built ahead and suspended; sign-in hands one over (fly.toml: 1); after a deploy, warm ones from the previous image are removed and rebuilt
--port-range 3890-3896    host ports for sandboxes (docker default: ephemeral);  --docker-network <name>  address sandboxes by name instead
--relay-url <url>         how sandboxes reach this host (default: host.docker.internal, or the host's hostname on --docker-network)
--idle-minutes 30 --sweep-seconds 15
--dev-sign-in | --apple-bundle-id <id>
--apple-app-id <TeamID>.<bundle id>   or DEEPSEEK_BOT_APPLE_APP_ID: universal links for /open/*; unset, Apple's association file answers 404
--model provider/model --base-url … --api-key-env NAME   passed to every sandbox
DEEPSEEK_BOT_HOST_SECRET  shared with sandboxes; generated into <home>/host-secret when absent
```
