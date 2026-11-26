package dev.deepseekbot.app;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Intent;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.util.Log;
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
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * The connection lost and back on a device (REGRESSION.md, "Connection"): Wi-Fi off, airplane mode, and the computer's bot
 * restarting. The stand-in bot (StandInBot) runs on the device and the app pairs with it at the device's own Wi-Fi
 * address, so turning Wi-Fi off really takes the address away and Android closes the app's sockets on it, as with a
 * computer on the LAN. In each: the status reads Reconnecting while the connection is gone, in every sample and never
 * Online, with no /events socket opened meanwhile; it comes back to Online over a new /events socket once the connection
 * is back, and the reply the assistant wrote meanwhile shows exactly once, with the row from before it still there once.
 */
@RunWith(AndroidJUnit4.class)
public class NetworkRecoveryTest {
    private static final String TAG = "NetworkRecoveryTest";
    private static final int PORT = 38518;
    private static final String CODE = "482913";
    private static final String RECONNECTING = "Reconnecting", CHANGING = "(changing)";
    private static final String BEFORE = "Before the break: the plan is saved.";
    private final UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
    private ActivityScenario<MainActivity> scenario;
    private StandInBot bot;

    @After
    public void close() throws Exception {
        // the network back whatever happened, for the tests after this one
        shell("cmd connectivity airplane-mode disable");
        shell("svc wifi enable");
        UiObject2 welcome = null;
        boolean paired = bot != null;
        if (paired) {
            try { bot.startListening(); } catch (IOException alreadyListening) {}
            // unpair: /me answers 401 and the app forgets this computer, back to the welcome screen (as ListFlashTest)
            bot.unauthorized = true;
            relaunch(null);
            welcome = device.wait(Until.findObject(By.res("own-computer")), 60_000);
            bot.stop();
        }
        // NSH 0.4.0 crashes in Native.scrollEnded when a scroll ends after its view is gone (ChatKeyboardTest)
        Thread.sleep(3_000);
        if (scenario != null) scenario.close();
        if (paired) assertNotNull("the welcome screen after the bot said 401: the pairing is forgotten for the tests after this one", welcome);
    }

    @Test
    public void wifiOffAirplaneModeAndABotRestartAllComeBackOnlineWithWhatWasSaidMeanwhileOnce() throws Exception {
        String address = wifiAddress();
        assertNotNull("the device's Wi-Fi address", address);
        bot = new StandInBot(InetAddress.getByName("0.0.0.0"), PORT);
        // the main thread in GET /threads, as the bot lists it: openMain follows it and opens /events
        bot.lists.put("/threads", "[{\"sessionId\":\"" + StandInBot.MAIN + "\",\"title\":\"\",\"updatedAt\":" + System.currentTimeMillis() + ",\"running\":false,\"blank\":false}]");
        bot.addRow("r0", BEFORE);
        relaunch("deepseekbot://pair?origin=http://" + address + ":" + PORT + "&code=" + CODE);
        UiObject2 connect = device.wait(Until.findObject(By.res("connect")), 30_000);
        assertNotNull("the connect screen, filled in from the pairing link", connect);
        connect.click();
        if (!StandInBot.awaitChat(device, 40_000, TAG)) throw new AssertionError("the chat after pairing at " + address);
        assertTrue("Online after pairing, status \"" + status() + "\"", waitFor(true, 30_000));
        assertNotNull("the thread's first row", device.wait(Until.findObject(By.text(BEFORE)), 15_000));

        List<String> bad = new ArrayList<>();
        int n = 0;
        for (String outage : new String[] {"wifi", "airplane", "restart"}) {
            n++;
            String meanwhile = "While away (" + outage + "): your train leaves at 8:12.";
            switch (outage) {
                case "wifi": shell("svc wifi disable"); break;
                case "airplane": shell("cmd connectivity airplane-mode enable"); break;
                default: bot.stopListening();
            }
            long t0 = System.currentTimeMillis();
            boolean left = waitForStatus(RECONNECTING, 30_000);
            long leftMs = System.currentTimeMillis() - t0;
            if (!left) bad.add(outage + ": not \"" + RECONNECTING + "\" 30 s after the connection went, status \"" + status() + "\"");
            bot.addRow("r" + n, meanwhile);
            // gone for a while: the app tries again and must not get through, or claim it did. Every sample the status
            // can be read in says Reconnecting, none says Online or anything else, and no /events socket opens.
            int during = bot.eventsOpened, readable = 0;
            List<String> seen = new ArrayList<>();
            for (long end = System.currentTimeMillis() + 8_000; System.currentTimeMillis() < end; Thread.sleep(200)) {
                String st = status();
                if (st.equals(CHANGING)) continue;
                readable++;
                if (!st.contains(RECONNECTING) && !seen.contains(st)) seen.add(st);
            }
            if (readable < 20) bad.add(outage + ": the status could be read only " + readable + " times while the connection was gone");
            for (String st : seen) bad.add(outage + ": \"" + st + "\" while the connection was still gone");
            if (bot.eventsOpened != during) bad.add(outage + ": " + (bot.eventsOpened - during) + " /events sockets opened while the connection was gone");
            if (device.findObject(By.text(meanwhile)) != null) bad.add(outage + ": the reply written while away showed before the connection came back");
            // the baseline for "a new socket" is the count just before the connection comes back
            int beforeBack = bot.eventsOpened;
            switch (outage) {
                case "wifi": shell("svc wifi enable"); break;
                case "airplane": shell("cmd connectivity airplane-mode disable"); break;
                default: bot.startListening();
            }
            long t1 = System.currentTimeMillis();
            boolean back = waitFor(true, 90_000);
            long backMs = System.currentTimeMillis() - t1;
            if (!back) bad.add(outage + ": not Online 90 s after the connection came back, status \"" + status() + "\"; " + reachable(address));
            if (bot.eventsOpened <= beforeBack) bad.add(outage + ": no new /events socket after the connection came back");
            if (device.wait(Until.findObject(By.text(meanwhile)), 15_000) == null) bad.add(outage + ": the reply written while away never showed");
            Thread.sleep(1_500);
            int meanwhileShown = device.findObjects(By.text(meanwhile)).size(), beforeShown = device.findObjects(By.text(BEFORE)).size();
            // exactly once now: a reply that showed and then went away is as wrong as one shown twice
            if (meanwhileShown != 1) bad.add(outage + ": the reply written while away shows " + meanwhileShown + " times");
            if (beforeShown != 1) bad.add(outage + ": the row from before shows " + beforeShown + " times");
            Log.i(TAG, outage + ": left Online after " + leftMs + " ms, back after " + backMs + " ms, status read " + readable + " times while away, /events opened " + (bot.eventsOpened - beforeBack) + " times after, reply shown " + meanwhileShown + ", earlier row " + beforeShown);
            // the next outage starts from a settled connection
            Thread.sleep(2_000);
        }
        assertTrue(String.join("\n", bad), bad.isEmpty());
    }

