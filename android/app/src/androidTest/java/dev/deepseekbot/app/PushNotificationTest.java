package dev.deepseekbot.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.os.ParcelFileDescriptor;
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
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Notifications on a device, without Firebase: the permission Android 13 asks for, a notification drawn from the bot's
 * data message (PushService hands it to PushBridge.show), and a tap that opens the app with the place it is about,
 * while the app runs (onNewIntent → the `notification` event) and when the tap launches it (host.params.notificationUrl).
 */
@RunWith(AndroidJUnit4.class)
public class PushNotificationTest {
    private final UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
    private final Context context = ApplicationProvider.getApplicationContext();
    private ActivityScenario<MainActivity> scenario;

    @After
    public void stop() {
        if (scenario != null) scenario.close();
        device.pressHome();
    }

    private void shell(String cmd) throws IOException {
        ParcelFileDescriptor out = InstrumentationRegistry.getInstrumentation().getUiAutomation().executeShellCommand(cmd);
        try (FileInputStream in = new FileInputStream(out.getFileDescriptor())) { while (in.read() >= 0) { } }
    }

    private static PushPayload payload(String title, String body, String url, String tag) {
        Map<String, String> m = new HashMap<>();
        m.put("title", title); m.put("body", body); m.put("url", url); m.put("tag", tag);
        return PushPayload.from(m);
    }

    /** Opens the shade, taps the notification titled `title`. */
    private void tap(String title) {
        device.openNotification();
        UiObject2 n = device.wait(Until.findObject(By.text(title)), 10_000);
        assertNotNull("the notification '" + title + "' in the shade", n);
        n.click();
    }

    @Test
    public void android13AsksOnceAndTheAnswerReachesTheApp() throws Exception {
        shell("pm revoke " + context.getPackageName() + " android.permission.POST_NOTIFICATIONS");
        shell("pm clear-permission-flags " + context.getPackageName() + " android.permission.POST_NOTIFICATIONS user-set user-fixed");
        scenario = ActivityScenario.launch(MainActivity.class);
        CountDownLatch done = new CountDownLatch(1);
        AtomicBoolean granted = new AtomicBoolean(false);
        scenario.onActivity(a -> a.push().askPermission(ok -> { granted.set(ok); done.countDown(); }));
        UiObject2 allow = device.wait(Until.findObject(By.res("com.android.permissioncontroller:id/permission_allow_button")), 10_000);
        assertNotNull("the system asks for notifications", allow);
        allow.click();
        assertTrue(done.await(10, TimeUnit.SECONDS));
        assertTrue("granted", granted.get());
    }

    @Test
    public void aTapWhileTheAppRunsOpensThePlace() throws Exception {
        shell("pm grant " + context.getPackageName() + " android.permission.POST_NOTIFICATIONS");
        scenario = ActivityScenario.launch(MainActivity.class);
        device.pressHome();
        PushBridge.show(context, payload("Nori has a question", "Window or aisle?", "/threads/side-1/asks/q-1", "question:q-1"));
        tap("Nori has a question");
        long end = System.currentTimeMillis() + 10_000;
        String[] opened = { null };
        while (System.currentTimeMillis() < end && opened[0] == null) { scenario.onActivity(a -> opened[0] = a.push().lastOpened); Thread.sleep(200); }
        assertEquals("/threads/side-1/asks/q-1", opened[0]);
    }

    @Test
    public void aTapThatLaunchesTheAppHandsItThePlace() throws Exception {
        shell("pm grant " + context.getPackageName() + " android.permission.POST_NOTIFICATIONS");
        MainActivity.launchedWith = null; // no activity runs: the tap starts one
        PushBridge.show(context, payload("Nori is done", "The packing list is ready.", "/threads/side-2", "turn:side-2"));
        tap("Nori is done");
        long end = System.currentTimeMillis() + 10_000;
        while (System.currentTimeMillis() < end && MainActivity.launchedWith == null) Thread.sleep(200);
        assertEquals("/threads/side-2", MainActivity.launchedWith);
    }
}
