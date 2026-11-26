package dev.deepseekbot.app;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.UiAutomation;
import android.content.res.Configuration;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Rect;
import android.os.ParcelFileDescriptor;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.accessibility.AccessibilityNodeInfo;
import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * The screenshot baseline and layout probe of the chat (REGRESSION.md, "UI: screenshots and layout"), on the demo thread
 * (Try it: made-up rows, no bot). Light and dark, keyboard down and up, the system font at 100% and 130%: in each, the
 * date line starts below the top chrome (0.1.10's screenshots), the composer and its Send button are above the keyboard and inside
 * the screen's sides, no line of text runs past them (their laid-out bounds, not the clipped ones), and the app is in the theme, font scale and keyboard
 * state the capture's name says. All of it on the emulator's screen (411 dp) and again 360 dp wide ("small-"). Each state's screenshot goes to /data/local/tmp/boop-shots/ (a file the shell
 * user writes, so the uninstall after the run leaves it), which the nightly run pulls and checks before uploading.
 */
@RunWith(AndroidJUnit4.class)
public class ScreenshotsTest {
    private static final String SHOTS = "/data/local/tmp/boop-shots";
    // chat.tsx: 8 dp under the status pill, then the top fade's 24 dp (as ChatKeyboardTest)
    private static final int BAR_BOTTOM_DP = 8, TOP_FADE_DP = 24;
    private final UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
    private final UiAutomation automation = InstrumentationRegistry.getInstrumentation().getUiAutomation();
    private ActivityScenario<MainActivity> scenario;
    // the device's own display-size override, if it has one ("Override density: N"), put back after the run
    private String densityBefore;

    @After
    public void close() throws InterruptedException {
        shell("cmd uimode night no");
        shell("settings put system font_scale 1.0");
        if (densityBefore != null) shell(densityBefore.isEmpty() ? "wm density reset" : "wm density " + densityBefore);
        // NSH 0.4.0 crashes in Native.scrollEnded when a scroll ends after its view is gone (ChatKeyboardTest)
        Thread.sleep(3_000);
        if (scenario != null) scenario.close();
    }

    @Test
    public void theChatInEveryModeHasNothingUnderItsChromeOrTheKeyboard() throws Exception {
        // this run's captures only: what an earlier run left would pass the nightly's check of all 8
        shell("rm -rf " + SHOTS); shell("mkdir -p " + SHOTS);
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("Override density: (\\d+)").matcher(shell("wm density"));
        densityBefore = m.find() ? m.group(1) : "";
        List<String> bad = new ArrayList<>();
        // the emulator's own screen (Pixel 6, 411 dp wide), then a small one: density 480 makes its 1080 px 360 dp
        for (boolean small : new boolean[] {false, true}) {
            shell(small ? "wm density 480" : "wm density reset");
            for (String font : new String[] {"1.0", "1.3"}) {
                for (boolean night : new boolean[] {false, true}) {
                    open(night, font);
                    if (small) bad.addAll(isSmall());
                    for (boolean keyboard : new boolean[] {false, true}) {
                        String state = (small ? "small-" : "") + (night ? "dark" : "light") + "-font" + font.replace(".", "") + (keyboard ? "-keyboard" : "");
                        if (keyboard) keyboardUp(); else keyboardDown();
                        toTheTop();
                        shell("screencap -p " + SHOTS + "/android-chat-" + state + ".png");
                        bad.addAll(probe(state, keyboard, night, Float.parseFloat(font)));
                        bad.addAll(noTextPastTheSides(state));
                        bad.addAll(nothingShowsThroughUnderTheCard(state));
                        toTheEnd();
                        // at the default text size it fits, on either screen: there it is never the exception
                        bad.addAll(theLastMessageAtTheEnd(state, keyboard, font.equals("1.0")));
                        bad.addAll(theRequestIsWhole(state, FIRST));
                        bad.addAll(theButtonsStayInReach(state));
                    }
                }
            }
        }
        // the card's main button answers when tapped, here in the tightest state (small, font 130%, keyboard up, the
        // card scrolled to its end): the card goes
        UiObject2 allow = device.findObject(By.text("Allow once"));
        if (allow == null) bad.add("at the end: Allow once is not on screen to tap");
        else {
            allow.click();
            if (!device.wait(Until.gone(By.res("pinned-asks")), 10_000)) bad.add("Allow once tapped at the end: the card is still there");
        }
        // Two different cards in the tightest state (360 dp, font 130%, keyboard up), light and dark: the demo's and one
        // more that only the debug build takes from a test (TestParams). One shows at a time; the pager reaches the other;
        // answering one shows the next; both answered, none is left.
        for (boolean night : new boolean[] {false, true}) {
            asks = "[{\"eventId\":\"test-ask-0\",\"toolName\":\"mcp__browser__browser_navigate\",\"reason\":\"" + SECOND + "\"}]";
            open(night, "1.3");
            asks = null;
            keyboardUp();
            toTheEnd();
            bad.addAll(twoCards("small-" + (night ? "dark" : "light")));
        }
        bad.addAll(titlesPerCard("small-"));
        assertTrue(String.join("\n", bad), bad.isEmpty());
    }

