# The iOS app

The phone app in `mobile/` runs inside a small native shell (`ios/`) so it can be installed from TestFlight and receive real push notifications. The shell is one full-screen view running the app; everything else (pairing, chat, settings) is the same TSX app the web and the dev host run.

What the shell adds:

- **Notifications.** After pairing, the app asks for permission, gets the device's APNs token and sends it to the bot (`POST /push/subscribe` with `{ kind: "apns", token }`). The bot then pushes approvals, questions, reminders and finished work to the phone through Apple, the same way it does Web Push for browsers. Tapping a notification opens the app at the place it points to.
- **A link to pair.** `deepseekbot://pair?invite=<a TailPocket code>`, `deepseekbot://pair?url=<the pairing link>` (or `?origin=http://host:3850&code=123456`) opens the app with the address and code filled in.
- **Interfaces the assistant writes.** When the assistant builds a module with its `ui` tool, the thread shows a card with Open. The shell downloads the signed `.nshpkg` from the bot with the device token, verifies it against the bot's root key (`GET /me` → `uiRootPublicKey`; one `NshTrust` store per bot under Application Support, so a package signed by another bot is refused) and runs it in a sheet: a second `NshAppView` with its own VM and limits, a title bar and Done. The module reads `{ token, origin, moduleId }` from `host.call('launch.params')` (also set as `host.params`), posts its result to the bot itself and asks the shell to `ui.close`.

## Build it for your own iPhone

Using a coding agent? Tell it: follow "Build it for your own iPhone" in `docs/ios.md`.

