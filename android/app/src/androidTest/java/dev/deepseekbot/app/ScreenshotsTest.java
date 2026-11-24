package dev.deepseekbot.app;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.UiAutomation;
import android.content.res.Configuration;
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
 * the screen's sides (their laid-out bounds, not the clipped ones), and the app is in the theme, font scale and keyboard
 * state the capture's name says. Each state's screenshot goes to /data/local/tmp/boop-shots/ (a file the shell
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

    @After
    public void close() throws InterruptedException {
        shell("cmd uimode night no");
        shell("settings put system font_scale 1.0");
        // NSH 0.4.0 crashes in Native.scrollEnded when a scroll ends after its view is gone (ChatKeyboardTest)
        Thread.sleep(3_000);
        if (scenario != null) scenario.close();
    }

    @Test
    public void theChatInEveryModeHasNothingUnderItsChromeOrTheKeyboard() throws Exception {
        // this run's captures only: what an earlier run left would pass the nightly's check of all 8
        shell("rm -rf " + SHOTS); shell("mkdir -p " + SHOTS);
        List<String> bad = new ArrayList<>();
        for (String font : new String[] {"1.0", "1.3"}) {
            for (boolean night : new boolean[] {false, true}) {
                open(night, font);
                for (boolean keyboard : new boolean[] {false, true}) {
                    String state = (night ? "dark" : "light") + "-font" + font.replace(".", "") + (keyboard ? "-keyboard" : "");
                    if (keyboard) keyboardUp(); else keyboardDown();
                    toTheTop();
                    shell("screencap -p " + SHOTS + "/android-chat-" + state + ".png");
                    bad.addAll(probe(state, keyboard, night, Float.parseFloat(font)));
                    bad.addAll(nothingShowsThroughUnderTheCard(state));
                    toTheEnd();
                    bad.addAll(theLastMessageIsAboveTheCard(state));
                }
            }
        }
        assertTrue(String.join("\n", bad), bad.isEmpty());
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
    private List<String> theLastMessageIsAboveTheCard(String state) {
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
        return bad;
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
        scenario = ActivityScenario.launch(MainActivity.class);
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
