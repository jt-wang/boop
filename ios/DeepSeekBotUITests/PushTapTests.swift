// Notifications on the simulator, through the chain the hosted app uses: scripts/push-sim.ts runs the bot with a
// scripted model, the host's relay and a stand-in for Apple that hands each request's payload to `xcrun simctl push`.
// Skipped unless PUSH_BOT is set. Env (TEST_RUNNER_ prefixed on the xcodebuild command line, docs/push.md):
//   PUSH_BOT     the bot's address (http://127.0.0.1:3941)
//   PUSH_CODE    the six digits from its pairing link (<home>.code)
//   PUSH_SECRET  the bot's host secret (<home>.secret): the test pairs a device of its own to start turns
//   PUSH_LANG    zh | en (the simulator's language is set before the run)
//   PUSH_SCHEME  dark | light
//   PUSH_SHOTS   where the screenshots go: push-ios-<lang>-<scheme>-<screen>.png
// With the app in the background: a question → the banner → a tap opens the thread at the card. A side thread
// finishes → a tap opens that thread. With the app closed: a tap launches it on that thread.
import XCTest

final class PushTapTests: XCTestCase {
    let env = ProcessInfo.processInfo.environment
    var bot: String { env["PUSH_BOT"] ?? "" }
    var zh: Bool { env["PUSH_LANG"] == "zh" }
    var scheme: String { env["PUSH_SCHEME"] ?? "light" }
    let app = XCUIApplication()
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    var token = ""

    func L(_ zhText: String, _ en: String) -> String { zh ? zhText : en }

    func testTapOpensTheRightPlace() throws {
        try XCTSkipIf(bot.isEmpty, "PUSH_BOT not set")
        XCUIDevice.shared.appearance = scheme == "dark" ? .dark : .light
        app.launch()
        app.terminate()

        // 1. Pair from the link (a clean install), allow notifications, through the first-run screens to the thread.
        let code = try XCTUnwrap(env["PUSH_CODE"])
        let pair = "\(bot)/pair?code=\(code)".addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
        XCUIDevice.shared.system.open(URL(string: "deepseekbot://pair?url=\(pair)")!)
        for label in ["Open", "打开"] { let b = springboard.buttons[label]; if b.waitForExistence(timeout: 3) { b.tap(); break } }
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        let connect = id("connect")
        XCTAssertTrue(connect.waitForExistence(timeout: 15), "connect screen")
        connect.tap()
        var allowed = false
        for label in ["Allow", "允许"] { let b = springboard.buttons[label]; if b.waitForExistence(timeout: 8) { b.tap(); allowed = true; break } }
        XCTAssertTrue(allowed, "the notification permission alert")
        for gate in ["age-adult", "consent-agree"] { let b = id(gate); if b.waitForExistence(timeout: 10) { b.tap() } }
        let name = id("name-go")
        if name.waitForExistence(timeout: 20) { name.tap() }
        XCTAssertTrue(id("composer").waitForExistence(timeout: 60), "the thread")
        token = (json(request("POST", "/pair", ["hostSecret": env["PUSH_SECRET"] ?? "", "name": "push-driver"]))?["token"] as? String) ?? ""
        XCTAssertFalse(token.isEmpty, "the driver paired")
        let main = try XCTUnwrap(json(request("GET", "/me"))?["mainSessionId"] as? String)
        waitIdle()
        waitForToken()

        // 2. In the background: a question. The banner, then a tap: the thread with the card.
        XCUIDevice.shared.press(.home)
        sleep(2)
        _ = request("POST", "/threads/\(main)/messages", ["text": L("帮我订个座位。", "Book me a seat.")])
        let question = banner(L("有个问题", "has a question"))
        XCTAssertTrue(question.exists, "a banner for the question")
        shot("question-banner")
        question.tap()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        let card = any("identifier BEGINSWITH 'ask-'")
        XCTAssertTrue(card.waitForExistence(timeout: 15), "the question card on the screen")
        XCTAssertTrue(any("label == %@", L("座位要靠窗还是靠过道？", "Window or aisle?")).waitForExistence(timeout: 5))
        sleep(1)
        shot("question-card")
        any("label == %@", L("靠窗", "Window")).tap()
        any("label == %@", L("发送回答", "Send answer")).tap()
        XCTAssertTrue(any("label CONTAINS %@", L("订了靠窗", "a window seat")).waitForExistence(timeout: 30), "the answer's reply, with the app open (no banner for it)")
        waitIdle()

        // 3. In the background: a side thread finishes. A tap opens that thread.
        XCUIDevice.shared.press(.home)
        sleep(2)
        let side = try XCTUnwrap(json(request("POST", "/threads", [:]))?["sessionId"] as? String)
        _ = request("POST", "/threads/\(side)/messages", ["text": L("整理一下行李清单。", "Make the packing list.")])
        let done = banner(L("做完了", "is done"))
        XCTAssertTrue(done.exists, "a banner for the side thread")
        shot("side-banner")
        done.tap()
        XCTAssertTrue(any("label CONTAINS %@", L("行李清单整理好了", "packing list is ready")).waitForExistence(timeout: 15), "the side thread on the screen")
        sleep(1)
        shot("side-thread")
        waitIdle()

        // 4. The app closed: a tap launches it on the thread the notification is about.
        app.terminate()
        sleep(2)
        _ = request("POST", "/threads/\(side)/messages", ["text": L("订酒店。", "Book the hotel.")])
        let cold = banner(L("做完了", "is done"))
        XCTAssertTrue(cold.exists, "a banner with the app closed")
        cold.tap()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
        XCTAssertTrue(any("label CONTAINS %@", L("酒店订好了", "hotel is booked")).waitForExistence(timeout: 30), "launched on the side thread")
        sleep(1)
        shot("cold-launch")
    }

