package dev.deepseekbot.app;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Intent;
import android.graphics.Rect;
import android.net.Uri;
import android.util.Log;
import android.view.Choreographer;
import android.view.View;
import android.view.ViewGroup;
import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;
import java.net.InetAddress;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * No flash of an empty state on a device (REGRESSION.md, "No flash of an empty state"): the headless
 * flash.test.tsx sampled every 50 ms; this samples every frame the device draws, during the push animation that opens
 * a list page. The app pairs over plain http with a stand-in bot (StandInBot) this test runs on the device's loopback (no computer,
 * no adb reverse), which answers the list slowly, with a 502, or not at all. Other chats on the menu (opened again from
 * the chat, as one comes back to the list), Upcoming, Goals and Activity: in no frame does the page's
 * empty sentence show while its rows are on the way or could not be sent. At the end the bot answers 401, and the app
 * forgets the pairing, as a fresh install, for the tests after this one.
 */
@RunWith(AndroidJUnit4.class)
public class ListFlashTest {
    private static final String TAG = "ListFlashTest";
    private static final int PORT = 38517;
    private static final String CODE = "482913";
    private static final long AT = 1700000000000L;
    private final UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
    private ActivityScenario<MainActivity> scenario;
    private StandInBot bot;
    // the device's animator scale before the test (nightly's ci-android-up.sh sets 0), put back after it
    private String animatorBefore;

    /** A list page: the button that opens it from the menu (null: the menu itself), its endpoint, a row's text, its empty sentence. */
    private static final class Page {
        final String name, entry, path, row, empty, rows;
        Page(String name, String entry, String path, String row, String empty, String rows) { this.name = name; this.entry = entry; this.path = path; this.row = row; this.empty = empty; this.rows = rows; }
    }

    private static final String MAIN = "{\"sessionId\":\"main\",\"title\":\"\",\"updatedAt\":" + AT + ",\"running\":false,\"blank\":false}";
    private static final Page[] PAGES = {
        new Page("Other chats", null, "/threads", "Trip plan", "No other chats yet",
            "[" + MAIN + ",{\"sessionId\":\"s2\",\"title\":\"Trip plan\",\"updatedAt\":" + AT + ",\"running\":false,\"blank\":false}]"),
        new Page("Upcoming", "Upcoming", "/schedules", "Take pills", "Nothing scheduled",
            "[{\"id\":\"t1\",\"name\":\"Take pills\",\"instruction\":\"Remind me\",\"when\":{\"kind\":\"daily\",\"time\":\"08:00\"},\"nextRunAt\":\"2030-01-01T08:00:00.000Z\",\"active\":true}]"),
        new Page("Goals", "Goals", "/goals", "Run a 10k", "No goals yet",
            "[{\"id\":\"g1\",\"title\":\"Run a 10k\",\"plan\":[],\"notes\":[],\"status\":\"active\"}]"),
        new Page("Activity", "Activity", "/activity", "green tea", "Nothing yet. Actions",
            "[{\"id\":\"a1\",\"at\":\"2026-10-28T08:00:00.000Z\",\"kind\":\"memory\",\"text\":\"Remembered that you like green tea\"}]"),
    };

    @After
    public void close() throws Exception {
        UiObject2 welcome = null;
        boolean paired = bot != null;
        if (paired) {
            // unpair: /me answers 401 and the app forgets this computer (state.ts connect), back to the welcome screen
            bot.unauthorized = true;
            relaunch(null);
            welcome = device.wait(Until.findObject(By.res("own-computer")), 30_000);
            bot.stop();
        }
        // NSH 0.4.0 crashes in Native.scrollEnded when a scroll ends after its view is gone (ChatKeyboardTest)
        Thread.sleep(3_000);
        if (scenario != null) scenario.close();
        if (animatorBefore != null) shell("settings put global animator_duration_scale " + animatorBefore);
        if (paired) assertNotNull("the welcome screen after the bot said 401: the pairing is forgotten for the tests after this one", welcome);
    }