    /**
     * Whether a card's title is kept to one line is that card's own: two cards whose bodies are as tall, one with a long title,
     * one with the demo's, in both orders and back and forth (360 dp, 130 %, keyboard up). Each title shows the same way, as
     * tall, however it was reached: a title kept to one line on one card once kept the next card's title to one line.
     */
    private List<String> titlesPerCard(String mode) throws InterruptedException {
        String card = "{\"eventId\":\"test-ask-0\",\"toolName\":\"mcp__shared-family-calendar-and-photo-albums__add\",\"reason\":\"Delete 3 old files in Documents\"";
        List<String> demo = new ArrayList<>(), other = new ArrayList<>();
        for (boolean longFirst : new boolean[] {false, true}) {
            asks = "[" + card + (longFirst ? ",\"first\":true}" : "}") + "]";
            open(false, "1.3");
            asks = null;
            keyboardUp();
            toTheEnd();
            if (device.wait(Until.findObject(By.res("ask-count")), 10_000) == null) { List<String> bad = new ArrayList<>(); bad.add(mode + " titles: no pager"); return bad; }
            if (longFirst) { other.add(title()); page("ask-next"); demo.add(title()); page("ask-previous"); other.add(title()); }
            else { demo.add(title()); page("ask-next"); other.add(title()); page("ask-previous"); demo.add(title()); page("ask-next"); other.add(title()); }
        }
        android.util.Log.i("BoopShots", "BOOP-TITLES " + mode + " demo " + demo + " long " + other);
        List<String> bad = new ArrayList<>();
        if (new java.util.HashSet<>(demo).size() > 1) bad.add(mode + " titles: the demo's title shows differently by the way it was reached: " + demo + " (after the long one: " + demo.get(2) + ")");
        if (new java.util.HashSet<>(other).size() > 1) bad.add(mode + " titles: the long title shows differently by the way it was reached: " + other);
        return bad;
    }

    private void page(String id) throws InterruptedException { device.findObject(By.res(id)).click(); Thread.sleep(1_000); }

    private String title() {
        Rect one = laidOut("ask-title-one-line"), wrapped = laidOut("ask-title");
        Rect r = one != null ? one : wrapped;
        return (one != null ? "one line " : "wrapped ") + (r == null ? "none" : String.valueOf(r.height()));
    }

    /** What the card asks, the sentence to approve, is whole in the card's body with the body at its top: never cut off. */
    private List<String> theRequestIsWhole(String state, String words) throws InterruptedException {
        List<String> bad = new ArrayList<>();
        Rect body = laidOut("ask-body");
        if (body == null) { bad.add(state + ": ask-body is not on screen"); return bad; }
        for (int i = 0; i < 15; i++) shell("input mouse scroll " + body.centerX() + " " + body.centerY() + " --axis VSCROLL,1");
        Thread.sleep(1_000);
        List<Rect> found = new ArrayList<>();
        scenario.onActivity(a -> { View b = find(a.getWindow().getDecorView(), "ask-body"); if (b != null) withText(b, words, found); });
        if (found.isEmpty()) { bad.add(state + ": \"" + words + "\" is not in the card"); return bad; }
        Rect r = found.get(0), f = laidOut("ask-body");
        if (r.top < f.top - 1 || r.bottom > f.bottom + 1) bad.add(state + ": what the card asks " + r.toShortString() + " is cut by its body " + f.toShortString());
        // the wheel at the body's top goes on to the thread: back to its end
        toTheEnd();
        return bad;
    }

    private static final String FIRST = "Delete 3 old files in Downloads", SECOND = "Open the airline site in the browser";
    /** Cards a launch passes to the debug build (TestParams.ASKS), or none. */
    private String asks;

