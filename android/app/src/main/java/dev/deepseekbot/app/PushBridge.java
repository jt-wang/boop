// Notifications for the NSH app on Android, over the view's channel (mobile/src/native.ts), as the iOS shell's
// PushBridge.swift does with APNs:
//   push.request → { granted }              asks for POST_NOTIFICATIONS on Android 13+ (once; later calls read the answer)
//   push.token   → { token, kind: "fcm" }   the FCM registration token; rejected when this build has no Firebase project
//   notification { url }                    a tap while the app runs; a tap that launched it is host.params.notificationUrl
//   appState     { state }                  "background" / "foreground" (MainActivity onStop / onStart)
package dev.deepseekbot.app;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;
import com.longbridge.nsh.NshHostReply;
import com.longbridge.nsh.NshView;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

final class PushBridge {
    private static final String TAG = "push";
    /** The intent extra a notification's tap carries to MainActivity. */
    static final String URL = "dev.deepseekbot.notificationUrl";
    static final String CHANNEL = "assistant";
    static final int PERMISSION_REQUEST = 7301;

    private final Activity activity;
    private NshView app;
    private final List<Consumer<Boolean>> waitingForPermission = new ArrayList<>();
    /** The last place a tap asked the app to open (tests read it). */
    volatile String lastOpened;

    PushBridge(Activity activity) { this.activity = activity; }

    void attach(NshView view) {
        app = view;
        view.handle("push.request", (data, reply) -> activity.runOnUiThread(() -> askPermission(ok -> reply.resolve(granted(ok)))));
        view.handle("push.token", (data, reply) -> token(reply));
    }

    /** Whether notifications may show: asks for POST_NOTIFICATIONS on Android 13+ when the person has not answered yet. UI thread. */
    void askPermission(Consumer<Boolean> done) {
        if (Build.VERSION.SDK_INT < 33 || activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            done.accept(enabled(activity));
            return;
        }
        waitingForPermission.add(done);
        if (waitingForPermission.size() == 1) activity.requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, PERMISSION_REQUEST);
    }

    /** MainActivity.onRequestPermissionsResult. */
    void onPermissionResult(boolean ok) {
        List<Consumer<Boolean>> waiting = new ArrayList<>(waitingForPermission);
        waitingForPermission.clear();
        Log.i(TAG, "POST_NOTIFICATIONS granted=" + ok);
        for (Consumer<Boolean> r : waiting) r.accept(ok && enabled(activity));
    }

    private static Map<String, Object> granted(boolean ok) {
        Map<String, Object> m = new HashMap<>();
        m.put("granted", ok);
        return m;
    }

    private static boolean enabled(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        return nm != null && nm.areNotificationsEnabled();
    }

    /** FCM's token. Firebase starts only in a build with the owner's google-services.json; otherwise this says so. */
    private void token(NshHostReply reply) {
        com.google.firebase.messaging.FirebaseMessaging fm;
        try {
            if (com.google.firebase.FirebaseApp.getApps(activity).isEmpty()) { reply.reject("this build has no Firebase project (android/app/google-services.json)"); return; }
            fm = com.google.firebase.messaging.FirebaseMessaging.getInstance();
        } catch (RuntimeException e) {
            reply.reject("Firebase is not set up: " + e.getMessage());
            return;
        }
        fm.getToken().addOnCompleteListener(task -> {
            if (!task.isSuccessful() || task.getResult() == null) {
                Exception e = task.getException();
                Log.w(TAG, "FCM token failed: " + (e == null ? "no token" : e.getMessage()));
                reply.reject(e == null ? "no token" : e.getMessage());
                return;
            }
            Log.i(TAG, "FCM token received (" + task.getResult().length() + " chars)");
            Map<String, Object> m = new HashMap<>();
            m.put("token", task.getResult());
            m.put("kind", "fcm");
            reply.resolve(m);
        });
    }

    /** A tap while the app runs (MainActivity.onNewIntent). */
    void opened(String url) {
        if (url == null) return;
        lastOpened = url;
        if (app == null) return;
        Map<String, Object> m = new HashMap<>();
        m.put("url", url);
        app.send("notification", m);
    }

    /** MainActivity onStart / onStop: the bot pushes only while no one can see the app (src/server.ts presence). */
    void appState(String state) {
        if (app == null) return;
        Map<String, Object> m = new HashMap<>();
        m.put("state", state);
        app.send("appState", m);
    }

    /** The url a notification's tap put in the intent, or null. */
    static String urlFrom(Intent intent) {
        return intent == null ? null : PushPayload.launchUrl(intent.getStringExtra(URL));
    }

    /** One notification for the bot's message: the channel, the text, and a tap that opens the app at `p.url`. */
    static void show(Context c, PushPayload p) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        ensureChannel(c, nm);
        Intent open = new Intent(c, MainActivity.class)
                .setAction(Intent.ACTION_VIEW)
                .putExtra(URL, p.url)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        String tag = p.notificationTag();
        PendingIntent tap = PendingIntent.getActivity(c, tag.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(c, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(p.title)
                .setContentText(p.body)
                .setStyle(new Notification.BigTextStyle().bigText(p.body))
                .setContentIntent(tap)
                .setAutoCancel(true)
                .setCategory(p.tag != null && (p.tag.startsWith("approval:") || p.tag.startsWith("question:")) ? Notification.CATEGORY_MESSAGE : Notification.CATEGORY_STATUS)
                .build();
        nm.notify(tag, 1, n);
    }

    static void ensureChannel(Context c, NotificationManager nm) {
        if (nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, c.getString(R.string.notification_channel), NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription(c.getString(R.string.notification_channel_hint));
        nm.createNotificationChannel(ch);
    }

    static void tokenChanged(Context c, String token) {
        Log.i(TAG, "FCM token changed (" + (token == null ? 0 : token.length()) + " chars); the app sends it on its next start");
    }
}
