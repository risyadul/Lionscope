package io.github.risyadul.lionscope

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.util.Log
import java.lang.reflect.Field
import java.lang.reflect.Method

/**
 * Current state of Compose recomposition tracking reported in v15 `inspectBegin.recompositionTracking`:
 * [OFF] supported but disabled, [ACTIVE] observing compositions, [UNSUPPORTED] app has no Compose or Compose < 1.9
 * or required observer/scope symbols failed verification or runtime linkage, [CONFLICT] another Compose observer
 * already occupies a composition's observer slot and was left untouched.
 */
internal enum class RecompositionStatus(val wire: String) {
    OFF("off"),
    ACTIVE("active"),
    UNSUPPORTED("unsupported"),
    CONFLICT("conflict"),
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

    /** True when tracked scopes hit the bounded capacity and newly seen scopes have unavailable counts. */
    val truncated: Boolean

    /** Turns observation on or off. Disabling detaches all observers and drops stored counts. */
    fun setEnabled(enabled: Boolean)

    /** Re-scans running Recomposers to attach to newly started windows (e.g. a new Activity or Dialog). */
    fun rescan()

    /** Resets all counts to zero while keeping observers attached. */
    fun reset()

    /**
     * Counts for [scope] (`RecomposeScope`), or null when tracking is not [RecompositionStatus.ACTIVE] or when
     * [truncated] is true and [scope] is not in the tracked map (unavailable rather than falsely reporting 0/0).
     * When active, not truncated, and [scope] has not recomposed or skipped since attach/reset, returns
     * [RecompositionCounts.ZERO].
     */
    fun countsFor(scope: Any): RecompositionCounts?
}

/**
 * 1.6-safe probe and factory for Compose 1.9+ recomposition tracking. Never references 1.9-only types directly, so it
 * loads cleanly on apps without Compose or with Compose 1.6–1.8. Fails closed to [RecompositionStatus.UNSUPPORTED] if
 * any required public observer symbol, `RecomposeScopeImpl` getter, or `CompositionImpl` observer-holder symbol is
 * missing or incompatible.
 */
internal object ComposeRecompositionSupport {
    private const val RECOMPOSE_SCOPE = "androidx.compose.runtime.RecomposeScope"
    private const val RECOMPOSE_SCOPE_IMPL = "androidx.compose.runtime.RecomposeScopeImpl"
    private const val RECOMPOSER = "androidx.compose.runtime.Recomposer"
    private const val RECOMPOSER_COMPANION = "androidx.compose.runtime.Recomposer\$Companion"
    private const val RECOMPOSER_INFO = "androidx.compose.runtime.RecomposerInfo"
    private const val COMPOSITION_IMPL = "androidx.compose.runtime.CompositionImpl"
    private const val COMPOSITION_OBSERVER_HOLDER = "androidx.compose.runtime.CompositionObserverHolder"
    private const val COMPOSITION_OBSERVER = "androidx.compose.runtime.tooling.CompositionObserver"
    private const val COMPOSITION_OBSERVER_HANDLE = "androidx.compose.runtime.tooling.CompositionObserverHandle"
    private const val REGISTRATION_OBSERVER = "androidx.compose.runtime.tooling.CompositionRegistrationObserver"
    private const val OBSERVABLE_COMPOSITION = "androidx.compose.runtime.tooling.ObservableComposition"
    private const val STATE_FLOW = "kotlinx.coroutines.flow.StateFlow"

    internal class ProbeSuccess(
        val scopeImplClass: Class<*>,
        val skippedGetter: Method,
        val rereadingGetter: Method,
        val compositionImplClass: Class<*>,
        val observerHolderField: Field,
        val holderGetObserver: Method,
        val holderCurrent: Method,
    )

    internal sealed class ProbeResult {
        class Supported(val access: ProbeSuccess) : ProbeResult()
        class Unsupported(val reason: String) : ProbeResult()
    }