    /** The pager on the card it shows: what a screen reader says, that card's words and not the other's. */
    private void page(List<String> bad, String state, String says, String on, String off) {
        UiObject2 count = device.findObject(By.res("ask-count"));
        String read = count == null ? "nothing" : count.getContentDescription();
        if (!says.equals(read)) bad.add(state + ": the pager reads \"" + read + "\", not \"" + says + "\"");
        if (device.findObject(By.text(on)) == null) bad.add(state + ": \"" + on + "\" does not show");
        if (device.findObject(By.text(off)) != null) bad.add(state + ": \"" + off + "\" shows too");
    }

    private List<String> twoCards(String mode) throws InterruptedException {
        List<String> bad = new ArrayList<>();
        String state = mode + " two cards";
        if (device.wait(Until.findObject(By.res("ask-count")), 10_000) == null) { bad.add(state + ": no pager (ask-count)"); return bad; }
        page(bad, state + ", first", "Request 1 of 2", FIRST, SECOND);
        // the pager is in the card's title row, not a row of its own
        Rect head = laidOut("ask-head");
        if (head == null) bad.add(state + ": no title row (ask-head)");
        else for (String id : new String[] {"ask-previous", "ask-next"}) {
            Rect r = laidOut(id);
            if (r != null && (r.centerY() < head.top || r.centerY() > head.bottom)) bad.add(state + ": " + id + " " + r.toShortString() + " is not in the card's title row " + head.toShortString());
        }
        // the pager's two buttons: 48 dp or more each way, inside the screen, above the keyboard
        float dp = ApplicationProvider.getApplicationContext().getResources().getDisplayMetrics().density;
        AtomicInteger ime = new AtomicInteger();
        scenario.onActivity(a -> { WindowInsets in = a.getWindow().getDecorView().getRootWindowInsets(); ime.set(in == null ? 0 : in.getInsets(WindowInsets.Type.ime()).bottom); });
        int above = device.getDisplayHeight() - ime.get();
        for (String id : new String[] {"ask-previous", "ask-next"}) {
            Rect r = laidOut(id);
            if (r == null) { bad.add(state + ": " + id + " is not on screen"); continue; }
            if (r.width() < Math.round(48 * dp) - 1 || r.height() < Math.round(48 * dp) - 1) bad.add(state + ": " + id + " is " + r.width() + " by " + r.height() + " px, under 48 dp (" + Math.round(48 * dp) + ")");
            if (r.bottom > above + 1) bad.add(state + ": " + id + " ends at " + r.bottom + ", under the keyboard at " + above);
        }
        // the title: whole beside the pager where it fits (one line with an ellipsis only where it does not), read whole
        // kept to one line only where the wrapped title would push the last message under the fade: on record
        android.util.Log.i("BoopShots", "BOOP-TITLE " + state + ": " + (laidOut("ask-title-one-line") != null ? "one line" : "wrapped"));
        UiObject2 title = device.findObject(By.res("ask-title"));
        if (title == null) title = device.findObject(By.res("ask-title-one-line"));
        String said = title == null ? "nothing" : title.getContentDescription() != null ? title.getContentDescription() : title.getText();
        if (!"Running a command".equals(said)) bad.add(state + ": the title reads \"" + said + "\", not \"Running a command\"");
        bad.addAll(theLastMessageAtTheEnd(state + ", first", true, false));
        bad.addAll(theRequestIsWhole(state + ", first", FIRST));
        bad.addAll(theButtonsStayInReach(state + ", first"));
        device.findObject(By.res("ask-next")).click();
        Thread.sleep(1_000);
        page(bad, state + ", after Next", "Request 2 of 2", SECOND, FIRST);
        bad.addAll(theLastMessageAtTheEnd(state + ", after Next", true, false));
        bad.addAll(theRequestIsWhole(state + ", second", SECOND));
        shell("screencap -p " + SHOTS + "/android-chat-" + mode + "-two-cards.png");
        bad.addAll(theButtonsStayInReach(state + ", second"));
        device.findObject(By.res("ask-previous")).click();
        Thread.sleep(1_000);
        page(bad, state + ", after Previous", "Request 1 of 2", FIRST, SECOND);
        bad.addAll(theLastMessageAtTheEnd(state + ", after Previous", true, false));
        // answering the first shows the second at once, without the pager; answering that leaves none
        device.findObject(By.text("Allow once")).click();
        if (!device.wait(Until.gone(By.res("ask-count")), 10_000)) bad.add(state + ": the first answered, the pager is still there");
        if (device.wait(Until.findObject(By.text(SECOND)), 5_000) == null) bad.add(state + ": the first answered, \"" + SECOND + "\" does not show");
        if (device.findObject(By.text(FIRST)) != null) bad.add(state + ": the first answered, it is still there");
        bad.addAll(theButtonsStayInReach(state + ", the second alone"));
        UiObject2 allow = device.findObject(By.text("Allow once"));
        if (allow == null) bad.add(state + ": the second alone has no Allow once");
        else {
            allow.click();
            if (!device.wait(Until.gone(By.res("pinned-asks")), 10_000)) bad.add(state + ": both answered, a card is still there");
        }
        return bad;
    }

