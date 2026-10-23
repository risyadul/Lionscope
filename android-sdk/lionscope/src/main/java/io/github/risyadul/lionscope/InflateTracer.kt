package io.github.risyadul.lionscope

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Resources
import android.os.Looper
import android.util.AttributeSet
import android.util.Log
import android.view.InflateException
import android.view.LayoutInflater
import android.view.View
import android.view.Window
import androidx.annotation.RequiresApi
import org.xmlpull.v1.XmlPullParser
import org.xmlpull.v1.XmlPullParserException
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Method
import java.util.IdentityHashMap

/** What [LayoutsTracker] forwards to inflation tracking (main thread); only [InflateTracer] implements it. */
internal interface InflateHooks {
    fun onActivityPreCreated(activity: Activity)
    fun onActivityPostCreated(activity: Activity)

    /** The Activity was started or resumed (also when coming back to a stopped one). */
    fun onActivityShown(activity: Activity)
    fun onFragmentViewCreated(fragment: Any, activity: Any?, view: View)
    fun onFragmentViewDestroyed(fragment: Any)
    fun onDialogShown(fragment: Any, activity: Any?, window: Window)
}

/**
 * App-side opt-out that works before any link or config exists, for apps that set their own factory on the
 * Activity's LayoutInflater (that throws "A factory has already been set" once ours is there):
 * `<meta-data android:name="io.github.risyadul.lionscope.inflateTracking" android:value="false" />` in the
 * application element. Then the factory is never installed in that process, whatever the session's options say.
 */
internal object InflateOptOut {
    const val META_DATA = "io.github.risyadul.lionscope.inflateTracking"

    /** Off for a boolean `false` or the string `false` (any case, trimmed); anything else, or nothing, allows it. */
    fun allowsValue(value: Any?): Boolean = when (value) {
        is Boolean -> value
        is String -> !value.trim().equals("false", ignoreCase = true)
        else -> true
    }

    /** Reads the application's meta-data; an unreadable manifest allows tracking (the default). */
    @Suppress("DEPRECATION") // getApplicationInfo(String, int) and Bundle.get: the typed variants need API 33.
    fun allows(context: Context): Boolean {
        val value = try {
            context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
                .metaData?.get(META_DATA)
        } catch (e: PackageManager.NameNotFoundException) {
            null
        } catch (e: RuntimeException) {
            null
        }
        return allowsValue(value).also { allowed ->
            if (!allowed) Log.i(LOG_TAG, "Lionscope inflation tracking off for this app ($META_DATA = false)")
        }
    }
}

/** Where a layout came from, resolved to a [LayoutName] once its message has ended. */
internal class LayoutSource(val resources: Resources?, val resId: Int, val firstTag: String, val line: Int)

/**
 * Layout inflation timing (API 29+): installs a [TracingFactory] on each AppCompatActivity's LayoutInflater in
 * `onActivityPreCreated`, where it has no factory yet, and turns its per-view callbacks into inflations through an
 * [InflateRecorder] that is finished when the current main-thread message ends (a front-of-queue post). It never
 * replaces or chains another factory: an inflater that already has one is left alone. Other activities are not
 * measured: they may install AppCompat's factory themselves when none is set (`AppCompatDelegate.installViewFactory`
 * in a plain Activity), or a library may, and ours would silently take its place.
 *
 * Screen attribution (see [InflateRecorder]): an app-owned fragment's root view and the layouts of a shown app-owned
 * dialog's window are attributed when the fragment reports them (view created / dialog started), which also covers
 * views re-created from the back stack, fragments created by a `FragmentContainerView` during `setContentView` and
 * dialog content inflated in `onStart`; then the app-owned fragment whose view holds the view a layout was inflated
 * into (RecyclerView rows: their screen is resolved only after the first layout pass); then the Activity, for what
 * is inflated between its pre-created and post-created callbacks; then the Activity last created, started or resumed
 * in the same message (`onStart` / `onResume` / `onPostCreate` work, a stopped Activity coming back: the top screen
 * is only resolved after that message); else the top screen. Fragments open no creation
 * scope: restored fragments are created inside `super.onCreate`, long before their view, and would claim the
 * Activity's own `setContentView`. Main thread only.
 */
