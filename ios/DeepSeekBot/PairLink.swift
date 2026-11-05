import Foundation

/// `deepseekbot://pair?invite=<TailPocket code>`, `deepseekbot://pair?url=<http pairing link>` or `deepseekbot://pair?origin=http://host:3850&code=123456`
/// → the http pairing link the app's connect screen understands (`host.params.pairUrl`).
enum PairLink {
    static func pairURL(from url: URL) -> String? {
        guard url.scheme?.lowercased() == "deepseekbot", url.host?.lowercased() == "pair",
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        else { return nil }
        let value = { (name: String) in items.first { $0.name == name }?.value }
        if let invite = value("invite"), invite.hasPrefix("tailpocket1:") { return invite }
        if let full = value("url"), full.lowercased().hasPrefix("http") { return full }
        if let origin = value("origin"), origin.lowercased().hasPrefix("http") {
            var s = origin.hasSuffix("/") ? String(origin.dropLast()) : origin
            s += "/pair"
            if let code = value("code"), !code.isEmpty { s += "?code=\(code)" }
            return s
        }
        return nil
    }

    /// [compliance] `https://<host>/open/<sandbox>/ui/<id>` (a universal link) or `deepseekbot://ui/<id>?origin=…`.
    static func isInterfaceLink(_ url: URL) -> Bool {
        if url.scheme?.lowercased() == "deepseekbot" { return url.host?.lowercased() == "ui" }
        guard url.scheme?.lowercased() == "https" else { return false }
        let parts = url.path.split(separator: "/")
        return parts.count == 4 && parts[0] == "open" && parts[2] == "ui"
    }
}
