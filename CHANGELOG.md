# Changelog

## v0.1.10-release.1

- Fix the phone app's type check, which stopped the signed Android and iOS builds of v0.1.10. No change in behaviour; the v0.1.10 release files are built from this commit.

## v0.1.10

- TailPocket v0.3.6. When the phone cannot reach the computer, Settings says why instead of only "Reconnecting": Boop is not running on the computer or the computer was reset; the computer is off or asleep, or this network blocks the connection; or your relay server cannot be reached.
- The chat shows the same reason above the message box; tapping it, or the status at the top, opens Settings. The Connection row says Not connected whenever the phone is offline.
- Only when the computer looks reset does Settings offer Pair again, and only when you tap it. Scan only the code on your own computer's screen; the phone keeps its current pairing until the new one works, so a failed or cancelled pairing changes nothing. The reason is never used to unpair or forget the computer on its own.
- Version 0.1.10: phone build 10, Mac build 8.

## v0.1.9

- Public CI checks that every commit and tag has the project's public identity, a 12:00 UTC date and no trailer other than `Source-Rev`. No app change; v0.1.8 stays the current release.

## v0.1.8

- TailPocket v0.3.3 (v0.3.2's optional Tailcat, with the fixes from its security audit): Tailcat is now optional. Start the computer with `--routes` (or `"routes"` in `config.json`) set to any of `tailcat`, `lan`, `relay`. `--routes lan` keeps everything on your network and talks to no Tailcat server; a phone away from that network cannot connect. Without `--routes` nothing changes. A wrong set stops the bot with one sentence saying what to change.
- Phones: Settings › Computer › Connection chooses the routes this phone may use: all routes, local network only, relay only or Tailcat only, each with what it means and costs. Switching reconnects at once, a route that reaches nothing is reported, and a choice TailPocket refuses is not shown as applied. The old Tailcat-only switch becomes Tailcat only.
- Pairing works without Tailcat (emoji pairing over the local network or your relay). Phones paired over Tailcat before v0.3 that never sent their end-to-end key pair again on a computer without Tailcat; the bot says how many.
- Version 0.1.8: phone build 9, Mac build 7.

## v0.1.7

- TailPocket v0.3.1 on every platform. Removing a paired phone closes its open connections immediately, including when it was the last phone. Helper shutdown is bounded; phones can move to a better connection without interrupting existing requests.
- Settings shows only the diagnostics entry and its current state. Recording and explicit export stay on the diagnostics subpage. Recording and every category default to off; turning recording on still requires selecting each category. Disabled categories appear off and cannot be selected. Existing retained logs are preserved, and recording does not resume after restart or upgrade.
- Diagnostics remain local, bounded and opt-in, with no conversation content or automatic upload. Exports are named Boop Diagnostics.
- Fix entering demo mode on the web app: only Android registers the Android back-button handler.
- Version 0.1.7: phone build 8, Mac build 6. iOS is distributed through TestFlight Internal, not the App Store.

## v0.1.6

The same app as the v0.1.5 pre-release, which was for internal testing on TailPocket v0.3.0-pre.9, now built on the TailPocket v0.3.0 release.

- TailPocket v0.3. Phones still connect through Tailcat. With `DEEPSEEK_BOT_RELAY_URL` and `DEEPSEEK_BOT_RELAY_TOKEN` set, they can also connect through your own tailpocket-relay, end-to-end encrypted with Noise, and the QR becomes `tailpocket2:…`. The relay sees only ciphertext.
- Phones paired before this do not scan again: the new app fetches the computer's key over Tailcat the first time it opens. If the computer is not on v0.3 yet, the phone keeps using Tailcat and shows no error.
- The computer keeps each phone's end-to-end key across restarts.
- Settings says which way the connection goes: directly, through a relay, or over the local network (all end-to-end encrypted). A phone the computer removed is signed out.
- Without the TailPocket helper, the bot no longer falls back to plain HTTP on the local network. It stays on 127.0.0.1 and says to install the helper. A plain local network address you choose (`--host 0.0.0.0`, `--no-tailpocket`, a host in the config) still works, but now prints a warning that anyone on the network can see all traffic, the token included.
- Deep links `deepseekbot://pair?invite=tailpocket2:…` open on iOS and Android, and the Mac window shows a `tailpocket2:` code.
- TailPocket v0.3.0 on the computer. Pairing compares four emoji: the phone shows them, the computer shows the phone's name and the same emoji, and the person confirms there (`y`/`n` in the terminal, two buttons in the Mac window). The QR is always `tailpocket2:…`; pairing needs this app version, while phones paired before keep connecting.
- Phones on the same Wi-Fi reach the computer straight over the local network, end-to-end encrypted. `--no-lan` turns that off; `--tailcat-only` on the computer and Settings › Computer › Tailcat only on the phone use Tailcat alone.
- Through TailPocket every request goes under the tunnel's base, which carries a token, so another app on the phone cannot use the tunnel. The token is never saved.
- The TestFlight and Android release workflows build TailPocket v0.3.0 (public `e1aea0f`) instead of v0.2.4, and Android asks for its 0.3.0 libraries.
- Version 0.1.6: phone build 7, Mac build 5.

## v0.1.4-release.1

- Update the bundled Mac app to 0.1.4 (4), using the existing DMG build and ad hoc signing process with stock NSH 0.4 and the matching TailPocket helper. Remove build-home paths before signing.
- Record the successful iOS 0.1.4 (4) TestFlight upload in the download guide. APK, DMG, computer packages and their notices are distributed together in the v0.1.4 release.

## v0.1.4-android.2

- Install the Android SDK and pinned NDK explicitly on GitHub runners before building the signed APK.

## v0.1.4-android.1

- Add a manual Android release build using the existing GitHub signing secrets. Verify the APK signature against v0.1.0 and require an increased version code before publishing the artifact.
- Align Android's TailPocket dependencies with the pinned 0.2.4 native libraries. App version remains 0.1.4, build 4; the existing v0.1.4 tag and iOS upload are unchanged.

## v0.1.4

- Boop now builds on stock NSH 0.4. No patched framework: a phone reaches an `https` computer with the release as it comes.
- A computer that writes interfaces for the app needs `nsh` 0.4.
- Interfaces written with `nsh` 0.4 do not open in the v0.1.0 phone app. Update the phone app before the computer. The new phone app opens interfaces from a computer still on `nsh` 0.3.
- Integrate the GitHub TestFlight signing workflow with the NSH 0.4 app, retaining build caches and removing local home paths before export.
- Pairing, reconnecting and offline history were checked on an iOS 27.0 simulator with the pinned TailPocket runtime.

This release publishes updated source and computer packages. The iOS app is delivered through TestFlight, not the App Store. Android and Mac app downloads remain at v0.1.0.

## v0.1.3

- The phone app's connect screen has two ways in: scan the code on the computer, or paste the one the Boop window copies (Copy code). A server address and its six-digit code are under "Connect to a server address".
- "Try a demo, no computer needed" opens demo mode: the header says Demo mode, and a bar above the tabs on every page says everything is made up and nothing is really done.
- docs/BUILD.md says a Fly.io host is for several people and that its phone app is built with the host's address; the downloaded app connects to your own computer or a Docker server.

Downloads: a new `boop.apk` (0.1.3), which installs over 0.1.0. The Mac app and the computer files are the v0.1.0 ones, since that code has not changed.

## v0.1.2-testflight-ci.1

- Add a manual GitHub Actions workflow for signing iOS builds and optional TestFlight upload. Cloud agents use GitHub permissions; Apple credentials stay in the protected environment.
- Setup and dispatch instructions are in docs/testflight-ci.md.

## v0.1.2

- The README says what the downloads do: a reminder arrives as a message in the chat, and notifications in the phone apps need your own Firebase or APNs setup (`docs/push.md`).

No new downloads: the links still give the v0.1.0 files.

## v0.1.1

- Build Boop for your own iPhone and sign it with your own Apple account: `docs/ios.md`, "Build it for your own iPhone".
- "Try it without a computer" on the pairing screen opens the app on made-up data, with no pairing and no network.
- On a computer you run, a report from the app stays on that computer. The app says so and links to GitHub issues.
- Terms and privacy links open the public pages when the phone has no hosted account.
- Unpairing removes the copy of every conversation the phone kept.
- The Android app builds from a clean checkout next to public TailPocket.

No new downloads: the links still give the v0.1.0 files.

## v0.1.0

The first public release of Boop: an AI assistant that runs on your own computer or server and that you talk to from your phone.

- On a Mac, download `Boop.dmg` (Apple silicon): nothing else to install. It is not notarized yet, so macOS asks you to allow it the first time.
- On a Mac or Linux with Node.js 24+, one install command downloads the right file from this release. No clone and no build.
- To run it on a server with Docker or Fly.io, or to change the code, build it yourself (`docs/BUILD.md`).
- Scan the code it shows from the phone app, once, and the phone reaches your computer through TailPocket from any network. No account.
- It has a shell, files, web search and a browser that keeps its logins. It keeps working after you close the app, and comes back when something is done or needs your yes.
- Answers can be real controls: a choice, a form, a table.
- Memory you can read and edit, reminders, goals and connectors to other services.
- Notifications in the browser app. The phone apps get them when you build with your own Firebase or Apple keys (`docs/push.md`).
- The interface comes in seven languages.
- Android: download `boop.apk` from this release. iPhone: build it yourself with Xcode (`docs/ios.md`); it has only run on the simulator so far.