@RequiresApi(29)
internal class InflateTracer(
    private val reporter: InflateReporter,
    private val topScreen: () -> String?,
    private val ownership: AppOwnership,
    private val postAtFrontOfQueue: (Runnable) -> Unit,
    private val nanoTime: () -> Long = System::nanoTime,
    private val wallMs: () -> Long = System::currentTimeMillis,
    /** Layout and line of each view the factory creates, for the Inspector; null records none. */
    private val origins: ViewOrigins? = null,
    private val sourceResId: (AttributeSet) -> Int = Resources::getAttributeSetSourceResId,
) : InflateHooks {
    /** An Activity between its pre-created and post-created callbacks. */
    private class Scope(val owner: Any, val screen: String)

    private val recorder = InflateRecorder<LayoutSource>()
    private val scopes = ArrayList<Scope>()
    /** App-owned fragments by their (current) root view. */
    private val fragmentsByView = IdentityHashMap<View, Any>()
    private val names = HashMap<Int, LayoutName>()
    /** Activity created, started or resumed in the current message; cleared when it ends. */
    private var messageActivity: String? = null
    private var endScheduled = false
    private val endOfMessage = Runnable { guarded(::finish) }
    private var loggedInstall = false

    val isRecording: Boolean
        get() = reporter.isRecording

    override fun onActivityPreCreated(activity: Activity) {
        if (!isRecording) return
        pushScope(activity, ScreenNames.nameOf(activity))
        install(activity)
    }

    override fun onActivityPostCreated(activity: Activity) {
        popScope(activity)
        onActivityShown(activity)
    }

    override fun onActivityShown(activity: Activity) {
        if (!isRecording) return
        messageActivity = ScreenNames.nameOf(activity)
        scheduleEnd()
    }

    override fun onFragmentViewCreated(fragment: Any, activity: Any?, view: View) {
        if (!isOwned(fragment, activity)) return
        forgetView(fragment)
        if (fragmentsByView.size < MAX_FRAGMENT_VIEWS) fragmentsByView[view] = fragment
        if (isRecording && !recorder.isEmpty) recorder.assignView(view, ScreenNames.nameOf(fragment))
    }

    override fun onFragmentViewDestroyed(fragment: Any) = forgetView(fragment)

    private fun forgetView(fragment: Any) {
        val views = fragmentsByView.values.iterator()
        while (views.hasNext()) if (views.next() === fragment) views.remove()
    }

    override fun onDialogShown(fragment: Any, activity: Any?, window: Window) {
        if (!isRecording || recorder.isEmpty || !isOwned(fragment, activity)) return
        val decor = window.peekDecorView() ?: return
        recorder.assignRoots(ScreenNames.nameOf(fragment)) { (it as? View)?.rootView === decor }
    }

    /**
     * Any view created by [TracingFactory] on the main thread, recording or not: its layout and the parser's line,
     * which is where the view's start tag ends (also for `<include>` roots and `<merge>` children: each layout has
     * its own parser).
     */
    fun noteOrigin(parser: AttributeSet, view: View) {
        val origins = origins ?: return
        val line = (parser as? XmlPullParser)?.lineNumber ?: return
        origins.record(view, sourceResId(parser), line)
    }

    /** One view created by [TracingFactory] on the main thread while recording. */
    fun record(parser: AttributeSet, view: View, parent: View?, context: Context, tag: String, startNanos: Long, endNanos: Long) {
        recorder.onView(parser, view, parent, startNanos, endNanos) {
            val resId = Resources.getAttributeSetSourceResId(parser)
            val xml = parser as? XmlPullParser
            InflateRecorder.Opening(
                source = LayoutSource(context.resources, resId, tag, if (resId == 0) xml?.lineNumber ?: 0 else 0),
                merge = xml?.depth == MERGE_CHILD_DEPTH,
                parentParsing = isAtStartTag(recorder.parserAround(parent)),
                scope = scopes.lastOrNull()?.screen,
            )
        }
        scheduleEnd()
    }

    private fun install(activity: Activity) {
        val inflater = activity.window?.layoutInflater ?: return
        if (inflater.factory != null || inflater.factory2 != null) return
        val delegate = installDelegate(AppCompatBridge.get(), activity) ?: return
        try {
            inflater.factory2 = TracingFactory(activity, inflater, delegate, this)
        } catch (e: IllegalStateException) {
            return // A factory was set in the meantime.
        }
        if (!loggedInstall) {
            loggedInstall = true
            // A "factory has already been set" crash in the app never mentions Lionscope: say it once, up front.
            Log.w(LOG_TAG, INSTALL_WARNING)
        }
    }

    /**
     * Whether a parser is inside a tag (an `<include>` being inflated, a view being constructed). Only
     * `getEventType()` is asked: XmlBlock.Parser answers it from a Java field, also once closed (a finished inflate
     * leaves it at its last end tag or END_DOCUMENT), never from its freed native state.
     */
    private fun isAtStartTag(parser: Any?): Boolean = try {
        (parser as? XmlPullParser)?.eventType == XmlPullParser.START_TAG
    } catch (e: XmlPullParserException) {
        false
    } catch (e: RuntimeException) {
        false
    }

    private fun isOwned(fragment: Any, activity: Any?): Boolean =
        ownership.isOwned(fragment.javaClass.name, activity?.javaClass?.name)

    private fun pushScope(owner: Any, screen: String) {
        if (scopes.size >= MAX_SCOPES) return
        scopes += Scope(owner, screen)
        scheduleEnd()
    }

    private fun popScope(owner: Any) {
        for (i in scopes.indices.reversed()) {
            if (scopes[i].owner === owner) {
                scopes.removeAt(i)
                return
            }
        }
    }

    private fun scheduleEnd() {
        if (endScheduled) return
        endScheduled = true
        postAtFrontOfQueue(endOfMessage)
    }

    /** The message that inflated has ended. Scopes never outlive a message (an Activity's or a fragment's creation). */
    private fun finish() {
        endScheduled = false
        scopes.clear()
        val fallback = messageActivity ?: topScreen()
        messageActivity = null
        if (recorder.isEmpty) return
        if (!isRecording) {
            recorder.clear()
            return
        }
        val inflations = recorder.finish(fallback, ::screenOf)
        val nowNanos = nanoTime()
        val nowWall = wallMs()
        for (inflation in inflations) {
            val tsMs = nowWall - (nowNanos - inflation.startNanos) / NANOS_PER_MS
            val durationMs = inflation.durationNanos / NANOS_PER_MS_D
            reporter.add(nameOf(inflation.source), inflation.screen, tsMs, durationMs, inflation.views, inflation.isNested)
        }
    }

    /** The innermost app-owned fragment whose view holds [parent], if any. */
    private fun screenOf(parent: Any?): String? {
        var view = if (fragmentsByView.isEmpty()) null else parent as? View
        var depth = 0
        while (view != null && depth++ < MAX_PARENT_WALK) {
            fragmentsByView[view]?.let { return ScreenNames.nameOf(it) }
            view = view.parent as? View
        }
        return null
    }

    private fun nameOf(source: LayoutSource): LayoutName {
        if (source.resId == 0) return LayoutNames.unnamed(source.firstTag, source.line)
        names[source.resId]?.let { return it }
        val name = try {
            val resources = source.resources ?: return LayoutNames.unnamed(source.firstTag, source.line)
            LayoutNames.named(resources.getResourcePackageName(source.resId), resources.getResourceEntryName(source.resId))
        } catch (e: Resources.NotFoundException) {
            LayoutNames.unnamed(source.firstTag, source.line)
        }
        if (names.size < MAX_NAMES) names[source.resId] = name
        return name
    }

    internal companion object {
        /** AppCompat's delegate for an AppCompatActivity, else null: the Activity gets no factory. */
        fun installDelegate(bridge: AppCompatBridge?, activity: Activity): Any? =
            bridge?.takeIf { it.isAppCompat(activity) }?.delegateOf(activity)

        const val INSTALL_WARNING = "Lionscope installed a LayoutInflater factory for inflation timing; if the app " +
            "sets its own factory and crashes with \"A factory has already been set\", add <meta-data " +
            "android:name=\"" + InflateOptOut.META_DATA + "\" android:value=\"false\" /> to its <application>"

        /** Children of a `<merge>` root are at parser depth 2; a regular root tag is at depth 1. */
        private const val MERGE_CHILD_DEPTH = 2
        private const val MAX_SCOPES = 32
        private const val MAX_NAMES = 1_024
        private const val MAX_FRAGMENT_VIEWS = 256
        private const val MAX_PARENT_WALK = 256
        private const val NANOS_PER_MS = 1_000_000L
        private const val NANOS_PER_MS_D = 1_000_000.0
    }
}

