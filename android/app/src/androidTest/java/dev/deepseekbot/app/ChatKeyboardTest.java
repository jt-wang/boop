package dev.deepseekbot.app;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.UiAutomation;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Rect;
import android.os.ParcelFileDescriptor;
import android.view.View;
import android.widget.TextView;
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
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * The chat with the keyboard up, in light and dark, on the demo thread (Try it: made-up rows, no bot).
 * 0.1.10's screenshots (2026-11-22): the date line at the top of the thread was half under the top chrome, and in dark
 * mode the composer had no caret. NSH's Android views draw no `maskImage`, so the top fade (chat.tsx) is a solid band
 * down to its bottom edge, not a gradient; and the composer, with no `caretColor`, kept the platform's caret: Material's accent
 * (teal on the emulator, the wallpaper's tint on an Android 12+ phone), which did not show on the dark composer.
 */
@RunWith(AndroidJUnit4.class)
public class ChatKeyboardTest {
    // chat.tsx: the bar's wrapper has 8 dp under the status pill (`pb-2`), and the top fade reaches 24 dp past that.
    private static final int BAR_BOTTOM_DP = 8, TOP_FADE_DP = 24;
    private final UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
    private final UiAutomation automation = InstrumentationRegistry.getInstrumentation().getUiAutomation();
    private final float dp = ApplicationProvider.getApplicationContext().getResources().getDisplayMetrics().density;
    private ActivityScenario<MainActivity> scenario;

    /** The demo chat, the app started in that mode (as on a phone already in dark mode). */
    private void openTheDemo(boolean night) throws InterruptedException {
        if (scenario != null) { Thread.sleep(3_000); scenario.close(); }
        shell("cmd uimode night " + (night ? "yes" : "no"));
        scenario = ActivityScenario.launch(MainActivity.class);
        UiObject2 own = device.wait(Until.findObject(By.res("own-computer")), 30_000);
        if (own != null) {
            own.click();
            UiObject2 tryIt = device.wait(Until.findObject(By.res("try-it")), 10_000);
            assertNotNull("Try it", tryIt);
            tryIt.click();
        }
        assertNotNull("the demo chat", device.wait(Until.findObject(By.res("composer")), 30_000));
    }

    @After
    public void close() throws InterruptedException {
        shell("cmd uimode night no");
        // NSH 0.4.0 crashes in Native.scrollEnded when a scroll ends after its view is gone: let the thread settle first
        Thread.sleep(3_000);
        if (scenario != null) scenario.close();
    }

    @Test
    public void theDateLineClearsTheTopChromeWithTheKeyboardUp() throws Exception {
        for (boolean night : new boolean[] {false, true}) {
            String mode = night ? "dark" : "light";
            keyboardUp(night);
            // to the top of the thread without a drag (a drag takes the keyboard down: keyboardDismissMode)
            UiObject2 composer = device.findObject(By.res("composer"));
            Rect c = composer.getVisibleBounds();
            for (int i = 0; i < 15; i++) shell("input mouse scroll " + c.centerX() + " " + (c.top / 2) + " --axis VSCROLL,1");
            Thread.sleep(1_500);
            assertTrue(mode + ": the keyboard stayed up", keyboardShown());
            UiObject2 divider = device.wait(Until.findObject(By.res("time-divider")), 5_000);
            UiObject2 status = device.findObject(By.res("status"));
            assertNotNull(mode + ": the date line at the top", divider);
            assertNotNull(mode + ": the status pill", status);
            int fadeBottom = status.getVisibleBounds().bottom + Math.round((BAR_BOTTOM_DP + TOP_FADE_DP) * dp);
            int top = divider.getVisibleBounds().top;
            assertTrue(mode + ": the date line starts at " + top + " px, under the top chrome, which ends at " + fadeBottom, top >= fadeBottom - 1);
        }
    }

    @Test
    public void theComposerCaretStandsOutInLightAndDark() throws Exception {
        for (boolean night : new boolean[] {false, true}) {
            String mode = night ? "dark" : "light";
            keyboardUp(night);
            // a letter, so the caret sits after it on the composer's own background, clear of the placeholder
            shell("input text x");
            Thread.sleep(500);
            // where the EditText draws its caret, on screen: the line's box at the selection's end
            Rect at = new Rect();
            scenario.onActivity(a -> {
                View focus = a.getCurrentFocus();
                assertTrue(mode + ": the composer has the focus", focus instanceof TextView);
                TextView t = (TextView) focus;
                int[] xy = new int[2];
                t.getLocationOnScreen(xy);
                int end = Math.max(t.getSelectionEnd(), 0), line = t.getLayout().getLineForOffset(end);
                int x = xy[0] + t.getTotalPaddingLeft() - t.getScrollX() + Math.round(t.getLayout().getPrimaryHorizontal(end));
                int y = xy[1] + t.getTotalPaddingTop() - t.getScrollY();
                at.set(x, y + t.getLayout().getLineTop(line), x + Math.round(3 * dp), y + t.getLayout().getLineBottom(line));
            });
            // the caret blinks (500 ms on, 500 off): its most visible pixel over four periods, in the app's text color
            AtomicInteger foreground = new AtomicInteger();
            scenario.onActivity(a -> foreground.set(a.getColor(R.color.foreground)));
            double best = 0;
            int caret = 0, bg = 0;
            for (int i = 0; i < 20 && !(best >= 3 && near(caret, foreground.get())); i++) {
                Bitmap shot = automation.takeScreenshot();
                int under = shot.getPixel(at.right + Math.round(8 * dp), at.centerY());
                for (int x = at.left; x < at.right; x++) {
                    for (int y = at.top + 2; y < at.bottom - 2; y++) {
                        double c = contrast(shot.getPixel(x, y), under);
                        if (c > best || c >= 3 && near(shot.getPixel(x, y), foreground.get())) { best = c; caret = shot.getPixel(x, y); bg = under; }
                    }
                }
                Thread.sleep(200);
            }
            String seen = mode + ": the caret in " + at.toShortString() + " is #" + hex(caret) + " on #" + hex(bg) + " (" + String.format("%.2f", best) + ":1)";
            assertTrue(seen + ", not the app's text color #" + hex(foreground.get()), near(caret, foreground.get()));
            assertTrue(seen + ", under 3:1", best >= 3);
        }
    }

    private static String hex(int c) {
        return String.format("%06x", c & 0xFFFFFF);
    }

    private static boolean near(int a, int b) {
        return Math.abs(Color.red(a) - Color.red(b)) <= 24 && Math.abs(Color.green(a) - Color.green(b)) <= 24 && Math.abs(Color.blue(a) - Color.blue(b)) <= 24;
    }

    private void keyboardUp(boolean night) throws Exception {
        openTheDemo(night);
        UiObject2 composer = device.wait(Until.findObject(By.res("composer")), 10_000);
        assertNotNull("the composer", composer);
        composer.click();
        for (int i = 0; i < 20 && !keyboardShown(); i++) Thread.sleep(250);
        assertTrue("the keyboard is up", keyboardShown());
        Thread.sleep(1_000);
    }

    private boolean keyboardShown() {
        return shell("dumpsys input_method").contains("mInputShown=true");
    }

    /** WCAG's contrast ratio of two opaque colors. */
    private static double contrast(int a, int b) {
        double l1 = Color.luminance(a), l2 = Color.luminance(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }

    private String shell(String command) {
        try (ParcelFileDescriptor out = automation.executeShellCommand(command); InputStream in = new FileInputStream(out.getFileDescriptor())) {
            return new String(in.readAllBytes());
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }
}
