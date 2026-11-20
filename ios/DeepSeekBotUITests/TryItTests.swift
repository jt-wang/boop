// The real shell with no host set, as a TestFlight build has it, in English and unpaired (uninstall the app first).
// Try it: Start, "Try a demo, no computer needed", an approval card, a message, Settings, leave. No computer or network.
// A bad invite: TailPocket's native bridge refuses it, and the person reads the sentence for that code. The headless
// tests stand in for the bridge, so only a run here shows that the native rejection still reaches the app as that code.
import XCTest

final class TryItTests: XCTestCase {
    let app = XCUIApplication()

    func id(_ s: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: s).firstMatch }
    func says(_ s: String) -> XCUIElement { app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", s)).firstMatch }
    /// The control itself: a group's label holds the text of everything inside it, so tapping by CONTAINS can hit the group.
    func named(_ s: String) -> XCUIElement { app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", s)).firstMatch }
    func shot(_ name: String) {
        guard let dir = ProcessInfo.processInfo.environment["SHOTS"] else { return }
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("try-\(name).png"))
    }

    override func setUp() {
        super.setUp()
        _ = QAPassTests.skipQuiescence
        continueAfterFailure = false
        app.launch()
        XCTAssertTrue(id("start").waitForExistence(timeout: 30), "the welcome screen")
        id("start").tap()
    }

    func testTryItOpensEveryPageOnMadeUpData() {
        XCTAssertTrue(id("try-it").waitForExistence(timeout: 15), "the connect screen offers Try it")
        id("try-it").tap()
        XCTAssertTrue(id("composer").waitForExistence(timeout: 15), "the thread")
        XCTAssertTrue(says("dentist").waitForExistence(timeout: 10), "the sample thread")
        shot("thread")

        let allow = named("Allow once")
        XCTAssertTrue(allow.waitForExistence(timeout: 10), "the approval card")
        allow.tap()
        XCTAssertTrue(says("how asking works").waitForExistence(timeout: 10), "the card's answer")

        id("composer").tap()
        id("composer").typeText("Book me a table")
        named("Send").tap()
        XCTAssertTrue(says("Book me a table").waitForExistence(timeout: 10), "the typed message in the thread")
        XCTAssertTrue(says("demo reply").waitForExistence(timeout: 10), "the sample reply")
        shot("reply")

        named("Settings").tap()
        XCTAssertTrue(id("demo-leave").waitForExistence(timeout: 10), "Settings on the sample")
        shot("settings")
        for _ in 0..<6 {
            if id("diagnostics-open").isHittable { break }
            app.swipeUp()
        }
        Thread.sleep(forTimeInterval: 2) // Quiescence is disabled; let the scroll stop before reading/tapping rows.
        XCTAssertTrue(id("diagnostics-open").exists)
        XCTAssertTrue(id("diagnostics-open").label.contains("Off"))
        XCTAssertFalse(id("diagnostics-enabled").exists)
        XCTAssertFalse(id("diagnostics-share").exists)
        shot("settings-diagnostics-entry")
        for _ in 0..<6 {
            if id("demo-leave").isHittable { break }
            app.swipeDown()
        }
        Thread.sleep(forTimeInterval: 2)
        id("demo-leave").tap()
        XCTAssertTrue(id("try-it").waitForExistence(timeout: 10), "back at the connect screen")
    }

    func testABadInviteSaysSoInWords() {
        // The connect screen opens on Scan; a pasted code is the other way in.
        XCTAssertTrue(id("paste-code").waitForExistence(timeout: 15), "the connect screen offers to paste a code")
        id("paste-code").tap()
        XCTAssertTrue(id("invite").waitForExistence(timeout: 10), "the field for the pasted code")
        id("invite").tap()
        id("invite").typeText("tailpocket1:not-a-real-invite")
        id("connect").tap()
        XCTAssertTrue(says("not a Boop pairing code").waitForExistence(timeout: 20), "the words for invalid-invite")
        shot("bad-invite")
    }

    func testLocalDiagnosticsRestartAndExplicitShare() {
        XCTAssertTrue(id("diagnostics-open").waitForExistence(timeout: 15))
        id("diagnostics-open").tap()
        XCTAssertTrue(named("Off").waitForExistence(timeout: 10))
        for category in ["interaction", "performance", "network", "resources"] {
            XCTAssertFalse(id("diagnostics-\(category)").isEnabled)
            XCTAssertEqual(id("diagnostics-\(category)").value as? String, "not checked")
        }
        shot("diagnostics-off")
        id("diagnostics-enabled").tap()
        for category in ["interaction", "performance", "network", "resources"] {
            XCTAssertTrue(id("diagnostics-\(category)").isEnabled)
            XCTAssertEqual(id("diagnostics-\(category)").value as? String, "not checked")
        }
        shot("diagnostics-no-categories")
        id("diagnostics-interaction").tap()
        id("diagnostics-resources").tap()
        id("diagnostics-retain").tap()
        XCTAssertTrue(named("Recording").exists)
        shot("diagnostics-on")
        // Real system sampling, not an accelerated clock or a mock bridge.
        Thread.sleep(forTimeInterval: 65)
        app.terminate()
        app.launch()
        XCTAssertTrue(id("diagnostics-open").waitForExistence(timeout: 15))
        id("diagnostics-open").tap()
        XCTAssertTrue(named("Off").waitForExistence(timeout: 10))
        for category in ["interaction", "performance", "network", "resources"] {
            XCTAssertFalse(id("diagnostics-\(category)").isEnabled)
            XCTAssertEqual(id("diagnostics-\(category)").value as? String, "not checked")
        }
        shot("diagnostics-restored-off")
        app.swipeUp()
        Thread.sleep(forTimeInterval: 2)
        id("diagnostics-export-interaction").tap()
        id("diagnostics-export-resources").tap()
        for _ in 0..<5 {
            if id("diagnostics-share").isHittable { break }
            app.swipeUp()
            Thread.sleep(forTimeInterval: 2) // let the scroll decelerate before tapping
        }
        id("diagnostics-share").press(forDuration: 0.1)
        XCTAssertTrue(named("Share diagnostic metadata?").waitForExistence(timeout: 10))
        XCTAssertFalse(says("No events in this range").exists)
        shot("diagnostics-confirm")
        named("Cancel").tap()
        XCTAssertTrue(id("diagnostics-share").exists)
        id("diagnostics-share").press(forDuration: 0.1)
        XCTAssertTrue(named("Share diagnostic metadata?").waitForExistence(timeout: 10))
        named("Share").tap()
        XCTAssertTrue(named("Copy").waitForExistence(timeout: 10), "the real system share sheet")
        XCTAssertTrue(named("Boop Diagnostics").exists, "the full product name in the system share preview")
        shot("diagnostics-share")
        named("Copy").tap()
        for _ in 0..<5 {
            if id("diagnostics-clear").isHittable { break }
            app.swipeDown()
            Thread.sleep(forTimeInterval: 2)
        }
        id("diagnostics-clear").tap()
    }
}
