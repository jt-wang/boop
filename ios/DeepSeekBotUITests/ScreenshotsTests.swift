// The screenshot baseline and layout probe of the chat on iOS (REGRESSION.md, "UI: screenshots and layout"), as
// android ScreenshotsTest: on the demo thread (Try it: made-up rows, no bot), light and dark, keyboard down and up, the
// system text size at its default and at Extra Extra Extra Large (the 130 % of Android's pass, roughly). In each: the date
// line starts below the top chrome, the composer and its Send button are above the keyboard and inside the screen's sides,
// no line of text runs past them, the bottom chrome around the pinned card shows no message through it, the last message
// at the end of the thread is above the card, Decline and Allow once stay whole and hittable with what the card asks
// scrolled to its end inside it (and Allow once, tapped at the end, answers the card), and the app is in the theme, text size and keyboard state the capture's name
// says. Run on a default iPhone and on an iPhone SE (375 points wide; SHOTS_SMALL=1 says the run is that one, and the test
// checks the width). Each state's screenshot goes to SHOTS as ios-chat-[small-]<theme>-font<100|130>[-keyboard].png.
// Uninstall the app first: the demo opens from the welcome screen.
import XCTest

final class ScreenshotsTests: XCTestCase {
    let app = XCUIApplication()
    let env = ProcessInfo.processInfo.environment
    // chat.tsx: 8 points under the status pill before the first row (iOS has no top fade)
    let barBottom: CGFloat = 8

