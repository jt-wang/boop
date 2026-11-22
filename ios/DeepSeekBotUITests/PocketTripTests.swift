// A real pairing through TailPocket on a simulator, against a real bot on the Mac (npm start), so it needs the invite that bot
// printed: TEST_RUNNER_INVITE=tailpocket1:… xcodebuild test -only-testing:DeepSeekBotUITests/PocketTripTests
// The proof of connection is a sum only the model can answer, sent and read back through the tunnel; "connected" on screen is
// not evidence. Runs in English with an assistant already named. TEST_RUNNER_SHOTS names a folder for screenshots.
import XCTest

final class PocketTripTests: XCTestCase {
    let env = ProcessInfo.processInfo.environment
    let app = XCUIApplication()
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    func any(_ format: String) -> XCUIElement { app.descendants(matching: .any).matching(NSPredicate(format: format)).firstMatch }

    func shot(_ name: String) {
        guard let dir = env["SHOTS"] else { return }
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }

    func roundTrip(_ name: String) {
        let box = any("identifier == 'composer' OR label == 'Message' OR placeholderValue == 'Message'")
        XCTAssertTrue(box.waitForExistence(timeout: 40), "\(name): no composer")
        let x = Int.random(in: 100...499), y = Int.random(in: 500...999)
        box.tap()
        box.typeText("What is \(x) plus \(y)? Reply with only the number")
        any("label == 'Send'").tap()
        let started = Date()
        let answer = any("label == '\(x + y)'")
        XCTAssertTrue(answer.waitForExistence(timeout: 120), "\(name): no reply")
        print("TRIP \(name): reply through the tunnel after \(Int(Date().timeIntervalSince(started))) s")
    }

    func testInvitePairsAndAMessageGoesThroughTheTunnel() throws {
        guard let invite = env["INVITE"] else { throw XCTSkip("needs TEST_RUNNER_INVITE from a running bot") }
        continueAfterFailure = false
        app.launch()
        app.terminate()

        // The link a computer's QR holds, opened cold; the camera has nothing to scan on a simulator.
        XCUIDevice.shared.system.open(URL(string: "deepseekbot://pair?invite=\(invite)")!)
        let open = springboard.buttons["Open"]
        if open.waitForExistence(timeout: 5) { open.tap() }
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        let connect = any("identifier == 'connect'")
        XCTAssertTrue(connect.waitForExistence(timeout: 15))
        shot("ios-connect")
        let started = Date()
        connect.tap()
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 30) { allow.tap() }
        print("TRIP paired after \(Int(Date().timeIntervalSince(started))) s")
        // [compliance] the age question and the AI disclosure, on a bot with the consent gate
        for gate in ["age-adult", "consent-agree"] { let b = any("identifier == '\(gate)'"); if b.waitForExistence(timeout: 10) { b.tap() } }

        roundTrip("same network")
        shot("ios-thread")

        // Reopened: a new loopback port from a new tunnel, the same pairing.
        app.terminate()
        app.activate()
        roundTrip("reopened")
        shot("ios-reopened")

