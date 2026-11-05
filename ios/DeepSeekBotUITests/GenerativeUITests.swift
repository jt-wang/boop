// Generative UI, second layer, on the simulator against a real bot (the model
// behind it answers for real). BOT: the bot's address; PAIR_CODE: the six digits
// from its pairing link (used when the app is not paired yet); HOST_SECRET: the
// bot's DEEPSEEK_BOT_HOST_SECRET, which lets the test pair a device of its own and
// send the prompt over HTTP (typing into the thread is not what is under test);
// SHOTS: a directory on the Mac for the screenshots.
//
// Pairs from the link when needed, asks for a tip calculator, waits for the bot's
// activity log to say the interface was built, taps Open on the module card,
// screenshots the sheet in light and dark, uses the module and checks the thread
// shows its answer.
import XCTest

final class GenerativeUITests: XCTestCase {
    let env = ProcessInfo.processInfo.environment
    var bot: String { env["BOT"] ?? "http://127.0.0.1:3887" }

    func testTipCalculatorModuleOpensInASheet() throws {
        let shots = env["SHOTS"]
        let app = XCUIApplication()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        app.launch()
        let any = { (predicate: String) in app.descendants(matching: .any).matching(NSPredicate(format: predicate)).firstMatch }

        // 1. Paired already (the thread) or not (pair from the link, name the assistant).
        let composer = any("identifier == 'composer'")
        if !composer.waitForExistence(timeout: 10) {
            let code = try XCTUnwrap(env["PAIR_CODE"], "PAIR_CODE: the app is not paired and the test has no code")
            app.terminate()
            let pair = "\(bot)/pair?code=\(code)".addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
            XCUIDevice.shared.system.open(URL(string: "deepseekbot://pair?url=\(pair)")!)
            let openButton = springboard.buttons["Open"]
            if openButton.waitForExistence(timeout: 5) { openButton.tap() }
            XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
            let connect = any("label == 'Connect' OR identifier == 'connect'")
            XCTAssertTrue(connect.waitForExistence(timeout: 15), app.debugDescription)
            connect.tap()
            let allow = springboard.buttons["Allow"]
            if allow.waitForExistence(timeout: 10) { allow.tap() }
            let name = any("identifier == 'name'")
            XCTAssertTrue(name.waitForExistence(timeout: 20), app.debugDescription)
            name.tap()
            name.typeText("Nori")
            // [compliance] the age question and the AI disclosure come before naming on a bot with the consent gate
            for gate in ["age-adult", "consent-agree"] { let b = any("identifier == '\(gate)'"); if b.waitForExistence(timeout: 10) { b.tap() } }
            let go = any("label == 'Continue' OR identifier == 'name-go'")
            XCTAssertTrue(go.waitForExistence(timeout: 5))
            go.tap()
            XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        }

        // 2. The test's own device: pairs with the host secret, finds the main thread, sends the prompt.
        let secret = try XCTUnwrap(env["HOST_SECRET"], "HOST_SECRET: the bot's DEEPSEEK_BOT_HOST_SECRET")
        let token = try XCTUnwrap(json(post("/pair", ["hostSecret": secret, "name": "ui-test"]))?["token"] as? String, "paired with the host secret")
        var main: String?
        let untilMain = Date().addingTimeInterval(30)
        while main == nil && Date() < untilMain {
            main = json(get("/me", token))?["mainSessionId"] as? String
            if main == nil { Thread.sleep(forTimeInterval: 1) }
        }
        let sessionId = try XCTUnwrap(main, "the app opened its main thread")
        let before = (json(get("/activity", token), array: true) ?? []).count
        _ = post("/threads/\(sessionId)/messages", ["text": "Make me a tip calculator for a €42 bill with 10/15/20% buttons; use the ui tool."], token)

        // 3. The bot built the interface (its activity log says so), then the card with Open is on screen.
        let untilBuilt = Date().addingTimeInterval(240)
        var built = false
        while !built && Date() < untilBuilt {
            let entries = json(get("/activity", token), array: true) ?? []
            built = entries.prefix(max(0, entries.count - before) + 5).contains { ($0["kind"] as? String) == "ui" }
            if !built { Thread.sleep(forTimeInterval: 3) }
        }
        XCTAssertTrue(built, "the activity log has a 'ui' entry: \(get("/activity", token).prefix(500))")
        Thread.sleep(forTimeInterval: 2)
        let opens = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'open-'"))
        XCTAssertTrue(opens.firstMatch.waitForExistence(timeout: 30), "the module card with Open: \(app.debugDescription.suffix(2000))")
        let open = opens.allElementsBoundByIndex.last!   // the newest module (an earlier run may have left one above)
        let tapped = Date()
        open.tap()
        let done = app.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 60), "the sheet with Done: \(app.debugDescription.suffix(2000))")
        let twenty = any("label == '20%'")
        XCTAssertTrue(twenty.waitForExistence(timeout: 30), "the module drew its buttons: \(app.debugDescription.suffix(2000))")
        let openMs = Int(Date().timeIntervalSince(tapped) * 1000)
        print("[genui] Open tapped → module drawn in \(openMs) ms")
        Thread.sleep(forTimeInterval: 1)
        save(XCUIScreen.main.screenshot(), as: "mobile-genui-light.png", in: shots)
        XCUIDevice.shared.appearance = .dark
        Thread.sleep(forTimeInterval: 1.5)
        save(XCUIScreen.main.screenshot(), as: "mobile-genui-dark.png", in: shots)
        XCUIDevice.shared.appearance = .light

        // 4. Use it: the module posts its result, closes itself, and the thread shows the answer.
        twenty.tap()
        Thread.sleep(forTimeInterval: 0.5)
        // the module's own send button: a hittable button inside the sheet (the thread's Open sits behind it)
        let use = app.buttons.matching(NSPredicate(format: "NOT (label IN {'10%', '15%', '20%', 'Done'}) AND NOT (identifier BEGINSWITH 'open-')")).allElementsBoundByIndex.filter { $0.isHittable }.last
        XCTAssertNotNil(use, "a button to send the result: \(app.debugDescription.suffix(2000))")
        use?.tap()
        let answered = any("label BEGINSWITH 'Answered:'")
        XCTAssertTrue(answered.waitForExistence(timeout: 60), "the row shows Answered: \(app.debugDescription.suffix(2000))")
        XCTAssertFalse(done.exists, "the sheet closed itself (ui.close)")
        print("[genui] \(answered.label)")
        Thread.sleep(forTimeInterval: 1)
        save(XCUIScreen.main.screenshot(), as: "mobile-genui-answered-light.png", in: shots)
    }

    // MARK: the bot over HTTP

    private func request(_ method: String, _ path: String, _ body: [String: Any]?, _ token: String?) -> String {
        var req = URLRequest(url: URL(string: bot + path)!)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { req.httpBody = try? JSONSerialization.data(withJSONObject: body) }
        let done = DispatchSemaphore(value: 0)
        var out = ""
        URLSession.shared.dataTask(with: req) { data, _, _ in out = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""; done.signal() }.resume()
        _ = done.wait(timeout: .now() + 30)
        return out
    }
    private func get(_ path: String, _ token: String? = nil) -> String { request("GET", path, nil, token) }
    private func post(_ path: String, _ body: [String: Any], _ token: String? = nil) -> String { request("POST", path, body, token) }
    private func json(_ s: String) -> [String: Any]? { s.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any] }
    private func json(_ s: String, array: Bool) -> [[String: Any]]? { s.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [[String: Any]] }

    private func save(_ shot: XCUIScreenshot, as name: String, in dir: String?) {
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let dir else { return }
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let ok = FileManager.default.createFile(atPath: "\(dir)/\(name)", contents: shot.pngRepresentation)
        print("[genui] screenshot \(name) → \(dir): \(ok)")
    }
}
