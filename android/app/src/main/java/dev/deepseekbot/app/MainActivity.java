// One full-screen NshView running assets/nsh/bundle.nshc (built from mobile/ by scripts/android-build.sh). The NSH
// app draws into the system bars' areas itself. The iOS shell's RootViewController + SceneDelegate.
package dev.deepseekbot.app;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.WindowInsetsController;
import com.longbridge.nsh.NshView;
import io.jingtao.tailpocket.nsh.TailPocketNsh;
import kotlinx.coroutines.CoroutineScopeKt;
import java.util.HashMap;
import java.util.Map;

public final class MainActivity extends Activity {
    private static final String TAG = "nsh";
    private NshView app;
    private UiBridge ui;
    private PushBridge push;
    /** [push] The place the notification that launched this activity points at (tests read it). */
    static volatile String launchedWith;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        edgeToEdge();
        app = new NshView(this);
        app.setErrorListener(message -> Log.e(TAG, message));
        // The app is this shell's own code, as it was in the APK `nsh package` made (AppActivity: no limits). An
        // embedder can only raise them: the largest heap and budgets setLimits takes; the stack keeps its default.
        app.setLimits(2047, 0, Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MAX_VALUE);
        setContentView(app);
        MonoTabBar.attach(app); // the tab bar in black and white, not the system's dynamic color

        ui = new UiBridge(this);
        ui.attach(app); // generated interfaces open full screen over this view
        InlineModule.register(this, ui, app); // and inside the thread (`boop.module`)
        push = new PushBridge(this);
        push.attach(app); // [push] permission, the FCM token, taps on notifications
        TailPocketNsh.INSTANCE.attach(app, CoroutineScopeKt.MainScope()); // how this phone reaches a computer running Boop (docs/connection.md)

        Map<String, Object> params = new HashMap<>();
        // `ui`: this shell runs the modules the assistant writes (UiBridge, `ui.open`); an app without it opens them in the browser
        params.put("ui", true);
        // `inlineUi`: this shell also runs them inside the thread (InlineModule)
        params.put("inlineUi", true);
        // Opened from a deepseekbot://pair link: the app starts on the connect screen with it filled in.
        String pair = PairLink.pairUrl(getIntent().getDataString());
        if (pair != null) params.put("pairUrl", pair);
        // [compliance] Opened from a link to an interface (an App Link to the host's /open/…, or deepseekbot://ui/…).
        String link = getIntent().getDataString();
        if (PairLink.isInterfaceLink(link)) params.put("linkUrl", link);
        // [push] Opened by a tap on a notification: the app opens where it points.
        String tapped = PushBridge.urlFrom(getIntent());
        if (tapped != null) params.put("notificationUrl", tapped);
        launchedWith = tapped;
        // `dev.deepseekbot.HOST_URL` (scripts/android-build.sh --host): the host that gives this build's accounts a
        // computer; the app reads it as `host.params.hostUrl`. Empty: self-hosting only.
        String host = hostUrl();
        if (!host.isEmpty()) params.put("hostUrl", host);
        app.setParams(params);
        app.loadAssetBundle("nsh");
    }

    /** A pairing link opened while the app runs (`host.on("pair")`). */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String tapped = PushBridge.urlFrom(intent); // [push] a tap on a notification while the app runs
        if (tapped != null) { push.opened(tapped); return; }
        String pair = PairLink.pairUrl(intent.getDataString());
        if (pair != null) {
            Map<String, Object> data = new HashMap<>();
            data.put("url", pair);
            app.send("pair", data);
        } else if (PairLink.isInterfaceLink(intent.getDataString())) { // [compliance] a link to an interface while running
            Map<String, Object> data = new HashMap<>();
            data.put("url", intent.getDataString());
            app.send("link", data);
        }
    }

    // [push] Whether a person can see the app: the bot sends notifications only while no one does.
    @Override
    protected void onStart() { super.onStart(); if (push != null) push.appState("foreground"); }

    @Override
    protected void onStop() { if (push != null) push.appState("background"); super.onStop(); }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == PushBridge.PERMISSION_REQUEST) push.onPermissionResult(results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED);
    }

    /** The notifications bridge (tests open notifications through it). */
    PushBridge push() { return push; }

    /** The modules bridge (tests open modules through it). */
    UiBridge ui() { return ui; }

    private String hostUrl() {
        try {
            ApplicationInfo info = getPackageManager().getApplicationInfo(getPackageName(), PackageManager.GET_META_DATA);
            String v = info.metaData == null ? null : info.metaData.getString("dev.deepseekbot.HOST_URL");
            return v == null ? "" : v.trim();
        } catch (PackageManager.NameNotFoundException e) {
            return "";
        }
    }

    /** Draw behind the system bars: the app gets them as `safeArea()` (as nsh's AppActivity does). */
    @SuppressWarnings("deprecation")
    private void edgeToEdge() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        getWindow().setStatusBarColor(0);
        getWindow().setNavigationBarColor(0);
        systemBars();
    }

    /** Dark system bar icons in light mode, light ones in dark mode. */
    @SuppressWarnings("deprecation")
    private void systemBars() {
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        View decor = getWindow().getDecorView();
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c == null) return;
            int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            c.setSystemBarsAppearance(dark ? 0 : light, light);
        } else {
            int flags = decor.getSystemUiVisibility();
            int light = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            decor.setSystemUiVisibility(dark ? flags & ~light : flags | light);
        }
    }

    @Override
    public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
        systemBars();
    }

    /** Android 12 and older: the app gets the back button first. */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (app == null || !app.handleBack()) super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        ui.closeAll();
        InlineModule.stopAll();
        app.destroy();
        super.onDestroy();
    }
}