    /** Until the status line reads these words, or `ms` passes. */
    private boolean waitForStatus(String words, long ms) throws InterruptedException {
        for (long end = System.currentTimeMillis() + ms; System.currentTimeMillis() < end; Thread.sleep(250)) if (status().contains(words)) return true;
        return false;
    }

    /** Until the status line reads Online (or no longer does), or `ms` passes. */
    private boolean waitFor(boolean online, long ms) throws InterruptedException {
        for (long end = System.currentTimeMillis() + ms; System.currentTimeMillis() < end; Thread.sleep(250)) if (statusIsOnline() == online) return true;
        return false;
    }

    private boolean statusIsOnline() { return (" " + status() + " ").contains(" Online "); }

    /** The chat's status line, its words. */
    private String status() {
        UiObject2 s = device.findObject(By.res("status"));
        if (s == null) return "(no status)";
        List<String> words = new ArrayList<>();
        try { for (UiObject2 o : s.findObjects(By.textStartsWith(""))) if (o.getText() != null && !o.getText().isEmpty()) words.add(o.getText()); }
        catch (androidx.test.uiautomator.StaleObjectException e) { return CHANGING; }
        return String.join(" ", words);
    }

    /** When the app did not get back: can this process reach the bot at the paired address, and is that still the
     *  Wi-Fi address? A yes says the app is stuck; a no says the device's network is. */
    private static String reachable(String address) {
        String now;
        try { now = address.equals(wifiAddress()) ? "the Wi-Fi address is unchanged" : "the Wi-Fi address changed"; } catch (Exception e) { now = "no Wi-Fi address"; }
        try (java.net.Socket s = new java.net.Socket()) {
            s.connect(new java.net.InetSocketAddress(address, PORT), 3_000);
            return now + ", and a socket from the test reaches the bot";
        } catch (IOException e) {
            return now + ", and a socket from the test does not reach the bot (" + e.getClass().getSimpleName() + ")";
        }
    }

    /** The device's IPv4 address on Wi-Fi. */
    private static String wifiAddress() throws Exception {
        for (NetworkInterface i : Collections.list(NetworkInterface.getNetworkInterfaces())) {
            if (!i.getName().startsWith("wlan") || !i.isUp()) continue;
            for (InetAddress a : Collections.list(i.getInetAddresses())) if (a instanceof Inet4Address) return a.getHostAddress();
        }
        return null;
    }

    private void relaunch(String link) throws InterruptedException {
        if (scenario != null) { Thread.sleep(3_000); scenario.close(); }
        Intent i = new Intent(ApplicationProvider.getApplicationContext(), MainActivity.class);
        if (link != null) i.setAction(Intent.ACTION_VIEW).setData(Uri.parse(link));
        scenario = ActivityScenario.launch(i);
    }

    private String shell(String command) {
        try (ParcelFileDescriptor out = InstrumentationRegistry.getInstrumentation().getUiAutomation().executeShellCommand(command);
             InputStream in = new FileInputStream(out.getFileDescriptor())) {
            return new String(in.readAllBytes());
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }
}
