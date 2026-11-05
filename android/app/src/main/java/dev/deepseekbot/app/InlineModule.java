// A generated interface inside the thread (the app's `nativeComponent("boop.module")`, mobile/src/cards.tsx): the
// same signed package `ui.open` runs full screen (UiBridge), downloaded and verified the same way, run in a second
// NshView laid out where the card is. The module says how tall it is (`ui.size`, which the bot's build adds around
// its root, src/ui.ts) and the view takes that height; `ui.close` from the module tells the app (`close`).
//
// The thread's list remounts a row's views when rows around it change (four loads of one interface in one turn,
// measured 2026-11-02), and a reload loses what the person chose in it. So a running interface outlives the
// component: on destroy its view is kept (the last few, by module), and the next component for that module takes it
// over as it is.
package dev.deepseekbot.app;

import android.app.Activity;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import com.longbridge.nsh.NshComponent;
import com.longbridge.nsh.NshComponentContext;
import com.longbridge.nsh.NshView;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

final class InlineModule implements NshComponent {
    static final String NAME = "boop.module";
    private static final String TAG = "ui";
    /** Interfaces kept running after their row left the screen. */
    private static final int KEEP = 4;

    /** A running interface and the component showing it now (null while kept). */
    private static final class Live {
        final NshView app;
        InlineModule owner;
        float height;
        Live(NshView app) { this.app = app; }
    }
    private static final LinkedHashMap<String, Live> live = new LinkedHashMap<>(8, 0.75f, true);

    private final Activity activity;
    private final UiBridge ui;
    private final NshComponentContext ctx;
    private final FrameLayout box;
    private final Map<String, Object> props = new HashMap<>();
    private Live shown;
    private String key;
    private boolean started, destroyed;

    InlineModule(Activity activity, UiBridge ui, NshComponentContext ctx) {
        this.activity = activity;
        this.ui = ui;
        this.ctx = ctx;
        this.box = new FrameLayout(activity);
    }

    /** Registers the component on the app's view. */
    static void register(Activity activity, UiBridge ui, NshView view) {
        view.registerComponent(NAME, ctx -> new InlineModule(activity, ui, ctx));
    }

    @Override public View view() { return box; }

    /** The props are `ui.open`'s args; the module starts once all of them are there. */
    @Override public void setProp(String name, Object value) {
        props.put(name, value);
        if (!started && props.get("url") instanceof String && props.get("auth") instanceof String && props.get("rootKey") instanceof String && props.get("moduleId") instanceof String) start();
    }

    private void start() {
        started = true;
        key = props.get("moduleId") + "|" + props.get("url"); // a rebuilt interface is another package
        Live kept = live.get(key);
        if (kept != null && kept.owner == null) { show(kept); Log.i(TAG, "inline " + props.get("moduleId") + " kept, shown again"); return; }
        ui.load(new HashMap<>(props), new UiBridge.Reply() {
            @Override public void resolve(Object value) {}
            @Override public void reject(String message) { Log.w(TAG, "inline " + key + ": " + message); ctx.emit("failed", message); }
        }, (pkg, params, grant, downloadedMs) -> {
            if (destroyed) { pkg.close(); return; }
            params.put("inline", true);
            NshView app = new NshView(activity);
            Live l = new Live(app);
            app.setLimits(0, 0, 0, 0, 0); // NSH's default limits for an app embedded in this one, as full screen
            app.setGrantedCapabilities(grant.replace("\"host\":[\"launch.params\",\"ui.close\"]", "\"host\":[\"launch.params\",\"ui.close\",\"ui.size\"]"));
            app.setParams(params);
            app.setErrorListener(message -> { Log.e(TAG, "inline module: " + message); if (l.owner != null) l.owner.ctx.emit("failed", message); });
            app.handle("launch.params", (data, reply) -> reply.resolve(params));
            app.handle("ui.close", (data, reply) -> { if (l.owner != null) l.owner.ctx.emit("close", null); reply.resolve(null); });
            app.handle("ui.size", (data, reply) -> {
                Object h = data instanceof Map ? ((Map<?, ?>) data).get("height") : null;
                if (h instanceof Number && ((Number) h).floatValue() > 0) {
                    l.height = ((Number) h).floatValue();
                    if (l.owner != null) l.owner.sized(l.height);
                }
                reply.resolve(null);
            });
            Live old = live.put(key, l);
            if (old != null && old != l && old.owner == null) old.app.destroy();
            show(l);
            app.runPackage(pkg);
            Log.i(TAG, "inline " + pkg.appId + " shown, download " + downloadedMs + " ms");
        });
    }

    private void show(Live l) {
        shown = l;
        l.owner = this;
        ViewGroup parent = (ViewGroup) l.app.getParent();
        if (parent != null) parent.removeView(l.app);
        box.addView(l.app, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        if (l.height > 0) sized(l.height);
        ctx.emit("ready", null);
    }

    private void sized(float height) {
        float dp = activity.getResources().getDisplayMetrics().density;
        ctx.setSize(box.getWidth() / dp, height);
        ctx.emit("size", height);
    }

    /** The activity is going: stop every kept interface (its views belong to that activity). */
    static void stopAll() {
        for (Live l : live.values()) l.app.destroy();
        live.clear();
    }

    @Override public void destroy() {
        destroyed = true;
        Live l = shown;
        shown = null;
        if (l == null) return;
        if (l.owner == this) l.owner = null;
        box.removeView(l.app);
        // Keep the last few; the rest stop.
        int over = live.size() - KEEP;
        for (Iterator<Map.Entry<String, Live>> it = live.entrySet().iterator(); over > 0 && it.hasNext(); ) {
            Live e = it.next().getValue();
            if (e.owner != null) continue;
            e.app.destroy();
            it.remove();
            over--;
        }
    }
}
