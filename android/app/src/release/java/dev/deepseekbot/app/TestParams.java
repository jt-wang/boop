package dev.deepseekbot.app;

import android.content.Intent;
import java.util.Map;

/** The release build takes nothing from a test (the debug source set's TestParams does). */
final class TestParams {
    static void add(Intent intent, Map<String, Object> params) {}

    private TestParams() {}
}
