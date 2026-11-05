// NSH 0.3.0's Android TabBar (com.longbridge.nsh.TabBarComponent) paints its selected pill, glyphs and labels from
// the system's Material 3 palette (android.R.color.system_accent2_*, system_neutral*: the wallpaper's colors on
// Android 12+) and takes no color from the app. The app is black and white only, as the iOS shell gets through
// the window tint. This repaints the bar's items with TabColors before each frame, after NSH painted them.
// It depends on NSH's view tree for a tab: Item (LinearLayout) → [indicator (FrameLayout, background = the pill,
// a GradientDrawable) → glyph (ImageView)], label (TextView); read from nsh.aar 0.3.0 with javap (2026-10-28).
// If that shape changes, the items are left as NSH drew them and TabBarColorTest fails.
package dev.deepseekbot.app;

import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.widget.ImageView;
import android.widget.TextView;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;

final class MonoTabBar implements ViewTreeObserver.OnGlobalLayoutListener, ViewTreeObserver.OnPreDrawListener {
    static final String ITEM = "com.longbridge.nsh.TabBarComponent$Item";
    static final String BAR = "com.longbridge.nsh.TabBarComponent$Bar";
    private final View root;
    private final List<WeakReference<ViewGroup>> items = new ArrayList<>();

    private MonoTabBar(View root) { this.root = root; }

    static void attach(View root) {
        MonoTabBar m = new MonoTabBar(root);
        ViewTreeObserver o = root.getViewTreeObserver();
        o.addOnGlobalLayoutListener(m);
        o.addOnPreDrawListener(m);
    }

    /** The tree changed: find the tab items again (a tab bar appears after pairing, and again after a sign-out). */
    @Override
    public void onGlobalLayout() {
        boolean current = !items.isEmpty();
        for (WeakReference<ViewGroup> ref : items) { ViewGroup v = ref.get(); if (v == null || !v.isAttachedToWindow()) current = false; }
        if (current) return; // the walk is skipped while the bar we know is on screen
        items.clear();
        collect(root);
    }

    @Override
    public boolean onPreDraw() {
        boolean night = (root.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        for (WeakReference<ViewGroup> ref : items) {
            ViewGroup item = ref.get();
            if (item != null) { paint(item, night); paintBar(item, night); }
        }
        return true;
    }

    private void collect(View v) {
        if (ITEM.equals(v.getClass().getName()) && v instanceof ViewGroup) { items.add(new WeakReference<>((ViewGroup) v)); return; }
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) collect(g.getChildAt(i));
        }
    }

    /** The bar the item sits in: NSH sets it to the system's neutral surface (lavender on a stock Android 15). */
    static void paintBar(View item, boolean night) {
        for (android.view.ViewParent p = item.getParent(); p instanceof View; p = p.getParent()) {
            if (!BAR.equals(p.getClass().getName())) continue;
            View bar = (View) p;
            int c = TabColors.bar(night);
            Drawable bg = bar.getBackground();
            if (!(bg instanceof android.graphics.drawable.ColorDrawable) || ((android.graphics.drawable.ColorDrawable) bg).getColor() != c) bar.setBackgroundColor(c);
            return;
        }
    }

    /** Sets only what differs, so a frame that changes nothing does not invalidate. */
    static void paint(ViewGroup item, boolean night) {
        if (item.getChildCount() < 2 || !(item.getChildAt(0) instanceof ViewGroup) || !(item.getChildAt(1) instanceof TextView)) return;
        ViewGroup indicator = (ViewGroup) item.getChildAt(0);
        TextView label = (TextView) item.getChildAt(1);
        TabColors c = TabColors.of(item.isSelected(), night);
        Drawable bg = indicator.getBackground();
        if (item.isSelected() && bg instanceof GradientDrawable) {
            GradientDrawable pill = (GradientDrawable) bg;
            ColorStateList now = pill.getColor();
            if (now == null || now.getDefaultColor() != c.pill) pill.setColor(c.pill);
        }
        if (indicator.getChildCount() > 0 && indicator.getChildAt(0) instanceof ImageView) {
            ImageView icon = (ImageView) indicator.getChildAt(0);
            ColorStateList tint = icon.getImageTintList();
            if (tint == null || tint.getDefaultColor() != c.icon) icon.setImageTintList(ColorStateList.valueOf(c.icon));
        }
        if (label.getCurrentTextColor() != c.label) label.setTextColor(c.label);
    }
}
