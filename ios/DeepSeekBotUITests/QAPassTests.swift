// A full pass on the real shell, against a real bot and the real model. Skipped unless QA_BOT is set.
// Env:
//   QA_BOT     the bot's address (http://127.0.0.1:3930)
//   QA_CODE    the six digits from its pairing link
//   QA_SECRET  the bot's DEEPSEEK_BOT_HOST_SECRET: the test pairs a device of its own to read the thread's state
//   QA_LANG    zh | en (the simulator's language is set before the run; this picks the prompts and labels)
//   QA_SCHEME  dark | light
//   QA_SHOTS   where the screenshots go: qa-ios-<lang>-<scheme>-<screen>.png
//   QA_SMOKE   with QA_HOST: sign in, wait for Online, one message and its reply, then stop
//   QA_TASK_CARD  a background task's card in the conversation, with a bot on a scripted model: ask, the
//              task's table, a tap on a row, the conversation's reply
// A real session of ten and more turns (rename in chat, a web question, a card, an approval, a follow-up, a
// connector through the fake service, something remembered), then every screen with the keyboard up first,
// memory viewed, edited and forgotten, and Discover. It records what it saw; the review is by eye.
import XCTest
import ObjectiveC

final class QAPassTests: XCTestCase {
    let env = ProcessInfo.processInfo.environment
    lazy var bot: String = env["QA_BOT"] ?? ""
    /// QA_HOST (the shell built with DEEPSEEK_BOT_HOST_URL), QA_EMAIL, QA_ACCESS_CODE: sign in through
    /// Start instead of pairing; the turns that need the local fake service or the busy proxy are skipped.
    var hosted: String { env["QA_HOST"] ?? "" }
    var zh: Bool { env["QA_LANG"] == "zh" }
    var scheme: String { env["QA_SCHEME"] ?? "light" }
    var app: XCUIApplication!
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    var token = ""
    var notes: [String] = []

    func L(_ zhText: String, _ en: String) -> String { zh ? zhText : en }

    /// While the assistant works the status dot breathes, and XCUITest waits up to 60 s for the app's animations to
    /// stop before every tap and every query (measured 2026-10-28: "App animations complete notification not received"
    /// six times in the first two turns, a minute each). The pass waits for what it needs itself (waitTurn, sleeps),
    /// so it skips that wait.
    static let skipQuiescence: Void = {
        guard let cls = NSClassFromString("XCUIApplicationProcess") else { return }
        let one: @convention(block) (AnyObject, Bool) -> Void = { _, _ in }
        let two: @convention(block) (AnyObject, Bool, Bool) -> Void = { _, _, _ in }
        if let m = class_getInstanceMethod(cls, NSSelectorFromString("waitForQuiescenceIncludingAnimationsIdle:")) { method_setImplementation(m, imp_implementationWithBlock(one)) }
        if let m = class_getInstanceMethod(cls, NSSelectorFromString("waitForQuiescenceIncludingAnimationsIdle:isPreEvent:")) { method_setImplementation(m, imp_implementationWithBlock(two)) }
    }()
    override func setUp() { super.setUp(); _ = Self.skipQuiescence }

