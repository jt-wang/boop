// The system tab bar's selected item is black (white in dark), as the black and white from DeepSeek
// Harness's own theme says; UIKit's default is system blue. Needs a paired app (run QAPassTests first, or pair by
// hand): skipped when the thread is not on screen. Reads the pixels of the selected tab in a screenshot.
import XCTest

final class TabBarTests: XCTestCase {
    func testTheSelectedTabIsNotBlue() throws {
        let app = XCUIApplication()
        app.launch()
        let bar = app.tabBars.firstMatch
        try XCTSkipUnless(bar.waitForExistence(timeout: 20), "the app is not paired: no tab bar")
        for appearance in [XCUIDevice.Appearance.light, .dark] {
            XCUIDevice.shared.appearance = appearance
            sleep(2)
            let selected = bar.buttons.element(boundBy: 0)
            XCTAssertTrue(selected.isSelected, "the chat tab is the selected one")
            let blue = bluePixels(in: selected.screenshot().image)
            XCTAssertEqual(blue, 0, "\(appearance == .dark ? "dark" : "light"): \(blue) blue pixels in the selected tab")
        }
        XCUIDevice.shared.appearance = .light
    }

    /// QA 2026-10-28 #17: the Discover tab showed its icon without its label (seen right after naming the assistant,
    /// and later in a session). Skipped unless TAB_BOT is set. Pairs from TAB_BOT / TAB_CODE when the app is not paired
    /// yet; TAB_SECRET (the bot's host secret) lets it clear the assistant's name, so each round the bar comes up the
    /// way it does after naming. TAB_ROUNDS rounds of: a fresh name, the keyboard up and down (the bar leaves and comes
    /// back), Safari and back, a relaunch. TAB_SHOTS keeps each bar it looked at.
    func testDiscoverKeepsItsLabel() throws {
        let env = ProcessInfo.processInfo.environment
        let bot = env["TAB_BOT"] ?? ""
        try XCTSkipIf(bot.isEmpty, "TAB_BOT not set")
        _ = QAPassTests.skipQuiescence
        let app = XCUIApplication()
        app.launch()
        let id = { (s: String) in app.descendants(matching: .any).matching(identifier: s).firstMatch }
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = { for label in ["Allow", "允许"] { let b = springboard.buttons[label]; if b.waitForExistence(timeout: 3) { b.tap(); break } } }
        if !id("composer").waitForExistence(timeout: 30), !id("name").exists, id("start").exists || id("connect").exists, let code = env["TAB_CODE"] {
            app.terminate()
            let pair = "\(bot)/pair?code=\(code)".addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
            XCUIDevice.shared.system.open(URL(string: "deepseekbot://pair?url=\(pair)")!)
            for label in ["Open", "打开"] { let b = springboard.buttons[label]; if b.waitForExistence(timeout: 3) { b.tap(); break } }
            XCTAssertTrue(id("connect").waitForExistence(timeout: 15), "connect screen")
            id("connect").tap()
            allow()
            for gate in ["age-adult", "consent-agree"] { let b = id(gate); if b.waitForExistence(timeout: 10) { b.tap() } }
        }
        let name = { (step: String) in
            let field = id("name")
            guard field.waitForExistence(timeout: 30) else { return }
            field.tap(); field.typeText("Nori"); id("name-go").tap()
            _ = id("composer").waitForExistence(timeout: 30)
        }
        name("first")
        try XCTSkipUnless(id("composer").waitForExistence(timeout: 30), "the app is not paired")
        let token = Self.call(bot, "POST", "/pair", ["hostSecret": env["TAB_SECRET"] ?? "", "name": "tabbar-driver"], nil)["token"] as? String ?? ""
        let rounds = Int(env["TAB_ROUNDS"] ?? "5") ?? 5
        var missing: [String] = []
        let look = { (step: String) in
            let bar = app.tabBars.firstMatch
            guard bar.waitForExistence(timeout: 10) else { missing.append("\(step): no tab bar"); return }
            sleep(2)
            let image = bar.screenshot()
            if let dir = env["TAB_SHOTS"] {
                try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
                try? image.pngRepresentation.write(to: URL(fileURLWithPath: "\(dir)/tabbar-\(step).png"))
            }
            if !Self.hasLabel(image.image, right: true) { missing.append(step) }
            print("[tabbar] \(step): \(Self.hasLabel(image.image, right: true) ? "label" : "NO LABEL") frame \(bar.frame) window \(app.windows.firstMatch.frame)")
        }
        look("start")
        for round in 1...rounds {
            if !token.isEmpty {
                _ = Self.call(bot, "PUT", "/settings", ["assistantName": ""], token)
                app.terminate(); app.launch()
                name("round-\(round)")
                look("named-\(round)")
            }
            id("composer").tap()
            _ = app.keyboards.firstMatch.waitForExistence(timeout: 5)
            app.typeText("hi")
            let thread = id("thread")
            thread.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
            if app.keyboards.count > 0 { thread.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap() }
            look("keyboard-\(round)")
            XCUIApplication(bundleIdentifier: "com.apple.mobilesafari").activate()
            sleep(2)
            app.activate()
            look("safari-\(round)")
            app.terminate(); app.launch()
            _ = id("composer").waitForExistence(timeout: 20)
            look("relaunch-\(round)")
        }
        XCTAssertEqual(missing, [], "the Discover tab without its label")
    }

