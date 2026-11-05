// Generated interfaces. The app asks
//   ui.open { url, auth, token, title, rootKey, origin, moduleId }
// with the signed .nshpkg the bot published. The shell downloads it with the
// device token, verifies it against the bot's root key (NshTrust, one trust
// store per bot origin, so a package signed by another bot is refused) and runs
// it in a sheet of its own: a second NshAppView, its own VM and limits, with
//   params { token, origin, moduleId }   (also answered as `launch.params`,
//   the same name the browser build uses, so one module source runs everywhere)
// The module posts its result to the bot itself and calls `ui.close`.
import NativeShell
import UIKit
import os

@MainActor
final class UiBridge {
    static let shared = UiBridge()
    private let log = Logger(subsystem: "io.jingtao.boop", category: "ui")
    private var trusts: [String: NshTrust] = [:]
    private weak var presenter: UIViewController?

    struct OpenError: LocalizedError { let message: String; var errorDescription: String? { message } }

    /// Wire the view's `ui.open`; `presenter` shows the sheet.
    func attach(_ view: NshAppView, presenter: UIViewController) {
        self.presenter = presenter
        view.handle("ui.open") { [weak self] data in
            guard let self else { throw OpenError(message: "no bridge") }
            return try await self.open(data as? [String: Any] ?? [:])
        }
    }

    private func open(_ args: [String: Any]) async throws -> [String: Any] {
        guard let urlString = args["url"] as? String, let url = URL(string: urlString),
            let auth = args["auth"] as? String, !auth.isEmpty,
            let rootKey = args["rootKey"] as? String, !rootKey.isEmpty,
            let moduleId = args["moduleId"] as? String, !moduleId.isEmpty
        else { throw OpenError(message: "ui.open needs url, auth, rootKey and moduleId") }
        let started = Date()
        let origin = (args["origin"] as? String) ?? "\(url.scheme ?? "http")://\(url.host ?? "")\(url.port.map { ":\($0)" } ?? "")"

        var request = URLRequest(url: url)
        request.setValue("Bearer \(auth)", forHTTPHeaderField: "Authorization")
        let (downloaded, response) = try await URLSession.shared.download(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw OpenError(message: "download failed: HTTP \(status)") }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ui", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("\(moduleId).nshpkg")
        try? FileManager.default.removeItem(at: file)
        try FileManager.default.moveItem(at: downloaded, to: file)
        let downloadedMs = Int(Date().timeIntervalSince(started) * 1000)

        let trust = try trust(for: origin, rootKey: rootKey)
        let params: [String: Any] = ["token": args["token"] as? String ?? "", "origin": origin, "moduleId": moduleId]
        let sheet = ModuleSheetController(title: args["title"] as? String ?? "", params: params)
        // [compliance] App Review 4.7.2 / 4.7.3: the module reaches its own bot, its two host functions and what the
        // person allowed for this interface (`grants`), nothing else; no native component is registered on its view.
        // A request must pass the package's own declaration and this grant (NSH sandbox-and-capabilities).
        try sheet.app.grantCapabilities(Self.grant(origin: origin, grants: args["grants"] as? [String] ?? []))
        // Verifies off the main thread, then runs; a refused package throws here and nothing is shown.
        let info = try await sheet.app.loadPackage(at: file, trust: trust)
        let nav = UINavigationController(rootViewController: sheet)
        if let sp = nav.sheetPresentationController {
            sp.detents = [.large()]
            sp.prefersGrabberVisible = true
        }
        guard let presenter else { throw OpenError(message: "nothing to present on") }
        presenter.present(nav, animated: true)
        let ms = Int(Date().timeIntervalSince(started) * 1000)
        log.notice("ui.open \(info.id, privacy: .public) build \(info.build) — download \(downloadedMs) ms, verified+shown \(ms) ms")
        return ["ok": true, "id": info.id, "name": info.name, "build": info.build, "downloadMs": downloadedMs, "ms": ms]
    }

    /// [compliance] The capabilities a module is granted: the bot's host, `launch.params` and `ui.close`, and per
    /// permission the person allowed: https links, the clipboard, the photo picker. JSON as `grantCapabilities` takes it.
    static func grant(origin: String, grants: [String]) -> String {
        var c: [String: Any] = [
            "network": ["hosts": [URL(string: origin)?.host ?? ""]],
            "host": ["launch.params", "ui.close"],
        ]
        if grants.contains("openUrl") { c["openUrl"] = ["schemes": ["https"]] }
        if grants.contains("clipboard") { c["clipboard"] = true }
        if grants.contains("picker") { c["picker"] = true }
        let data = (try? JSONSerialization.data(withJSONObject: c, options: [.sortedKeys])) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    /// One trust store per bot origin under Application Support; the root is added on first use (adding it again is harmless).
    private func trust(for origin: String, rootKey: String) throws -> NshTrust {
        if let t = trusts[origin] { try t.addRoot(rootKey); return t }
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let name = origin.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? String($0) : "_" }.joined()
        let dir = base.appendingPathComponent("nsh-trust", isDirectory: true).appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let t = try NshTrust(stateDirectory: dir)
        try t.addRoot(rootKey)
        trusts[origin] = t
        return t
    }
}

/// The sheet: a title bar with Done and one NshAppView running the module.
final class ModuleSheetController: UIViewController {
    let app = NshAppView()
    private let params: [String: Any]
    private let log = Logger(subsystem: "io.jingtao.boop", category: "ui")

    init(title: String, params: [String: Any]) {
        self.params = params
        super.init(nibName: nil, bundle: nil)
        self.title = title
        app.params = params
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(close))
        app.translatesAutoresizingMaskIntoConstraints = false
        app.onError = { [weak self] message in self?.failed(message) }
        app.handle("ui.close") { [weak self] _ in
            await MainActor.run { self?.dismiss(animated: true) }
            return nil
        }
        app.handle("launch.params") { [params] _ in params }
        view.addSubview(app)
        NSLayoutConstraint.activate([
            app.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            app.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            app.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            app.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    @objc private func close() { dismiss(animated: true) }

    private func failed(_ message: String) {
        log.error("module: \(message, privacy: .public)")
        let label = UILabel()
        label.text = message
        label.numberOfLines = 0
        label.textColor = .secondaryLabel
        label.font = .preferredFont(forTextStyle: .footnote)
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            label.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16),
        ])
    }
}