    /// A notification banner whose text contains `text`: on the screen, or in Notification Center when it went by.
    func banner(_ text: String) -> XCUIElement {
        let match = NSPredicate(format: "label CONTAINS %@", text)
        let shown = springboard.descendants(matching: .any).matching(match).firstMatch
        if shown.waitForExistence(timeout: 40) { return shown }
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.0)).press(forDuration: 0.1, thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.6)))
        _ = shown.waitForExistence(timeout: 5)
        return shown
    }

    /// The bot has this phone's token (the app posts it after Allow).
    func waitForToken() { sleep(3) }

    func waitIdle() {
        let end = Date().addingTimeInterval(120)
        while Date() < end {
            let threads = (request("GET", "/threads").data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [[String: Any]]) ?? []
            if !threads.isEmpty && !threads.contains(where: { ($0["running"] as? Bool) == true }) { sleep(2); return }
            sleep(1)
        }
    }

    func id(_ identifier: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: identifier).firstMatch }
    func any(_ format: String, _ args: CVarArg...) -> XCUIElement { app.descendants(matching: .any).matching(NSPredicate(format: format, argumentArray: args)).firstMatch }

    func shot(_ screen: String) {
        guard let dir = env["PUSH_SHOTS"] else { return }
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: "\(dir)/push-ios-\(zh ? "zh" : "en")-\(scheme)-\(screen).png", contents: XCUIScreen.main.screenshot().pngRepresentation)
    }

    func request(_ method: String, _ p: String, _ body: [String: Any]? = nil) -> String {
        var req = URLRequest(url: URL(string: bot + p)!)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !token.isEmpty { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { req.httpBody = try? JSONSerialization.data(withJSONObject: body) }
        let done = DispatchSemaphore(value: 0)
        var out = ""
        URLSession.shared.dataTask(with: req) { data, _, _ in out = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""; done.signal() }.resume()
        _ = done.wait(timeout: .now() + 30)
        return out
    }
    func json(_ s: String) -> [String: Any]? { s.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any] }
}