    func testQAPass() throws {
        try XCTSkipIf(bot.isEmpty && hosted.isEmpty, "QA_BOT not set")
        continueAfterFailure = true
        XCUIDevice.shared.appearance = scheme == "dark" ? .dark : .light
        app = XCUIApplication()
        app.launch()
        if start > 1 && env["QA_ONLY_EXTRA"] == nil {
            // resuming a session this app is already in: the driver's own device, then the turns from QA_START on
            token = (json(post("/pair", ["hostSecret": env["QA_SECRET"] ?? "", "name": "qa-driver"]))?["token"] as? String) ?? ""
            XCTAssertTrue(id("composer").waitForExistence(timeout: 30), "the thread")
            try session()
            return
        }
        if !hosted.isEmpty { try signInHosted(); return }
        app.terminate()

        // 1. Pair from the link (a clean install), name the assistant.
        let code = try XCTUnwrap(env["QA_CODE"])
        let pair = "\(bot)/pair?code=\(code)".addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
        XCUIDevice.shared.system.open(URL(string: "deepseekbot://pair?url=\(pair)")!)
        for label in ["Open", "打开"] { let b = springboard.buttons[label]; if b.waitForExistence(timeout: 3) { b.tap(); break } }
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        let connect = id("connect")
        XCTAssertTrue(connect.waitForExistence(timeout: 15), "connect screen")
        shot("connect")
        connect.tap()
        for label in ["Allow", "允许"] { let b = springboard.buttons[label]; if b.waitForExistence(timeout: 5) { b.tap(); break } }
        // [compliance] the age question and the AI disclosure come before naming
        for gate in ["age-adult", "consent-agree"] { let b = id(gate); if b.waitForExistence(timeout: 10) { shot(gate); b.tap() } }
        let name = id("name")
        XCTAssertTrue(name.waitForExistence(timeout: 30), "naming screen")
        shot("name")
        // a person who types the suggested name must get it once ("NoriNori" on the hosted web, 2026-10-28)
        name.tap(); name.typeText(L("小诺", "Nori")); sleep(1); shot("name-typed")
        id("name-go").tap()
        XCTAssertTrue(id("composer").waitForExistence(timeout: 60), "the thread")
        token = (json(post("/pair", ["hostSecret": env["QA_SECRET"] ?? "", "name": "qa-driver"]))?["token"] as? String) ?? ""
        XCTAssertFalse(token.isEmpty, "the driver paired")
        sleep(3)
        shot("chat-empty")
        if env["QA_TASK_CARD"] != nil { try taskCard(); return }
        try session()
    }

    func taskCard() throws {
        turn(1, "帮我比较一下去埃武拉的火车")
        let row = any("label CONTAINS %@", "小田急浪漫特快")
        XCTAssertTrue(row.waitForExistence(timeout: 60), "the task's table in the conversation")
        sleep(2); shot("task-card")
        any("identifier BEGINSWITH 'row-' AND NOT (identifier ENDSWITH '-selected')").tap()
        XCTAssertTrue(any("label CONTAINS %@", "就按").waitForExistence(timeout: 60), "the conversation's reply to the tap")
        sleep(2); shot("task-card-answered")
        writeNotes()
    }

    func signInHosted() throws {
        shot("welcome")
        id("start").tap()
        let email = id("email")
        XCTAssertTrue(email.waitForExistence(timeout: 20), "sign-in screen")
        shot("sign-in")
        email.tap(); email.typeText(env["QA_EMAIL"] ?? "")
        let code = id("access-code")
        if code.exists { code.tap(); code.typeText(env["QA_ACCESS_CODE"] ?? "") }
        id("sign-in").tap()
        sleep(3); shot("preparing")
        // a new account answers the age question, the disclosure and the name; an account another phone set up opens
        // its thread at once. The notification prompt may come first either way.
        let end = Date().addingTimeInterval(240)
        while Date() < end && !id("age-adult").exists && !id("composer").exists {
            for label in ["Allow", "允许"] { let b = springboard.buttons[label]; if b.exists { b.tap() } }
            sleep(2)
        }
        if id("age-adult").exists {
            for gate in ["age-adult", "consent-agree"] { let b = id(gate); if b.waitForExistence(timeout: 20) { shot(gate); b.tap() } else { note("hosted: no \(gate)") } }
            let name = id("name")
            XCTAssertTrue(name.waitForExistence(timeout: 40), "naming screen")
            name.tap(); name.typeText(L("小诺", "Nori")); sleep(1); shot("name-typed")
            id("name-go").tap()
        } else { note("hosted: the account was set up on another phone; straight to its thread") }
        for label in ["Allow", "允许"] { let b = springboard.buttons[label]; if b.waitForExistence(timeout: 5) { b.tap(); break } }
        XCTAssertTrue(id("composer").waitForExistence(timeout: 60), "the thread")
        // the driver signs in as the same account and talks to the same computer
        bot = hosted
        let account = (json(post("/host/sign-in", ["email": env["QA_EMAIL"] ?? "", "code": env["QA_ACCESS_CODE"] ?? ""]))?["accountToken"] as? String) ?? ""
        token = account
        let sandbox = json(get("/host/sandbox")) ?? [:]
        bot = (sandbox["origin"] as? String) ?? ""
        token = (sandbox["token"] as? String) ?? ""
        XCTAssertFalse(token.isEmpty, "the driver reached the computer")
        sleep(3); shot("chat-empty")
        if env["QA_SMOKE"] != nil { try smoke(); return }
        try session()
    }

