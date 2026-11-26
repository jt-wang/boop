package dev.deepseekbot.app;

import android.content.Intent;
import java.util.Map;

/** UI tests only, in the debug build: more approval cards on the demo (ScreenshotsTest), from the launch intent. */
final class TestParams {
    static final String ASKS = "dev.deepseekbot.testAsks";

    static void add(Intent intent, Map<String, Object> params) {
        String asks = intent == null ? null : intent.getStringExtra(ASKS);
        if (asks != null) params.put("testAsks", asks);
    }

    private TestParams() {}
}
