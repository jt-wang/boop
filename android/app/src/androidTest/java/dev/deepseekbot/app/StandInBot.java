package dev.deepseekbot.app;

import android.util.Base64;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import org.json.JSONObject;

/**
 * The computer, as far as the device tests need one, run by the test on the device itself: pairing by code, /me, lists,
 * what the app sends on connecting, and the /events socket (hello, a snapshot of the main thread on follow, rows as they
 * come, pong). A list's mode: absent (at once), "slow" (after 1.5 s), "502", or "none" (closed without an answer).
 * {@link #stopListening()} and {@link #startListening()} take it away and bring it back on the same port, as a computer
 * whose bot restarts.
 */
final class StandInBot implements Runnable {
    /**
     * After the connect tap: the chat, with Android's notification question declined whenever it comes (it can come after
     * the chat has shown, and cover it), so nothing is granted that PushNotificationTest would have to revoke. True once
     * the composer has shown for 3 s with no question over it; false after `ms`, the screen's words logged under `tag`.
     */
    static boolean awaitChat(androidx.test.uiautomator.UiDevice device, long ms, String tag) throws Exception {
        java.util.regex.Pattern deny = java.util.regex.Pattern.compile(".*:id/permission_deny(_and_dont_ask_again)?_button");
        long clearSince = 0;
        for (long end = System.currentTimeMillis() + ms; System.currentTimeMillis() < end; Thread.sleep(250)) {
            androidx.test.uiautomator.UiObject2 no = device.findObject(androidx.test.uiautomator.By.res(deny));
            if (no != null) { no.click(); clearSince = 0; continue; }
            if (device.findObject(androidx.test.uiautomator.By.res("composer")) == null) { clearSince = 0; continue; }
            if (clearSince == 0) clearSince = System.currentTimeMillis();
            else if (System.currentTimeMillis() - clearSince >= 3_000) return true;
        }
        ByteArrayOutputStream dump = new ByteArrayOutputStream();
        device.dumpWindowHierarchy(dump);
        for (String l : dump.toString().split("text=\"")) if (l.length() > 1 && !l.startsWith("\"")) Log.i(tag, "on screen: " + l.substring(0, Math.min(80, l.indexOf('"'))));
        return false;
    }

    private static final String TAG = "StandInBot";
    static final String MAIN = "main";
    final Map<String, String> lists = new ConcurrentHashMap<>(), mode = new ConcurrentHashMap<>();
    /** How each list GET was answered since the last clear, as actually done: "200", "slow 200", "502" or "closed". */
    final Map<String, List<String>> served = new ConcurrentHashMap<>();
    /** The main thread's rows, as JSON objects, in order. */
    final List<String> rows = new CopyOnWriteArrayList<>();
    /** How many /events sockets were opened, all told. */
    volatile int eventsOpened;
    volatile boolean unauthorized;
    private final InetAddress bind;
    private final int port;
    private final Set<Socket> open = ConcurrentHashMap.newKeySet();
    private final Set<Events> events = ConcurrentHashMap.newKeySet();
    private volatile ServerSocket server;
    private Thread thread;

    StandInBot(InetAddress bind, int port) throws IOException {
        this.bind = bind;
        this.port = port;
        startListening();
    }

    synchronized void startListening() throws IOException {
        ServerSocket s = new ServerSocket();
        s.setReuseAddress(true);
        s.bind(new InetSocketAddress(bind, port), 50);
        server = s;
        thread = new Thread(this, "stand-in bot");
        thread.start();
    }

    /** Gone: no new connection is accepted, and every open one (the /events socket among them) is cut. */
    synchronized void stopListening() throws Exception {
        server.close();
        for (Socket s : open) try { s.close(); } catch (IOException ignored) {}
        events.clear();
        thread.join(2_000);
    }

    void stop() throws Exception { stopListening(); }

    /** A row from the assistant in the main thread: kept for the next snapshot, and sent to every phone following now. */
    void addRow(String id, String text) {
        String row = "{\"kind\":\"them\",\"id\":\"" + id + "\",\"text\":" + JSONObject.quote(text) + ",\"at\":" + System.currentTimeMillis() + "}";
        rows.add(row);
        for (Events e : events) e.send("{\"type\":\"rows\",\"sessionId\":\"" + MAIN + "\",\"rows\":[" + row + "]}");
    }

    @Override public void run() {
        ServerSocket s = server;
        while (!s.isClosed()) {
            try { Socket c = s.accept(); open.add(c); new Thread(() -> serve(c)).start(); } catch (Exception e) { return; }
        }
    }

    private void record(String path, String answer) { served.computeIfAbsent(path, k -> Collections.synchronizedList(new ArrayList<>())).add(answer); }

