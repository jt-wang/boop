# Changelog

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
