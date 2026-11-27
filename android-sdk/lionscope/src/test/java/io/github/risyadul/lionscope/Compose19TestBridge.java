package io.github.risyadul.lionscope;

import androidx.compose.runtime.Composer;
import androidx.compose.runtime.Composition;
import kotlin.Unit;
import kotlin.jvm.functions.Function2;

/**
 * Tiny Java bridge so JVM unit tests in `:lionscope` (which intentionally does not apply the Compose compiler plugin
 * to keep `main` free of Compose runtime dependencies) can pass `Function2<Composer, Integer, Unit>` directly to
 * `Composition.setContent` and `ScopeUpdateScope.updateScope`.
 */
final class Compose19TestBridge {
    private Compose19TestBridge() {}

    @SuppressWarnings({"unchecked", "rawtypes"})
    static void setContent(Composition composition, Function2<Composer, Integer, Unit> content) {
        composition.setContent((Function2) content);
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    static void updateScope(
        androidx.compose.runtime.ScopeUpdateScope scope,
        Function2<Composer, Integer, Unit> block
    ) {
        scope.updateScope((Function2) block);
    }
}