    func id(_ s: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: s).firstMatch }

    override func setUp() {
        super.setUp()
        _ = QAPassTests.skipQuiescence
        // every state is checked and each state's problems are recorded as found (below): one red state does not hide the next
        continueAfterFailure = true
    }

    override func tearDown() {
        XCUIDevice.shared.appearance = .light
        super.tearDown()
    }

    func testTheChatInEveryModeHasNothingUnderItsChromeOrTheKeyboard() throws {
        let small = env["SHOTS_SMALL"] == "1"
        // SHOTS_THEME=light|dark: one theme per run, the simulator already in it (scripts/ios-shots.sh sets it with simctl:
        // XCUIDevice.appearance is ignored under xcodebuild on the iOS 26 runtime); unset, both themes
        let nights = env["SHOTS_THEME"].map { [$0 == "dark"] } ?? [false, true]
        var bad: [String] = []
        var dividerHeight: CGFloat = 0, reported = 0
        for (font, size) in [("100", "UICTContentSizeCategoryL"), ("130", "UICTContentSizeCategoryXXXL")] {
            for night in nights {
                open(night: night, size: size)
                let width = app.frame.width
                if small && abs(width - 375) > 1 { bad.append("small: the app is \(width) points wide, not 375") }
                if !small && width < 390 { bad.append("the default pass is on a \(width)-point screen: run it on a default iPhone") }
                for keyboard in [false, true] {
                    let state = (small ? "small-" : "") + (night ? "dark" : "light") + "-font" + font + (keyboard ? "-keyboard" : "")
                    if keyboard { keyboardUp() } else { keyboardDown() }
                    toTheTop()
                    let shot = XCUIScreen.main.screenshot()
                    keep(state, shot)
                    if let dir = env["SHOTS"] {
                        try? shot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("ios-chat-\(state).png"))
                    }
                    // the text size as named: the date line is clearly taller at the large size than at the default
                    let h = id("time-divider").exists ? id("time-divider").frame.height : 0
                    if font == "100" { dividerHeight = max(dividerHeight, h) }
                    else if h < dividerHeight * 1.15 { bad.append("\(state): the date line is \(h) points tall, \(dividerHeight) at the default size: the text size did not grow") }
                    bad += probe(state, keyboard: keyboard, night: night, shot: shot)
                    bad += noTextPastTheSides(state)
                    bad += nothingShowsThroughUnderTheCard(state, shot: shot)
                    toTheEnd()
                    keep("\(state)-end")
                    // on a default iPhone every state has the room for the whole last message: never the exception there
                    bad += theLastMessageAtTheEnd(state, keyboard: keyboard, mustFit: !small)
                    bad += theRequestIsWhole(state, first)
                    bad += theButtonsStayInReach(state)
                    keep("\(state)-card-end")
                    // this state's problems on record now: a crash in a later state would otherwise lose them
                    for b in bad[reported...] { record(XCTIssue(type: .assertionFailure, compactDescription: b)) }
                    reported = bad.count
                }
            }
        }
        // the card's main button answers when tapped, here in the tightest state (largest text, keyboard up, the card
        // scrolled to its end): the card goes, the demo's answer comes
        named("Allow once").tap()
        let gone = NSPredicate(format: "exists == false")
        if XCTWaiter.wait(for: [expectation(for: gone, evaluatedWith: id("pinned-asks"))], timeout: 10) != .completed { bad.append("Allow once tapped at the end: the card is still there") }
        for b in bad[reported...] { record(XCTIssue(type: .assertionFailure, compactDescription: b)) }
        reported = bad.count
        // Two different cards in the tightest state (largest text, keyboard up), light and dark: the demo's and one more
        // that only a debug build takes from a test (-BoopTestAsks). One shows at a time; the pager reaches the other;
        // answering one shows the next; both answered, none is left.
        for night in nights {
            open(night: night, size: "UICTContentSizeCategoryXXXL", asks: [(second, "mcp__browser__browser_navigate")])
            keyboardUp()
            toTheEnd()
            bad += twoCards((small ? "small-" : "") + (night ? "dark" : "light"))
            for b in bad[reported...] { record(XCTIssue(type: .assertionFailure, compactDescription: b)) }
            reported = bad.count
        }
        if nights.contains(false) { bad += titlesPerCard(small ? "small-" : "") }
        for b in bad[reported...] { record(XCTIssue(type: .assertionFailure, compactDescription: b)) }
        reported = bad.count
    }

    let first = "Delete 3 old files in Downloads", second = "Open the airline site in the browser"

    /// Two cards with the keyboard up. The last message on each page by theLastMessageAtTheEnd: whole where there is the room,
    /// and on a default iPhone there always is.
    func twoCards(_ mode: String) -> [String] {
        var bad: [String] = []
        let last = { (state: String) in self.theLastMessageAtTheEnd(state, keyboard: true, mustFit: !mode.hasPrefix("small-")) }
        let count = id("ask-count")
        guard count.waitForExistence(timeout: 10) else { return ["\(mode) two cards: no pager (ask-count)"] }
        let shows = { (s: String) in self.named(s).exists }
        // what a screen reader says, and where each card is
        let page = { (want: String, on: String, off: String, state: String) in
            if count.label != want { bad.append("\(state): the pager reads \"\(count.label)\", not \"\(want)\"") }
            if !shows(on) { bad.append("\(state): \"\(on)\" does not show") }
            if shows(off) { bad.append("\(state): \"\(off)\" shows too") }
        }
        page("Request 1 of 2", first, second, "\(mode) two cards, first")
        // the pager is in the card's title row, not a row of its own
        let head = id("ask-head").frame
        for name in ["ask-previous", "ask-next"] where id(name).exists {
            let r = id(name).frame
            if r.midY < head.minY || r.midY > head.maxY { bad.append("\(mode) two cards: \(name) \(r) is not in the card's title row \(head)") }
        }
        // the pager's two buttons: 44 points or more each way, inside the screen, above the keyboard, hittable
        let kb = app.keyboards.firstMatch
        let above = kb.exists && kb.frame.height > 0 ? kb.frame.minY : app.frame.maxY
        for name in ["ask-previous", "ask-next"] {
            let e = id(name), r = e.frame
            if !e.exists { bad.append("\(mode) two cards: \(name) is not on screen"); continue }
            if r.width < 44 || r.height < 44 { bad.append("\(mode) two cards: \(name) is \(r.width) by \(r.height) points, under 44") }
            if r.maxY > above + 1 { bad.append("\(mode) two cards: \(name) ends at \(r.maxY), under the keyboard at \(above)") }
            if !e.isHittable { bad.append("\(mode) two cards: \(name) is not hittable") }
        }
        // the title: whole wherever it fits beside the pager (one line with an ellipsis only where it does not), read whole
        // kept to one line only where the wrapped title would push the last message under the fade: on record, per device
        print("BOOP-TITLE \(mode) \(app.frame.width)pt: \(id("ask-title-one-line").exists ? "one line" : "wrapped")")
        let title = id("ask-title").exists ? id("ask-title") : id("ask-title-one-line")
        if title.label != "Running a command" { bad.append("\(mode) two cards: the title reads \"\(title.label)\", not \"Running a command\"") }
        bad += last("\(mode) two cards, first")
        bad += theRequestIsWhole("\(mode) two cards, first", first)
        bad += theButtonsStayInReach("\(mode) two cards, first")
        keep("\(mode)-two-cards-1")
        id("ask-next").tap(); Thread.sleep(forTimeInterval: 1)
        page("Request 2 of 2", second, first, "\(mode) two cards, after Next")
        bad += last("\(mode) two cards, after Next")
        bad += theRequestIsWhole("\(mode) two cards, second", second)
        keep("\(mode)-two-cards-2")
        if let dir = env["SHOTS"] { try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("ios-chat-\(mode)-two-cards.png")) }
        bad += theButtonsStayInReach("\(mode) two cards, second")
        id("ask-previous").tap(); Thread.sleep(forTimeInterval: 1)
        page("Request 1 of 2", first, second, "\(mode) two cards, after Previous")
        bad += last("\(mode) two cards, after Previous")
        // answering the first shows the second at once, without the pager; answering that leaves none
        named("Allow once").tap()
        let gone = NSPredicate(format: "exists == false")
        if XCTWaiter.wait(for: [expectation(for: gone, evaluatedWith: count)], timeout: 10) != .completed { bad.append("\(mode) two cards: the first answered, the pager is still there") }
        if !shows(second) { bad.append("\(mode) two cards: the first answered, \"\(second)\" does not show") }
        if shows(first) { bad.append("\(mode) two cards: the first answered, it is still there") }
        bad += theButtonsStayInReach("\(mode) two cards, the second alone")
        named("Allow once").tap()
        if XCTWaiter.wait(for: [expectation(for: gone, evaluatedWith: id("pinned-asks"))], timeout: 10) != .completed { bad.append("\(mode) two cards: both answered, a card is still there") }
        return bad
    }

    /// Whether a card's title is kept to one line is that card's own: two cards whose bodies are as tall, one with a long title
    /// (three lines or more beside the pager), one with the demo's, in both orders and back and forth (largest text, keyboard
    /// up). Each title shows the same way, as tall, however it was reached: a title kept to one line on one card once kept
    /// the next card's title to one line where it fit wrapped.
    func titlesPerCard(_ mode: String) -> [String] {
        let long = "mcp__shared-family-calendar-and-photo-albums__add", same = "Delete 3 old files in Documents"
        func title() -> String {
            let one = id("ask-title-one-line"), e = one.exists ? one : id("ask-title")
            return (one.exists ? "one line" : "wrapped") + " \((e.frame.height * 2).rounded() / 2)"
        }
        func next() { id("ask-next").tap(); Thread.sleep(forTimeInterval: 1) }
        func previous() { id("ask-previous").tap(); Thread.sleep(forTimeInterval: 1) }
        var demo: [String] = [], other: [String] = []
        for longFirst in [false, true] {
            open(night: false, size: "UICTContentSizeCategoryXXXL", asks: [(same, long)], asksFirst: longFirst)
            keyboardUp(); toTheEnd()
            guard id("ask-count").waitForExistence(timeout: 10) else { return ["\(mode) titles: no pager"] }
            if longFirst { other.append(title()); next(); demo.append(title()); previous(); other.append(title()) }
            else { demo.append(title()); next(); other.append(title()); previous(); demo.append(title()); next(); other.append(title()) }
        }
        print("BOOP-TITLES \(mode) demo \(demo) long \(other)")
        var bad: [String] = []
        if Set(demo).count > 1 { bad.append("\(mode) titles: the demo's title shows differently by the way it was reached: \(demo) (after the long one: \(demo[2]))") }
        if Set(other).count > 1 { bad.append("\(mode) titles: the long title shows differently by the way it was reached: \(other)") }
        return bad
    }

    /// What the card asks, the sentence to approve, is whole in the card's body with the body at its top: never cut off.
    func theRequestIsWhole(_ state: String, _ words: String) -> [String] {
        let body = id("ask-body")
        guard body.exists else { return ["\(state): ask-body is not on screen"] }
        let b = body.frame
        if b.height > 20 {
            let o = app.coordinate(withNormalizedOffset: .zero)
            for _ in 0 ..< 6 { o.withOffset(CGVector(dx: b.midX, dy: b.minY + 2)).press(forDuration: 0.05, thenDragTo: o.withOffset(CGVector(dx: b.midX, dy: b.maxY - 2))) }
            Thread.sleep(forTimeInterval: 1)
        }
        let line = labelled(body).first { $0.words == words }
        guard let r = line?.frame else { return ["\(state): \"\(words)\" is not in the card"] }
        let f = body.frame
        return r.minY < f.minY - 1 || r.maxY > f.maxY + 1 ? ["\(state): what the card asks \(r) is cut by its body \(f)"] : []
    }

    /// The last message at the end of the thread, by what the screen has room for. With the keyboard up, the card shows what
    /// it cannot do without first: its title row, what it asks whole, its buttons. Where that and the whole last message do
    /// not both fit between the top fade and the card's bottom (a small screen, the largest text), the last message may show
    /// in part: then no line is cut by the card, and with the keyboard down, the card still pinned, it shows whole (a drag
    /// up the thread takes the keyboard down, so that is also where scrolling up to read it leads). The test measures that
    /// room itself from the elements' frames and reads no flag of the app's: an app that got it wrong would say so too.
    /// `mustFit`: a state that has the room (a default iPhone); falling into the exception there is a layout fault.
    func theLastMessageAtTheEnd(_ state: String, keyboard: Bool, mustFit: Bool) -> [String] {
        guard keyboard else { return theLastMessageIsAboveTheCard(state) }
        let card = id("pinned-asks"), body = id("ask-body"), last = id("msg-0"), box = id("ask-reason")
        guard card.exists, body.exists, box.exists, last.exists, id("status").exists else { return theLastMessageIsAboveTheCard(state) }
        // what the card cannot do without: its body from its first words to the end of the box that holds what it asks (the
        // body scrolls, so what comes after may stay below; its other elements, laid out outside it, are not read), and the
        // last message's lines from first to last
        let lines = labelled(last).map(\.frame)
        guard !lines.isEmpty else { return theLastMessageIsAboveTheCard(state) }
        let asks = box.frame, top = min(asks.minY, labelled(body).map(\.frame.minY).min() ?? asks.minY)
        let span = { (rs: [CGRect]) in (rs.map(\.maxY).max() ?? 0) - (rs.map(\.minY).min() ?? 0) }
        let fade = id("status").frame.maxY + barBottom + 24
        // the card itself (ask-<event id>), not its container, which a wrong layout could stretch; + 8: the container's
        // padding under it
        let named = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'ask-' AND NOT (identifier IN %@)", ["ask-body", "ask-head", "ask-count", "ask-next", "ask-previous", "ask-pager", "ask-reason", "ask-title", "ask-title-one-line"])).allElementsBoundByIndex
        guard let shown = named.map(\.frame).filter({ $0.contains(CGPoint(x: body.frame.midX, y: body.frame.midY)) }).min(by: { $0.height < $1.height }) else { return theLastMessageIsAboveTheCard(state) }
        let c = card.frame, must = shown.height - body.frame.height + asks.maxY - top + 8, message = span(lines)
        // 8: the space the thread keeps between its last line and the card
        let fits = fade + message + 8 + must <= c.maxY + 1
        print("BOOP-FIT \(state): \(fits ? "fits" : "exception") (fade \(fade), card must \(must), message \(message), card bottom \(c.maxY))")
        if fits { return theLastMessageIsAboveTheCard(state) }
        if mustFit { return ["\(state) at the end: no room for the whole last message (\(message) points) and what the card must show (\(must) points) between the top fade at \(fade) and the card's bottom at \(c.maxY): this state has that room"] + theLastMessageIsAboveTheCard(state) }
        return theLastMessageIsAboveTheCard(state, whole: false) + theLastMessageWithTheKeyboardDown("\(state), keyboard down")
    }

    /// The exception's check: the keyboard taken down by a drag from the thread into it, the whole last message above the
    /// card at the end of the thread; then the keyboard up again.
    func theLastMessageWithTheKeyboardDown(_ state: String) -> [String] {
        var bad: [String] = []
        let o = app.coordinate(withNormalizedOffset: .zero)
        o.withOffset(CGVector(dx: 60, dy: id("bottom-chrome").frame.minY - 4)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.98)))
        for _ in 0 ..< 20 where app.keyboards.count > 0 { Thread.sleep(forTimeInterval: 0.25) }
        if app.keyboards.count > 0 { bad.append("\(state): the keyboard did not go down") }
        toTheEnd()
        bad += theLastMessageIsAboveTheCard(state)
        keep(state.replacingOccurrences(of: " ", with: "-").replacingOccurrences(of: ",", with: ""))
        keyboardUp()
        toTheEnd()
        return bad
    }

    /// The screen at a check, in the result bundle (not SHOTS): what a failure's numbers were read from.
    func keep(_ name: String, _ shot: XCUIScreenshot = XCUIScreen.main.screenshot()) {
        let a = XCTAttachment(screenshot: shot); a.name = name; a.lifetime = .keepAlways; add(a)
    }

    func named(_ s: String) -> XCUIElement { app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", s)).firstMatch }

    /// With what the card asks scrolled to its end inside it, Decline and Allow once are still in the card, whole, above
    /// the keyboard and below the top chrome, and hittable.
    func theButtonsStayInReach(_ state: String) -> [String] {
        let body = id("ask-body"), card = id("pinned-asks")
        guard body.exists, card.exists else { return ["\(state) card end: missing on screen:" + (body.exists ? "" : " ask-body") + (card.exists ? "" : " pinned-asks")] }
        let b = body.frame
        if b.height > 20 {
            let from = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: b.midX, dy: b.maxY - 4)), to = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: b.midX, dy: b.minY + 2))
            for _ in 0 ..< 6 { from.press(forDuration: 0.05, thenDragTo: to) }
            Thread.sleep(forTimeInterval: 1)
        }
        var bad: [String] = []
        let kb = app.keyboards.firstMatch
        let above = kb.exists && kb.frame.height > 0 ? kb.frame.minY : app.frame.maxY
        let top = id("status").exists ? id("status").frame.maxY : 0
        let c = card.frame
        // nothing of the card spills out of its room: every line in it outside its scrolling body ends inside it and
        // above the message field ("Allow for this task" once ran under the field)
        let field = id("composer-field").exists ? id("composer-field").frame.minY : above
        let inBody = body.frame
        let lines = labelled(card)
        // the walk sees the card's buttons: a check that reads only static text passed with these two under the field
        for words in ["Allow for this task", "Always allow"] where !lines.contains(where: { $0.words == words }) { bad.append("\(state) card end: \"\(words)\" not among the card's lines: the check cannot see it") }
        for (_, r) in lines {
            if r.minY >= inBody.minY - 1 && r.maxY <= inBody.maxY + 1 { continue }
            if r.maxY > c.maxY + 1 || r.maxY > field + 1 { bad.append("\(state) card end: a line \(r) runs past the card (\(c.maxY)) or under the message field (\(field))") }
        }
        for label in ["Decline", "Allow once"] {
            let e = named(label)
            guard e.exists else { bad.append("\(state) card end: \(label) is not on screen"); continue }
            let r = e.frame
            if r.minY < c.minY - 1 || r.maxY > c.maxY + 1 { bad.append("\(state) card end: \(label) \(r) is outside the card \(c)") }
            if r.maxY > above + 1 { bad.append("\(state) card end: \(label) ends at \(r.maxY), under the keyboard at \(above)") }
            if r.minY < top { bad.append("\(state) card end: \(label) starts at \(r.minY), under the top chrome at \(top)") }
            if r.height < 30 { bad.append("\(state) card end: \(label) is \(r.height) points tall, cut off") }
            if !e.isHittable { bad.append("\(state) card end: \(label) is not hittable") }
        }
        return bad
    }

    /// What is wrong on screen now, in words; empty when nothing is.
    func probe(_ state: String, keyboard: Bool, night: Bool, shot: XCUIScreenshot) -> [String] {
        var bad: [String] = []
        let screen = app.frame
        let kb = app.keyboards.firstMatch
        let up = kb.exists && kb.frame.height > 0
        if keyboard && !up { bad.append("\(state): the keyboard is not up") }
        if !keyboard && up { bad.append("\(state): the keyboard is up") }
        let divider = id("time-divider"), status = id("status")
        guard divider.exists, status.exists else {
            return bad + ["\(state): missing on screen:" + (divider.exists ? "" : " time-divider") + (status.exists ? "" : " status")]
        }
        // the theme as named: the background beside the status pill, at the screen's left edge
        let p = Pixels(shot.image)
        let lum = p.luminance(atPoint: CGPoint(x: 3, y: status.frame.midY), screen: screen)
        if night && lum > 60 { bad.append("\(state): the background is light (luminance \(lum))") }
        if !night && lum < 190 { bad.append("\(state): the background is dark (luminance \(lum))") }
        let chrome = status.frame.maxY + barBottom
        if divider.frame.minY < chrome - 1 { bad.append("\(state): the date line starts at \(divider.frame.minY), under the top chrome, which ends at \(chrome)") }
        let above = up ? kb.frame.minY : screen.maxY
        for name in ["composer", "send"] {
            // the one in the bottom chrome: the app keeps other pages' views in its tree, off screen
            let e = id("bottom-chrome").descendants(matching: .any).matching(identifier: name).firstMatch
            guard e.exists else { bad.append("\(state): \(name) is not on screen"); continue }
            let r = e.frame
            if r.maxY > above + 1 { bad.append("\(state): \(name) ends at \(r.maxY), under the keyboard, which starts at \(above)") }
            if r.minX < 0 || r.maxX > screen.width { bad.append("\(state): \(name) runs past the screen's side: \(r) on a screen \(screen.width) wide") }
            if r.height < 24 { bad.append("\(state): \(name) is \(r.height) points tall, cut off") }
        }
        return bad
    }

    /// The frames of everything under an element that reads as words, buttons included: a button's text is not a static
    /// text of its own to accessibility, so "Allow for this task" (a button) under the message field was not among
    /// a static-text-only walk (the card's break, 2026-11-26). The element's own frame and its containers are not.
    /// Read from one snapshot of the tree: a query per element (`allElementsBoundByIndex`) asked the app's accessibility so
    /// often that iOS throttled its logging and XCTest's fault hook crashed the app (iPhone SE, 2026-11-26).
    func labelled(_ e: XCUIElement) -> [(words: String, frame: CGRect)] {
        guard let root = try? e.snapshot() else { return [] }
        var out: [(words: String, frame: CGRect)] = []
        func walk(_ n: XCUIElementSnapshot, _ isRoot: Bool) {
            let leaf = n.children.isEmpty || n.elementType == .button || n.elementType == .staticText
            // words a person reads: not a scroll view's indicator, an element of its own with a label ("Vertical scroll
            // bar, 2 pages") as tall as the list, which a check of every labelled leaf took for a line (2026-11-26)
            let reads: [XCUIElement.ElementType] = [.staticText, .button, .link, .textField, .textView]
            if !isRoot, leaf, reads.contains(n.elementType), !n.label.isEmpty, !n.frame.isEmpty { out.append((n.label, n.frame)) }
            if isRoot || !leaf { for c in n.children { walk(c, false) } }
        }
        walk(root, true)
        return out
    }

    /// Every line of text on screen is inside the screen's sides: none is cut off at an edge.
    func noTextPastTheSides(_ state: String) -> [String] {
        let width = app.frame.width
        return labelled(app).map(\.frame).compactMap { r in
            guard !r.isEmpty, r.maxY > 0, r.minY < app.frame.height else { return nil }
            return r.minX < -1 || r.maxX > width + 1 ? "\(state): a line of text \(r) runs past the screen's side (\(width) wide)" : nil
        }
    }

    /// With the demo's card pinned above the composer and the thread scrolled under it, the bottom chrome outside the card
    /// and the field is plain background: row by row, across the screen less its rounded edges, every pixel is the row's
    /// own colour; a cut-off line of a message is not (as android ScreenshotsTest).
    func nothingShowsThroughUnderTheCard(_ state: String, shot: XCUIScreenshot) -> [String] {
        let chrome = id("bottom-chrome"), card = id("pinned-asks"), field = id("composer-field")
        guard chrome.exists, card.exists, field.exists else {
            return ["\(state): missing on screen:" + (chrome.exists ? "" : " bottom-chrome") + (card.exists ? "" : " pinned-asks") + (field.exists ? "" : " composer-field")]
        }
        let p = Pixels(shot.image), s = CGFloat(p.w) / app.frame.width
        let x0 = Int(40 * s), x1 = p.w - x0, edge = 2 * s
        let c = chrome.frame, k = card.frame, f = field.frame
        var off = 0, rows = 0
        for y in max(Int(c.minY * s), 0) ..< min(Int(c.maxY * s), p.h) {
            let fy = CGFloat(y)
            if fy >= k.minY * s - edge && fy < k.maxY * s + edge { continue }
            if fy >= f.minY * s - edge && fy < f.maxY * s + edge { continue }
            rows += 1
            let ref = p.rgb(p.w / 2, y)
            for x in x0 ..< x1 { let v = p.rgb(x, y); if max(abs(v.0 - ref.0), abs(v.1 - ref.1), abs(v.2 - ref.2)) > 24 { off += 1 } }
        }
        if rows == 0 { return ["\(state): no chrome outside the card and the field to look at"] }
        return off > 0 ? ["\(state): \(off) pixels in the \(rows) rows of the chrome around the card and the field are not the background: the thread shows through"] : []
    }

    /// At the end of the thread with a card pinned, the last message is above the card, whole: no line of the thread is cut
    /// by the card, and (`whole`) every line of the last message is below the top fade and above the card.
    func theLastMessageIsAboveTheCard(_ state: String, whole: Bool = true) -> [String] {
        let card = id("pinned-asks")
        guard card.exists else { return ["\(state) at the end: pinned-asks is not on screen"] }
        let top = card.frame.minY
        // the rows in the thread's frame (which runs under the floating chrome); the list keeps rows past it loaded, unseen
        let view = id("thread").frame
        let texts = labelled(id("thread")).map(\.frame).filter { $0.intersects(view) }
        guard !texts.isEmpty else { return ["\(state) at the end: no message on screen"] }
        var bad: [String] = []
        for r in texts {
            if r.minY < top && r.maxY > top + 1 { bad.append("\(state) at the end: a message line \(r) is cut by the card, which starts at \(top)") }
            else if r.minY >= top { bad.append("\(state) at the end: a message line \(r) is under the card, which starts at \(top)") }
        }
        guard whole else { return bad }
        // chat.tsx: the top fade runs to the chrome's bottom (the status pill and the bar's 8) and 24 past it
        let fade = id("status").frame.maxY + barBottom + 24
        let last = id("msg-0")
        guard last.exists else { return bad + ["\(state) at the end: the last message (msg-0) is not on screen"] }
        let lines = labelled(last).map(\.frame)
        guard !lines.isEmpty else { return bad + ["\(state) at the end: no line in the last message"] }
        for r in lines {
            if r.minY < fade - 1 { bad.append("\(state) at the end: a line of the last message \(r) starts under the top fade, which ends at \(fade)") }
            if r.maxY > top + 1 { bad.append("\(state) at the end: a line of the last message \(r) ends past the card's top \(top)") }
        }
        return bad
    }

    func open(night: Bool, size: String, asks: [(reason: String, tool: String)] = [], asksFirst: Bool = false) {
        app.terminate()
        XCUIDevice.shared.appearance = night ? .dark : .light
        app.launchArguments = ["-AppleLanguages", "(en-US)", "-AppleLocale", "en_US", "-UIPreferredContentSizeCategoryName", size]
        if !asks.isEmpty {
            let json: [[String: Any]] = asks.enumerated().map { ["eventId": "test-ask-\($0.offset)", "toolName": $0.element.tool, "reason": $0.element.reason, "first": asksFirst] }
            app.launchArguments += ["-BoopTestAsks", String(data: try! JSONSerialization.data(withJSONObject: json), encoding: .utf8)!]
        }
        // The app's own os_log off for this test: with a card overflowing, XCTest's reads of its accessibility logged so
        // much that iOS throttled the process, and XCTest's fault hook then crashed the app (EXC_BAD_ACCESS in
        // runtime_issue_os_log_fault_callback, iPhone SE, 2026-11-26), before the check that saw the overflow could say so.
        app.launchEnvironment["OS_ACTIVITY_MODE"] = "disable"
        app.launch()
        let start = id("start"), composer = id("composer")
        for _ in 0 ..< 60 where !start.exists && !composer.exists { Thread.sleep(forTimeInterval: 0.5) }
        if start.exists {
            start.tap()
            XCTAssertTrue(id("try-it").waitForExistence(timeout: 15), "the connect screen offers Try it")
            id("try-it").tap()
        }
        XCTAssertTrue(composer.waitForExistence(timeout: 30), "the demo chat")
        XCTAssertTrue(id("pinned-asks").waitForExistence(timeout: 10), "the demo's pinned card")
        Thread.sleep(forTimeInterval: 1)
    }

    func keyboardUp() {
        if app.keyboards.count == 0 { id("composer").tap() }
        _ = app.keyboards.firstMatch.waitForExistence(timeout: 5)
        Thread.sleep(forTimeInterval: 1)
    }

    func keyboardDown() {
        // a drag from the thread into the keyboard, as a person takes it down (keyboardDismissMode interactive)
        if app.keyboards.count > 0 {
            let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
            from.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
        }
        for _ in 0 ..< 20 where app.keyboards.count > 0 { Thread.sleep(forTimeInterval: 0.25) }
        Thread.sleep(forTimeInterval: 0.5)
    }

    /// To the top of the thread: taps on the status bar (the list's scrollsToTop). A drag down the thread takes the keyboard
    /// down (keyboardDismissMode interactive), and 12 drags down did not reach the top either (measured 2026-11-26).
    func toTheTop() {
        for _ in 0 ..< 3 { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.005)).tap(); Thread.sleep(forTimeInterval: 0.8) }
        Thread.sleep(forTimeInterval: 1)
    }

    /// To the end of the thread: drags up the thread from just above the pinned card to the top of the screen, never
    /// starting on the card (a scroll view of its own) and moving away from the keyboard, which an upward drag leaves up.
    /// (Ending under the status pill, not starting there: with a tall card the gap above it is a few points.)
    func toTheEnd() {
        let h = app.frame.height
        // above the bottom chrome (its 8-point top padding over the card is not the thread)
        let low = (id("bottom-chrome").exists && id("pinned-asks").exists ? id("bottom-chrome").frame.minY - 4 : h * 0.6) / h
        let high = 0.02
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: low)), to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: high))
        for _ in 0 ..< 15 { from.press(forDuration: 0.05, thenDragTo: to) }
        Thread.sleep(forTimeInterval: 1.5)
    }
}

/// A screenshot's pixels, RGB.
struct Pixels {
    let w: Int, h: Int
    private var data: [UInt8]
    init(_ image: UIImage) {
        let cg = image.cgImage!
        w = cg.width; h = cg.height
        data = [UInt8](repeating: 0, count: w * h * 4)
        let ctx = CGContext(data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    func rgb(_ x: Int, _ y: Int) -> (Int, Int, Int) { let i = (y * w + x) * 4; return (Int(data[i]), Int(data[i + 1]), Int(data[i + 2])) }
    func luminance(atPoint p: CGPoint, screen: CGRect) -> Int {
        let s = CGFloat(w) / screen.width
        let v = rgb(min(Int(p.x * s), w - 1), min(Int(p.y * s), h - 1))
        return (v.0 * 299 + v.1 * 587 + v.2 * 114) / 1000
    }
}
