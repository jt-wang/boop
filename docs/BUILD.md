# Build Boop yourself

To use Boop you need none of this: the [README](../README.md#try-it) installs from the release files. Build it to change the code, to run it on a server behind HTTPS, or to get the iPhone app.

## The server

macOS or Linux, Node.js 24+, and Go for TailPocket's helper:

```sh
git clone https://github.com/jt-wang/boop.git
cd boop
npm install
git clone --depth 1 https://github.com/jt-wang/tailpocket.git .tailpocket
TAILPOCKET_DIR="$PWD/.tailpocket" scripts/tailpocket-sync.sh helper
DEEPSEEK_API_KEY=sk-… npm start
```

Without the helper it prints `http://<lan-ip>:3850/pair?code=123456` instead: plain HTTP, same Wi-Fi only.

## The apps

The phone shells and the Mac app also need a TailPocket checkout beside this repository: `git clone https://github.com/jt-wang/tailpocket ../tailpocket`.

- iPhone: [ios.md](ios.md). There is no download yet, so this is the only way to get it.
- Android: [android.md](android.md).
- Mac: [mac.md](mac.md).

## On a server

With Docker, from the clone:

```sh
cd deploy && DOMAIN=bot.example.com DEEPSEEK_API_KEY=sk-… docker compose up -d
docker compose logs bot | grep pair     # the pairing link, now over HTTPS
```

Caddy gets the certificate; the phone pairs at `https://bot.example.com/pair?code=…`. Data lives in the `bot-data` volume. The image has no browser; the assistant installs one when it first needs it.

[Three commands on Fly.io](hosting.md#on-flyio-in-one-command) give every person their own microVM; from a clean clone `fly launch` took 11 s and `fly deploy` 58 s. Hosting for several people is in [hosting.md](hosting.md).

## Make the release files

```sh
scripts/android-build.sh                     # android/build/boop.apk
scripts/mac-build.sh                         # mac/.nsh/out/Boop.dmg
scripts/release-pack.sh <tree> <out dir>     # boop-<os>-<arch>.tgz; needs TailPocket's helpers from its scripts/build-host.sh
```

## Tests

```sh
npm test                 # unit + protocol tests, two of them against a real dsh; no model needed
npm run test:e2e         # real model through the whole stack (needs an OpenAI-compatible endpoint)
cd mobile && nsh test    # the app, headless
scripts/build-web.sh     # after changing mobile/: rebuild the browser build in app/ (npm test fails while it is stale)
```
