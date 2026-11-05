# Android

The same app as iOS and the browser (`mobile/`), inside a native shell of its own (`android/`, Gradle, Java), built the way the iOS shell is: one full-screen `NshView` running the app's bundle, plus what the app needs from the phone. Interfaces the assistant builds (`ui` modules) open inside the app, as on iOS. Verified 2026-10-27 on the Android 15 emulator in Chinese and dark mode, against a bot behind an HTTPS tunnel: 打开 → the module ran in the app → 20% → Use this → the thread showed 已回答：Tip €8.40 (20%) (`docs/screenshots/android-zh-dark-module-*.png`).

## Build

```sh
scripts/android-build.sh [--host https://your-host]     # → android/build/boop.apk
adb install -r android/build/boop.apk
```

A public release is signed with its own key, which stays outside the repository. Every later version must use the same key, or phones refuse the update. Passwords go through the environment, never a command line:

```sh
ORG_GRADLE_PROJECT_keystore="$HOME/.android-keys/boop-release.jks" \
ORG_GRADLE_PROJECT_keyAlias=boop \
ORG_GRADLE_PROJECT_keystorePassword="$(cat "$HOME/.android-keys/boop-release.pass")" \
scripts/android-build.sh
```

The script overwrites your home folder inside `libnsh.so` (the patched runtime below holds it in panic locations). Without `--host`, Start opens the connect screen.

The script builds the app (`nsh build mobile --release` into `android/app/src/main/assets/nsh`), puts `nsh.aar` with the TLS-fixed `libnsh.so` in `android/app/libs` (both gitignored; below), and runs Gradle (`./gradlew assembleRelease`; `--debug` for a debuggable build). `--host` is the host Start signs in to; the shell passes it to the app as `host.params.hostUrl`, as `DEEPSEEK_BOT_HOST_URL` does on iOS. For a store release add `-Pkeystore=… -PkeyAlias=… -PkeystorePassword=…` to the Gradle call and raise `build` in `mobile/nsh.json` (name, id and version come from there).

