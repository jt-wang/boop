// The device check for two thread gaps, on the real shell against a real bot and the real
// model. Skipped unless GAPS_BOT is set. Env (TEST_RUNNER_ prefixed on the xcodebuild command line):
//   GAPS_BOT     the bot's address (http://127.0.0.1:3977)
//   GAPS_CODE    the six digits from its pairing link
//   GAPS_SECRET  the bot's DEEPSEEK_BOT_HOST_SECRET: the test pairs a device of its own to send and to see when a turn ends
//   GAPS_LANG    zh | en      GAPS_SCHEME  dark | light      GAPS_SHOTS  where the screenshots go
// It checks: 1. after "write me a haiku and save it as haiku.md", the file card under the reply opens the file page;
// 2. scrolled up in a long thread, a question that arrives is on screen above the composer and answerable there.
import XCTest

final class ThreadGapsTests: XCTestCase {
    let env = ProcessInfo.processInfo.environment
    var bot: String { env["GAPS_BOT"] ?? "" }
    var zh: Bool { env["GAPS_LANG"] == "zh" }
    var app: XCUIApplication!
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    var token = ""
    var session = ""

    func L(_ zhText: String, _ en: String) -> String { zh ? zhText : en }

    func testThreadGaps() throws {
        try XCTSkipIf(bot.isEmpty, "GAPS_BOT not set")
        continueAfterFailure = true
        XCUIDevice.shared.appearance = env["GAPS_SCHEME"] == "dark" ? .dark : .light
        app = XCUIApplication()
        app.launch(); app.terminate()

        // pair from the link, as a person does
        let code = try XCTUnwrap(env["GAPS_CODE"])
        let pair = "\(bot)/pair?code=\(code)".addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
        XCUIDevice.shared.system.open(URL(string: "deepseekbot://pair?url=\(pair)")!)
        for label in ["Open", "打开"] { let b = springboard.buttons[label]; if b.waitForExistence(timeout: 3) { b.tap(); break } }
        XCTAssertTrue(id("connect").waitForExistence(timeout: 15), "connect screen")
        id("connect").tap()
        for label in ["Allow", "允许"] { let b = springboard.buttons[label]; if b.waitForExistence(timeout: 5) { b.tap(); break } }
        for gate in ["age-adult", "consent-agree", "name-go"] { let b = id(gate); if b.waitForExistence(timeout: 6) { b.tap() } }
        XCTAssertTrue(id("composer").waitForExistence(timeout: 60), "the thread")
        token = (json(request("POST", "/pair", ["hostSecret": env["GAPS_SECRET"] ?? "", "name": "gaps-driver"], nil))?["token"] as? String) ?? ""
        session = (json(request("POST", "/sessions/main", [:], token))?["sessionId"] as? String) ?? ""
        XCTAssertFalse(token.isEmpty || session.isEmpty, "the driver paired")

        // 1. the file it wrote: a card under the reply, which opens the file page
        send(L("给我写一首俳句，存成 haiku.md", "Write me a haiku and save it as haiku.md"))
        waitIdle()
        let card = any("identifier BEGINSWITH 'file-changed:'")
        XCTAssertTrue(card.waitForExistence(timeout: 30), "a card for the file it wrote")
        sleep(2)
        shot("file-card")
        XCTAssertTrue(card.label.contains("haiku.md"), "the card is named haiku.md: \(card.label)")
        card.tap()
        XCTAssertTrue(id("delete-file").waitForExistence(timeout: 15), "the file page")
        sleep(2)
        shot("file-page")
        back()

        // 2. a long thread, scrolled up; then the assistant asks a question. Approvals sit in the same place; none
        // reaches a card in an ordinary session here (asked to write outside its folder, the request was refused before
        // any card), so they are covered by the headless tests.
        send(L("列出里斯本 25 个值得去的地方，每个两句话。不要用卡片，直接用文字列表。", "List 25 places worth visiting in Lisbon, two sentences each. No card, a plain text list."))
        waitIdle()
        let thread = id("thread")
        for _ in 0..<3 { thread.swipeDown(velocity: .fast) }
        sleep(1)
        shot("scrolled-up")
        // a plain reply while scrolled up: the list stays where the person is
        send(L("只回一个字：好", "Reply with one word: OK"))
        waitIdle(); sleep(1)
        shot("reply-scrolled-up")
        for _ in 0..<3 { thread.swipeDown(velocity: .fast) }
        sleep(1)
        send(L("在继续之前，用提问工具问我一个问题：喝茶还是咖啡？给两个选项。", "Before anything else, use your question tool to ask me: tea or coffee? Two options."))
        shot("question-sent-scrolled-up")
        if let question = waitAsk("question") {
            sleep(2)
            shot("question-scrolled-up")
            let cardView = id("ask-\(question)")
            XCTAssertTrue(cardView.exists && cardView.isHittable, "the question card is on screen while scrolled up")
            XCTAssertTrue(id("pinned-asks").exists, "it sits above the composer")
            tapLabel(L("咖啡", "Coffee")); tapLabel(L("发送回答", "Send answer"))
            sleep(2)
            shot("question-answered")
        } else { XCTFail("no question within 180 s") }
        waitIdle()
        shot("after")
    }

