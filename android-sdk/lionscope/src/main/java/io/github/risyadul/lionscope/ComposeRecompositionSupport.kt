package io.github.risyadul.lionscope

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.util.Log
import java.lang.reflect.Field

/**
 * Current state of Compose recomposition tracking reported in v15 `inspectBegin.recompositionTracking`:
 * [OFF] supported but disabled, [ACTIVE] observing compositions, [UNSUPPORTED] app has no Compose or Compose < 1.9
 * or required internal skip-flag symbols are missing.
 */
internal enum class RecompositionStatus(val wire: String) {
    OFF("off"),
    ACTIVE("active"),
    UNSUPPORTED("unsupported"),
}

/** Observed recomposition and skip counts for one restartable composable scope since tracking started or last reset. */
internal data class RecompositionCounts(val recompositions: Int, val skips: Int) {
    companion object {
        val ZERO = RecompositionCounts(0, 0)
    }
}

/**
 * Tracks per-scope recomposition and skip counts while enabled. Implementations using Compose 1.9+ APIs live in
 * [ComposeRecomposition19] and are only instantiated after [ComposeRecompositionSupport.probe] succeeds.
 */
internal interface ComposeRecompositionTracker {
    val status: RecompositionStatus

    /** True when tracked scopes hit the bounded capacity and new scopes could not be inserted. */
    val truncated: Boolean

    /** Turns observation on or off. Disabling detaches all observers and drops stored counts. */
    fun setEnabled(enabled: Boolean)

    /** Re-scans running Recomposers to attach to newly started windows (e.g. a new Activity or Dialog). */
    fun rescan()

    /** Resets all counts to zero while keeping observers attached. */
    fun reset()

    /**
     * Counts for [scope] (`RecomposeScope`), or null when tracking is not [RecompositionStatus.ACTIVE].
     * When active and [scope] has not recomposed or skipped since attach/reset, returns [RecompositionCounts.ZERO].
     */
    fun countsFor(scope: Any): RecompositionCounts?
}

/**
 * 1.6-safe probe and factory for Compose 1.9+ recomposition tracking. Never references 1.9-only types directly, so it
 * loads cleanly on apps without Compose or with Compose 1.6–1.8. Fails closed to [RecompositionStatus.UNSUPPORTED] if
 * any required public observer symbol or internal `RecomposeScopeImpl` skip/rereading flag symbol is missing.
 */
internal object ComposeRecompositionSupport {
    private const val RECOMPOSE_SCOPE = "androidx.compose.runtime.RecomposeScope"
    private const val RECOMPOSE_SCOPE_IMPL = "androidx.compose.runtime.RecomposeScopeImpl"
    private const val RECOMPOSER = "androidx.compose.runtime.Recomposer"
    private const val RECOMPOSER_COMPANION = "androidx.compose.runtime.Recomposer\$Companion"
    private const val RECOMPOSER_INFO = "androidx.compose.runtime.RecomposerInfo"
    private const val COMPOSITION_OBSERVER = "androidx.compose.runtime.tooling.CompositionObserver"
    private const val REGISTRATION_OBSERVER = "androidx.compose.runtime.tooling.CompositionRegistrationObserver"
    private const val OBSERVABLE_COMPOSITION = "androidx.compose.runtime.tooling.ObservableComposition"

    internal class ProbeSuccess(
        val scopeImplClass: Class<*>,
        val flagsField: Field,
    )

    internal sealed class ProbeResult {
        class Supported(val access: ProbeSuccess) : ProbeResult()
        class Unsupported(val reason: String) : ProbeResult()
    }