    /** Every line of text on screen, by its laid-out bounds, is inside the screen's sides: none is cut off at an edge. */
    private List<String> noTextPastTheSides(String state) {
        List<String> bad = new ArrayList<>();
        int width = device.getDisplayWidth();
        List<Rect> texts = new ArrayList<>();
        scenario.onActivity(a -> texts(a.getWindow().getDecorView(), texts));
        for (Rect r : texts) if (r.left < -1 || r.right > width + 1) bad.add(state + ": a line of text " + r.toShortString() + " runs past the screen's side (" + width + " wide)");
        return bad;
    }

    /** The app is laid out 360 dp wide, so the small pass is of a small screen and not the default one again. */
    private List<String> isSmall() {
        AtomicInteger w = new AtomicInteger();
        scenario.onActivity(a -> w.set(a.getResources().getConfiguration().screenWidthDp));
        return Math.abs(w.get() - 360) <= 1 ? new ArrayList<>() : new ArrayList<>(List.of("small: the app is " + w.get() + " dp wide, not 360"));
    }

    /** What is wrong on screen now, in words; empty when nothing is. */
    private List<String> probe(String state, boolean keyboard, boolean night, float font) {
        List<String> bad = new ArrayList<>();
        float dp = ApplicationProvider.getApplicationContext().getResources().getDisplayMetrics().density;
        int width = device.getDisplayWidth(), height = device.getDisplayHeight();
        // the capture is of the mode its name says: the app's own theme and font scale, the keyboard as named
        AtomicReference<Configuration> config = new AtomicReference<>();
        AtomicInteger ime = new AtomicInteger();
        scenario.onActivity(a -> {
            config.set(new Configuration(a.getResources().getConfiguration()));
            WindowInsets in = a.getWindow().getDecorView().getRootWindowInsets();
            ime.set(in == null ? 0 : in.getInsets(WindowInsets.Type.ime()).bottom);
        });
        boolean isNight = (config.get().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        if (isNight != night) bad.add(state + ": the app is in " + (isNight ? "dark" : "light") + " mode");
        if (Math.abs(config.get().fontScale - font) > 0.01) bad.add(state + ": the app's font scale is " + config.get().fontScale);
        if (keyboard && ime.get() == 0) bad.add(state + ": the keyboard is not up");
        if (!keyboard && ime.get() != 0) bad.add(state + ": the keyboard is up (" + ime.get() + " px)");
        UiObject2 divider = device.wait(Until.findObject(By.res("time-divider")), 5_000);
        UiObject2 status = device.findObject(By.res("status"));
        if (divider == null || status == null) {
            bad.add(state + ": missing on screen:" + (divider == null ? " time-divider" : "") + (status == null ? " status" : ""));
            return bad;
        }
        int chrome = status.getVisibleBounds().bottom + Math.round((BAR_BOTTOM_DP + TOP_FADE_DP) * dp);
        if (divider.getVisibleBounds().top < chrome - 1) bad.add(state + ": the date line starts at " + divider.getVisibleBounds().top + ", under the top chrome, which ends at " + chrome);
        int above = height - ime.get();
        for (String id : new String[] {"composer", "send"}) {
            // where the view is laid out on screen, not clipped: UiObject2.getVisibleBounds() is already cut to the window
            // and its parents, so a view half past an edge would still look inside it
            Rect r = laidOut(id);
            if (r == null) { bad.add(state + ": " + id + " is not on screen"); continue; }
            if (r.bottom > above + 1) bad.add(state + ": " + id + " ends at " + r.bottom + ", under the keyboard, which starts at " + above);
            if (r.left < 0 || r.right > width) bad.add(state + ": " + id + " runs past the screen's side: " + r.toShortString() + " on a screen " + width + " wide");
            if (r.height() < Math.round(24 * dp)) bad.add(state + ": " + id + " is " + r.height() + " px tall, cut off");
        }
        return bad;
    }

    /**
     * With a card pinned above the composer (the demo's "Running a command") and the thread scrolled under it, the bottom
     * chrome outside the card and the composer's field is plain background: no cut-off line of a message shows through
     * between them or under the field. Row by row, across the screen less its rounded edges, every pixel is
     * the row's own colour; a line of text is not.
     */
    private List<String> nothingShowsThroughUnderTheCard(String state) {
        List<String> bad = new ArrayList<>();
        float dp = ApplicationProvider.getApplicationContext().getResources().getDisplayMetrics().density;
        Rect chrome = laidOut("bottom-chrome"), card = laidOut("pinned-asks"), field = laidOut("composer-field");
        if (chrome == null || card == null || field == null) { bad.add(state + ": missing on screen:" + (chrome == null ? " bottom-chrome" : "") + (card == null ? " pinned-asks" : "") + (field == null ? " composer-field" : "")); return bad; }
        Bitmap shot = automation.takeScreenshot();
        int x0 = Math.round(40 * dp), x1 = shot.getWidth() - x0, off = 0, rows = 0, edge = Math.round(2 * dp);
        for (int y = Math.max(chrome.top, 0); y < Math.min(chrome.bottom, shot.getHeight()); y++) {
            // the card and the field with their shadows and hairlines are not the strip
            if (y >= card.top - edge && y < card.bottom + edge) continue;
            if (y >= field.top - edge && y < field.bottom + edge) continue;
            rows++;
            int ref = shot.getPixel(shot.getWidth() / 2, y);
            for (int x = x0; x < x1; x++) {
                int c = shot.getPixel(x, y);
                if (Math.max(Math.abs(Color.red(c) - Color.red(ref)), Math.max(Math.abs(Color.green(c) - Color.green(ref)), Math.abs(Color.blue(c) - Color.blue(ref)))) > 24) off++;
            }
        }
        shot.recycle();
        if (rows == 0) bad.add(state + ": no chrome outside the card and the field to look at");
        if (off > 0) bad.add(state + ": " + off + " pixels in the " + rows + " rows of the chrome around the card and the field are not the background: the thread shows through");
        return bad;
    }

    /**
     * At the end of the thread with a card pinned, the last message is above the card, whole: no row's text is cut by
     * the card's top edge or hidden under the card, with the keyboard down and up.
     */
    private List<String> theLastMessageIsAboveTheCard(String state) { return theLastMessageIsAboveTheCard(state, true); }

    /** As above; `whole` adds: every line of the last message (msg-0) is below the top fade and above the card. */
    private List<String> theLastMessageIsAboveTheCard(String state, boolean whole) {
        List<String> bad = new ArrayList<>();
        Rect card = laidOut("pinned-asks");
        if (card == null) { bad.add(state + " at the end: pinned-asks is not on screen"); return bad; }
        List<Rect> texts = new ArrayList<>();
        scenario.onActivity(a -> { View list = find(a.getWindow().getDecorView(), "thread"); if (list != null) texts(list, texts); });
        if (texts.isEmpty()) { bad.add(state + " at the end: no message on screen"); return bad; }
        Rect last = texts.get(0);
        for (Rect r : texts) {
            if (r.bottom > last.bottom) last = r;
            if (r.top < card.top && r.bottom > card.top + 1) bad.add(state + " at the end: a message line " + r.toShortString() + " is cut by the card, which starts at " + card.top);
            else if (r.top >= card.top) bad.add(state + " at the end: a message line " + r.toShortString() + " is under the card, which starts at " + card.top);
        }
        if (last.bottom > card.top + 1 && bad.isEmpty()) bad.add(state + " at the end: the last message ends at " + last.bottom + ", under the card at " + card.top);
        if (!whole) return bad;
        float dp = ApplicationProvider.getApplicationContext().getResources().getDisplayMetrics().density;
        UiObject2 status = device.findObject(By.res("status"));
        if (status == null) { bad.add(state + " at the end: status is not on screen"); return bad; }
        int fade = status.getVisibleBounds().bottom + Math.round((BAR_BOTTOM_DP + TOP_FADE_DP) * dp);
        List<Rect> lines = new ArrayList<>();
        scenario.onActivity(a -> { View m = find(a.getWindow().getDecorView(), "msg-0"); if (m != null) texts(m, lines); });
        if (lines.isEmpty()) { bad.add(state + " at the end: no line in the last message (msg-0)"); return bad; }
        for (Rect r : lines) {
            if (r.top < fade - 1) bad.add(state + " at the end: a line of the last message " + r.toShortString() + " starts under the top fade, which ends at " + fade);
            if (r.bottom > card.top + 1) bad.add(state + " at the end: a line of the last message " + r.toShortString() + " ends past the card's top " + card.top);
        }
        return bad;
    }

    /**
     * The last message at the end of the thread, by what the screen has room for. With the keyboard up, the card shows what it
     * cannot do without first: its title row, what it asks whole, its buttons. Where that and the whole last message do not
     * both fit between the top fade and the card's bottom (a small screen, large text, a tall top inset), the last message may
     * show in part: then no line is cut by the card, and with the keyboard down it shows whole. The test measures that room
     * itself, from the laid-out views, and reads no flag of the app's: an app that got it wrong would tell the test so too.
     * `mustFit`: a state that has the room (the default text size); falling into the exception there is a layout fault.
     */
    private List<String> theLastMessageAtTheEnd(String state, boolean keyboard, boolean mustFit) throws InterruptedException {
        if (!keyboard) return theLastMessageIsAboveTheCard(state);
        float dp = ApplicationProvider.getApplicationContext().getResources().getDisplayMetrics().density;
        Rect card = laidOut("pinned-asks"), body = laidOut("ask-body"), box = laidOut("ask-reason");
        UiObject2 status = device.findObject(By.res("status"));
        List<Rect> words = new ArrayList<>(), lines = new ArrayList<>();
        AtomicReference<Rect> shown = new AtomicReference<>();
        scenario.onActivity(a -> {
            // the card itself (ask-<event id>), the body's nearest such parent: not its container, which a wrong layout could stretch
            for (android.view.ViewParent v = find(a.getWindow().getDecorView(), "ask-body") == null ? null : find(a.getWindow().getDecorView(), "ask-body").getParent(); v instanceof View; v = v.getParent()) {
                String res = ((View) v).createAccessibilityNodeInfo().getViewIdResourceName();
                if (res != null && res.matches("(.*/)?ask-.*") && !res.matches("(.*/)?ask-(body|head)")) {
                    int[] xy = new int[2]; ((View) v).getLocationOnScreen(xy);
                    shown.set(new Rect(xy[0], xy[1], xy[0] + ((View) v).getWidth(), xy[1] + ((View) v).getHeight()));
                    break;
                }
            }
            View b = find(a.getWindow().getDecorView(), "ask-body"); if (b != null) texts(b, words);
            View m = find(a.getWindow().getDecorView(), "msg-0"); if (m != null) texts(m, lines);
        });
        if (card == null || body == null || box == null || shown.get() == null || status == null || lines.isEmpty()) return theLastMessageIsAboveTheCard(state);
        int fade = status.getVisibleBounds().bottom + Math.round((BAR_BOTTOM_DP + TOP_FADE_DP) * dp);
        // what the card cannot do without: its body from its first words to the end of the box that holds what it asks (the
        // body scrolls, so what comes after may stay below), and the last message's lines from first to last
        // + 8 dp: the container's padding under the card
        int top = box.top; for (Rect r : words) top = Math.min(top, r.top);
        int must = shown.get().height() - body.height() + box.bottom - top + Math.round(8 * dp), message = span(lines);
        // 8 dp: the space the thread keeps between its last line and the card
        boolean fits = fade + message + Math.round(8 * dp) + must <= card.bottom + 1;
        android.util.Log.i("BoopShots", "BOOP-FIT " + state + ": " + (fits ? "fits" : "exception") + " (fade " + fade + ", card must " + must + ", message " + message + ", card bottom " + card.bottom + ")");
        if (fits) return theLastMessageIsAboveTheCard(state);
        List<String> bad = new ArrayList<>();
        if (mustFit) {
            bad.add(state + " at the end: no room for the whole last message (" + message + " px) and what the card must show (" + must + " px) between the top fade at " + fade + " and the card's bottom at " + card.bottom + ": this state has that room");
            bad.addAll(theLastMessageIsAboveTheCard(state));
            return bad;
        }
        bad.addAll(theLastMessageIsAboveTheCard(state, false));
        keyboardDown();
        toTheEnd();
        bad.addAll(theLastMessageIsAboveTheCard(state + ", keyboard down"));
        keyboardUp();
        toTheEnd();
        return bad;
    }

    /** From the top of the first to the bottom of the last. */
    private static int span(List<Rect> rs) {
        int top = Integer.MAX_VALUE, bottom = Integer.MIN_VALUE;
        for (Rect r : rs) { top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom); }
        return bottom - top;
    }

