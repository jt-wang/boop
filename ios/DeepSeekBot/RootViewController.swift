// One full-screen NshAppView running nsh/bundle.nshc (built from mobile/ by
// scripts/ios-bundle.sh). The NSH app draws into the safe areas itself.
import NativeShell
import TailPocketNSH
import UIKit
import LinkPresentation
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
        attachDiagnostics()
        // `DeepSeekBotHostURL` in Info.plist: the host that gives this build's accounts a computer
        //; the app reads it as `host.params.hostUrl`. Empty: self-hosting only.
        // `ui`: this shell runs the modules the assistant writes (UiBridge, `ui.open`); an app without it opens them in the browser
        var params: [String: Any] = ["ui": true, "diagnostics": true]
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

    private func attachDiagnostics() {
        // Only this trusted root view has these handlers; generated interfaces do not.
        let files = FileManager.default
        var directory = files.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("BoopDiagnostics", isDirectory: true)
        let journal = directory.appendingPathComponent("journal.json")
        app.handle("diagnostics.read") { _ -> Any in
            guard files.fileExists(atPath: journal.path) else { return NSNull() }
            return try String(contentsOf: journal, encoding: .utf8)
        }
        app.handle("diagnostics.write") { data in
            guard let text = (data as? [String: Any])?["text"] as? String,
                  text.utf8.count <= 262144 else { throw DiagnosticError.invalidExport }
            try files.createDirectory(at: directory, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try directory.setResourceValues(values)
            try Data(text.utf8).write(to: journal, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            return true
        }
        app.handle("diagnostics.remove") { _ in
            // Keep the directory and its backup-exclusion attribute.
            if files.fileExists(atPath: journal.path) { try files.removeItem(at: journal) }
            return true
        }
        app.handle("diagnostics.sample") { _ in
            guard UIApplication.shared.applicationState == .active else { return [:] as [String: Any] }
            let device = UIDevice.current
            let wasMonitoring = device.isBatteryMonitoringEnabled
            device.isBatteryMonitoringEnabled = true
            defer { device.isBatteryMonitoringEnabled = wasMonitoring }
            let charging: String
            switch device.batteryState {
            case .charging: charging = "charging"
            case .full: charging = "full"
            case .unplugged: charging = "unplugged"
            default: charging = "unknown"
            }
            let thermal: String
            switch ProcessInfo.processInfo.thermalState {
            case .nominal: thermal = "nominal"
            case .fair: thermal = "fair"
            case .serious: thermal = "serious"
            case .critical: thermal = "critical"
            @unknown default: thermal = "unknown"
            }
            var fields: [String: Any] = ["charging": charging, "thermal": thermal,
                "lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled ? "on" : "off"]
            if device.batteryLevel >= 0 { fields["batteryLevel"] = device.batteryLevel }
            return fields
        }
        app.handle("diagnostics.share") { [weak self] data in
            guard let self, let text = (data as? [String: Any])?["text"] as? String,
                  text.utf8.count <= 262144 else { throw DiagnosticError.invalidExport }
            // Share text directly: no export file or log copy remains in a cache directory.
            let sheet = UIActivityViewController(activityItems: [DiagnosticShareItem(text)], applicationActivities: nil)
            sheet.popoverPresentationController?.sourceView = self.view
            sheet.popoverPresentationController?.sourceRect = CGRect(x: self.view.bounds.midX, y: self.view.bounds.midY, width: 1, height: 1)
            self.present(sheet, animated: true)
            return ["opened": true]
        }
    }
    private enum DiagnosticError: Error { case invalidExport }

    private final class DiagnosticShareItem: NSObject, UIActivityItemSource {
        let text: String
        init(_ text: String) { self.text = text }
        func activityViewControllerPlaceholderItem(_ controller: UIActivityViewController) -> Any { text }
        func activityViewController(_ controller: UIActivityViewController, itemForActivityType type: UIActivity.ActivityType?) -> Any? { text }
        func activityViewController(_ controller: UIActivityViewController, subjectForActivityType type: UIActivity.ActivityType?) -> String { "Boop Diagnostics" }
        func activityViewControllerLinkMetadata(_ controller: UIActivityViewController) -> LPLinkMetadata? {
            let metadata = LPLinkMetadata()
            metadata.title = "Boop Diagnostics"
            return metadata
        }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { NshAppView.preferredStatusBarStyle }
    override var prefersStatusBarHidden: Bool { NshAppView.prefersStatusBarHidden }
    override var preferredStatusBarUpdateAnimation: UIStatusBarAnimation { NshAppView.preferredStatusBarUpdateAnimation }
}