        any("label == 'Settings' OR identifier == 'settings'").tap()
        let security = any("label == 'End-to-end encrypted'")
        XCTAssertTrue(security.waitForExistence(timeout: 15), "Settings names the connection")
        shot("ios-settings")
        XCTAssertTrue(any("label == 'Through TailPocket to your computer'").waitForExistence(timeout: 15), "Settings names the path")
    }
    // TailPocket v0.3.2, without Tailcat: a bot started with `--routes lan` lists only the local network in its QR, and the
    // app pairs over it (the simulator shares the Mac's network). TEST_RUNNER_INVITE from that bot; it answers the emoji.
    func testWithoutTailcatTheInvitePairsOverTheLocalNetwork() throws {
        guard let invite = env["INVITE"] else { throw XCTSkip("needs TEST_RUNNER_INVITE from a bot started with --routes lan") }
        continueAfterFailure = false
        app.launch()
        app.terminate()
        XCUIDevice.shared.system.open(URL(string: "deepseekbot://pair?invite=\(invite)")!)
        let open = springboard.buttons["Open"]
        if open.waitForExistence(timeout: 5) { open.tap() }
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        let connect = any("identifier == 'connect'")
        XCTAssertTrue(connect.waitForExistence(timeout: 15))
        connect.tap()
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 30) { allow.tap() }
        for gate in ["age-adult", "consent-agree"] { let b = any("identifier == '\(gate)'"); if b.waitForExistence(timeout: 10) { b.tap() } }
        let settings = any("label == 'Settings' OR identifier == 'settings'")
        XCTAssertTrue(settings.waitForExistence(timeout: 60), "paired without Tailcat")
        settings.tap()
        XCTAssertTrue(any("label CONTAINS 'over the local network'").waitForExistence(timeout: 30), "Settings says the local network")
    }

    // Settings › Connection on a paired app: the row, the choices, and the state after switching to Local network only.
    // Leaves the phone on All routes again. TEST_RUNNER_SHOTS for the screenshots; run once per appearance.
    func testConnectionRowSwitchesRoutes() throws {
        guard env["INVITE"] != nil else { throw XCTSkip("needs a paired app and a running bot (TEST_RUNNER_INVITE)") }
        continueAfterFailure = false
        let style = env["STYLE"] ?? "light"
        app.launch()
        let settings = any("label == 'Settings' OR identifier == 'settings'")
        XCTAssertTrue(settings.waitForExistence(timeout: 30))
        settings.tap()
        let row = any("identifier == 'connection-row'")
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        XCTAssertTrue(any("label == 'Connected'").waitForExistence(timeout: 30))
        sleep(2)
        shot("ios-settings-connection-\(style)")
        row.tap()
        let lan = any("identifier == 'route-lan'")
        XCTAssertTrue(lan.waitForExistence(timeout: 10), "the choices")
        XCTAssertTrue(any("label CONTAINS 'Away from that network it does not connect'").exists, "what LAN only costs")
        sleep(1)
        shot("ios-connection-picker-\(style)")
        lan.tap()
        XCTAssertTrue(any("label == 'Connected'").waitForExistence(timeout: 30), "reconnected after the switch")
        XCTAssertTrue(any("label CONTAINS 'over the local network'").waitForExistence(timeout: 30), "the way there after the switch")
        sleep(1)
        shot("ios-connection-switched-\(style)")
        // a route the computer does not offer (a --routes lan computer has no relay): the page says so, no silent fallback
        any("identifier == 'route-relay'").tap()
        XCTAssertTrue(any("label CONTAINS 'This way does not reach the computer'").waitForExistence(timeout: 60), "says Relay only reaches nothing")
        shot("ios-connection-unreachable-\(style)")
        any("identifier == 'route-all'").tap()
        XCTAssertTrue(any("label == 'Connected'").waitForExistence(timeout: 30))
    }

    // An example exchange for the screenshots, sent while the computer answers (the bot runs a fake model).
    func testSayExample() throws {
        guard env["INVITE"] != nil else { throw XCTSkip("needs a paired app and a running bot") }
        continueAfterFailure = false
        app.launch()
        let box = any("identifier == 'composer' OR label == 'Message' OR placeholderValue == 'Message'")
        XCTAssertTrue(box.waitForExistence(timeout: 40))
        box.tap()
        box.typeText("Can I fit the dentist in tomorrow?")
        any("label == 'Send'").tap()
        XCTAssertTrue(any("label CONTAINS 'the dentist at 4 works'").waitForExistence(timeout: 60), "the example reply")
    }

    // TailPocket v0.3.4+: with the computer side stopped (refused) or frozen (no answer), the chat and Settings say why,
    // from the same state as Status, and keep the pairing. TEST_RUNNER_REASON: not-running or no-answer.
    func testUnreachableSaysWhy() throws {
        guard let reason = env["REASON"] else { throw XCTSkip("needs a paired app whose computer is unreachable (TEST_RUNNER_REASON)") }
        continueAfterFailure = false
        let style = env["STYLE"] ?? "light"
        let words = reason == "not-running" ? "Boop isn't running on the computer" : "Check it's on and awake"
        app.launch()
        let card = any("identifier == 'offline-reason'")
        XCTAssertTrue(card.waitForExistence(timeout: 90), "the chat says why")
        XCTAssertTrue(any("label CONTAINS \"\(words)\"").exists, "the same words as Settings: \(reason)")
        XCTAssertTrue(any("label CONTAINS \"Can't reach\"").exists, "the header agrees")
        sleep(1)
        shot("ios-unreach-chat-\(reason)-\(style)")
        let box = any("identifier == 'composer' OR label == 'Message' OR placeholderValue == 'Message'")
        box.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
        sleep(1)
        XCTAssertTrue(card.isHittable, "the keyboard leaves the reason in view")
        shot("ios-unreach-kb-\(reason)-\(style)")
        any("identifier == 'status'").tap() // not connected: the status opens Settings
        XCTAssertTrue(any("identifier == 'computer-status'").waitForExistence(timeout: 10), "the status opened Settings")
        XCTAssertTrue(any("label CONTAINS \"\(words)\"").waitForExistence(timeout: 30), "Settings says why: \(reason)")
        XCTAssertFalse(any("label == 'Finding the route…'").exists, "the Connection row follows Status")
        XCTAssertEqual(any("identifier == 'repair'").exists, reason == "not-running", "Pair again only for a reset computer")
        sleep(1)
        shot("ios-unreach-\(reason)-\(style)")
        guard reason == "not-running" else { return }
        any("identifier == 'repair'").tap()
        XCTAssertTrue(any("label CONTAINS \"Scan only the code shown on your own computer's screen\"").waitForExistence(timeout: 10))
        sleep(1)
        shot("ios-repair-\(style)")
    }
}
