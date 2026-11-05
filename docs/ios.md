# The iOS app

The phone app in `mobile/` runs inside a small native shell (`ios/`) so it can be installed from TestFlight and receive real push notifications. The shell is one full-screen view running the app; everything else (pairing, chat, settings) is the same TSX app the web and the dev host run.

What the shell adds:

- **Notifications.** After pairing, the app asks for permission, gets the device's APNs token and sends it to the bot (`POST /push/subscribe` with `{ kind: "apns", token }`). The bot then pushes approvals, questions, reminders and finished work to the phone through Apple, the same way it does Web Push for browsers. Tapping a notification opens the app at the place it points to.
- **A link to pair.** `deepseekbot://pair?invite=<a TailPocket code>`, `deepseekbot://pair?url=<the pairing link>` (or `?origin=http://host:3850&code=123456`) opens the app with the address and code filled in.
- **Interfaces the assistant writes.** When the assistant builds a module with its `ui` tool, the thread shows a card with Open. The shell downloads the signed `.nshpkg` from the bot with the device token, verifies it against the bot's root key (`GET /me` → `uiRootPublicKey`; one `NshTrust` store per bot under Application Support, so a package signed by another bot is refused) and runs it in a sheet: a second `NshAppView` with its own VM and limits, a title bar and Done. The module reads `{ token, origin, moduleId }` from `host.call('launch.params')` (also set as `host.params`), posts its result to the bot itself and asks the shell to `ui.close`.

## Build and run on the simulator

Needs Xcode, the `nsh` CLI and the NSH distribution (`~/.nsh`, which `nsh` installs) and `xcodegen` (`brew install xcodegen`, only when you change `ios/project.yml`).

```sh
scripts/ios-build.sh simulator
xcrun simctl install booted ios/build/sim/DeepSeekBot.app
xcrun simctl launch booted io.jingtao.boop
```

The simulator build is arm64 only: `~/.nsh/embed/ios/NativeShell.xcframework` (nsh 0.3.0) has no x86_64 simulator slice, and a generic simulator build fails with `Unable to resolve module dependency: 'NativeShell'` (measured 2026-10-27).

`scripts/ios-bundle.sh` (called by the build) runs `nsh build mobile --release` into `ios/DeepSeekBot/nsh/` and links `~/.nsh/embed/ios/NativeShell.xcframework` into `ios/Frameworks/`. Both are ignored by git; run it again after changing anything in `mobile/`.

`ios/DeepSeekBotUITests/GenerativeUITests.swift` drives the whole second layer against a real bot: `xcodebuild … -only-testing:DeepSeekBotUITests/GenerativeUITests TEST_RUNNER_BOT=http://127.0.0.1:3887 TEST_RUNNER_PAIR_CODE=<the six digits> TEST_RUNNER_HOST_SECRET=<the bot's DEEPSEEK_BOT_HOST_SECRET> TEST_RUNNER_SHOTS=<a directory> test` (exported as environment variables, not passed as arguments) pairs from the link, asks for a tip calculator, taps Open, screenshots the sheet in light and dark into `SHOTS`, uses the module and checks the thread shows "Answered: …".