    // the driver's device sends, so the keyboard never comes up and the list stays where the person left it
    func send(_ text: String) { _ = request("POST", "/threads/\(session)/messages", ["text": text], token); sleep(3) }
    func waitAsk(_ kind: String) -> String? {
        for _ in 0..<180 {
            if let a = (jsonArray(request("GET", "/asks", nil, token)) ?? []).first(where: { ($0["kind"] as? String) == kind }) { return a["eventId"] as? String }
            sleep(1)
        }
        return nil
    }
    func waitIdle() {
        var idle = 0
        for _ in 0..<300 {
            if !(jsonArray(request("GET", "/asks", nil, token)) ?? []).isEmpty { return }
            let running = (jsonArray(request("GET", "/threads", nil, token)) ?? []).contains { ($0["running"] as? Bool) == true }
            idle = running ? 0 : idle + 1
            if idle >= 4 { return }
            sleep(1)
        }
    }

    func id(_ identifier: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: identifier).firstMatch }
    func any(_ format: String) -> XCUIElement { app.descendants(matching: .any).matching(NSPredicate(format: format)).firstMatch }
    @discardableResult func tapLabel(_ label: String) -> Bool {
        let e = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).allElementsBoundByIndex.filter { $0.isHittable }.last
        e?.tap(); return e != nil
    }
    func back() {
        let b = app.navigationBars.buttons.element(boundBy: 0)
        if b.exists && b.isHittable { b.tap() } else { app.swipeRight() }
        sleep(1)
    }
    func shot(_ screen: String) {
        guard let dir = env["GAPS_SHOTS"] else { return }
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let scheme = env["GAPS_SCHEME"] ?? "light"
        FileManager.default.createFile(atPath: "\(dir)/ios-\(env["GAPS_LANG"] ?? "en")-\(scheme)-\(screen).png", contents: XCUIScreen.main.screenshot().pngRepresentation)
    }

    private func request(_ method: String, _ p: String, _ body: [String: Any]?, _ tok: String?) -> String {
        var req = URLRequest(url: URL(string: bot + p)!)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let tok, !tok.isEmpty { req.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization") }
        if let body { req.httpBody = try? JSONSerialization.data(withJSONObject: body) }
        let done = DispatchSemaphore(value: 0)
        var out = ""
        URLSession.shared.dataTask(with: req) { data, _, _ in out = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""; done.signal() }.resume()
        _ = done.wait(timeout: .now() + 30)
        return out
    }
    private func json(_ s: String) -> [String: Any]? { s.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any] }
    private func jsonArray(_ s: String) -> [[String: Any]]? { s.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [[String: Any]] }
}