    private void serve(Socket s) {
        try (Socket socket = s) {
            InputStream in = socket.getInputStream();
            String line = line(in);
            if (line == null || line.isEmpty()) return;
            String[] req = line.split(" ");
            Map<String, String> headers = new HashMap<>();
            for (String h; (h = line(in)) != null && !h.isEmpty(); ) {
                int c = h.indexOf(':');
                if (c > 0) headers.put(h.substring(0, c).trim().toLowerCase(), h.substring(c + 1).trim());
            }
            int length = headers.containsKey("content-length") ? Integer.parseInt(headers.get("content-length")) : 0;
            for (int i = 0; i < length; i++) in.read();
            String method = req[0], path = req[1].split("\\?")[0];
            Log.i(TAG, method + " " + path);
            if (path.equals("/events") && "websocket".equalsIgnoreCase(headers.get("upgrade")) && !unauthorized) { events(socket, in, headers.get("sec-websocket-key")); return; }
            String list = method.equals("GET") ? lists.get(path) : null;
            String m = list == null ? null : mode.get(path);
            // recorded from what is actually done below, not from the mode: a closed socket, or the status written and
            // whether this answer waited first
            if ("none".equals(m)) { record(path, "closed"); return; }
            boolean waited = false;
            if ("slow".equals(m)) { Thread.sleep(1_500); waited = true; }
            int status = 200;
            String body;
            if (unauthorized && !path.equals("/pair")) { status = 401; body = "{\"error\":\"unpaired\"}"; }
            else if ("502".equals(m)) { status = 502; body = "{\"error\":\"the assistant did not answer\"}"; }
            else if (list != null) body = list;
            else if (path.equals("/pair")) body = "{\"token\":\"tok_standin\"}";
            else if (path.equals("/me")) body = "{\"device\":{\"id\":\"d1\",\"name\":\"Android\"},\"assistant\":{\"name\":\"Nori\"},\"mainSessionId\":\"" + MAIN + "\",\"connected\":true,\"pushPublicKey\":null}";
            else if (path.equals("/ws-ticket")) body = "{\"ticket\":\"standin\"}";
            else if (path.equals("/api/session/list")) body = "{\"result\":{\"ok\":true,\"value\":{\"items\":[]}}}";
            else if (path.startsWith("/api/")) { status = 404; body = "{\"error\":\"not here\"}"; }
            // any other list the app reads (memory, ideas, …) is empty, as the demo's SampleBot answers (mobile/src/try.ts)
            else if (method.equals("GET")) body = "[]";
            else body = "{\"ok\":true}";
            byte[] b = body.getBytes(StandardCharsets.UTF_8);
            OutputStream out = socket.getOutputStream();
            out.write(("HTTP/1.1 " + status + " X\r\ncontent-type: application/json\r\ncontent-length: " + b.length + "\r\nconnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            out.write(b);
            out.flush();
            if (list != null) record(path, (waited ? "slow " : "") + status);
        } catch (Exception e) {
            Log.w(TAG, String.valueOf(e));
        } finally {
            open.remove(s);
        }
    }

    /** One phone's /events socket (RFC 6455, text frames only), until it closes or the bot stops listening. */
    private void events(Socket socket, InputStream in, String key) throws Exception {
        String accept = Base64.encodeToString(MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.US_ASCII)), Base64.NO_WRAP);
        OutputStream out = socket.getOutputStream();
        // counted before the 101 goes out: the app may say Online the moment it reads it, and a test then reads this
        eventsOpened++;
        out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        out.flush();
        Events e = new Events(out);
        events.add(e);
        try {
            e.send("{\"type\":\"hello\",\"asks\":[],\"connected\":true}");
            while (true) {
                int b0 = in.read(), b1 = in.read();
                if (b0 < 0 || b1 < 0) return;
                long n = b1 & 0x7f;
                if (n == 126) n = (in.read() << 8) | in.read();
                else if (n == 127) { n = 0; for (int i = 0; i < 8; i++) n = (n << 8) | in.read(); }
                // the app sends follow and ping, a few hundred bytes: anything far bigger closes the socket
                if (n < 0 || n > 64 * 1024) return;
                byte[] mask = new byte[4];
                if ((b1 & 0x80) != 0) for (int i = 0; i < 4; i++) mask[i] = (byte) in.read();
                byte[] payload = new byte[(int) n];
                for (int i = 0; i < n; i++) { int c = in.read(); if (c < 0) return; payload[i] = (byte) (c ^ mask[i % 4]); }
                int op = b0 & 0x0f;
                Log.i(TAG, "events <- op " + op + (op == 1 ? " " + new String(payload, StandardCharsets.UTF_8) : ""));
                if (op == 8) return;
                if (op != 1) continue;
                JSONObject m = new JSONObject(new String(payload, StandardCharsets.UTF_8));
                String type = m.optString("type");
                if (type.equals("ping")) e.send("{\"type\":\"pong\"}");
                else if (type.equals("follow") && MAIN.equals(m.optString("sessionId"))) {
                    e.send("{\"type\":\"snapshot\",\"sessionId\":\"" + MAIN + "\",\"rows\":[" + String.join(",", rows) + "],\"running\":false,\"statusText\":\"\",\"title\":\"\"}");
                    // the newest row once more, as a frame that may cross the snapshot: the app keeps one of each row
                    if (!rows.isEmpty()) e.send("{\"type\":\"rows\",\"sessionId\":\"" + MAIN + "\",\"rows\":[" + rows.get(rows.size() - 1) + "]}");
                }
            }
        } finally {
            events.remove(e);
        }
    }

    private static final class Events {
        private final OutputStream out;
        Events(OutputStream out) { this.out = out; }

        synchronized void send(String text) {
            byte[] p = text.getBytes(StandardCharsets.UTF_8);
            try {
                out.write(0x81);
                if (p.length < 126) out.write(p.length);
                else if (p.length < 65536) { out.write(126); out.write(p.length >> 8); out.write(p.length & 0xff); }
                else { out.write(127); for (int i = 7; i >= 0; i--) out.write((int) ((long) p.length >> (8 * i)) & 0xff); }
                out.write(p);
                out.flush();
            } catch (IOException ignored) {}
        }
    }

    private static String line(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        for (int c; (c = in.read()) >= 0; ) {
            if (c == '\n') return b.toString("UTF-8").replaceAll("\r$", "");
            b.write(c);
        }
        return b.size() == 0 ? null : b.toString("UTF-8");
    }
}