/**
 * Times view creation on the main thread while recording, creating views exactly as the inflater would without it:
 * AppCompat's delegate first (`AppCompatDelegate.createView`, so widget substitution stays intact), then the
 * Activity (its private factory: `<fragment>`, `FragmentContainerView`, app overrides of `onCreateView`), then the
 * framework, through the public API 29 `createView` with the view's own context. On the main thread it does so also
 * when not recording, so every view it creates gets its origin noted for the Inspector ([InflateTracer.noteOrigin]);
 * elsewhere it only does AppCompat's part and leaves the rest to the inflater. A view AppCompat fails on fails exactly as with
 * AppCompat's own factory (see [AppCompatBridge.invokeCreateView]); a framework view whose constructor throws fails
 * as `LayoutInflater.createView` throws it (an InflateException with the cause), never constructed a second time by
 * the inflater. Views it cannot create the same way (a `ViewStub`, an inflater it does not know, a class not found
 * under any framework prefix) are left to the inflater.
 */
@RequiresApi(29)
internal class TracingFactory(
    private val activity: Activity,
    private val inflater: LayoutInflater,
    private val delegate: Any,
    private val tracer: InflateTracer,
    /** Only the framework's own inflater class is reproduced view for view. */
    private val createsFrameworkViews: Boolean = inflater.javaClass.name == PHONE_LAYOUT_INFLATER,
    /** `LayoutInflater.createView(Context, String, String, AttributeSet)` (API 29). */
    private val createView: (Context, String, String?, AttributeSet) -> View? = inflater::createView,
) : LayoutInflater.Factory2 {

    @Volatile
    private var delegateBroken = false

    override fun onCreateView(name: String, context: Context, attrs: AttributeSet): View? =
        onCreateView(null, name, context, attrs)

    override fun onCreateView(parent: View?, name: String, context: Context, attrs: AttributeSet): View? {
        if (Looper.myLooper() !== Looper.getMainLooper()) return delegateView(parent, name, context, attrs)
        if (!tracer.isRecording) {
            val view = createView(parent, name, context, attrs)
            if (view != null) guarded { tracer.noteOrigin(attrs, view) }
            return view
        }
        val start = System.nanoTime()
        val view = createView(parent, name, context, attrs)
        val end = System.nanoTime()
        if (view != null) {
            guarded { tracer.record(attrs, view, parent, context, name, start, end) }
            guarded { tracer.noteOrigin(attrs, view) }
        }
        return view
    }

    private fun createView(parent: View?, name: String, context: Context, attrs: AttributeSet): View? =
        delegateView(parent, name, context, attrs)
            ?: activity.onCreateView(parent, name, context, attrs)
            ?: frameworkView(name, context, attrs)

    private fun delegateView(parent: View?, name: String, context: Context, attrs: AttributeSet): View? {
        if (delegateBroken) return null
        val bridge = AppCompatBridge.get() ?: return null
        return AppCompatBridge.invokeCreateView({ bridge.createView(delegate, parent, name, context, attrs) }) { cause ->
            delegateBroken = true
            Log.w(LOG_TAG, "Lionscope stopped delegating to AppCompat: $cause")
        }
    }

    private fun frameworkView(name: String, context: Context, attrs: AttributeSet): View? {
        if (!createsFrameworkViews || name == VIEW_STUB || name == FULL_VIEW_STUB) return null
        // A constructor failure propagates as createView throws it (an InflateException with the cause), as it would
        // from the inflater: returning null instead would make the inflater construct the view a second time.
        return try {
            if (name.indexOf('.') != -1) return createView(context, name, null, attrs)
            // PhoneLayoutInflater.onCreateView: these prefixes in turn, then LayoutInflater's `android.view.`.
            for (prefix in FRAMEWORK_PREFIXES) {
                try {
                    return createView(context, name, prefix, attrs)
                } catch (e: ClassNotFoundException) {
                    // Next prefix.
                }
            }
            null
        } catch (e: ClassNotFoundException) {
            null
        }
    }

    private companion object {
        const val PHONE_LAYOUT_INFLATER = "com.android.internal.policy.PhoneLayoutInflater"
        /** A ViewStub keeps the inflater that created it (for a later inflate): leave it to the real one. */
        const val VIEW_STUB = "ViewStub"
        const val FULL_VIEW_STUB = "android.view.ViewStub"
        val FRAMEWORK_PREFIXES = arrayOf("android.widget.", "android.webkit.", "android.app.", "android.view.")
    }
}