    /**
     * Verifies all Compose 1.9+ observer APIs, `RecomposeScopeImpl` skip/rereading getters, and `CompositionImpl`
     * observer-slot inspection symbols via reflection. Safe on apps without Compose or with older Compose runtimes.
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
        val compositionImpl = findClass(COMPOSITION_IMPL)
            ?: return ProbeResult.Unsupported("missing_composition_impl")
        val observerHolderClass = findClass(COMPOSITION_OBSERVER_HOLDER)
            ?: return ProbeResult.Unsupported("missing_observer_holder")
        val compositionObserver = findClass(COMPOSITION_OBSERVER)
            ?: return ProbeResult.Unsupported("missing_composition_observer")
        val observerHandle = findClass(COMPOSITION_OBSERVER_HANDLE)
            ?: return ProbeResult.Unsupported("missing_observer_handle")
        val registrationObserver = findClass(REGISTRATION_OBSERVER)
            ?: return ProbeResult.Unsupported("missing_registration_observer")
        val observableComposition = findClass(OBSERVABLE_COMPOSITION)
            ?: return ProbeResult.Unsupported("missing_observable_composition")
        val scopeImpl = findClass(RECOMPOSE_SCOPE_IMPL)
            ?: return ProbeResult.Unsupported("missing_recompose_scope_impl")
        val stateFlowClass = findClass(STATE_FLOW)
            ?: return ProbeResult.Unsupported("missing_state_flow")

        return try {
            // Public 1.9 observer contract (validate parameter and return types).
            recomposer.getDeclaredField("Companion")
            val runningRecomposersMethod = recomposerCompanion.getMethod("getRunningRecomposers")
            if (!stateFlowClass.isAssignableFrom(runningRecomposersMethod.returnType)) {
                return ProbeResult.Unsupported("unexpected_running_recomposers_type")
            }
            val observeMethod = recomposerInfo.getMethod("observe", registrationObserver)
            if (!observerHandle.isAssignableFrom(observeMethod.returnType)) {
                return ProbeResult.Unsupported("unexpected_observe_return_type")
            }
            registrationObserver.getMethod("onCompositionRegistered", observableComposition)
            registrationObserver.getMethod("onCompositionUnregistered", observableComposition)
            val setObserverMethod = observableComposition.getMethod("setObserver", compositionObserver)
            if (!observerHandle.isAssignableFrom(setObserverMethod.returnType)) {
                return ProbeResult.Unsupported("unexpected_set_observer_return_type")
            }
            observerHandle.getMethod("dispose")
            compositionObserver.getMethod("onBeginComposition", observableComposition)
            compositionObserver.getMethod("onEndComposition", observableComposition)
            compositionObserver.getMethod("onScopeEnter", recomposeScope)
            compositionObserver.getMethod("onScopeExit", recomposeScope)
            compositionObserver.getMethod("onReadInScope", recomposeScope, Any::class.java)
            compositionObserver.getMethod("onScopeInvalidated", recomposeScope, Any::class.java)
            compositionObserver.getMethod("onScopeDisposed", recomposeScope)

            // CompositionImpl observer slot inspection (prevents silently displacing an existing observer).
            val observerHolderField = compositionImpl.getDeclaredField("observerHolder")
            if (observerHolderField.type != observerHolderClass) {
                return ProbeResult.Unsupported("unexpected_observer_holder_type")
            }
            val holderGetObserver = observerHolderClass.getMethod("getObserver")
            if (!compositionObserver.isAssignableFrom(holderGetObserver.returnType)) {
                return ProbeResult.Unsupported("unexpected_holder_get_observer_type")
            }
            val holderCurrent = observerHolderClass.getMethod("current")
            if (!compositionObserver.isAssignableFrom(holderCurrent.returnType)) {
                return ProbeResult.Unsupported("unexpected_holder_current_type")
            }

            // Internal RecomposeScopeImpl skip and rereading getters: use the runtime's own getters rather than
            // hardcoded bitmasks so moved flag bits never silently misclassify skips as recompositions.
            val skippedGetter = scopeImpl.declaredMethods.firstOrNull {
                (it.name == "getSkipped" || it.name.startsWith("getSkipped\$")) &&
                    it.parameterTypes.isEmpty() &&
                    it.returnType == Boolean::class.javaPrimitiveType
            } ?: return ProbeResult.Unsupported("missing_skipped_getter")
            val rereadingGetter = scopeImpl.declaredMethods.firstOrNull {
                it.name == "getRereading" &&
                    it.parameterTypes.isEmpty() &&
                    it.returnType == Boolean::class.javaPrimitiveType
            } ?: return ProbeResult.Unsupported("missing_rereading_getter")

            skippedGetter.isAccessible = true
            rereadingGetter.isAccessible = true
            observerHolderField.isAccessible = true
            holderGetObserver.isAccessible = true
            holderCurrent.isAccessible = true
            ProbeResult.Supported(
                ProbeSuccess(
                    scopeImplClass = scopeImpl,
                    skippedGetter = skippedGetter,
                    rereadingGetter = rereadingGetter,
                    compositionImplClass = compositionImpl,
                    observerHolderField = observerHolderField,
                    holderGetObserver = holderGetObserver,
                    holderCurrent = holderCurrent,
                ),
            )
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
                skippedGetter = probeResult.access.skippedGetter,
                rereadingGetter = probeResult.access.rereadingGetter,
                compositionImplClass = probeResult.access.compositionImplClass,
                observerHolderField = probeResult.access.observerHolderField,
                holderGetObserver = probeResult.access.holderGetObserver,
                holderCurrent = probeResult.access.holderCurrent,
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

/** Re-scans running Recomposers when an Activity starts or resumes as a belt-and-suspenders supplement. */
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

/**
 * Connects [ComposeRecompositionTracker] to [LinkPort]: enables/disables on v15 `config` (on both session and
 * inspect-only links), clears counts on v15 `resetComposeRecompositions`, and auto-detaches observers on disconnect.
 */
internal class ComposeRecompositionController(
    private val link: LinkPort,
    private val main: MainScheduler,
    private val tracker: ComposeRecompositionTracker,
) {
    init {
        link.addWelcomeListener { welcomed ->
            if (!welcomed) main.post(Runnable { guarded { tracker.setEnabled(false) } })
        }
        link.addComposeRecompositionListener { message ->
            main.post(Runnable { guarded { onMessage(message) } })
        }
    }

    private fun onMessage(message: GatewayMessage) {
        if (!link.isWelcomed || !DeviceLink.speaks(link.negotiatedVersion, DEVICE_PROTOCOL_V15)) return
        when (message) {
            is GatewayMessage.Config -> tracker.setEnabled(message.options.composeRecompositionTracking)
            is GatewayMessage.ResetComposeRecompositions -> tracker.reset()
            else -> Unit
        }
    }
}
