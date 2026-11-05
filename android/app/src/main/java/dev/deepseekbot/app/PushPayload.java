// The bot's FCM data message (src/push-fcm.ts fcmMessage: title, body, url, tag) as a notification on the phone.
// No Android types here: the JVM tests read it directly (PushPayloadTest).
package dev.deepseekbot.app;

import java.util.Map;
import java.util.UUID;

final class PushPayload {
    final String title;
    final String body;
    /** A place in the app (`/threads/<id>`, `/threads/<id>/asks/<event>`, `/discover`); `/` when the message named none. */
    final String url;
    /** The bot's collapse tag (`turn:<id>`, `question:<event>`): one notification per tag, a newer one replaces it. */
    final String tag;

    private PushPayload(String title, String body, String url, String tag) { this.title = title; this.body = body; this.url = url; this.tag = tag; }

    /** Null when there is nothing to show. */
    static PushPayload from(Map<String, String> data) {
        if (data == null) return null;
        String title = data.get("title");
        if (title == null || title.isEmpty()) return null;
        String body = data.get("body");
        String url = launchUrl(data.get("url"));
        String tag = data.get("tag");
        return new PushPayload(title, body == null ? "" : body, url == null ? "/" : url, tag == null || tag.isEmpty() ? null : tag);
    }

    /** Only a path inside the app is opened: never another scheme or host. */
    static String launchUrl(String url) {
        if (url == null || !url.startsWith("/") || url.startsWith("//")) return null;
        return url;
    }

    /** NotificationManager's tag: the bot's tag, so repeats collapse; a fresh one for an untagged message. */
    String notificationTag() { return tag != null ? tag : "untagged:" + UUID.randomUUID(); }
}
