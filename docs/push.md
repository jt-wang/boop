# Notifications

When the assistant finishes something, needs a yes, has a question, or a reminder is due while the app is closed, the phone gets a notification, and tapping it opens the place it is about.

## What pushes, what it says, where a tap lands

The words are in `src/lang.ts` and `src/push-text.ts`.

| Event | Title | Body | Tap opens |
|---|---|---|---|
| Approval waiting | 「Nori需要你点头」 / "Nori needs a yes" | the card's own words in the person's language, harness permission names in plain words; without words, what it wants to do ("Writing a file") | the thread, card at the bottom (`/threads/<id>/asks/<event>`) |
| Question waiting | 「Nori有个问题」 / "Nori has a question" | the first question | the thread, card at the bottom |
| A turn ends, any thread | 「Nori做完了」 / "Nori is done" | its last line, Markdown removed, 160 characters | that thread (`/threads/<id>`) |
| Reminder due | the reminder's name | 「到点了。」 / "It’s time." | the main thread |
| The assistant's `notify` | its title | its body | the main thread |
| Morning ideas (opt-in) | the assistant's name | the first idea | Discover (`/discover`) |

- **No push while someone is looking.** An app in the foreground on that thread gets nothing; one on another thread gets the banner, as Messages does for another conversation. The app tells the bot when it goes to the background (`{type:'presence'}` on `/events`, from the shell's `appState`); a socket that misses a ping (one every 30 s) is dropped within a minute, so a killed or suspended app counts as closed.
- **One push per card and per turn.** A reminder's push stands for the turn it starts; repeated "done" for one thread share a collapse id (`turn:<id>`), so the lock screen keeps the newest.

## The chain

Each step: what is sent, which code receives it, what it does, what comes back. **Confirmed** means a test or a run in this repository shows it; **not confirmed** means nobody here has seen it.

1. **Permission and token.** `mobile/src/native.ts` `afterConnect` → `host.call('push.request')` → iOS `PushBridge.swift` asks `UNUserNotificationCenter` and registers with APNs; Android `PushBridge.java` asks for `POST_NOTIFICATIONS` (Android 13+) → `host.call('push.token')` → `{token, kind}`. Confirmed on the iOS simulator (PushTapTests: Allow, then an 80-byte token reaches the bot). Android permission: confirmed on the Android 15 emulator (`PushNotificationTest`: the system dialog, Allow, the answer reaches the bridge). Android token: needs your own `google-services.json`; without it `push.token` rejects and the app stays without notifications.
2. **Token to the bot.** `POST /push/subscribe {kind:'apns'|'fcm', token}` or a Web Push subscription → `PushService` keeps it in `<home>/push.json`. Confirmed (`test/push-apns.test.ts`, `test/push-fcm.test.ts`, `mobile/native.test.tsx`, `mobile/push.test.tsx`).
3. **Something happens.** `src/server.ts` (approvals, questions, turn ends, `bot.notify` for the bot's own pushes) decides by the rules above. Confirmed with a fake harness (`test/push-triggers.test.ts`) and with the real harness and the scripted model (`test/push.e2e.test.ts`: a turn, a reminder, a question, its answer, a turn with the app open, a side thread).
4. **Bot → host relay.** In a hosted sandbox: `RelayApnsSender` / `RelayFcmSender` post `{kind, token, title, body, url, tag}` to the host's `POST /host/push` with the host secret, at `DEEPSEEK_BOT_PUSH_RELAY` (`http://host.docker.internal:<port>` on Docker, `http://host.process.<app>.internal:<port>` on Fly). Confirmed on this machine with a real host server (`test/push.e2e.test.ts`). The Docker and Fly addresses are not tested yet.
5. **Host → Apple.** `ApnsSender`: HTTP/2, ES256 JWT from the `.p8`, `apns-topic`, `apns-push-type: alert`, `apns-collapse-id`, body `{aps:{alert,sound,thread-id}, url}`. Confirmed against a stand-in HTTP/2 server (e2e). Accepted by Apple: test it with your own APNs key. If the key or topic is wrong, the host answers the bot with Apple's status and reason and the bot logs `[bot] APNs: …`.
6. **Host → Firebase.** `FcmSender`: a service-account JWT exchanged at Google's token endpoint, then `POST /v1/projects/<id>/messages:send` with a data-only, high-priority message. Confirmed against stand-ins for both endpoints (unit and e2e). Accepted by Google: test it with your own Firebase project. A wrong account shows as `[bot] FCM: FCM 401 …` (or the host's log).
7. **Bot → browser.** `web-push` with the bot's VAPID key. Confirmed against a stand-in push service; the e2e decrypts the payload with the subscription's keys.
8. **The phone shows it.** iOS: the payload ApnsSender sends, delivered to the simulator by `xcrun simctl push`, shows as a banner. Android: `PushService` → `PushBridge.show` draws it on the "Your assistant" channel. Confirmed on iOS; Android's drawing only when FCM delivers (step 6); `PushNotificationTest` draws the same notification directly.
9. **The tap.** iOS: `PushBridge` → `notification {url}` while running, `host.params.notificationUrl` when the tap launched the app. Android: the notification's intent carries the url to `MainActivity` the same two ways. The app (`App.tsx`) pops to the chat and opens that thread, or Discover. Confirmed on the iOS simulator (PushTapTests: question card, side thread, cold launch), on the Android 15 emulator up to the shell (`PushNotificationTest`: a tap while running and a tap that launches the app hand over the url), and headless for the app's routing (`mobile/push.test.tsx`, including the browser's `/?open=<url>`).

## Check it yourself

- Unit: `npm test` (push, push-apns, push-fcm, push-triggers, finish, host); app: `cd mobile && nsh test push.test.tsx native.test.tsx`.
- End to end, no phone: `DEEPSEEK_BOT_E2E=1 node --test test/push.e2e.test.ts` (about 35 s).
- iOS simulator: `node scripts/push-sim.ts <home> 3943 <udid> <zh|en>`, then `xcodebuild … test-without-building -only-testing:DeepSeekBotUITests/PushTapTests` with `TEST_RUNNER_PUSH_BOT`, `PUSH_CODE` (`<home>.code`), `PUSH_SECRET` (`<home>.secret`), `PUSH_LANG`, `PUSH_SCHEME`, `PUSH_SHOTS`. Each APNs request is in `<home>.apns.jsonl`.
- Android: `scripts/android-test.sh <serial>` runs the JVM tests and `PushNotificationTest` (permission prompt, a tap while running, a tap that launches the app).

## What you provide

| For | What | Where it goes |
|---|---|---|
| iPhones | An APNs key (`AuthKey_<id>.p8`, its Key ID, the Team ID) and the App ID `io.jingtao.boop` with Push Notifications ticked (`docs/ios.md`) | `config.json` → `"apns": {keyId, teamId, keyPath, bundleId, sandbox}` on the bot; for hosted accounts on the host (`<host home>/config.json`) |
| Android phones, build | A Firebase project with an Android app for package `io.jingtao.boop` (Firebase console → Project settings → Your apps → Add app → Android), and its `google-services.json` | `android/app/google-services.json` (git-ignored); `scripts/android-build.sh` then applies the Google Services plugin |
| Android phones, sending | A service account key of that project allowed to send FCM messages (Project settings → Service accounts → Generate new private key) | `config.json` → `"fcm": {"serviceAccountPath": "/path/key.json"}` on the bot, or on the host for hosted accounts |
| Browsers | nothing; VAPID keys are made per bot | |

