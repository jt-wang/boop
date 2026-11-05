// Generated interfaces, the iOS shell's UiBridge.swift on Android. The app asks
//   ui.open { url, auth, token, title, rootKey, origin, moduleId }
// with the signed .nshpkg the bot published. The shell downloads it with the device token, verifies it against the
// bot's root key (NshTrust, one trust store per bot origin, so a package signed by another bot is refused) and runs it
// full screen over the app: a second NshView, its own VM and limits, with
//   params { token, origin, moduleId }   (also answered as `launch.params`, the same name the browser build uses,
//   so one module source runs everywhere)
// The module posts its result to the bot itself and calls `ui.close`.
package dev.deepseekbot.app;

import android.app.Activity;
import android.app.Dialog;
import android.content.res.Configuration;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsetsController;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.longbridge.nsh.NshHostReply;
import com.longbridge.nsh.NshPackage;
import com.longbridge.nsh.NshTrust;
import com.longbridge.nsh.NshView;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class UiBridge {
    private static final String TAG = "ui";

    /** How a `ui.open` ends: resolved with what the app gets, or rejected with why. */
    interface Reply {
        void resolve(Object value);
        void reject(String message);
    }

    private final Activity activity;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private final Map<String, NshTrust> trusts = new HashMap<>();
    private final List<ModuleDialog> open = new ArrayList<>();

    UiBridge(Activity activity) {
        this.activity = activity;
    }

    /** Wire the view's `ui.open`. */
    void attach(NshView view) {
        view.handle("ui.open", (data, reply) -> open(data, new Reply() {
            @Override public void resolve(Object value) { reply.resolve(value); }
            @Override public void reject(String message) { reply.reject(message); }
        }));
    }

    /** A module downloaded and verified: what runs it. */
    interface Loaded {
        void run(NshPackage pkg, Map<String, Object> params, String grant, long downloadedMs);
    }

    /** Downloads and verifies the module the args name, off the main thread; `loaded` on the main thread, else `reply` is rejected. */
    @SuppressWarnings("unchecked")
    void load(Object data, Reply reply, Loaded loaded) {
        Map<String, Object> args = data instanceof Map ? (Map<String, Object>) data : new HashMap<>();
        String url = string(args.get("url")), auth = string(args.get("auth")), rootKey = string(args.get("rootKey")), moduleId = string(args.get("moduleId"));
        if (url.isEmpty() || auth.isEmpty() || rootKey.isEmpty() || !moduleId.matches("[A-Za-z0-9_-]+")) {
            reply.reject("ui.open needs url, auth, rootKey and moduleId");
            return;
        }
        long started = System.nanoTime();
        work.execute(() -> {
            try {
                URL u = new URL(url);
                String origin = args.get("origin") instanceof String && !string(args.get("origin")).isEmpty()
                        ? string(args.get("origin"))
                        : u.getProtocol() + "://" + u.getHost() + (u.getPort() >= 0 ? ":" + u.getPort() : "");
                File file = download(u, auth, moduleId);
                long downloadedMs = (System.nanoTime() - started) / 1_000_000;
                // Verifies off the main thread, then runs; a refused package throws here and nothing is shown.
                NshPackage pkg = trust(origin, rootKey).openPackage(file);
                Map<String, Object> params = new HashMap<>();
                params.put("token", string(args.get("token")));
                params.put("origin", origin);
                params.put("moduleId", moduleId);
                // [compliance] App Review 4.7.2 / 4.7.3, Google Play's interpreter exception: the module reaches its own
                // bot, its two host functions and what the person allowed for this interface, nothing else.
                String grant = grant(origin, list(args.get("grants")));
                Log.i(TAG, "ui load " + moduleId + " grant " + grant);
                main.post(() -> loaded.run(pkg, params, grant, downloadedMs));
            } catch (NshPackage.RefusedException e) {
                Log.w(TAG, "ui load refused: " + e.getMessage());
                reply.reject(e.getMessage());
            } catch (Exception e) {
                Log.w(TAG, "ui load failed: " + e);
                reply.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            }
        });
    }

    /** Downloads, verifies and shows the module; `reply` once it shows or was refused. Any thread. */
    @SuppressWarnings("unchecked")
    void open(Object data, Reply reply) {
        Map<String, Object> args = data instanceof Map ? (Map<String, Object>) data : new HashMap<>();
        long started = System.nanoTime();
        load(data, reply, (pkg, params, grant, downloadedMs) -> {
            try {
                ModuleDialog dialog = new ModuleDialog(string(args.get("title")), params, grant);
                dialog.run(pkg);
                long ms = (System.nanoTime() - started) / 1_000_000;
                Log.i(TAG, "ui.open " + pkg.appId + " build " + pkg.build + " — download " + downloadedMs + " ms, verified+shown " + ms + " ms");
                Map<String, Object> result = new HashMap<>();
                result.put("ok", true);
                result.put("id", pkg.appId);
                result.put("name", pkg.appName);
                result.put("build", pkg.build);
                result.put("downloadMs", downloadedMs);
                result.put("ms", ms);
                reply.resolve(result);
            } catch (RuntimeException e) {
                pkg.close();
                reply.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    private File download(URL url, String auth, String moduleId) throws IOException {
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        c.setConnectTimeout(30_000);
        c.setReadTimeout(60_000);
        c.setRequestProperty("Authorization", "Bearer " + auth);
        try {
            int status = c.getResponseCode();
            if (status != 200) throw new IOException("download failed: HTTP " + status);
            File dir = new File(activity.getCacheDir(), "ui");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
            File file = new File(dir, moduleId + ".nshpkg");
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(file)) {
                byte[] buf = new byte[64 * 1024];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            }
            return file;
        } finally {
            c.disconnect();
        }
    }

    /** One trust store per bot origin under the files directory; the root is added on first use (adding it again is harmless). */
    private synchronized NshTrust trust(String origin, String rootKey) throws IOException {
        NshTrust t = trusts.get(origin);
        if (t == null) {
            File dir = new File(new File(activity.getFilesDir(), "nsh-trust"), origin.replaceAll("[^A-Za-z0-9]", "_"));
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
            t = new NshTrust(dir);
            trusts.put(origin, t);
        }
        if (!t.addRoot(rootKey)) throw new IOException("the bot's root key is not a valid key");
        return t;
    }

    /** Modules on screen now (tests look at them). */
    List<ModuleDialog> openModules() { return new ArrayList<>(open); }

    /** The activity is going away: close the modules over it. */
    void closeAll() {
        for (ModuleDialog d : new ArrayList<>(open)) d.dismiss();
    }

    private static String string(Object o) { return o instanceof String ? (String) o : ""; }

    /** A JS array as the host channel hands it over: a List, or an array. */
    @SuppressWarnings("unchecked")
    static List<Object> list(Object o) {
        if (o instanceof List) return (List<Object>) o;
        if (o instanceof Object[]) return java.util.Arrays.asList((Object[]) o);
        return new ArrayList<>();
    }

    /**
     * [compliance] The capabilities a module's view is granted (NshView.setGrantedCapabilities): the bot's host,
     * `launch.params` and `ui.close`, and per permission the person allowed: https links, the clipboard, the photo
     * picker. The iOS shell's UiBridge.grant, key for key.
     */
    static String grant(String origin, List<Object> grants) {
        String host;
        try { host = new URL(origin).getHost(); } catch (Exception e) { host = ""; }
        StringBuilder s = new StringBuilder("{");
        if (grants.contains("clipboard")) s.append("\"clipboard\":true,");
        s.append("\"host\":[\"launch.params\",\"ui.close\"],");
        s.append("\"network\":{\"hosts\":[\"").append(host.replaceAll("[^A-Za-z0-9.:\\[\\]-]", "")).append("\"]}");
        if (grants.contains("openUrl")) s.append(",\"openUrl\":{\"schemes\":[\"https\"]}");
        if (grants.contains("picker")) s.append(",\"picker\":true");
        return s.append("}").toString();
    }

    /** Full screen over the app: a title bar with Done, and one NshView running the module. */
    final class ModuleDialog extends Dialog {
        final NshView app;
        private final FrameLayout body;
        private final Map<String, Object> params;

        @SuppressWarnings("deprecation")
        ModuleDialog(String title, Map<String, Object> params, String grant) {
            super(activity, R.style.DeepSeekBot_Module);
            this.params = params;
            app = new NshView(activity);
            app.setLimits(0, 0, 0, 0, 0); // an app embedded in this one: NSH's default limits for embedded apps
            app.setGrantedCapabilities(grant); // [compliance] applies from the load in run(); no native component is registered
            app.setParams(params);
            app.setErrorListener(this::failed);
            app.handle("ui.close", (data, reply) -> { dismiss(); reply.resolve(null); });
            app.handle("launch.params", (data, reply) -> reply.resolve(this.params));

            float dp = activity.getResources().getDisplayMetrics().density;
            LinearLayout root = new LinearLayout(activity);
            root.setOrientation(LinearLayout.VERTICAL);
            LinearLayout bar = new LinearLayout(activity);
            bar.setGravity(Gravity.CENTER_VERTICAL);
            bar.setPadding((int) (16 * dp), 0, (int) (4 * dp), 0);
            TextView name = new TextView(activity);
            name.setText(title);
            name.setSingleLine(true);
            name.setEllipsize(android.text.TextUtils.TruncateAt.END);
            name.setTextColor(activity.getColor(R.color.foreground));
            name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
            name.setTypeface(Typeface.create(Typeface.DEFAULT, 600, false));
            bar.addView(name, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
            TextView done = new TextView(activity);
            done.setText(R.string.done);
            done.setContentDescription(activity.getString(R.string.done));
            done.setTextColor(activity.getColor(R.color.foreground));
            done.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
            done.setTypeface(Typeface.create(Typeface.DEFAULT, 600, false));
            done.setGravity(Gravity.CENTER);
            done.setPadding((int) (12 * dp), 0, (int) (12 * dp), 0);
            done.setMinWidth((int) (48 * dp));
            done.setOnClickListener(v -> dismiss());
            TypedValue ripple = new TypedValue();
            activity.getTheme().resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, ripple, true);
            done.setBackgroundResource(ripple.resourceId);
            bar.addView(done, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, (int) (48 * dp)));
            root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, (int) (56 * dp)));
            body = new FrameLayout(activity);
            body.addView(app, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            root.addView(body, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
            // Android 15 draws every window edge to edge (target SDK 35): the title bar goes below the status bar;
            // the module's view gets the rest of the insets as its safe area.
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                int top = Build.VERSION.SDK_INT >= 30
                        ? insets.getInsets(android.view.WindowInsets.Type.statusBars() | android.view.WindowInsets.Type.displayCutout()).top
                        : insets.getSystemWindowInsetTop();
                v.setPadding(0, top, 0, 0);
                return insets;
            });
            setContentView(root);
            setOnDismissListener(d -> {
                open.remove(this);
                app.destroy();
            });
        }

        void run(NshPackage pkg) {
            app.runPackage(pkg);
            show();
            Window w = getWindow();
            if (w != null) {
                w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
                int bg = activity.getColor(R.color.background);
                w.setStatusBarColor(bg);
                w.setNavigationBarColor(bg);
                lightBars(w);
            }
            open.add(this);
        }

        @SuppressWarnings("deprecation")
        private void lightBars(Window w) {
            boolean dark = (activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
            if (Build.VERSION.SDK_INT >= 30) {
                WindowInsetsController c = w.getInsetsController();
                if (c == null) return;
                int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                c.setSystemBarsAppearance(dark ? 0 : light, light);
            } else if (!dark) {
                View decor = w.getDecorView();
                decor.setSystemUiVisibility(decor.getSystemUiVisibility() | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
            }
        }

        /** A fatal error of the module: said under it, in small type (the iOS sheet's footnote). */
        private void failed(String message) {
            Log.e(TAG, "module: " + message);
            TextView label = new TextView(activity);
            label.setText(message);
            label.setTextColor(activity.getColor(R.color.muted));
            label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            float dp = activity.getResources().getDisplayMetrics().density;
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
            lp.setMargins((int) (16 * dp), 0, (int) (16 * dp), (int) (16 * dp));
            body.addView(label, lp);
        }
    }
}
