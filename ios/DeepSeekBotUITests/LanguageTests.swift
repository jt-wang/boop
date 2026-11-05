// A phone set to Chinese opens the app in Chinese. The app takes its language from NSH's locale(), which on
// iOS follows the languages the app bundle declares: with none but the development language it said English on
// a Chinese iPhone (2026-10-27, iOS 26.3 simulator, zh-Hans-CN: the welcome, the chrome and the bot's first words
// were English). Launched with the system's own language arguments, so it runs on any simulator.
import XCTest

final class LanguageTests: XCTestCase {
    func testAChinesePhoneOpensInChinese() {
        let app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", "(zh-Hans-CN)", "-AppleLocale", "zh_CN"]
        app.launch()
        // the welcome's Start, or, when this simulator is paired already, the thread's Send
        let chinese = app.descendants(matching: .any).matching(NSPredicate(format: "label IN {'开始', '发送'}")).firstMatch
        let english = app.descendants(matching: .any).matching(NSPredicate(format: "label IN {'Start', 'Send'}")).firstMatch
        XCTAssertTrue(chinese.waitForExistence(timeout: 15), "the app opened in English on a Chinese phone: \(app.debugDescription.prefix(1500))")
        XCTAssertFalse(english.exists, "English on a Chinese phone")
    }

    func testEachOfTheOtherLanguagesOpensInItsOwnWords() {
        // the welcome's Start in each language (mobile/src/locales/); a paired simulator shows the thread instead
        let cases: [(String, String, String)] = [
            ("zh-Hant-TW", "zh_TW", "開始"), ("es-MX", "es_MX", "Empezar"), ("ko-KR", "ko_KR", "시작하기"),
            ("ja-JP", "ja_JP", "はじめる"), ("ru-RU", "ru_RU", "Начать"),
        ]
        for (language, locale, start) in cases {
            let app = XCUIApplication()
            app.launchArguments += ["-AppleLanguages", "(\(language))", "-AppleLocale", locale]
            app.launch()
            let own = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", start)).firstMatch
            XCTAssertTrue(own.waitForExistence(timeout: 15), "\(language) did not open in its own words: \(app.debugDescription)")
            app.terminate()
        }
    }

    func testAnEnglishPhoneOpensInEnglish() {
        let app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", "(en-US)", "-AppleLocale", "en_US"]
        app.launch()
        let english = app.descendants(matching: .any).matching(NSPredicate(format: "label IN {'Start', 'Send'}")).firstMatch
        XCTAssertTrue(english.waitForExistence(timeout: 15), "the app did not open in English on an English phone: \(app.debugDescription.prefix(1500))")
    }
}
