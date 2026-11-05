package dev.deepseekbot.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The same links as the iOS shell's PairLink.swift. */
public class PairLinkTest {
    @Test
    public void fullPairingUrl() {
        assertEquals("https://bot.example.com/pair?code=123456",
                PairLink.pairUrl("deepseekbot://pair?url=https%3A%2F%2Fbot.example.com%2Fpair%3Fcode%3D123456"));
    }

    @Test
    public void originAndCode() {
        assertEquals("http://192.168.1.5:3850/pair?code=654321",
                PairLink.pairUrl("deepseekbot://pair?origin=http%3A%2F%2F192.168.1.5%3A3850%2F&code=654321"));
        assertEquals("http://192.168.1.5:3850/pair", PairLink.pairUrl("deepseekbot://pair?origin=http://192.168.1.5:3850"));
    }

    @Test
    public void notAPairingLink() {
        assertNull(PairLink.pairUrl("deepseekbot://other?url=https://x"));
        assertNull(PairLink.pairUrl("https://pair?url=https://x"));
        assertNull(PairLink.pairUrl("deepseekbot://pair?url=javascript:alert(1)"));
        assertNull(PairLink.pairUrl("deepseekbot://pair"));
        assertNull(PairLink.pairUrl(null));
    }

    // [compliance] links to an interface (App Review 4.7.4): the host's /open/… App Link and the app's own scheme
    @Test
    public void interfaceLinks() {
        assertTrue(PairLink.isInterfaceLink("https://host.example/open/sb-abc123/ui/m0000000002"));
        assertTrue(PairLink.isInterfaceLink("deepseekbot://ui/m1?origin=http%3A%2F%2F192.168.1.5%3A3850"));
        assertFalse(PairLink.isInterfaceLink("https://host.example/privacy"));
        assertFalse(PairLink.isInterfaceLink("deepseekbot://pair?url=https://x"));
        assertFalse(PairLink.isInterfaceLink(null));
    }

    // [compliance] what a module's view is granted: its bot, two host functions, and only what the person allowed
    @Test
    public void grantIsTheSandboxPlusWhatWasAllowed() {
        assertEquals("{\"host\":[\"launch.params\",\"ui.close\"],\"network\":{\"hosts\":[\"10.0.2.2\"]}}",
                UiBridge.grant("http://10.0.2.2:3895", java.util.List.of()));
        assertEquals("{\"clipboard\":true,\"host\":[\"launch.params\",\"ui.close\"],\"network\":{\"hosts\":[\"host.example\"]},\"openUrl\":{\"schemes\":[\"https\"]}}",
                UiBridge.grant("https://host.example/s/sb-1", java.util.List.of("openUrl", "clipboard")));
    }

    @org.junit.Test public void aTailPocketCodeComesThroughAsItIs() {
        org.junit.Assert.assertEquals("tailpocket1:abc_-1", PairLink.pairUrl("deepseekbot://pair?invite=tailpocket1%3Aabc_-1"));
        org.junit.Assert.assertNull(PairLink.pairUrl("deepseekbot://pair?invite=http://evil.example"));
    }
}
