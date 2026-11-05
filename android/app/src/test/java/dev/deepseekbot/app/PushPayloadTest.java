package dev.deepseekbot.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

/** What the bot's FCM data message (src/push-fcm.ts fcmMessage) becomes on the phone, and where a tap goes. */
public class PushPayloadTest {
    private static Map<String, String> data(String... kv) {
        Map<String, String> m = new HashMap<>();
        for (int i = 0; i < kv.length; i += 2) m.put(kv[i], kv[i + 1]);
        return m;
    }

    @Test
    public void theBotsMessageCarriesTitleBodyAndThePlaceToOpen() {
        PushPayload p = PushPayload.from(data("title", "Nori有个问题", "body", "靠窗还是靠过道？", "url", "/threads/main/asks/e1", "tag", "question:e1"));
        assertEquals("Nori有个问题", p.title);
        assertEquals("靠窗还是靠过道？", p.body);
        assertEquals("/threads/main/asks/e1", p.url);
        assertEquals("question:e1", p.tag);
    }

    @Test
    public void onlyAPlaceInTheAppIsOpened() {
        assertEquals("/", PushPayload.from(data("title", "t", "body", "b", "url", "https://evil.example/x")).url);
        assertEquals("/", PushPayload.from(data("title", "t", "body", "b", "url", "//evil.example/x")).url);
        assertEquals("/", PushPayload.from(data("title", "t", "body", "b")).url);
        assertEquals("/discover", PushPayload.launchUrl("/discover"));
        assertNull(PushPayload.launchUrl("javascript:alert(1)"));
        assertNull(PushPayload.launchUrl(null));
    }

    @Test
    public void aMessageWithoutATitleShowsNothing() {
        assertNull(PushPayload.from(data("body", "b")));
        assertNull(PushPayload.from(null));
    }

    @Test
    public void oneNotificationPerTagSoRepeatedDoneCollapses() {
        PushPayload a = PushPayload.from(data("title", "Nori is done", "body", "1", "tag", "turn:main"));
        PushPayload b = PushPayload.from(data("title", "Nori is done", "body", "2", "tag", "turn:main"));
        PushPayload c = PushPayload.from(data("title", "Nori is done", "body", "3", "tag", "turn:side"));
        assertEquals(a.notificationTag(), b.notificationTag());
        assertNotEquals(a.notificationTag(), c.notificationTag());
        PushPayload untagged1 = PushPayload.from(data("title", "t", "body", "1"));
        PushPayload untagged2 = PushPayload.from(data("title", "t", "body", "2"));
        assertNotEquals(untagged1.notificationTag(), untagged2.notificationTag());
    }

    @Test
    public void theManifestAsksForNotificationsAndRegistersTheMessagingService() throws Exception {
        String xml = new String(Files.readAllBytes(Paths.get("src/main/AndroidManifest.xml")), StandardCharsets.UTF_8);
        assertTrue("POST_NOTIFICATIONS (Android 13+)", xml.contains("android.permission.POST_NOTIFICATIONS"));
        assertTrue("the FCM service", xml.contains("android:name=\".PushService\"") && xml.contains("com.google.firebase.MESSAGING_EVENT"));
    }
}
