import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let root = RootViewController()
        // Opened from a deepseekbot://pair link: the app starts on the connect screen with it filled in.
        if let url = connectionOptions.urlContexts.first?.url, let pair = PairLink.pairURL(from: url) {
            root.initialPairURL = pair
        }
        // [compliance] Opened from a link to an interface: a universal link (https://<host>/open/…, App Review 4.7.4) or deepseekbot://ui/…
        if let url = connectionOptions.urlContexts.first?.url, PairLink.isInterfaceLink(url) { root.initialLinkURL = url.absoluteString }
        if let activity = connectionOptions.userActivities.first(where: { $0.activityType == NSUserActivityTypeBrowsingWeb }), let url = activity.webpageURL, PairLink.isInterfaceLink(url) {
            root.initialLinkURL = url.absoluteString
        }
        // [push] Launched by a tap on a notification: the app opens where it points (`host.params.notificationUrl`).
        if let response = connectionOptions.notificationResponse {
            root.initialNotificationURL = PushBridge.url(of: response.notification)
            PushBridge.shared.launchNotificationID = response.notification.request.identifier
        }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = root
        window.tintColor = .label // black-and-white like dsh's own interface: tab bar selection, back buttons
        window.makeKeyAndVisible()
        self.window = window
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let root = window?.rootViewController as? RootViewController else { return }
        for context in URLContexts {
            if let pair = PairLink.pairURL(from: context.url) { root.open(pairURL: pair) }
            else if PairLink.isInterfaceLink(context.url) { root.open(linkURL: context.url.absoluteString) }
        }
    }

    // [push] Whether a person can see the app: the bot sends notifications only while no one does.
    func sceneDidEnterBackground(_ scene: UIScene) { PushBridge.shared.appState("background") }
    func sceneWillEnterForeground(_ scene: UIScene) { PushBridge.shared.appState("foreground") }

    /// [compliance] A universal link while the app runs.
    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        guard userActivity.activityType == NSUserActivityTypeBrowsingWeb, let url = userActivity.webpageURL, PairLink.isInterfaceLink(url),
            let root = window?.rootViewController as? RootViewController else { return }
        root.open(linkURL: url.absoluteString)
    }
}