    /// QA_SMOKE (hosted only): the live connection, one message and its reply, then stop.
    func smoke() throws {
        let online = any("label CONTAINS %@", L("在线", "Online"))
        XCTAssertTrue(online.waitForExistence(timeout: 30), "online within 30 s")
        shot("smoke-loaded")
        turn(1, L("2 加 3 等于几？只回答数字。", "What is 2 + 3? Answer with the number only."))
        XCTAssertTrue(any("label == %@", "5").waitForExistence(timeout: 30), "the reply in the thread")
        shot("smoke-reply")
        writeNotes()
    }

    var start: Int { env["QA_ONLY_EXTRA"] != nil ? 13 : Int(env["QA_START"] ?? "1") ?? 1 }

    func session() throws {
        // 2. The session.
        let newName = L("小墨", "Momo")
        turn(1, L("你好！以后你就叫小墨吧。", "Hi. From now on your name is Momo."))
        if start <= 1 { if !any("label CONTAINS %@", newName).waitForExistence(timeout: 20) { note("rename: the header does not say \(newName) 20 s after the turn") }; shot("rename") }
        turn(2, L("帮我上网查一下：里斯本今天天气怎么样？", "Look it up on the web: what is the weather in Lisbon today?"))
        if start <= 2 { replyCopy(); replyReport() }
        turn(3, L("我周末想出去玩，在卡斯凯什、埃武拉、辛特拉里纠结。用一张选项卡片让我选一个。", "I want a weekend trip and cannot pick between Cascais, Evora and Sintra. Give me a card with the three to choose from."))
        let option = any("(identifier BEGINSWITH 'opt-' OR identifier BEGINSWITH 'row-') AND NOT (identifier ENDSWITH '-selected')")
        if start > 3 {} else if option.waitForExistence(timeout: 10) { shot("card"); option.tap(); waitTurn(); shot("card-answered") } else { note("card: no choices card after turn 3") }
        turn(5, L("在你电脑的主目录下（工作文件夹外面）建一个文件 trip.md，写上我选的地方。", "Create a file trip.md in the home folder of your computer, outside your work folder, with the place I picked."))
        turn(6, L("刚才查的里斯本天气，适合去我选的那个地方吗？一句话回答。", "Given the Lisbon weather you looked up earlier, is it a good day for the place I picked? One sentence."))
        if !hosted.isEmpty { note("hosted: the connector turns need the local fake service; skipped") } else {
        turn(7, L("帮我连上 Acme Pages。", "Connect my Acme Pages."))
        let connectCard = any("identifier BEGINSWITH 'connect-'")
        if start > 7 {} else if connectCard.waitForExistence(timeout: 10) {
            shot("connect-card")
            connectCard.tap()
            sleep(6)
            XCUIScreen.main.screenshot().pngRepresentation.write(to: "connect-browser", self)
            app.activate()
            if !any("identifier BEGINSWITH 'connected-'").waitForExistence(timeout: 30) { note("connect: the card did not say Connected 30 s after the browser came back") }
            waitTurn()
            shot("connected")
        } else { note("connect: no connect card after turn 7") }
        turn(8, L("在 Acme Pages 里搜一下 garden，告诉我找到了什么。", "Search my Acme Pages for garden and tell me what you found."))
        }
        turn(9, L("记住：我对花生过敏。", "Remember: I am allergic to peanuts."))
        if start <= 9 { waitMemory() }
        turn(10, L("每天早上 8 点提醒我喝水。", "Remind me every morning at 8 to drink water."))
        turn(11, L("帮我定个目标：三个月内跑完 10 公里。", "Set me a goal: run 10 km within three months."))
        turn(12, L("谢谢！刚才那个目标，第一周我该做什么？", "Thanks! For that goal, what should I do in the first week?"))
        extraSteps()
        if env["QA_ONLY_EXTRA"] != nil { writeNotes(); return }

        // 3. Every screen, with the keyboard up first.
        dismissKeyboard()
        shot("chat")
        let composer = id("composer")
        composer.tap(); composer.typeText(L("草稿", "draft"))
        sleep(1)
        shot("chat-keyboard")
        tapLabel(L("菜单", "Menu")); sleep(2); shot("menu"); keyboardCheck("menu")
        for (label, screen) in [(L("文件库", "Library"), "library"), (L("日程", "Upcoming"), "upcoming"), (L("目标", "Goals"), "goals"), (L("活动", "Activity"), "menu-activity")] {
            if tapLabel(label) { sleep(2); shot(screen); back() }
        }
        // [compliance] the interfaces it built, each with what it may use
        let interfaces = id("interfaces-row")
        if interfaces.waitForExistence(timeout: 3) {
            interfaces.tap(); sleep(2); shot("interfaces")
            let one = any("identifier BEGINSWITH 'if-' AND NOT (identifier IN {'if-title', 'if-open', 'if-link', 'if-hide', 'if-report'})")
            if one.waitForExistence(timeout: 5) { one.tap(); sleep(2); shot("interface"); back() } else { note("interfaces: the tip calculator is not listed") }
            back()
        } else { note("menu: no Interfaces row") }
        back()
        composer.tap(); sleep(1)
        tapLabel(L("设置", "Settings")); sleep(2); shot("settings"); keyboardCheck("settings")
        if tapLabel(L("连接器", "Connectors")) {
            sleep(2); shot("connectors")
            let mine = id("open-acme-pages")
            if mine.exists { mine.tap(); sleep(2); shot("connector-connected"); back() } else { note("connectors: Acme Pages is not in the list") }
            let other = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'open-' AND identifier != 'open-acme-pages'")).firstMatch
            if other.exists { other.tap(); sleep(2); shot("connector-available"); back() }
            back()
        }
        for (label, screen) in [(L("用量", "Usage"), "usage"), (L("活动", "Activity"), "activity"), (L("设备", "Devices"), "devices")] {
            if tapLabel(label) { sleep(2); shot(screen); back() }
        }
        // [compliance] Settings → About → AI provider
        let provider = id("ai-provider-row")
        for _ in 0..<6 where !(provider.exists && provider.isHittable) { app.swipeUp(); sleep(1) }
        if provider.exists && provider.isHittable { shot("settings-about"); provider.tap(); sleep(2); shot("ai-provider"); back() } else { note("settings: no AI provider row") }
        for _ in 0..<3 { app.swipeDown() }
        sleep(1)
        let memoryRow = id("memory-row")
        if !memoryRow.waitForExistence(timeout: 3) { note("settings: not on Settings any more (no Memory row); back to it"); back(); tapLabel(L("设置", "Settings")); sleep(2) }
        if memoryRow.waitForExistence(timeout: 3) { memoryRow.tap() } else { note("settings: no Memory row"); writeNotes(); return }
        sleep(3); shot("profile-memory")
        let item = any("identifier BEGINSWITH 'mem-' AND NOT (identifier BEGINSWITH 'mem-group') AND NOT (identifier BEGINSWITH 'mem-more') AND NOT (identifier BEGINSWITH 'mem-forget') AND NOT (identifier BEGINSWITH 'mem-count') AND NOT (identifier BEGINSWITH 'mem-note')")
        if item.waitForExistence(timeout: 5) {
            item.tap(); sleep(2); shot("memory-edit")
            let field = id("memory-text")
            field.tap(); field.typeText(L("，连花生油也不行", ", peanut oil too")); sleep(1)
            shot("memory-edit-keyboard")
            id("memory-save").tap(); sleep(3); shot("memory-saved")
            let more = any("identifier BEGINSWITH 'more-'")
            if more.waitForExistence(timeout: 5) {
                more.tap(); sleep(1); shot("memory-actions")
                let forget = app.buttons.matching(NSPredicate(format: "label == %@", L("忘掉", "Forget"))).firstMatch
                if forget.waitForExistence(timeout: 3) { app.buttons.matching(NSPredicate(format: "label == %@", L("忘掉", "Forget"))).allElementsBoundByIndex.filter { $0.isHittable }.last?.tap(); sleep(1); shot("memory-forget-confirm"); let confirm = app.buttons.matching(NSPredicate(format: "label == %@", L("忘掉", "Forget"))).allElementsBoundByIndex.filter { $0.isHittable }.last; confirm?.tap(); sleep(3); shot("memory-forgotten") }
                else { note("memory: no Forget in the item's actions"); shot("memory-actions-missing"); app.buttons[L("取消", "Cancel")].tap() }
            }
        } else { note("memory: nothing listed after 'remember'") }
        back()
        let style = id("style")
        if style.exists { style.press(forDuration: 1.2); sleep(2); shot("identity"); back() }
        back()
        id("status").tap(); sleep(2); shot("profile-activity")
        for seg in ["permissions", "upcoming", "memory"] { let s = id("seg-\(seg)"); if s.exists { s.tap(); sleep(2); shot("profile-\(seg)") } }
        back()
        dismissKeyboard()
        let discover = app.tabBars.buttons[L("发现", "Discover")]
        if discover.waitForExistence(timeout: 5) { discover.tap() } else { note("tab bar: no Discover tab") }
        sleep(3); shot("discover")
        app.tabBars.buttons[L("对话", "Chat")].tap(); sleep(1)
        shot("chat-end")

        writeNotes()
    }

