package dev.deepseekbot.app;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.UiAutomation;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.BySelector;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * The tab bar's selected pill is black, white in dark mode, never the system's
 * dynamic color. NSH 0.3.0's TabBar takes Material 3's system palette and no color from the app; on an Android 12+
 * phone the pill was the wallpaper's tint (a grey blue on the emulator). The iOS shell's TabBarTests is the same check.
 * Pairs with a stand-in bot on 127.0.0.1 through a pairing link, then reads the selected tab's pixels in light and dark.
 */
@RunWith(AndroidJUnit4.class)
public class TabBarColorTest {
    private static final BySelector SELECTED_TAB = By.clazz("android.widget.TabWidget").selected(true);
    private final UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
    private final UiAutomation automation = InstrumentationRegistry.getInstrumentation().getUiAutomation();
    private ActivityScenario<MainActivity> scenario;
    private ServerSocket server;

    @Before
    public void start() throws IOException {
        server = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
        Thread t = new Thread(this::serve, "bot");
        t.setDaemon(true);
        t.start();
    }

    @After
    public void stop() throws IOException {
        shell("cmd uimode night no");
        if (scenario != null) scenario.close();
        server.close();
    }

    @Test
    public void theSelectedTabIsBlackInLightAndWhiteInDark() throws Exception {
        shell("cmd uimode night no");
        String origin = "http://127.0.0.1:" + server.getLocalPort();
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse("deepseekbot://pair?url=" + Uri.encode(origin + "/pair?code=123456")));
        open.setClass(ApplicationProvider.getApplicationContext(), MainActivity.class);
        scenario = ActivityScenario.launch(open);
        // a paired app opens on the chat; a fresh one on the connect screen, filled in from the link
        if (!device.wait(Until.hasObject(SELECTED_TAB), 6_000)) {
            UiObject2 connect = device.wait(Until.findObject(By.res("connect")), 20_000);
            assertNotNull("the connect screen", connect);
            connect.click();
        }
        assertNotNull("the tab bar", device.wait(Until.findObject(SELECTED_TAB), 30_000));

        for (boolean night : new boolean[] {false, true}) {
            shell("cmd uimode night " + (night ? "yes" : "no"));
            Thread.sleep(2_500);
            UiObject2 tab = device.wait(Until.findObject(SELECTED_TAB), 10_000);
            assertNotNull("the selected tab", tab);
            Rect b = tab.getVisibleBounds();
            Bitmap shot = automation.takeScreenshot();
            float dp = ApplicationProvider.getApplicationContext().getResources().getDisplayMetrics().density;
            // NSH's tab item: 12 dp of padding, then the 64 × 32 dp pill around a 24 dp glyph. Inside the pill, clear of the glyph.
            int y = b.top + Math.round(28 * dp);
            int[] xs = {b.centerX() - Math.round(24 * dp), b.centerX() + Math.round(24 * dp)};
            for (int x : xs) {
                int c = shot.getPixel(x, y);
                int r = (c >> 16) & 0xFF, g = (c >> 8) & 0xFF, bl = c & 0xFF;
                String where = (night ? "dark" : "light") + ": pill pixel at " + x + "," + y + " is #" + Integer.toHexString(c & 0xFFFFFF);
                if (night) assertTrue(where + ", not white", r >= 0xE8 && g >= 0xE8 && bl >= 0xE8);
                else assertTrue(where + ", not black", r <= 0x30 && g <= 0x30 && bl <= 0x30);
            }
        }
    }

    private void shell(String command) {
        try (ParcelFileDescriptor out = automation.executeShellCommand(command); InputStream in = new FileInputStream(out.getFileDescriptor())) {
            in.readAllBytes();
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    /** Enough of the bot for the app to pair and draw the chat: /pair, /me with a named assistant, /threads; the rest answers empty. */
    private void serve() {
        while (!server.isClosed()) {
            try (Socket s = server.accept()) {
                InputStream in = s.getInputStream();
                String head = readHead(in);
                String[] line = head.split("\r\n")[0].split(" ");
                int length = Integer.parseInt(header(head, "content-length").isEmpty() ? "0" : header(head, "content-length"));
                in.readNBytes(length);
                String path = line[1].split("\\?")[0];
                String body;
                if (path.equals("/pair")) body = "{\"token\":\"tok_abcdefghijklmnopqrstuvwxyz0123456789\"}";
                else if (path.equals("/me")) body = "{\"device\":{\"id\":\"d1\",\"name\":\"Android\"},\"assistant\":{\"name\":\"Nori\"},\"mainSessionId\":\"main\",\"connected\":true,\"pushPublicKey\":null}";
                else if (path.equals("/threads")) body = "[{\"sessionId\":\"main\",\"title\":\"\",\"updatedAt\":1700000000000,\"running\":false,\"blank\":true}]";
                else if (path.equals("/ws-ticket")) { respond(s.getOutputStream(), 503, "{}"); continue; }
                else body = line[0].equals("GET") && !path.equals("/settings") ? "[]" : "{}";
                respond(s.getOutputStream(), 200, body);
            } catch (IOException e) {
                // closed
            }
        }
    }

    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c, m = 0;
        while ((c = in.read()) >= 0) {
            b.write(c);
            m = (c == '\r' || c == '\n') ? m + 1 : 0;
            if (m == 4) break;
        }
        return b.toString(StandardCharsets.UTF_8.name());
    }

    private static String header(String head, String name) {
        for (String l : head.split("\r\n")) {
            int i = l.indexOf(':');
            if (i > 0 && l.substring(0, i).trim().equalsIgnoreCase(name)) return l.substring(i + 1).trim();
        }
        return "";
    }

    private static void respond(OutputStream out, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        out.write(("HTTP/1.1 " + status + " X\r\ncontent-type: application/json\r\ncontent-length: " + bytes.length + "\r\nconnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(bytes);
        out.flush();
    }
}