The UI test (`ios/DeepSeekBotUITests`) drives the shell against a stand-in bot on the Mac: opens the pair link, taps Connect, allows notifications and checks that the token reached the bot. Run it with `xcodebuild -project ios/DeepSeekBot.xcodeproj -scheme DeepSeekBot -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test` with a server answering `POST /pair`, `GET /me`, `POST /push/subscribe` and `GET /subscriptions` on `http://127.0.0.1:3861` (the test's `BOT` environment variable changes the address).

## NSH 0.3.0 cannot open wss (fixed with a patched framework)

NSH 0.3.0's iOS framework and runtimes have the same TLS gap as its Android library (docs/android.md, "NSH 0.3.0 cannot open wss"): rustls 0.23 with no crypto provider. A hosted computer is only reachable over `wss://`, so the app signs in, then stays 「Not connected」 with an empty thread and sends nothing. Upstream fixed it in nsh-core (longbridge/nsh#530, merge 464e7be3, 2026-10-27); no release has it yet.

Measured 2026-10-29 on the iPhone 17 Pro Max simulator (iOS 26.3) with a probe app run by `nsh test --target ios`, one socket per launch, both NSH socket APIs (the global `WebSocket` and the `websocket` module):

| Target | Stock 0.3.0 | 0.3.0 + #530 |
|---|---|---|
| `ws://127.0.0.1` (an echo server on the Mac) | echo | echo |
| `wss://127.0.0.1:3972` (nothing listening) | error: connection refused | error: connection refused |
| `wss://self-signed.badssl.com` | module: rejects with "Could not automatically determine the process-level CryptoProvider"; global: no open, error or close in 20 s, and the JS thread stops (a 1 s timer never fires) | error: invalid peer certificate: UnknownIssuer |
| `wss://echo.websocket.org` | the same as the line above | echo |

The patched framework is v0.3.0 with #530 cherry-picked. A framework built from NSH main (a1397055) also opens `wss://` in the probe, but in the app bundled by nsh 0.3.0 the typed email and access code never reached the sign-in fields (one run), so the framework has to come from the same version as the `nsh` CLI. To build and install it, in an NSH checkout:

```sh
git switch -c v030-ios-wss 76fa8a7f
git cherry-pick -x 464e7be3          # Cargo.lock conflicts: git checkout --ours Cargo.lock && git add Cargo.lock && git cherry-pick --continue
cargo build --release -p nsh-ios-host -p nsh-ios-app --target aarch64-apple-ios-sim
cargo build --release -p nsh-ios-app --target aarch64-apple-ios
cargo xtask ios-embed --no-catalyst --no-dev   # → dist/nsh/embed/ios/NativeShell.xcframework
```

`cargo xtask ios-embed` reads the Rust libraries from the checkout's own `target/`, whatever `CARGO_TARGET_DIR` says. Then keep the originals beside the new files and copy them in:

- `~/.nsh/embed/ios/NativeShell.xcframework` (the original as `NativeShell.xcframework.orig`): what `scripts/ios-bundle.sh` links into the app.
- `~/.nsh/runtime/ios/iphonesimulator/{nsh-ios-host,nsh-ios-app}` and `~/.nsh/runtime/ios/iphoneos/nsh-ios-app` (each original as `*.orig`): what `nsh test --target ios` and `nsh package` use.

To go back, move each `.orig` over its file. The Mac Catalyst host and `NativeShellDev.xcframework` stay stock; this app uses neither. `scripts/ios-bundle.sh` warns when the framework it links has no `ring` symbols, which is the stock one. Once an NSH release contains #530, the stock install is enough.

## Install on your own iPhone

This path has not been run on a physical iPhone yet; the app has only run on the simulator. Compiling for a device passes.

Needs a Mac with Xcode, this repository, a TailPocket checkout next to it (`git clone https://github.com/jt-wang/tailpocket ../tailpocket`), and your Apple Account added in Xcode → Settings → Accounts. Your Team ID is shown there. A bundle id must be yours: `io.jingtao.boop` belongs to another team.

1. On the iPhone, turn on Developer Mode: Settings → Privacy & Security → Developer Mode, then restart it. Connect it with a cable and tap Trust.
2. Build and install. `<device>` comes from `xcrun devicectl list devices`.

```sh
scripts/tailpocket-sync.sh ios
scripts/ios-bundle.sh
xcodebuild -project ios/DeepSeekBot.xcodeproj -scheme DeepSeekBot -configuration Debug \
  -destination 'id=<device>' -derivedDataPath ios/build/derived -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=<your team id> PRODUCT_BUNDLE_IDENTIFIER=<com.you.boop> CODE_SIGN_ENTITLEMENTS= build
xcrun devicectl device install app --device <device> ios/build/derived/Build/Products/Debug-iphoneos/DeepSeekBot.app
```

3. If iOS will not open the app, trust your developer profile under Settings → General → VPN & Device Management.
4. Open Boop on your computer, then tap Scan the code in the app.

`CODE_SIGN_ENTITLEMENTS=` leaves notifications and universal links out of this build. For notifications, drop it and use a paid Apple Developer Program team (the steps below).

Without a paid membership, Xcode uses a Personal Team. [Apple's limits](https://developer.apple.com/support/compare-memberships/): the provisioning profile expires after 7 days, so rebuild and reinstall then; up to 3 devices and 3 apps per device.

## Ship through TestFlight

Everything below needs your Apple Developer account. Copy `ios/Config/Signing.local.xcconfig.example` to `ios/Config/Signing.local.xcconfig` and set your team there; that file is not committed.

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

With the API key, `xcodebuild` creates the App Store provisioning profile for `io.jingtao.boop` itself (`-allowProvisioningUpdates`). Without it, sign in to Xcode once with the Apple ID of the team (Xcode → Settings → Accounts) and run the same commands without the `ASC_*` variables.

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
