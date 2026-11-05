// Notifications for the NSH app, over the view's channel (mobile/src/native.ts):
//   push.request → { granted }   asks the system for permission (once; later calls read the saved answer)
//   push.token   → { token, kind: "apns" }  the APNs device token as hex, after registerForRemoteNotifications
//   notification { url }         the person tapped a notification while the app ran; the bot put `url` in the payload.
//                                A tap that launched the app arrives as `host.params.notificationUrl` (SceneDelegate)
//   appState     { state }       "background" / "foreground" (SceneDelegate): the bot pushes only while no one sees the app
import NativeShell
import UIKit
import UserNotifications
import os

@MainActor
final class PushBridge: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushBridge()
    private let log = Logger(subsystem: "io.jingtao.boop", category: "push")

    private(set) var token: String?
    private var waitingForToken: [NshHostReply] = []
    private weak var app: NshAppView?
    private var pendingNotificationURL: String?

    /// Registering needs no prompt when the person already answered (it only fetches the token).
    var canRegisterSilently: Bool { UserDefaults.standard.bool(forKey: "push.asked") }

    /// Wire the view's `push.*` functions; call before `loadBundle`.
    func attach(_ view: NshAppView) {
        app = view
        view.handle("push.request") { [weak self] _ in
            let center = UNUserNotificationCenter.current()
            let settings = await center.notificationSettings()
            let granted: Bool
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral: granted = true
            case .denied: granted = false
            case .notDetermined: granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            @unknown default: granted = false
            }
            UserDefaults.standard.set(true, forKey: "push.asked")
            self?.log.notice("push.request: granted=\(granted)")
            if granted { UIApplication.shared.registerForRemoteNotifications() }
            return ["granted": granted]
        }
        view.handle("push.token") { [weak self] _, reply in
            guard let self else { reply.reject("no bridge"); return }
            if let token { reply.resolve(["token": token, "kind": "apns"]); return }
            waitingForToken.append(reply)
            UIApplication.shared.registerForRemoteNotifications()
        }
        if let url = pendingNotificationURL {
            pendingNotificationURL = nil
            view.send("notification", ["url": url])
        }
    }

    func didRegister(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        log.notice("APNs token received (\(hex.count) hex chars)")
        token = hex
        let waiting = waitingForToken
        waitingForToken = []
        waiting.forEach { $0.resolve(["token": hex, "kind": "apns"]) }
    }

    func didFail(_ error: Error) {
        log.error("APNs registration failed: \(error.localizedDescription, privacy: .public)")
        let waiting = waitingForToken
        waitingForToken = []
        waiting.forEach { $0.reject(error.localizedDescription) }
    }

    /// The notification that launched the app: SceneDelegate hands its url to the app as a launch param, so the
    /// delegate's later `didReceive` for the same notification is not sent again.
    var launchNotificationID: String?

    /// The place a notification points at (`url` in its payload, src/push-apns.ts).
    nonisolated static func url(of notification: UNNotification) -> String {
        notification.request.content.userInfo["url"] as? String ?? "/"
    }

    private func deliver(url: String, id: String) {
        if id == launchNotificationID { launchNotificationID = nil; return }
        if let app { app.send("notification", ["url": url]) } else { pendingNotificationURL = url }
    }

    /// The app went to the background or came back (SceneDelegate).
    func appState(_ state: String) { app?.send("appState", ["state": state]) }

    // MARK: UNUserNotificationCenterDelegate
    // The completion-handler forms, answered on the main thread. The `async` form of didReceive crashed the app on
    // every tap: UIKit finishes the response off the main thread and asserts in
    // -[UIApplication _performBlockAfterCATransactionCommitSynchronizes:] (SIGABRT, iOS 26.3 simulator, 2026-10-28).

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // Shown while the app is open too: the bot does not send one about the thread on the screen (src/server.ts),
        // so what arrives now is about another thread, as Messages shows a banner for another conversation.
        DispatchQueue.main.async { completionHandler([.banner, .list, .sound]) }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let url = Self.url(of: response.notification)
        let id = response.notification.request.identifier
        DispatchQueue.main.async {
            MainActor.assumeIsolated { self.deliver(url: url, id: id) }
            completionHandler()
        }
    }
}