    /**
     * With what the card asks scrolled to its end inside it, Decline and Allow once are still in the card, whole (laid-out
     * bounds), above the keyboard and below the top chrome, and the topmost view at their centre is theirs.
     */
    private List<String> theButtonsStayInReach(String state) throws InterruptedException {
        List<String> bad = new ArrayList<>();
        Rect body = laidOut("ask-body"), card = laidOut("pinned-asks");
        if (body == null || card == null) { bad.add(state + " card end: missing on screen:" + (body == null ? " ask-body" : "") + (card == null ? " pinned-asks" : "")); return bad; }
        // a wheel over the card's body: a drag would start a gesture the thread may take (keyboardDismissMode)
        for (int i = 0; i < 15; i++) shell("input mouse scroll " + body.centerX() + " " + body.centerY() + " --axis VSCROLL,-1");
        Thread.sleep(1_000);
        card = laidOut("pinned-asks");
        AtomicInteger ime = new AtomicInteger();
        scenario.onActivity(a -> { WindowInsets in = a.getWindow().getDecorView().getRootWindowInsets(); ime.set(in == null ? 0 : in.getInsets(WindowInsets.Type.ime()).bottom); });
        int above = device.getDisplayHeight() - ime.get();
        UiObject2 status = device.findObject(By.res("status"));
        int top = status == null ? 0 : status.getVisibleBounds().bottom;
        float dp = ApplicationProvider.getApplicationContext().getResources().getDisplayMetrics().density;
        // nothing of the card spills out of its room: every line in it outside its scrolling body ends inside it and above
        // the message field ("Allow for this task" once ran under the field)
        Rect field = laidOut("composer-field"), inBody = laidOut("ask-body");
        List<Rect> lines = new ArrayList<>();
        scenario.onActivity(a -> { View c = find(a.getWindow().getDecorView(), "pinned-asks"); if (c != null) texts(c, lines); });
        // the walk sees the card's buttons (on iOS, a check reading only static text passed with these two under the field)
        for (String words : new String[] {"Allow for this task", "Always allow"}) {
            List<Rect> found = new ArrayList<>();
            scenario.onActivity(a -> { View c = find(a.getWindow().getDecorView(), "pinned-asks"); if (c != null) withText(c, words, found); });
            if (found.isEmpty()) bad.add(state + " card end: \"" + words + "\" not among the card's lines: the check cannot see it");
        }
        for (Rect r : lines) {
            if (inBody != null && r.top >= inBody.top - 1 && r.bottom <= inBody.bottom + 1) continue;
            if (r.bottom > card.bottom + 1 || (field != null && r.bottom > field.top + 1)) bad.add(state + " card end: a line " + r.toShortString() + " runs past the card (" + card.bottom + ") or under the message field (" + (field == null ? "?" : field.top) + ")");
        }
        for (String label : new String[] {"Decline", "Allow once"}) {
            List<Rect> found = new ArrayList<>();
            scenario.onActivity(a -> withText(a.getWindow().getDecorView(), label, found));
            if (found.isEmpty()) { bad.add(state + " card end: " + label + " is not on screen"); continue; }
            Rect r = found.get(0);
            if (r.top < card.top - 1 || r.bottom > card.bottom + 1) bad.add(state + " card end: " + label + " " + r.toShortString() + " is outside the card " + card.toShortString());
            if (r.bottom > above + 1) bad.add(state + " card end: " + label + " ends at " + r.bottom + ", under the keyboard at " + above);
            if (r.top < top) bad.add(state + " card end: " + label + " starts at " + r.top + ", under the top chrome at " + top);
            if (r.height() < Math.round(14 * dp)) bad.add(state + " card end: " + label + " is " + r.height() + " px tall, cut off");
            UiObject2 o = device.findObject(By.text(label));
            if (o == null || !o.getVisibleBounds().contains(r.centerX(), r.centerY())) bad.add(state + " card end: " + label + " is not where a tap at its centre reaches it");
        }
        return bad;
    }