/** AppCompat's public `AppCompatActivity.getDelegate()` / `AppCompatDelegate.createView`, by reflection. */
internal class AppCompatBridge private constructor(private val activityClass: Class<*>, private val api: Api?) {
    private class Api(val getDelegate: Method, val delegateClass: Class<*>, val createView: Method)

    fun isAppCompat(activity: Activity): Boolean = activityClass.isInstance(activity)

    /** Null when the delegate cannot be obtained: the Activity is then left to AppCompat's own factory. */
    fun delegateOf(activity: Activity): Any? {
        val api = api ?: return null
        return try {
            api.getDelegate.invoke(activity)?.takeIf { api.delegateClass.isInstance(it) }
        } catch (e: ReflectiveOperationException) {
            null
        } catch (e: RuntimeException) {
            null
        }
    }

    /** `delegate.createView(...)`; throws what `Method.invoke` throws. */
    fun createView(delegate: Any, parent: View?, name: String, context: Context, attrs: AttributeSet): View? =
        api?.createView?.invoke(delegate, parent, name, context, attrs) as? View

    companion object {
        /**
         * Runs a reflective `createView` call. What AppCompat itself throws for a view (a MaterialButton under a
         * non-MaterialComponents theme, a bad `app:srcCompat`) is rethrown exactly as AppCompat's own factory would
         * surface it, never turned into a plain framework widget. Only a failure of the reflection itself (access,
         * argument mismatch, a missing method) calls [onBroken] and returns null.
         */
        fun invokeCreateView(invoke: () -> View?, onBroken: (Throwable) -> Unit): View? = try {
            invoke()
        } catch (e: InvocationTargetException) {
            throw surfaced(e)
        } catch (e: ReflectiveOperationException) {
            onBroken(e)
            null
        } catch (e: IllegalArgumentException) {
            onBroken(e)
            null
        } catch (e: LinkageError) {
            onBroken(e)
            null
        }

        /** The cause as AppCompat's factory throws it: unchecked as is, anything else in an InflateException. */
        fun surfaced(e: InvocationTargetException): Throwable = when (val cause = e.targetException) {
            is RuntimeException, is Error -> cause
            null -> InflateException(e)
            else -> InflateException(cause)
        }

        @Volatile
        private var loaded = false
        private var instance: AppCompatBridge? = null

        /** Null without AppCompat. */
        @Synchronized
        fun get(): AppCompatBridge? {
            if (loaded) return instance
            instance = load()
            loaded = true
            return instance
        }

        private fun load(): AppCompatBridge? = try {
            forClasses(
                Class.forName("androidx.appcompat.app.AppCompatActivity"),
                Class.forName("androidx.appcompat.app.AppCompatDelegate"),
            )
        } catch (e: ClassNotFoundException) {
            null
        } catch (e: LinkageError) {
            null
        }

        /**
         * [activityClass] must have a public `getDelegate()` returning a [delegateClass] with a public
         * `createView(View, String, Context, AttributeSet)`; if not, its activities get no factory.
         */
        fun forClasses(activityClass: Class<*>, delegateClass: Class<*>): AppCompatBridge {
            val api = try {
                Api(
                    getDelegate = activityClass.getMethod("getDelegate"),
                    delegateClass = delegateClass,
                    createView = delegateClass.getMethod(
                        "createView",
                        View::class.java,
                        String::class.java,
                        Context::class.java,
                        AttributeSet::class.java,
                    ),
                )
            } catch (e: ReflectiveOperationException) {
                unresolved(e)
            } catch (e: LinkageError) {
                unresolved(e)
            }
            return AppCompatBridge(activityClass, api)
        }

        /** AppCompat is there but unusable (e.g. shrunk): its activities must not get our factory. */
        private fun unresolved(cause: Throwable): Api? {
            Log.w(LOG_TAG, "Lionscope inflation tracking skips AppCompat activities: $cause")
            return null
        }
    }
}
