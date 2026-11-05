package dev.deepseekbot.app;

import static org.junit.Assert.assertEquals;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.junit.Test;

/**
 * The tab bar's colors are the app's own (mobile/nsh.json's theme), never the system's dynamic palette. They were the
 * palette before the theme's warm greys, and the bar itself stayed the system's lavender (QA, Android 15, 2026-10-30).
 */
public class TabColorsTest {
    // Gradle runs JVM tests in the module directory (android/app)
    private static int token(String scheme, String name) throws Exception {
        String json = new String(Files.readAllBytes(Paths.get("../../mobile/nsh.json")), StandardCharsets.UTF_8);
        Matcher block = Pattern.compile("\"" + scheme + "\"\\s*:\\s*\\{([^}]*)\\}").matcher(json);
        if (!block.find()) throw new AssertionError("no " + scheme + " theme in nsh.json");
        Matcher m = Pattern.compile("\"" + name + "\"\\s*:\\s*\"#([0-9A-Fa-f]{6})\"").matcher(block.group(1));
        if (!m.find()) throw new AssertionError("no " + name + " in the " + scheme + " theme");
        return 0xFF000000 | Integer.parseInt(m.group(1), 16);
    }

    @Test
    public void lightTheSelectedPillIsThePrimaryWithItsForeground() throws Exception {
        TabColors c = TabColors.of(true, false);
        assertEquals(token("light", "primary"), c.pill);
        assertEquals(token("light", "primary-foreground"), c.icon);
        assertEquals(token("light", "primary"), c.label);
    }

    @Test
    public void darkTheSelectedPillIsThePrimaryWithItsForeground() throws Exception {
        TabColors c = TabColors.of(true, true);
        assertEquals(token("dark", "primary"), c.pill);
        assertEquals(token("dark", "primary-foreground"), c.icon);
        assertEquals(token("dark", "primary"), c.label);
    }

    @Test
    public void anUnselectedTabIsTheMutedForeground() throws Exception {
        assertEquals(token("light", "muted-foreground"), TabColors.of(false, false).icon);
        assertEquals(token("light", "muted-foreground"), TabColors.of(false, false).label);
        assertEquals(token("dark", "muted-foreground"), TabColors.of(false, true).icon);
        assertEquals(token("dark", "muted-foreground"), TabColors.of(false, true).label);
    }

    @Test
    public void theBarIsTheCardColor() throws Exception {
        assertEquals(token("light", "card"), TabColors.bar(false));
        assertEquals(token("dark", "card"), TabColors.bar(true));
    }

    /** The window before the first frame is the app's background. */
    @Test
    public void theWindowBackgroundIsTheAppsBackground() throws Exception {
        for (String[] f : new String[][] {{"src/main/res/values/themes.xml", "light"}, {"src/main/res/values-night/themes.xml", "dark"}}) {
            String xml = new String(Files.readAllBytes(Paths.get(f[0])), StandardCharsets.UTF_8);
            Matcher m = Pattern.compile("<color name=\"background\">#([0-9A-Fa-f]{6})</color>").matcher(xml);
            if (!m.find()) throw new AssertionError("no background in " + f[0]);
            assertEquals(f[0], token(f[1], "background"), 0xFF000000 | Integer.parseInt(m.group(1), 16));
        }
    }
}
