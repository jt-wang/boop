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
}
