package dev.deepseekbot.app;

/**
 * The tab bar's colors: the app's own. The selected
 * pill is the primary color, its glyph the primary's foreground; an unselected tab is the muted foreground; the bar
 * is the card color, the grouped pages' background.
 */
final class TabColors {
    final int pill;
    final int icon;
    final int label;

    private TabColors(int pill, int icon, int label) {
        this.pill = pill;
        this.icon = icon;
        this.label = label;
    }

    private static final int FOREGROUND = 0xFF26251E, FOREGROUND_DARK = 0xFFEDECEC;
    private static final int BACKGROUND = 0xFFF7F7F4, BACKGROUND_DARK = 0xFF14120B; // primary-foreground
    private static final int MUTED = 0xFF85847E, MUTED_DARK = 0xFF8E8D88;
    private static final int CARD = 0xFFF7F7F4, CARD_DARK = 0xFF1C1A14;

    static int bar(boolean night) { return night ? CARD_DARK : CARD; }

    static TabColors of(boolean selected, boolean night) {
        int primary = night ? FOREGROUND_DARK : FOREGROUND;
        if (selected) return new TabColors(primary, night ? BACKGROUND_DARK : BACKGROUND, primary);
        int muted = night ? MUTED_DARK : MUTED;
        return new TabColors(0, muted, muted);
    }
}
