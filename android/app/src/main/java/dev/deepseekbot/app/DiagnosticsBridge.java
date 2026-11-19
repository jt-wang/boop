package dev.deepseekbot.app;

import android.app.Activity;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import android.os.Build;
import android.os.PowerManager;
import android.util.AtomicFile;
import com.longbridge.nsh.NshView;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/** On-demand system readings and explicit sharing. No listeners, timers or network. */
final class DiagnosticsBridge {
    static void attach(Activity activity, NshView view) {
        AtomicFile journal = new AtomicFile(new File(activity.getNoBackupFilesDir(), "boop-diagnostics.json"));
        view.handle("diagnostics.read", (data, reply) -> {
            try { reply.resolve(journal.getBaseFile().exists() ? new String(journal.readFully(), StandardCharsets.UTF_8) : null); }
            catch (IOException error) { reply.reject("Diagnostic storage failed"); }
        });
        view.handle("diagnostics.write", (data, reply) -> {
            Object value = data instanceof Map ? ((Map<?, ?>) data).get("text") : null;
            if (!(value instanceof String) || ((String) value).getBytes(StandardCharsets.UTF_8).length > 262144) {
                reply.reject("Invalid diagnostic journal"); return;
            }
            FileOutputStream stream = null;
            try {
                stream = journal.startWrite();
                stream.write(((String) value).getBytes(StandardCharsets.UTF_8));
                journal.finishWrite(stream);
                reply.resolve(true);
            } catch (IOException error) { journal.failWrite(stream); reply.reject("Diagnostic storage failed"); }
        });
        view.handle("diagnostics.remove", (data, reply) -> {
            journal.delete();
            if (journal.getBaseFile().exists()) reply.reject("Diagnostic storage failed");
            else reply.resolve(true);
        });
        view.handle("diagnostics.sample", (data, reply) -> activity.runOnUiThread(() -> {
            Map<String, Object> fields = new HashMap<>();
            if (!activity.hasWindowFocus()) { reply.resolve(fields); return; }
            Intent battery = activity.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (battery != null) {
                int level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
                int scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
                if (level >= 0 && scale > 0) fields.put("batteryLevel", (double) level / scale);
                int state = battery.getIntExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_UNKNOWN);
                fields.put("charging", state == BatteryManager.BATTERY_STATUS_CHARGING ? "charging" : state == BatteryManager.BATTERY_STATUS_FULL ? "full" : state == BatteryManager.BATTERY_STATUS_UNKNOWN ? "unknown" : "unplugged");
            }
            PowerManager power = activity.getSystemService(PowerManager.class);
            fields.put("lowPower", power.isPowerSaveMode() ? "on" : "off");
            if (Build.VERSION.SDK_INT >= 29) {
                fields.put("androidThermalStatus", power.getCurrentThermalStatus());
            }
            reply.resolve(fields);
        }));
        view.handle("diagnostics.share", (data, reply) -> activity.runOnUiThread(() -> {
            Object value = data instanceof Map ? ((Map<?, ?>) data).get("text") : null;
            if (!(value instanceof String) || ((String) value).getBytes(StandardCharsets.UTF_8).length > 262144) {
                reply.reject("Invalid diagnostic export"); return;
            }
            Intent intent = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, (String) value)
                .putExtra(Intent.EXTRA_TITLE, "Boop Diagnostics").putExtra(Intent.EXTRA_SUBJECT, "Boop Diagnostics");
            activity.startActivity(Intent.createChooser(intent, "Boop Diagnostics"));
            reply.resolve(Map.of("opened", true));
        }));
    }
}