    @Test
    public void noListPageShowsItsEmptySentenceWhileItsRowsAreOnTheWay() throws Exception {
        // NSH's StackBox.push is a ValueAnimator: at scale 0 (nightly's emulator) a page lands in one frame and there is no
        // push to sample. Normal speed for this test; every case below also checks that some frame caught the page moving.
        animatorBefore = shell("settings get global animator_duration_scale").trim();
        shell("settings put global animator_duration_scale 1");
        // the setting reaches this process (the app's) by a callback; sampling before it lands sees no motion at all
        for (long end = System.currentTimeMillis() + 10_000; System.currentTimeMillis() < end && android.animation.ValueAnimator.getDurationScale() != 1f; ) Thread.sleep(100);
        assertTrue("the app's animator scale is " + android.animation.ValueAnimator.getDurationScale() + ", not 1", android.animation.ValueAnimator.getDurationScale() == 1f);
        bot = new StandInBot(InetAddress.getByName("127.0.0.1"), PORT);
        for (Page p : PAGES) bot.lists.put(p.path, p.rows);
        relaunch("deepseekbot://pair?origin=http://127.0.0.1:" + PORT + "&code=" + CODE);
        UiObject2 connect = device.wait(Until.findObject(By.res("connect")), 30_000);
        assertNotNull("the connect screen, filled in from the pairing link", connect);
        connect.click();
        if (!StandInBot.awaitChat(device, 40_000, TAG)) throw new AssertionError("the chat after pairing with the stand-in bot");
        Thread.sleep(1_000);

        List<String> bad = new ArrayList<>();
        for (Page p : PAGES) {
            // once at full speed, back to the chat, then again: slowly (rows after 1.5 s), with a 502, with no answer
            bot.mode.remove(p.path);
            open(p);
            if (device.wait(Until.findObject(By.textContains(p.row)), 10_000) == null) bad.add(p.name + ": its row never showed at full speed");
            backToChat(p);
            for (String mode : new String[] {"slow", "502", "none"}) {
                bot.mode.put(p.path, mode);
                bot.served.clear();
                Sampler s = new Sampler(p);
                s.start();
                open(p);
                long until = System.currentTimeMillis() + (mode.equals("slow") ? 5_000 : 2_500);
                while (System.currentTimeMillis() < until && !(mode.equals("slow") && s.rowFrame > 0 && s.frames > s.rowFrame + 10)) Thread.sleep(50);
                s.stop();
                String served = String.valueOf(bot.served.get(p.path));
                Log.i(TAG, p.name + " " + mode + ": " + s.frames + " frames, empty in " + s.emptyFrames + ", row from frame " + s.rowFrame + ", title at " + s.titleXs.size() + " x positions " + s.titleXs + ", the bot answered " + p.path + " with " + served);
                // the push was sampled while it moved: the page's title (and the menu's cell of the same name) at 3 or more x positions
                if (s.titleXs.size() < 3) bad.add(p.name + " " + mode + ": no frame caught the push moving (\"" + title(p) + "\" at x " + s.titleXs + "): animations off?");
                // the bot answered this case as it says, and only so: a 502 or a closed connection is not a list
                String want = mode.equals("slow") ? "slow 200" : mode.equals("502") ? "502" : "closed";
                List<String> got = bot.served.get(p.path);
                if (got == null || got.isEmpty()) bad.add(p.name + " " + mode + ": the page never asked for " + p.path);
                else for (String g : got) if (!g.equals(want)) bad.add(p.name + " " + mode + ": the bot answered " + p.path + " with " + g + ", not " + want);
                if (!mode.equals("slow") && s.rowFrame > 0) bad.add(p.name + " " + mode + ": a row (\"" + p.row + "\") showed from frame " + s.rowFrame + ", though the list could not be sent");
                if (s.frames < 20) bad.add(p.name + " " + mode + ": only " + s.frames + " frames sampled");
                if (s.emptyFrames > 0) bad.add(p.name + " " + mode + ": \"" + p.empty + "…\" shown in " + s.emptyFrames + " of " + s.frames + " frames, the first at frame " + s.firstEmpty + (s.rowFrame > 0 ? ", rows from frame " + s.rowFrame : ", no rows"));
                if (mode.equals("slow") && s.rowFrame < 0) bad.add(p.name + " slow: its row never showed");
                bot.mode.remove(p.path);
                backToChat(p);
            }
        }
        assertTrue(String.join("\n", bad), bad.isEmpty());
    }