Needs a Mac with Xcode and Go, the [`nsh` CLI](https://nsh.dev/docs/installation) 0.4 (the scripts stop on any other version), and your Apple Account added in Xcode → Settings → Accounts. Measured 2026-11-05 from a clean checkout with public TailPocket and stock `nsh` 0.4.0: the app compiles and signs with a paid team. A new bundle id, and the setting without entitlements, were measured the same day with `nsh` 0.3.0. A free account and an install on a physical iPhone have not been tried yet; so far the app has run only on the simulator.

1. Get both repositories, side by side:

```sh
git clone https://github.com/jt-wang/boop
git clone https://github.com/jt-wang/tailpocket
cd boop
cp ios/Config/Signing.local.xcconfig.example ios/Config/Signing.local.xcconfig
```

2. In `ios/Config/Signing.local.xcconfig` set `DEVELOPMENT_TEAM` to your Team ID and `BOOP_BUNDLE_ID` to an id of your own. With a free account, also remove the slashes before `BOOP_ENTITLEMENTS =`: the build then has no notifications or universal links, and [Apple's limits](https://developer.apple.com/support/compare-memberships/) apply (the app stops opening after 7 days until you build again, 3 apps per device).
3. On the iPhone turn on Developer Mode (Settings → Privacy & Security → Developer Mode, then restart), connect it with a cable and tap Trust.
4. Build and install. The device id comes from `xcrun devicectl list devices`.

```sh
scripts/tailpocket-sync.sh ios
scripts/ios-build.sh device <device id>
```

5. If iOS will not open the app, trust your developer profile under Settings → General → VPN & Device Management.
6. Pair: open Boop on your computer, then tap Scan the code in the app. No computer yet? Tap "Try a demo, no computer needed" to see the app in demo mode, on made-up data.

For notifications on your own build you need a paid Apple Developer Program team and an APNs key on your computer ([below](#2-tell-the-bot-about-apns)).

## Build and run on the simulator

Needs Xcode, the `nsh` 0.4 CLI with the NSH distribution it installs, and `xcodegen` (`brew install xcodegen`, only when you change `ios/project.yml`).

```sh
scripts/ios-build.sh simulator
xcrun simctl install booted ios/build/sim/DeepSeekBot.app
xcrun simctl launch booted io.jingtao.boop
```

The simulator build is arm64 only: NSH's `embed/ios/NativeShell.xcframework` has no x86_64 simulator slice (nsh 0.4.0, its `Info.plist`, 2026-11-05), and a generic simulator build fails with `Unable to resolve module dependency: 'NativeShell'` (measured 2026-10-27 on 0.3.0).

`scripts/ios-bundle.sh` (called by the build) runs `nsh build mobile --release` into `ios/DeepSeekBot/nsh/` and links `embed/ios/NativeShell.xcframework`, from the same install as the CLI, into `ios/Frameworks/`. Both are ignored by git; run it again after changing anything in `mobile/`.

`ios/DeepSeekBotUITests/GenerativeUITests.swift` drives the whole second layer against a real bot: `xcodebuild … -only-testing:DeepSeekBotUITests/GenerativeUITests TEST_RUNNER_BOT=http://127.0.0.1:3887 TEST_RUNNER_PAIR_CODE=<the six digits> TEST_RUNNER_HOST_SECRET=<the bot's DEEPSEEK_BOT_HOST_SECRET> TEST_RUNNER_SHOTS=<a directory> test` (exported as environment variables, not passed as arguments) pairs from the link, asks for a tip calculator, taps Open, screenshots the sheet in light and dark into `SHOTS`, uses the module and checks the thread shows "Answered: …".

The UI test (`ios/DeepSeekBotUITests`) drives the shell against a stand-in bot on the Mac: opens the pair link, taps Connect, allows notifications and checks that the token reached the bot. Run it with `xcodebuild -project ios/DeepSeekBot.xcodeproj -scheme DeepSeekBot -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test` with a server answering `POST /pair`, `GET /me`, `POST /push/subscribe` and `GET /subscriptions` on `http://127.0.0.1:3861` (the test's `BOT` environment variable changes the address).

## wss needs NSH 0.4

A computer you reach at an `https://` address is only reachable over `wss://`. NSH 0.3.0 could not open it on iOS or Android (rustls with no crypto provider); the app signed in, then stayed "Not connected" with an empty thread. NSH 0.4.0 contains the fix (longbridge/nsh#530).

The probe opens both NSH socket APIs, the global `WebSocket` and the `websocket` module: `nsh test --target ios scripts/qa/wss-probe`, or `--target android`. Measured 2026-11-05 on the iPhone 17 Pro simulator and on an Android 15 arm64 emulator, the same on both:

| Target | Stock 0.4.0 | Stock 0.3.0 |
|---|---|---|
| `wss://echo.websocket.org` | echo, both APIs | never opens: the test does not end in 30 s, exit 1 |
| `wss://self-signed.badssl.com` | error: invalid peer certificate: UnknownIssuer, both APIs | the run had already failed |

A package signed by `nsh` 0.3 opens in a phone app on 0.4 (measured on both phones, 2026-11-05). The other way round the phone refuses it: "the package needs runtime 0.4.0 or newer".

The framework has to come from the same version as the `nsh` CLI: with a framework from another NSH version, the typed email and access code never reached the sign-in fields (2026-10-29, one run). The build scripts take both from one install and stop on a version other than 0.4.

## Ship through TestFlight

Everything below needs your Apple Developer account. Copy `ios/Config/Signing.local.xcconfig.example` to `ios/Config/Signing.local.xcconfig` and set your team and bundle id there; that file is not committed. Where this section says `io.jingtao.boop`, use your own id.

### 1. Once: the app record and keys

1. **App ID with push.** [developer.apple.com → Identifiers](https://developer.apple.com/account/resources/identifiers/list) → `+` → App IDs → bundle id `io.jingtao.boop`, tick **Push Notifications**. (With automatic signing, Xcode registers the App ID itself; the Push capability has to be ticked here either way.)
2. **The app record.** [App Store Connect → Apps](https://appstoreconnect.apple.com/apps) → `+` → New App → platform iOS, bundle id `io.jingtao.boop`, any SKU. TestFlight needs nothing more than this record.
3. **An APNs key** (lets the bot send notifications). [Identifiers → Keys](https://developer.apple.com/account/resources/authkeys/list) → `+` → tick **Apple Push Notifications service (APNs)** → download `AuthKey_<KEY ID>.p8` (downloadable once; keep it). Note the **Key ID** (10 characters) and your **Team ID** (top right of the developer site).
4. **An App Store Connect API key** (lets `xcodebuild` and the upload run without an Apple ID password). [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api) → Team Keys → `+`, role **App Manager**. Download `AuthKey_<KEY ID>.p8`; note the **Key ID** and the **Issuer ID** shown above the list. (Alternative: your Apple ID plus an [app-specific password](https://appleid.apple.com/account/manage); `scripts/ios-upload.sh` takes either.)

Keep both `.p8` files outside the repository, for example in `~/.deepseek-bot/keys/`, readable by you only (`chmod 600`).

### 2. Tell the bot about APNs

In `~/.deepseek-bot/config.json`, add:

```json
"apns": {
  "keyId": "ABC123DEFG",
  "teamId": "ABCDE12345",
  "keyPath": "/Users/you/.deepseek-bot/keys/AuthKey_ABC123DEFG.p8",
  "bundleId": "io.jingtao.boop",
  "sandbox": false
}
```

`sandbox: true` only for builds installed straight from Xcode onto a device. TestFlight and App Store builds use production (`false`). The bot reads the key file at start and logs `APNs on (production)`; it never logs or stores the key's contents. An iPhone that registers before this section exists is remembered and gets notifications once the section is added and the bot restarted.

### 3. Archive, export, upload

```sh
export ASC_KEY_ID=ABC123DEFG ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx ASC_KEY_PATH=~/.deepseek-bot/keys/AuthKey_ABC123DEFG.p8
scripts/ios-build.sh archive     # nsh build → xcodebuild archive → ios/build/export/DeepSeekBot.ipa
scripts/ios-upload.sh            # validates, then uploads to App Store Connect
```

With the API key, `xcodebuild` creates the App Store provisioning profile for `io.jingtao.boop` itself (`-allowProvisioningUpdates`; measured with Xcode 27.0 on 2026-11-05: archive and export both succeeded with a team key). `scripts/ios-build.sh archive` also overwrites this Mac's home folder and NSH checkout inside the app binary, the same way the Android build does, before the export signs it. The export leaves symbols out (`uploadSymbols` is false in `ios/ExportOptions.plist`) because they name folders on this Mac, so crash reports symbolicate from `ios/build/DeepSeekBot.xcarchive`, which the next archive replaces. The upload needs the app record from step 1: App Store Connect's API answers `The resource 'apps' does not allow 'CREATE'`, and `altool` stops with `Unable to find Apple ID for Bundle ID` until the record exists. Without it, sign in to Xcode once with the Apple ID of the team (Xcode → Settings → Accounts) and run the same commands without the `ASC_*` variables.

After the upload, App Store Connect processes the build (5–15 minutes), then [TestFlight](https://appstoreconnect.apple.com/apps) → the app → TestFlight → add yourself as an internal tester, install TestFlight on the phone, install the app from it.

For every later upload, raise `CURRENT_PROJECT_VERSION` in `ios/project.yml` (the build number must grow) and run `xcodegen generate` in `ios/`.

### 4. First run on the phone

In the app tap Scan the code and point it at the QR the bot prints (on a simulator, paste the printed `tailpocket1:…` line into the connect screen, or open `deepseekbot://pair?invite=<it>`), allow notifications when asked, then ask the assistant for something that needs a yes: the notification arrives even with the app closed.

The toggle in Settings (Notifications) turns this off and on again for the phone; off calls `POST /push/unsubscribe`, which forgets the phone's web and APNs subscriptions.

## How it fits together

| Part | File | Does |
|---|---|---|
| Shell | `ios/DeepSeekBot/RootViewController.swift` | One `NshAppView` running `nsh/bundle.nshc`, edge to edge |
| Push bridge | `ios/DeepSeekBot/PushBridge.swift` | Answers the app's `push.request` and `push.token`; sends `notification { url }` on a tap (a tap that launched the app: `host.params.notificationUrl`) and `appState` when the app goes to the background (docs/push.md) |
| UI bridge | `ios/DeepSeekBot/UiBridge.swift` | Answers `ui.open { url, auth, token, title, rootKey, origin, moduleId }`: downloads, verifies (`NshTrust`) and runs the module in a sheet; the sheet answers the module's `launch.params` and `ui.close` |
| Links | `ios/DeepSeekBot/SceneDelegate.swift`, `PairLink.swift` | `deepseekbot://pair…` → `host.params.pairUrl` at launch, `pair { url }` event while running |
| App side | `mobile/src/native.ts` | Permission → token → `POST /push/subscribe`; `host.on("notification")`, `host.on("pair")` |
| Bot | `src/push-apns.ts`, `src/push.ts` | HTTP/2 to APNs with a JWT from the `.p8`; one token per paired phone; 410 drops the token |

The notification payload is `{ aps: { alert: { title, body }, sound, thread-id }, url }`, with `apns-collapse-id` set to the same tag Web Push uses, so repeated "finished" notifications collapse.

## Hosted accounts

The App Store build can offer "Start" (a hosted computer) as well as "I have my own computer". Set `DEEPSEEK_BOT_HOST_URL` in `ios/project.yml` (or the `DeepSeekBotHostURL` key in Info.plist) to the host's public URL (see `docs/hosting.md`); the app reads it as `host.params.hostUrl`. Leave it empty for a self-hosting-only build.