    func writeNotes() {
        let report = notes.joined(separator: "\n")
        print("[qa] notes:\n\(report)")
        if let dir = env["QA_SHOTS"] { try? report.write(toFile: "\(dir)/qa-ios-\(env["QA_LANG"] ?? "")-\(scheme)-notes.txt", atomically: true, encoding: .utf8) }
    }

    /// The second round's steps: a chart and a file handed over, a module opened, a message during a long
    /// task with the activity panel open, and a busy model.
    func extraSteps() {
        turn(13, L("用 Python 画一张里斯本这周气温的折线图存成 PNG，再把这周的跑步安排写成 week1.md，两个都用 present 发给我。", "Draw a line chart of Lisbon temperatures this week as a PNG with Python, and write my first running week as week1.md; present both to me."))
        let image = any("identifier BEGINSWITH 'file-' AND identifier ENDSWITH '-image'")
        let file = any("identifier BEGINSWITH 'file-' AND NOT (identifier ENDSWITH '-image')")
        shot("files")
        if image.waitForExistence(timeout: 5) { image.tap(); sleep(2); shot("file-image-page"); back() } else { note("files: no image row after the chart turn") }
        if file.waitForExistence(timeout: 5) { file.tap(); sleep(2); shot("file-page"); back() } else { note("files: no file card after the chart turn") }
        turn(14, L("做一个小费计算器界面给我，账单 42 欧元。", "Build me a tip calculator I can tap through, for a 42 euro bill."))
        let open = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'open-'")).allElementsBoundByIndex.last
        if let open, open.exists {
            shot("module-card"); open.tap(); sleep(8); shot("module-open")
            let done = app.buttons.matching(NSPredicate(format: "label IN {'Done', '完成'}")).firstMatch
            if done.waitForExistence(timeout: 10) { done.tap(); sleep(1) } else { note("module: no sheet with Done after Open") }
            shot("module-back")
        } else { note("module: no module card with Open after the interface turn") }
        turn(18, L("用浏览器打开 https://example.com ，截一张屏发给我看。", "Open https://example.com in your browser and show me a screenshot of the page."))
        if any("identifier BEGINSWITH 'file-'").waitForExistence(timeout: 10) { shot("browser-screenshot") } else { note("browser: no screenshot in the thread after asking for one") }
        say(L("帮我比较里斯本到辛特拉的三种走法：价格、时间、换乘，查清楚再告诉我。", "Compare three ways from Lisbon to Sintra: price, time, transfers; look them up properly before you answer."))
        sleep(10); shot("running")
        let live = id("activity-live")
        if live.exists { live.tap(); sleep(1); shot("running-panel-open") }
        let second = L("顺便也比较一下去埃武拉的。", "Also compare the same for Evora.")
        say(second)
        usleep(800_000); shot("second-sent")
        if !any("label == %@", second).exists { note("mid-task: the second message is not on screen right after sending") }
        waitTurn(15); dismissKeyboard(); shot("turn-15")
        if let port = try? String(contentsOfFile: "\(env["QA_HOME"] ?? "").busy", encoding: .utf8) {
            var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port.trimmingCharacters(in: .whitespacesAndNewlines))/busy?n=4")!); req.httpMethod = "POST"
            let done = DispatchSemaphore(value: 0); URLSession.shared.dataTask(with: req) { _, _, _ in done.signal() }.resume(); _ = done.wait(timeout: .now() + 5)
        } else { note("busy: no proxy port") }
        say(L("现在里斯本几点？一句话。", "What time is it in Lisbon now? One sentence."))
        for i in 0..<6 { sleep(3); shot("busy-\(i)") }
        waitTurn(16); shot("turn-16")
    }

    /// The newest reply on screen: msg-<n> counts from the bottom; a reply starts at the left edge.
    func newestReply() -> XCUIElement? {
        let width = app.frame.width
        return app.descendants(matching: .any).matching(NSPredicate(format: "identifier MATCHES 'msg-[0-9]+'")).allElementsBoundByIndex
            .filter { $0.isHittable && $0.frame.minX < width * 0.1 }
            .min { Int($0.identifier.dropFirst(4)) ?? 0 < Int($1.identifier.dropFirst(4)) ?? 0 }
    }
    /// [compliance] long-press a reply: Copy and Report; Copy says it copied.
    func replyCopy() {
        dismissKeyboard()
        guard let reply = newestReply() else { note("long-press: no reply on screen"); return }
        reply.press(forDuration: 1.0)
        let copy = app.buttons[L("复制", "Copy")]
        if !copy.waitForExistence(timeout: 5) { note("long-press: no Copy / Report menu on a reply"); shot("reply-menu-missing"); return }
        shot("reply-menu")
        if !app.buttons[L("举报", "Report")].exists { note("long-press: the menu has no Report") }
        copy.tap(); usleep(300_000); shot("copied")
    }
    /// [compliance] Report from a reply: a reason, a note, sent, thanks.
    func replyReport() {
        dismissKeyboard()
        guard let reply = newestReply() else { note("report: no reply on screen"); return }
        reply.press(forDuration: 1.0)
        let report = app.buttons[L("举报", "Report")]
        if !report.waitForExistence(timeout: 5) { note("report: no Report in the menu"); return }
        report.tap()
        let reason = id("reason-harmful")
        if !reason.waitForExistence(timeout: 10) { note("report: no report page"); shot("report-missing"); return }
        shot("report"); reason.tap()
        let field = id("report-note"); field.tap(); field.typeText("test report from QA"); sleep(1); shot("report-keyboard")
        id("report-send").tap()
        if !id("report-sent").waitForExistence(timeout: 10) { note("report: no thanks after Send"); shot("report-after-send"); return }
        shot("report-sent"); id("report-done").tap(); sleep(1)
    }

    func say(_ text: String) {
        let composer = id("composer")
        composer.tap()
        if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { composer.tap() }
        composer.typeText(text)
        id("send").tap()
    }

    // MARK: the session

    /// Type the words, send, screenshot the moment after Send, wait for the turn (allowing what asks), screenshot.
    func turn(_ n: Int, _ text: String) {
        if n < start { return }
        let composer = id("composer")
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap()
        if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { note("turn \(n): a tap on the composer brought no keyboard; tapped again"); composer.tap(); _ = app.keyboards.firstMatch.waitForExistence(timeout: 3) }
        composer.typeText(text)
        id("send").tap()
        usleep(400_000)
        if n == 1 { shot("sent") }
        if !any("label == %@", text).exists { note("turn \(n): the message is not on screen right after Send") }
        waitTurn(n)
        dismissKeyboard()
        shot(String(format: "turn-%02d", n))
    }

    /// Until the thread is idle; an approval is screenshot once and allowed once.
    func waitTurn(_ n: Int = 0) {
        let end = Date().addingTimeInterval(300)
        var idle = 0
        while Date() < end {
            let asks = jsonArray(get("/asks")) ?? []
            if let ask = asks.first {
                sleep(2)
                if (ask["kind"] as? String) == "approval" {
                    shot(String(format: "approval-%02d", n))
                    if !tapLabel(L("仅这次允许", "Allow once")) { note("turn \(n): an approval with no Allow once on screen") ; _ = post("/approvals/\(ask["eventId"] as? String ?? "")", ["outcome": "allowed-once"], token) }
                } else {
                    shot(String(format: "question-%02d", n))
                    note("turn \(n): the assistant asked a question; skipped")
                    if !tapLabel(L("跳过", "Skip")) { break }
                }
                idle = 0; sleep(2); continue
            }
            let threads = jsonArray(get("/threads")) ?? []
            let running = threads.contains { ($0["running"] as? Bool) == true }
            idle = running ? 0 : idle + 1
            if idle >= 4 { return }
            sleep(1)
        }
        note("turn \(n): still running after 300 s; Stop")
        if tapLabel(L("停止", "Stop")) { sleep(1); shot(String(format: "stop-%02d", n)); tapLabel(L("停止任务", "Stop task")); sleep(3) }
    }

    func waitMemory() {
        for _ in 0..<90 { if let items = jsonArray(get("/memory")), !items.isEmpty { sleep(5); return }; sleep(1) }
        note("memory: nothing remembered 90 s after 'remember'")
    }

    // MARK: the screen

    func id(_ identifier: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: identifier).firstMatch }
    func any(_ format: String, _ args: CVarArg...) -> XCUIElement { app.descendants(matching: .any).matching(NSPredicate(format: format, argumentArray: args)).firstMatch }
    @discardableResult func tapLabel(_ label: String) -> Bool {
        // a cell's label may carry more than its title (a value, a chevron): exact first, then the shortest that starts with it
        let exact = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).allElementsBoundByIndex.filter { $0.isHittable }
        let starts = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", label)).allElementsBoundByIndex.filter { $0.isHittable }.sorted { $0.label.count < $1.label.count }
        guard let e = exact.last ?? starts.first else { note("no '\(label)' to tap"); return false }
        e.tap(); return true
    }
    func back() {
        let b = app.navigationBars.buttons.element(boundBy: 0)
        if b.exists && b.isHittable { b.tap() } else { app.swipeRight() }
        sleep(1)
    }
    /// The keyboard down the way a person does it here: first a drag from the thread into the keyboard (interactive
    /// dismissal, noted when it does nothing), then a trip to Menu and back (any navigation takes it down).
    func dismissKeyboard() {
        guard app.keyboards.count > 0 else { return }
        let thread = id("thread")
        if thread.exists {
            let from = thread.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55))
            from.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
            sleep(1)
        }
        if app.keyboards.count > 0 {
            note("a drag from the thread into the keyboard did not take it down")
            if tapLabel(L("菜单", "Menu")) { sleep(1); back() }
        }
        if app.keyboards.count > 0 { note("the keyboard stayed up after Menu and back") }
    }
    func keyboardCheck(_ screen: String) { if app.keyboards.count > 0 { note("\(screen): the keyboard is up on a screen nobody types in") } }
    func note(_ s: String) { notes.append(s); print("[qa] \(s)") }

    func shot(_ screen: String) {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        png.write(to: screen, self)
    }
    fileprivate func path(_ screen: String) -> String? {
        guard let dir = env["QA_SHOTS"] else { return nil }
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return "\(dir)/qa-ios-\(env["QA_LANG"] ?? "en")-\(scheme)-\(screen).png"
    }

    // MARK: the bot over HTTP (the driver's own device)

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
    private func get(_ p: String) -> String { request("GET", p, nil, token) }
    private func post(_ p: String, _ body: [String: Any], _ tok: String? = nil) -> String { request("POST", p, body, tok) }
    private func json(_ s: String) -> [String: Any]? { s.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any] }
    private func jsonArray(_ s: String) -> [[String: Any]]? { s.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [[String: Any]] }
}

private extension Data {
    func write(to screen: String, _ t: QAPassTests) {
        guard let p = t.path(screen) else { return }
        FileManager.default.createFile(atPath: p, contents: self)
    }
}
