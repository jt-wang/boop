// FCM delivers the bot's data messages here, in the foreground and the background alike (high priority; src/push-fcm.ts).
// The notification is drawn by the app so a tap always opens MainActivity with the place it is about (PushBridge.URL).
// Without google-services.json (docs/push.md) Firebase never starts, and this service is never called.
package dev.deepseekbot.app;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

public final class PushService extends FirebaseMessagingService {
    @Override
    public void onMessageReceived(RemoteMessage message) {
        PushPayload p = PushPayload.from(message.getData());
        if (p != null) PushBridge.show(this, p);
    }

    /** A new token reaches the bot the next time the app opens (native.ts afterConnect → push.token → /push/subscribe). */
    @Override
    public void onNewToken(String token) {
        PushBridge.tokenChanged(this, token);
    }
}
