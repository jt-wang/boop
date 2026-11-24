package dev.deepseekbot.app;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.UiAutomation;
import android.os.ParcelFileDescriptor;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.regex.Pattern;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * The main flow on the real shell (REGRESSION.md, "User flows"), on the demo (Try it: made-up data, no computer):
 * start → Try it → answer an approval → send a message and get the reply → the menu and back → Discover and back →
 * Settings and back → the app to the background and back, the thread still there. Headless tests (try.test.tsx)
 * cover the same steps without the native views; this one proves taps, the keyboard and the lifecycle on Android.
 */
@RunWith(AndroidJUnit4.class)
public class MainFlowTest {
    private static final long WAIT = 15_000;
    private final UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
    private final UiAutomation automation = InstrumentationRegistry.getInstrumentation().getUiAutomation();
    private ActivityScenario<MainActivity> scenario;

    @After
    public void close() throws InterruptedException {
        Thread.sleep(3_000); // NSH 0.4.0's scrollEnded after its view is gone (ChatKeyboardTest)
        if (scenario != null) scenario.close();
    }

    private UiObject2 need(String what, androidx.test.uiautomator.BySelector by) {
        UiObject2 o = device.wait(Until.findObject(by), WAIT);
        assertNotNull(what, o);
        return o;
    }

    @Test
    public void theDemoFromStartToBackgroundAndBack() throws Exception {
        scenario = ActivityScenario.launch(MainActivity.class);
        UiObject2 own = device.wait(Until.findObject(By.res("own-computer")), 30_000);
        if (own != null) { own.click(); need("Try it", By.res("try-it")).click(); }
        need("the demo chat", By.res("composer"));

        need("the approval card", By.text("Allow once")).click();
        need("the line after the approval", By.text(Pattern.compile(".*how asking works.*", Pattern.DOTALL)));

        need("the composer", By.res("composer")).click();
        shell("input text Book%sme%sa%stable");
        need("Send", By.res("send")).click();
        need("the sent message", By.text("Book me a table"));
        need("the demo reply", By.text(Pattern.compile(".*demo reply.*", Pattern.DOTALL)));

        need("Menu", By.desc("Menu")).click();
        need("the menu", By.text("Main chat"));
        device.pressBack();
        need("the chat after the menu", By.res("composer"));

        need("the Discover tab", By.text("Discover")).click();
        need("Discover", By.text(Pattern.compile(".*Run 10 km.*", Pattern.DOTALL)));
        need("the Chat tab", By.text("Chat")).click();
        need("the chat after Discover", By.res("composer"));

        need("Settings", By.desc("Settings")).click();
        need("Settings", By.res("demo-leave"));
        device.pressBack();
        need("the chat after Settings", By.res("composer"));

        device.pressHome();
        Thread.sleep(2_000);
        shell("am start -n " + InstrumentationRegistry.getInstrumentation().getTargetContext().getPackageName() + "/" + MainActivity.class.getName());
        need("the chat after the background", By.res("composer"));
        assertTrue("the sent message is still in the thread", device.wait(Until.hasObject(By.text("Book me a table")), WAIT));
    }

    private String shell(String command) {
        try (ParcelFileDescriptor out = automation.executeShellCommand(command); InputStream in = new FileInputStream(out.getFileDescriptor())) {
            return new String(in.readAllBytes());
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }
}