    /** The title of the page as pushed: the menu's for Other chats, else the entry's own. */
    private static String title(Page p) { return p.entry != null ? p.entry : "Menu"; }

    private String shell(String command) {
        try (android.os.ParcelFileDescriptor out = InstrumentationRegistry.getInstrumentation().getUiAutomation().executeShellCommand(command);
             java.io.InputStream in = new java.io.FileInputStream(out.getFileDescriptor())) {
            return new String(in.readAllBytes());
        } catch (java.io.IOException e) {
            throw new RuntimeException(e);
        }
    }

    private void open(Page p) throws InterruptedException {
        UiObject2 menu = device.wait(Until.findObject(By.desc("Menu")), 10_000);
        assertNotNull("the Menu button", menu);
        menu.click();
        if (p.entry != null) {
            UiObject2 entry = device.wait(Until.findObject(By.text(p.entry)), 10_000);
            assertNotNull(p.entry + " on the menu", entry);
            entry.click();
        }
    }

    private void backToChat(Page p) throws InterruptedException {
        Thread.sleep(500);
        device.pressBack();
        if (p.entry != null) { Thread.sleep(800); device.pressBack(); }
        assertNotNull("the chat after " + p.name, device.wait(Until.findObject(By.res("composer")), 10_000));
        Thread.sleep(800);
    }

    private void relaunch(String link) throws InterruptedException {
        if (scenario != null) { Thread.sleep(3_000); scenario.close(); }
        Intent i = new Intent(ApplicationProvider.getApplicationContext(), MainActivity.class);
        if (link != null) i.setAction(Intent.ACTION_VIEW).setData(Uri.parse(link));
        scenario = ActivityScenario.launch(i);
    }

    /** Every frame the device draws: is the page's empty sentence on screen, and from which frame its row. */
    private final class Sampler implements Choreographer.FrameCallback {
        final Page page;
        volatile int frames, emptyFrames, firstEmpty = -1, rowFrame = -1;
        /** Every x at which a text view reading the page's title was drawn: one or two when nothing moved. */
        final java.util.Set<Integer> titleXs = java.util.concurrent.ConcurrentHashMap.newKeySet();
        final AtomicBoolean on = new AtomicBoolean();
        private volatile View root;
        Sampler(Page page) { this.page = page; }

        void start() {
            scenario.onActivity(a -> root = a.getWindow().getDecorView());
            on.set(true);
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> Choreographer.getInstance().postFrameCallback(this));
        }
        void stop() throws InterruptedException { on.set(false); Thread.sleep(100); }

        @Override public void doFrame(long nanos) {
            if (!on.get()) return;
            frames++;
            boolean[] seen = new boolean[2];
            look(root, seen);
            if (seen[0]) { emptyFrames++; if (firstEmpty < 0) firstEmpty = frames; }
            if (seen[1] && rowFrame < 0) rowFrame = frames;
            Choreographer.getInstance().postFrameCallback(this);
        }

        private void look(View v, boolean[] seen) {
            if (!v.isShown()) return;
            if (v instanceof ViewGroup && ((ViewGroup) v).getChildCount() > 0) {
                ViewGroup g = (ViewGroup) v;
                for (int i = 0; i < g.getChildCount(); i++) look(g.getChildAt(i), seen);
                return;
            }
            CharSequence t = v.createAccessibilityNodeInfo().getText();
            if (t == null) return;
            Rect r = new Rect();
            if (!v.getGlobalVisibleRect(r) || r.isEmpty() || v.getAlpha() == 0f) return;
            String s = t.toString();
            if (s.equals(title(page))) { int[] xy = new int[2]; v.getLocationOnScreen(xy); titleXs.add(xy[0]); }
            if (s.contains(page.empty)) seen[0] = true;
            if (s.contains(page.row)) seen[1] = true;
        }
    }
}
