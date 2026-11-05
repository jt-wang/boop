package dev.deepseekbot.app;

import static org.junit.Assert.assertTrue;

import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.junit.Test;

/** [compliance] The links to an interface the manifest must route to MainActivity. */
public class ManifestTest {
    private static List<String> filters() throws Exception {
        // Gradle runs JVM tests in the module directory (android/app)
        String xml = new String(Files.readAllBytes(Paths.get("src/main/AndroidManifest.xml")), StandardCharsets.UTF_8);
        List<String> out = new ArrayList<>();
        Matcher m = Pattern.compile("<intent-filter[^>]*>.*?</intent-filter>", Pattern.DOTALL).matcher(xml);
        while (m.find()) out.add(m.group());
        return out;
    }

    private static boolean browsableView(String f) {
        return f.contains("android.intent.action.VIEW") && f.contains("android.intent.category.BROWSABLE") && f.contains("android.intent.category.DEFAULT");
    }

    @Test
    public void theAppsOwnLinkToAnInterfaceOpensTheApp() throws Exception {
        assertTrue("an intent filter for deepseekbot://ui", filters().stream().anyMatch(f -> browsableView(f)
                && f.contains("android:scheme=\"deepseekbot\"") && f.contains("android:host=\"ui\"")));
    }

    @Test
    public void theHostsHttpsLinkToAnInterfaceIsAVerifiedAppLink() throws Exception {
        assertTrue("an autoVerify filter for https://${linkHost}/open/", filters().stream().anyMatch(f -> browsableView(f)
                && f.contains("android:autoVerify=\"true\"") && f.contains("android:scheme=\"https\"")
                && f.contains("android:host=\"${linkHost}\"") && f.contains("android:pathPrefix=\"/open/\"")));
    }
}