    private static func call(_ base: String, _ method: String, _ path: String, _ body: [String: Any], _ token: String?) -> [String: Any] {
        var req = URLRequest(url: URL(string: base + path)!)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        let done = DispatchSemaphore(value: 0)
        var out: [String: Any] = [:]
        URLSession.shared.dataTask(with: req) { data, _, _ in out = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]; done.signal() }.resume()
        _ = done.wait(timeout: .now() + 15)
        return out
    }

    /// Whether one half of the bar has text in its label band (under the icons, 46–64 % down the bar's screenshot on
    /// iOS 26): pixels that differ clearly from that band's most common colour (the bar's glass).
    static func hasLabel(_ image: UIImage, right: Bool) -> Bool {
        guard let cg = image.cgImage else { return false }
        let w = cg.width, h = cg.height
        var data = [UInt8](repeating: 0, count: w * h * 4)
        let ctx = CGContext(data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        let x0 = right ? w / 2 : 0, x1 = right ? w : w / 2
        var counts: [Int: Int] = [:]
        var pixels: [Int] = []
        for y in Int(Double(h) * 0.46) ..< Int(Double(h) * 0.64) {
            for x in x0 ..< x1 {
                let i = (y * w + x) * 4
                let v = (Int(data[i]) << 16) | (Int(data[i + 1]) << 8) | Int(data[i + 2])
                counts[v & 0xF0F0F0, default: 0] += 1
                pixels.append(v)
            }
        }
        guard let bg = counts.max(by: { $0.value < $1.value })?.key else { return false }
        let ink = pixels.filter { v in
            let dr = abs(((v >> 16) & 0xF0) - ((bg >> 16) & 0xF0)), dg = abs(((v >> 8) & 0xF0) - ((bg >> 8) & 0xF0)), db = abs((v & 0xF0) - (bg & 0xF0))
            return dr + dg + db > 120
        }.count
        return ink > 40
    }

    /// Pixels clearly blue (system blue is #007AFF / #0A84FF): blue well above red and green.
    private func bluePixels(in image: UIImage) -> Int {
        guard let cg = image.cgImage else { return -1 }
        let w = cg.width, h = cg.height
        var data = [UInt8](repeating: 0, count: w * h * 4)
        let ctx = CGContext(data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        var n = 0
        for i in stride(from: 0, to: data.count, by: 4) {
            let r = Int(data[i]), g = Int(data[i + 1]), b = Int(data[i + 2])
            if b > 150 && b - r > 80 && b - g > 40 { n += 1 }
        }
        return n
    }
}
