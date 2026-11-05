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
}
