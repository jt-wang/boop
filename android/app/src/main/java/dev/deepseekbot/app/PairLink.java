package dev.deepseekbot.app;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * {@code deepseekbot://pair?invite=<TailPocket code>}, {@code deepseekbot://pair?url=<http pairing link>} or {@code deepseekbot://pair?origin=http://host:3850&code=123456}
 * → the http pairing link the app's connect screen understands ({@code host.params.pairUrl}). The iOS shell's
 * PairLink.swift, line for line.
 */
final class PairLink {
    private PairLink() {}

    static String pairUrl(String link) {
        if (link == null) return null;
        URI uri;
        try { uri = new URI(link); } catch (Exception e) { return null; }
        if (!"deepseekbot".equalsIgnoreCase(uri.getScheme()) || !"pair".equalsIgnoreCase(uri.getHost())) return null;
        Map<String, String> items = query(uri.getRawQuery());
        String invite = items.get("invite");
        if (invite != null && invite.startsWith("tailpocket1:")) return invite;
        String full = items.get("url");
        if (full != null && full.toLowerCase().startsWith("http")) return full;
        String origin = items.get("origin");
        if (origin != null && origin.toLowerCase().startsWith("http")) {
            String s = origin.endsWith("/") ? origin.substring(0, origin.length() - 1) : origin;
            s += "/pair";
            String code = items.get("code");
            if (code != null && !code.isEmpty()) s += "?code=" + code;
            return s;
        }
        return null;
    }

    /** [compliance] A link to an interface: {@code https://<host>/open/<sandbox>/ui/<id>} (an App Link) or {@code deepseekbot://ui/<id>?origin=…}. */
    static boolean isInterfaceLink(String link) {
        if (link == null) return false;
        URI uri;
        try { uri = new URI(link); } catch (Exception e) { return false; }
        if ("deepseekbot".equalsIgnoreCase(uri.getScheme())) return "ui".equalsIgnoreCase(uri.getHost());
        if (!"https".equalsIgnoreCase(uri.getScheme()) && !"http".equalsIgnoreCase(uri.getScheme())) return false;
        String path = uri.getPath() == null ? "" : uri.getPath();
        return path.matches("/open/[a-z0-9][a-z0-9-]{2,40}/ui/[A-Za-z0-9_-]{1,40}");
    }

    private static Map<String, String> query(String raw) {
        Map<String, String> out = new HashMap<>();
        if (raw == null) return out;
        for (String pair : raw.split("&")) {
            int eq = pair.indexOf('=');
            String name = decode(eq < 0 ? pair : pair.substring(0, eq));
            if (!out.containsKey(name)) out.put(name, eq < 0 ? "" : decode(pair.substring(eq + 1)));
        }
        return out;
    }

    private static String decode(String s) {
        // Percent-decoding only, as URLComponents.queryItems does: a '+' stays a '+'.
        return URLDecoder.decode(s.replace("+", "%2B"), StandardCharsets.UTF_8);
    }
}
