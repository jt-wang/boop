# Changelog

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
