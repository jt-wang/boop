// One full-screen NshAppView running nsh/bundle.nshc (built from mobile/ by
// scripts/ios-bundle.sh). The NSH app draws into the safe areas itself.
import NativeShell
import TailPocketNSH
import UIKit
import os

final class RootViewController: UIViewController {
    private let app = NshAppView()
    private let log = Logger(subsystem: "io.jingtao.boop", category: "nsh")
    /// A pairing link the app was opened with; read by the app as `host.params.pairUrl`.
    var initialPairURL: String?
    /// [compliance] A link to an interface the app was opened with (universal link or deepseekbot://ui/…): `host.params.linkUrl`.
    var initialLinkURL: String?
    /// [push] The place a tapped notification that launched the app points at: `host.params.notificationUrl`.
    var initialNotificationURL: String?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        app.translatesAutoresizingMaskIntoConstraints = false
        app.onError = { [log] message in log.error("\(message, privacy: .public)") }
        view.addSubview(app)
        NSLayoutConstraint.activate([
            app.topAnchor.constraint(equalTo: view.topAnchor),
            app.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            app.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            app.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        PushBridge.shared.attach(app)
        TailPocketNsh.attach(app) // how this phone reaches a computer running Boop (docs/connection.md)
        UiBridge.shared.attach(app, presenter: self) // generated interfaces open in a sheet over this view
        // `DeepSeekBotHostURL` in Info.plist: the host that gives this build's accounts a computer
        //; the app reads it as `host.params.hostUrl`. Empty: self-hosting only.
        // `ui`: this shell runs the modules the assistant writes (UiBridge, `ui.open`); an app without it opens them in the browser
        var params: [String: Any] = ["ui": true]
        if let pair = initialPairURL { params["pairUrl"] = pair }
        if let link = initialLinkURL { params["linkUrl"] = link }
        if let tapped = initialNotificationURL { params["notificationUrl"] = tapped }
        if let host = Bundle.main.object(forInfoDictionaryKey: "DeepSeekBotHostURL") as? String, !host.isEmpty { params["hostUrl"] = host }
        if !params.isEmpty { app.params = params }

        guard let url = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh") else {
            log.error("nsh/bundle.nshc is not in the app: run scripts/ios-bundle.sh before building")
            return
        }
        do { try app.loadBundle(at: url) } catch { log.error("cannot load the app: \(error.localizedDescription, privacy: .public)") }
    }

    /// A pairing link opened while the app runs (`host.on("pair")`).
    func open(pairURL: String) { app.send("pair", ["url": pairURL]) }

    /// [compliance] A link to an interface opened while the app runs (`host.on("link")`).
    func open(linkURL: String) { app.send("link", ["url": linkURL]) }

    override var preferredStatusBarStyle: UIStatusBarStyle { NshAppView.preferredStatusBarStyle }
    override var prefersStatusBarHidden: Bool { NshAppView.prefersStatusBarHidden }
    override var preferredStatusBarUpdateAnimation: UIStatusBarAnimation { NshAppView.preferredStatusBarUpdateAnimation }
}