    /** The laid-out bounds of every shown view that reads exactly this text. */
    private static void withText(View v, String text, List<Rect> out) {
        if (!v.isShown()) return;
        if (v instanceof ViewGroup && ((ViewGroup) v).getChildCount() > 0) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) withText(g.getChildAt(i), text, out);
            return;
        }
        CharSequence t = v.createAccessibilityNodeInfo().getText();
        if (t == null || !t.toString().equals(text)) return;
        int[] xy = new int[2];
        v.getLocationOnScreen(xy);
        out.add(new Rect(xy[0], xy[1], xy[0] + Math.round(v.getWidth() * v.getScaleX()), xy[1] + Math.round(v.getHeight() * v.getScaleY())));
    }

    /** The laid-out bounds of every view under this one that reads as text, shown. */
    private static void texts(View v, List<Rect> out) {
        if (!v.isShown()) return;
        if (v instanceof ViewGroup && ((ViewGroup) v).getChildCount() > 0) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) texts(g.getChildAt(i), out);
            return;
        }
        CharSequence t = v.createAccessibilityNodeInfo().getText();
        if (t == null || t.toString().trim().isEmpty() || v.getHeight() == 0) return;
        int[] xy = new int[2];
        v.getLocationOnScreen(xy);
        out.add(new Rect(xy[0], xy[1], xy[0] + Math.round(v.getWidth() * v.getScaleX()), xy[1] + Math.round(v.getHeight() * v.getScaleY())));
    }

    /** The view with this test id (NSH's resource name), as laid out on screen: its position with its transforms, its full size. */
    private Rect laidOut(String id) {
        AtomicReference<Rect> out = new AtomicReference<>();
        scenario.onActivity(a -> {
            View v = find(a.getWindow().getDecorView(), id);
            if (v == null) return;
            int[] xy = new int[2];
            v.getLocationOnScreen(xy);
            out.set(new Rect(xy[0], xy[1], xy[0] + Math.round(v.getWidth() * v.getScaleX()), xy[1] + Math.round(v.getHeight() * v.getScaleY())));
        });
        return out.get();
    }

    private static View find(View v, String id) {
        if (v.getVisibility() == View.VISIBLE) {
            AccessibilityNodeInfo n = v.createAccessibilityNodeInfo();
            String res = n.getViewIdResourceName();
            if (id.equals(res) || (res != null && res.endsWith("/" + id))) return v;
        }
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) { View f = find(g.getChildAt(i), id); if (f != null) return f; }
        }
        return null;
    }

    private void open(boolean night, String font) throws InterruptedException {
        if (scenario != null) { Thread.sleep(3_000); scenario.close(); }
        shell("cmd uimode night " + (night ? "yes" : "no"));
        shell("settings put system font_scale " + font);
        Intent launch = new Intent(ApplicationProvider.getApplicationContext(), MainActivity.class);
        if (asks != null) launch.putExtra("dev.deepseekbot.testAsks", asks);
        scenario = ActivityScenario.launch(launch);
        UiObject2 own = device.wait(Until.findObject(By.res("own-computer")), 30_000);
        if (own != null) {
            own.click();
            UiObject2 tryIt = device.wait(Until.findObject(By.res("try-it")), 10_000);
            assertNotNull("Try it", tryIt);
            tryIt.click();
        }
        assertNotNull("the demo chat", device.wait(Until.findObject(By.res("composer")), 30_000));
        Thread.sleep(1_000);
    }

    private void keyboardUp() throws InterruptedException {
        device.findObject(By.res("composer")).click();
        for (int i = 0; i < 20 && !keyboardShown(); i++) Thread.sleep(250);
        Thread.sleep(1_000);
    }

    private void keyboardDown() throws InterruptedException {
        if (keyboardShown()) device.pressBack();
        for (int i = 0; i < 20 && keyboardShown(); i++) Thread.sleep(250);
        Thread.sleep(500);
    }

    /** To the top of the thread without a drag, which would take the keyboard down (keyboardDismissMode). */
    private void toTheTop() throws InterruptedException {
        Rect c = device.findObject(By.res("composer")).getVisibleBounds();
        for (int i = 0; i < 15; i++) shell("input mouse scroll " + c.centerX() + " " + (c.top / 2) + " --axis VSCROLL,1");
        Thread.sleep(1_500);
    }

    /** To the end of the thread, as toTheTop. */
    private void toTheEnd() throws InterruptedException {
        Rect c = device.findObject(By.res("composer")).getVisibleBounds();
        for (int i = 0; i < 25; i++) shell("input mouse scroll " + c.centerX() + " " + (c.top / 2) + " --axis VSCROLL,-1");
        Thread.sleep(1_500);
    }

    private boolean keyboardShown() {
        return shell("dumpsys input_method").contains("mInputShown=true");
    }

    private String shell(String command) {
        try (ParcelFileDescriptor out = automation.executeShellCommand(command); InputStream in = new FileInputStream(out.getFileDescriptor())) {
            return new String(in.readAllBytes());
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }
}