    /**
     * Verifies all Compose 1.9+ observer APIs and internal `RecomposeScopeImpl` flag symbols via reflection.
     * Safe to call on apps without Compose or with older Compose runtimes.
     */
    fun probe(
        findClass: (String) -> Class<*>? = ::loadClassOrNull,
    ): ProbeResult {
        val recomposeScope = findClass(RECOMPOSE_SCOPE)
            ?: return ProbeResult.Unsupported("no_compose_runtime")
        val recomposer = findClass(RECOMPOSER)
            ?: return ProbeResult.Unsupported("missing_recomposer")
        val recomposerCompanion = findClass(RECOMPOSER_COMPANION)
            ?: return ProbeResult.Unsupported("missing_recomposer_companion")
        val recomposerInfo = findClass(RECOMPOSER_INFO)
            ?: return ProbeResult.Unsupported("missing_recomposer_info")
        val compositionObserver = findClass(COMPOSITION_OBSERVER)
            ?: return ProbeResult.Unsupported("missing_composition_observer")
        val registrationObserver = findClass(REGISTRATION_OBSERVER)
            ?: return ProbeResult.Unsupported("missing_registration_observer")
        val observableComposition = findClass(OBSERVABLE_COMPOSITION)
            ?: return ProbeResult.Unsupported("missing_observable_composition")
        val scopeImpl = findClass(RECOMPOSE_SCOPE_IMPL)
            ?: return ProbeResult.Unsupported("missing_recompose_scope_impl")

        return try {
            // Public 1.9 observer contract.
            recomposer.getDeclaredField("Companion")
            recomposerCompanion.getMethod("getRunningRecomposers")
            recomposerInfo.getMethod("observe", registrationObserver)
            observableComposition.getMethod("setObserver", compositionObserver)
            compositionObserver.getMethod("onScopeEnter", recomposeScope)
            compositionObserver.getMethod("onScopeExit", recomposeScope)
            compositionObserver.getMethod("onReadInScope", recomposeScope, Any::class.java)
            compositionObserver.getMethod("onScopeDisposed", recomposeScope)

            // Internal RecomposeScopeImpl skip (0x10) and rereading (0x20) flags: fail closed if missing.
            val flagsField = scopeImpl.getDeclaredField("flags")
            if (flagsField.type != Int::class.javaPrimitiveType) {
                return ProbeResult.Unsupported("unexpected_flags_field_type")
            }
            val hasSkippedGetter = scopeImpl.declaredMethods.any {
                it.name.startsWith("getSkipped") &&
                    it.parameterTypes.isEmpty() &&
                    it.returnType == Boolean::class.javaPrimitiveType
            }
            if (!hasSkippedGetter) {
                return ProbeResult.Unsupported("missing_skipped_getter")
            }
            val hasRereadingGetter = scopeImpl.declaredMethods.any {
                it.name == "getRereading" &&
                    it.parameterTypes.isEmpty() &&
                    it.returnType == Boolean::class.javaPrimitiveType
            }
            if (!hasRereadingGetter) {
                return ProbeResult.Unsupported("missing_rereading_getter")
            }
            flagsField.isAccessible = true
            ProbeResult.Supported(ProbeSuccess(scopeImpl, flagsField))
        } catch (e: ReflectiveOperationException) {
            ProbeResult.Unsupported("missing_symbol:${e.javaClass.simpleName}")
        } catch (e: SecurityException) {
            ProbeResult.Unsupported("security_exception")
        } catch (e: LinkageError) {
            ProbeResult.Unsupported("linkage_error:${e.javaClass.simpleName}")
        } catch (e: RuntimeException) {
            ProbeResult.Unsupported("runtime_error:${e.javaClass.simpleName}")
        }
    }

    /** Creates a 1.9+ tracker when [probe] succeeds, or an inert [UnsupportedTracker] otherwise. */
    fun createTracker(
        maxTrackedScopes: Int = ComposeRecomposition19.DEFAULT_MAX_TRACKED_SCOPES,
        probeResult: ProbeResult = probe(),
    ): ComposeRecompositionTracker = when (probeResult) {
        is ProbeResult.Unsupported -> UnsupportedTracker
        is ProbeResult.Supported -> try {
            ComposeRecomposition19(
                scopeImplClass = probeResult.access.scopeImplClass,
                flagsField = probeResult.access.flagsField,
                maxTrackedScopes = maxTrackedScopes,
            )
        } catch (e: LinkageError) {
            Log.w(LOG_TAG, "Lionscope Compose recomposition tracking unavailable: $e")
            UnsupportedTracker
        } catch (e: RuntimeException) {
            Log.w(LOG_TAG, "Lionscope Compose recomposition tracking unavailable: $e")
            UnsupportedTracker
        }
    }

    internal object UnsupportedTracker : ComposeRecompositionTracker {
        override val status: RecompositionStatus = RecompositionStatus.UNSUPPORTED
        override val truncated: Boolean = false
        override fun setEnabled(enabled: Boolean) = Unit
        override fun rescan() = Unit
        override fun reset() = Unit
        override fun countsFor(scope: Any): RecompositionCounts? = null
    }

    private fun loadClassOrNull(name: String): Class<*>? = try {
        Class.forName(name, false, ComposeRecompositionSupport::class.java.classLoader)
    } catch (_: ClassNotFoundException) {
        null
    } catch (_: LinkageError) {
        null
    }
}

/** Re-scans running Recomposers when an Activity starts or resumes, so new window Recomposers get attached. */
internal class ComposeRecompositionLifecycle(
    private val tracker: ComposeRecompositionTracker,
) : Application.ActivityLifecycleCallbacks {
    override fun onActivityStarted(activity: Activity) = guarded { tracker.rescan() }
    override fun onActivityResumed(activity: Activity) = guarded { tracker.rescan() }
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivityStopped(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit
}
