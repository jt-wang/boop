// Walks the shell on a simulator against a stand-in bot on the Mac
// (BOT, default http://127.0.0.1:3861: POST /pair, GET /me, POST /push/subscribe,
// GET /subscriptions). Checks that a deepseekbot://pair link prefills the connect
// screen, that Connect asks for notification permission, and that the APNs
// token reaches the bot as { kind: "apns", token }.
import XCTest

final class PairAndPushTests: XCTestCase {
    let bot = ProcessInfo.processInfo.environment["BOT"] ?? "http://127.0.0.1:3861"

    func testPairLinkThenNotificationsReachTheBot() throws {
        let app = XCUIApplication()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        // A fresh install: launch once so the system registers the deepseekbot:// scheme, then quit.
        app.launch()
        app.terminate()

        // 1. Cold start from the link: the connect screen is prefilled.
        let pair = "\(bot)/pair?code=123456".addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
        XCUIDevice.shared.system.open(URL(string: "deepseekbot://pair?url=\(pair)")!)
        let openButton = springboard.buttons["Open"]
        if openButton.waitForExistence(timeout: 5) { openButton.tap() }
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        let connect = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Connect' OR identifier == 'connect'")).firstMatch
        XCTAssertTrue(connect.waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "value CONTAINS '123456' OR label CONTAINS '123456'")).firstMatch.waitForExistence(timeout: 5), "pairing code prefilled from the link")

        // 2. Connect: pairs with the bot, then the shell asks for notification permission.
        connect.tap()
        let allow = springboard.buttons["Allow"]
        XCTAssertTrue(allow.waitForExistence(timeout: 15), "notification permission alert")
        allow.tap()

        // 3. The bot has this simulator's token.
        let deadline = Date().addingTimeInterval(20)
        var subs: [[String: Any]] = []
        while Date() < deadline {
            let data = try? Data(contentsOf: URL(string: "\(bot)/subscriptions")!)
            subs = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [[String: Any]]) ?? []
            if !subs.isEmpty { break }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertEqual(subs.count, 1, "one subscription posted")
        XCTAssertEqual(subs.first?["kind"] as? String, "apns")
        let token = subs.first?["token"] as? String ?? ""
        // 32 bytes on a device, 80 on the simulator (measured 2026-10-27): hex of some length.
        XCTAssertNotNil(token.range(of: "^[0-9a-f]{32,}$", options: .regularExpression), "APNs token is hex: \(token)")

        // 4. The app went on to the next screen (the assistant has no name yet on the stand-in bot).
        XCTAssertTrue(app.staticTexts["What will you call your assistant?"].waitForExistence(timeout: 10), app.debugDescription)
    }
}