What it needs: `ANDROID_HOME` (default `~/Library/Android/sdk`) with `platforms;android-36`, a JDK 17 or newer (Android Studio's is used when `JAVA_HOME` is unset), and the NSH distribution in `~/.nsh` (`embed/android/nsh.aar`, `runtime/android/release/lib`). Gradle 8.14.3 and the Android Gradle plugin 8.13.0 come through the wrapper; set `GRADLE_USER_HOME` to keep their cache off a full system disk.

## What the shell does

| | The APK `nsh package` made (before) | The shell (`android/`) |
|---|---|---|
| Modules (`ui.open`) | none: 打开 opened a one-time play page in the phone's browser | `UiBridge.java`: downloads the `.nshpkg` with the device token, verifies it against the bot's root key (`NshTrust`, one store per bot origin under `files/nsh-trust/`), runs it full screen in a second `NshView` with NSH's default limits for embedded apps, answers `launch.params` with `{ token, origin, moduleId }`, closes on `ui.close` or Done. Tells the app with `host.params.ui = true`, as the iOS shell does |
| `deepseekbot://pair?invite=…`, `?url=…` | not handled | opens the connect screen filled in; while running, sent as the `pair` event (`PairLink.java`, the iOS `PairLink.swift`) |
| Built-in host (`--host`) | written into `mobile/src/build-config.ts` for one build | `host.params.hostUrl` from the manifest |
| Plain `http://` (a bot on the LAN) | refused | allowed, as on iOS (`usesCleartextTraffic`, the iOS shell's `NSAllowsArbitraryLoads`). Measured: pairing over `http://10.0.2.2:<port>` and the thread live over `ws://` |
| Tab bar icons | the system's (a chat bubble and a phone dialer) | the app's own chat and grid glyphs (`res/drawable-*/tab_chat.png`, `tab_discover.png`), tinted by NSH's TabBar |
| Tab bar colors | the system's dynamic color (Material 3, the wallpaper's tint): on the emulator a pale blue pill (#DDE2F9) in light mode, grey blue in dark | black and white, as on iOS: the selected pill black with a white glyph, white with a dark glyph in dark mode; other tabs grey. NSH 0.3.0's TabBar paints from `android.R.color.system_*` and takes no color from the app, so `MonoTabBar.java` repaints its items before each frame (`TabColors.java`) |
| Launcher entry | `com.longbridge.nsh.AppActivity` | an alias of that name for `.MainActivity`, so icons placed before the update still open the app |
| Window before the first frame | white | the app's background, dark in dark mode |
| App limits | none (`AppActivity`) | the largest `setLimits` takes: 2047 MB heap, no time or node budget (op and canvas-op counts keep NSH's defaults) |

Notifications: FCM through `PushService.java` and `PushBridge.java` (the permission prompt on Android 13+, the token, taps that open the thread). They work only in a build with your own `android/app/google-services.json`; without it the build is the same and gets no notifications (docs/push.md). Still different from iOS: the module opens full screen with a title bar and Done, where iOS shows a sheet.

## Tests

- `mobile/modules.test.tsx`: on Android with a shell that says `ui`, 打开 calls `ui.open` and opens no browser; without it (an APK `nsh package` made), the module's one-time play page runs in a sheet inside the app, in NSH's `WebView` (`ModulePlayer` in `cards.tsx`), never in the browser. `mobile/tabs.test.tsx`: the tab icon names.
- `scripts/android-test.sh [serial]`: JVM tests (`PairLinkTest`, `TabColorsTest`), then `ModuleOpenTest` and `TabBarColorTest` on a device. `TabBarColorTest` pairs with a stand-in bot through a pairing link and reads the selected tab's pill in a screenshot: black in light mode, white in dark (failed before: #DDE2F9). It signs the tip calculator (`android/app/src/androidTest/module`) once under root A and once under root B and serves them from a stand-in bot on 127.0.0.1: the package signed under the bot's root opens in the app, below the status bar, posts its result with the module token and closes itself; the one signed under another root is refused ("signed by key …, which is not trusted") and nothing shows; a download without the device token fails with HTTP 401. It installs the debug build on that device.
- `node scripts/android-module-e2e.ts <serial> [shots dir]`: the whole path against a real bot behind a quick tunnel, with a scripted model that builds the tip calculator. Install the build first; it clears the app's data. `ANDROID_E2E_HTTP=1` pairs over plain http instead and stops at the module card.

Chinese and dark mode on an emulator (a `google_apis` image, which allows root): `adb root`, `adb shell "setprop persist.sys.locale zh-CN && setprop ctl.restart zygote"`, then `adb shell cmd uimode night yes`.

## NSH 0.3.0 cannot open wss (fixed with a patched runtime)

NSH's Android runtime cannot open a `wss://` socket: it carries rustls 0.23 (through tokio-tungstenite's `rustls-tls-webpki-roots`) with no crypto provider installed, and nothing in the tree calls `install_default()` (NSH source at 1849776, 2026-10-27). Measured 2026-10-27 with a probe app: the global `WebSocket` never opens to `wss://echo.websocket.org` and the JS thread stalls; the `websocket` module rejects with `Could not automatically determine the process-level CryptoProvider from Rustls crate features`; both open plain `ws://`. v0.3.0 is the latest release, and nothing after it touches WebSocket or TLS.

The fix: compile rustls with its `ring` provider and install it before a connect (`rustls::crypto::ring::default_provider().install_default()`; four lines against v0.3.0, the upstream PR draft). Built with NDK r27c (`cargo xtask android --release --abi arm64-v8a`), the patched `libnsh.so` lives in `~/.nsh/runtime/android/release/lib/arm64-v8a/`. The stock `nsh.aar` in `~/.nsh/embed/android` still has the unpatched one, so `scripts/android-build.sh` replaces each ABI's library in a copy of the AAR with the runtime's (`NSH_RUNTIME_LIBS` overrides the directory) and warns when the arm64 one is the stock library. Only arm64-v8a is patched; the armeabi-v7a and x86_64 libraries are stock.

Measured 2026-10-27 on the emulator through a tunnel, the same build twice: with the runtime's arm64 library the thread fills live and the module flow passes; with the stock one (`NSH_RUNTIME_LIBS` pointing at it) the app pairs over HTTPS but no message or card ever reaches the thread. Until NSH ships the fix, an Android build needs that runtime. The iOS framework has the same gap and its own patched build (docs/ios.md, measured 2026-10-29).

## Known

- A new quick-tunnel name can take a few seconds to route; the e2e script waits for the bot's `/health` through it first.
- Emulator on a Mac whose resolver is slow to see new names: start it with `-dns-server 1.1.1.1`.
