// [compliance] The store obligations on the real shell, against the stand-in bot
// test/fixtures/compliance-bot.ts (a real bot server, a real signed interface that asks for the clipboard, no model).
// Skipped unless CB_BOT is set. Env (TEST_RUNNER_ prefixed on the xcodebuild command line):
//   CB_BOT     the bot's address (http://127.0.0.1:3895)
//   CB_CODE    the pairing code it printed
//   CB_MODULE  the interface id it printed
//   CB_LANG    zh | en      CB_SCHEME  dark | light
//   CB_SHOTS   where the screenshots go: compliance-ios-<lang>-<scheme>-<screen>.png
// Pair → the age question → the AI disclosure → name → long-press a reply → Report → thanks → Settings → AI provider →
// a deepseekbot://ui link opens the interface → Open asks for the clipboard → Allow: the module's clipboard works →
// switch it off → Open → Don't allow: the module's clipboard is refused (the shell grants only what was allowed).
import XCTest

final class ComplianceTests: XCTestCase {
    let env = ProcessInfo.processInfo.environment
    var zh: Bool { env["CB_LANG"] == "zh" }
    var app: XCUIApplication!
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    func L(_ zhText: String, _ en: String) -> String { zh ? zhText : en }
    func id(_ s: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: s).firstMatch }
    func any(_ format: String) -> XCUIElement { app.descendants(matching: .any).matching(NSPredicate(format: format)).firstMatch }
    func shot(_ name: String) {
        guard let dir = env["CB_SHOTS"] else { return }
        let scheme = env["CB_SCHEME"] ?? "light"
        FileManager.default.createFile(atPath: "\(dir)/compliance-ios-\(zh ? "zh" : "en")-\(scheme)-\(name).png", contents: XCUIScreen.main.screenshot().pngRepresentation)
    }
    func openURL(_ s: String) {
        XCUIDevice.shared.system.open(URL(string: s)!)
        for label in ["Open", "打开"] { let b = springboard.buttons[label]; if b.waitForExistence(timeout: 3) { b.tap(); break } }
    }
    func tapAlert(_ labels: [String]) {
        for label in labels {
            let inApp = app.alerts.buttons[label]; if inApp.waitForExistence(timeout: 2) { inApp.tap(); return }
            let sheet = app.sheets.buttons[label]; if sheet.exists { sheet.tap(); return }
            let any = app.buttons[label]; if any.exists { any.tap(); return }
        }
        XCTFail("no button \(labels): \(app.debugDescription.suffix(1500))")
    }

    func testComplianceFlowsOnTheShell() throws {
        guard let bot = env["CB_BOT"], !bot.isEmpty else { throw XCTSkip("CB_BOT not set") }
        let code = try XCTUnwrap(env["CB_CODE"]), module = try XCTUnwrap(env["CB_MODULE"])
        continueAfterFailure = false
        XCUIDevice.shared.appearance = env["CB_SCHEME"] == "dark" ? .dark : .light
        app = XCUIApplication()
        app.launch()
        app.terminate()

        // pair from the link (the shell hands it over at launch), then launch again in the language under test
        let pair = "\(bot)/pair?code=\(code)".addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
        openURL("deepseekbot://pair?url=\(pair)")
        let connect = id("connect")
        XCTAssertTrue(connect.waitForExistence(timeout: 15), "connect screen")
        connect.tap()
        for label in ["Allow", "允许"] { let b = springboard.buttons[label]; if b.waitForExistence(timeout: 5) { b.tap(); break } }
        XCTAssertTrue(id("age-adult").waitForExistence(timeout: 30), "paired")
        app.terminate()
        app.launchArguments += zh ? ["-AppleLanguages", "(zh-Hans-CN)", "-AppleLocale", "zh_CN"] : ["-AppleLanguages", "(en-US)", "-AppleLocale", "en_US"]
        app.launch()

        // 4.7.5: the age question before anything else
        let adult = id("age-adult")
        XCTAssertTrue(adult.waitForExistence(timeout: 30), "age question: \(app.debugDescription.suffix(1500))")
        shot("age")
        adult.tap()
        // 5.1.2(i): the provider by name before the first message
        XCTAssertTrue(id("consent-title").waitForExistence(timeout: 15), "AI disclosure")
        XCTAssertTrue(any("label CONTAINS 'SiliconFlow'").exists)
        shot("consent")
        id("consent-agree").tap()
        let go = id("name-go")
        XCTAssertTrue(go.waitForExistence(timeout: 15), "naming")
        go.tap()
        XCTAssertTrue(id("composer").waitForExistence(timeout: 30), "the thread")

        // 1.2: report a reply from the reply itself
        let reply = any("label CONTAINS 'Rain taps the window'")
        XCTAssertTrue(reply.waitForExistence(timeout: 30), "the reply")
        if app.keyboards.count > 0 { app.swipeDown() }
        shot("chat")
        // the reply's row (msg-0, the newest) hears the long press; its text is selectable and keeps a long press on the words for itself
        let row = id("msg-0")
        (row.exists ? row : reply).press(forDuration: 1.2)
        let report = app.buttons[L("举报", "Report")]
        XCTAssertTrue(report.waitForExistence(timeout: 5), "the reply's menu: \(app.debugDescription.suffix(1500))")
        shot("reply-menu")
        report.tap()
        XCTAssertTrue(id("reason-harmful").waitForExistence(timeout: 10), "report page")
        id("reason-harmful").tap()
        shot("report")
        id("report-send").tap()
        XCTAssertTrue(id("report-sent").waitForExistence(timeout: 10), "acknowledgement")
        shot("report-sent")
        id("report-done").tap()

        // 5.1.1: Settings → About: AI provider, privacy policy, terms
        app.buttons[L("设置", "Settings")].firstMatch.tap()
        let providerRow = id("ai-provider-row")
        for _ in 0..<6 where !providerRow.isHittable { app.swipeUp() }
        XCTAssertTrue(providerRow.waitForExistence(timeout: 5))
        shot("settings-about")
        providerRow.tap()
        XCTAssertTrue(id("stop-sharing").waitForExistence(timeout: 5))
        shot("ai-provider")
        app.navigationBars.buttons.firstMatch.tap()
        app.navigationBars.buttons.firstMatch.tap()

        // 4.7.4: a link to the interface opens its page; 4.7.3: consent per interface; 4.7.2: only what was allowed
        openURL("deepseekbot://ui/\(module)?origin=\(bot.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)")
        XCTAssertTrue(id("if-title").waitForExistence(timeout: 15), "the interface's page: \(app.debugDescription.suffix(1500))")
        shot("interface")
        id("if-open").tap()
        XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: 10), "asks for the clipboard")
        shot("permission")
        tapAlert([L("允许", "Allow")])
        let tryIt = any("label == 'Try the clipboard'")
        XCTAssertTrue(tryIt.waitForExistence(timeout: 30), "the module in its sheet")
        tryIt.tap()
        XCTAssertTrue(any("label == 'clipboard: allowed'").waitForExistence(timeout: 10), "allowed: the module reaches the clipboard")
        shot("module-allowed")
        any("label == 'Close'").tap()
        sleep(2) // the page reads the interface again after it opened: the switch shows the yes just given
        XCTAssertTrue(id("grant-clipboard").waitForExistence(timeout: 10))
        id("grant-clipboard").tap() // switch it off
        sleep(1)
        id("if-open").tap()
        XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: 10), "asks again")
        tapAlert([L("不允许", "Don't allow")])
        XCTAssertTrue(tryIt.waitForExistence(timeout: 30))
        tryIt.tap()
        XCTAssertTrue(any("label == 'clipboard: refused'").waitForExistence(timeout: 10), "not allowed: the shell refuses the clipboard")
        shot("module-refused")
        any("label == 'Close'").tap()
    }
}
