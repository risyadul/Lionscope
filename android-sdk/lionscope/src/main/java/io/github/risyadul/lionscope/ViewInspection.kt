package io.github.risyadul.lionscope

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.res.Resources
import android.graphics.Point
import android.os.Build
import android.text.InputType
import android.text.method.HideReturnsTransformationMethod
import android.text.method.PasswordTransformationMethod
import android.text.method.SingleLineTransformationMethod
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inspector.WindowInspector
import android.widget.Checkable
import android.widget.TextView
import androidx.annotation.RequiresApi
import java.lang.reflect.Method
import java.util.IdentityHashMap

private const val MAX_CONTEXT_DEPTH = 16

/** The Activity [context] is, or wraps (a ContextThemeWrapper, a Fragment's context, ...), else null. */
internal fun activityOf(context: Context?): Activity? {
    var current = context
    var depth = 0
    while (current is ContextWrapper && depth++ < MAX_CONTEXT_DEPTH) {
        if (current is Activity) return current
        current = current.baseContext
    }
    return null
}

/** A password field (or a view with a password autofill hint): its text is never read, sent or set. */
internal fun isPasswordView(view: View): Boolean {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && InspectorText.hasPasswordHint(view.autofillHints)) return true
    val textView = view as? TextView ?: return false
    return InspectorText.shown(textView.transformationMethod, textView.inputType) == InspectorText.Shown.SECRET
}

/** The windows the SDK tracks itself, for the Inspector below API 29 (main thread). */
internal interface KnownWindows {
    val hasStartedActivity: Boolean

    /** Decor views of the top started Activity and of the shown dialogs, bottom-most first. */
    fun knownRoots(): List<View>
}

/**
 * What the Inspector reads of a view's text. A password field (a password input type, a PasswordTransformationMethod,
 * or, on API 26+, an autofill hint containing "password") sends neither its text nor its content description. Other
 * text is sent as set (not caps-transformed) under no transformation, SingleLine, HideReturns or AllCaps; under any
 * other TransformationMethod it is sent as the screen shows it (`getTransformation`), or not at all if that fails.
 */
internal object InspectorText {
    /** TextView text is read up to this many chars before it is cleaned and capped for the wire. */
    const val MAX_RAW_TEXT = 2_000
    private const val PASSWORD_HINT = "password"
    private const val ALL_CAPS = "AllCapsTransformationMethod"

    enum class Shown { RAW, TRANSFORMED, SECRET }

    /** Text / number password variations (also the visible-password one: a password field all the same). */
    fun isPasswordInputType(inputType: Int): Boolean {
        val variation = inputType and (InputType.TYPE_MASK_CLASS or InputType.TYPE_MASK_VARIATION)
        return variation == InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD ||
            variation == InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD ||
            variation == InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD ||
            variation == InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
    }

    /** `View.AUTOFILL_HINT_PASSWORD` and its kin (`newPassword`, `current-password`, ...), any case. */
    fun hasPasswordHint(autofillHints: Array<String>?): Boolean =
        autofillHints?.any { it.contains(PASSWORD_HINT, ignoreCase = true) } == true

    /** How a TextView with [transformation] (its TransformationMethod) and [inputType] shows its text. */
    fun shown(transformation: Any?, inputType: Int): Shown = when {
        transformation is PasswordTransformationMethod || isPasswordInputType(inputType) -> Shown.SECRET
        transformation == null || transformation is SingleLineTransformationMethod ||
            transformation is HideReturnsTransformationMethod ||
            transformation.javaClass.simpleName == ALL_CAPS -> Shown.RAW
        else -> Shown.TRANSFORMED
    }

    /** At most [MAX_RAW_TEXT] chars, without copying a longer text whole. */
    fun raw(text: CharSequence?): String? {
        if (text == null) return null
        return (if (text.length > MAX_RAW_TEXT) text.subSequence(0, MAX_RAW_TEXT) else text).toString()
    }
}

/**
 * Which windows to walk: every window of the process on API 29+ (`WindowInspector`), else the ones the SDK knows
 * (no layout sources there: the inflater factory needs API 29). Only windows on screen.
 */
internal object WindowRoots {
    fun <T> select(sdkInt: Int, global: () -> List<T>, known: () -> List<T>, isShown: (T) -> Boolean): List<T> =
        (if (sdkInt >= Build.VERSION_CODES.Q) global() else known()).filter(isShown)
}

/**
 * [InspectorScene] over the app's real windows (Views, and composables when [compose] can read them). With [editor]
 * (v8 links) every View node carries its key and editable state, and a capture that worked becomes the one edits name.
 */
internal class ViewScene(
    private val known: KnownWindows,
    private val origins: ViewOrigins?,
    private val sdkInt: Int = Build.VERSION.SDK_INT,
    private val compose: () -> ComposeReading? = { ComposeSupport.reading },
    private val editor: ViewEditor<View>? = null,
) : InspectorScene<Any> {
    override val isForeground: Boolean
        get() = known.hasStartedActivity

    override fun prepare(readCompose: Boolean, viewState: Boolean): PreparedScene<Any>? {
        val global = { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) globalWindows() else emptyList() }
        val roots = WindowRoots.select(sdkInt, global, known::knownRoots, ::isShownWindow)
        if (roots.isEmpty()) return null
        val fragments = IdentityHashMap<Any, String>()
        val activities = IdentityHashMap<Activity, Unit>()
        val windows = roots.map { root ->
            val activity = windowActivity(root)
            if (activity != null && activities.put(activity, Unit) == null) fragmentRoots(activity, fragments)
            val location = IntArray(2).also(root::getLocationOnScreen)
            WindowRoot<Any>(
                root = root,
                type = (root.layoutParams as? WindowManager.LayoutParams)?.type,
                bounds = PixelRect(location[0], location[1], location[0] + root.width, location[1] + root.height),
                activity = activity?.javaClass?.name,
            )
        }
        val edits = editor?.takeIf { viewState }
        val keys = edits?.beginCapture()
        val views = ViewInspectorAccess(if (sdkInt >= Build.VERSION_CODES.Q) origins else null, fragments, keys)
        val reading = if (readCompose) compose()?.also { it.beginCapture() } else null
        val captured = if (edits != null && keys != null) {
            {
                keys.commit()
                edits.liveEdits()
            }
        } else {
            null
        }
        return PreparedScene(windows, display(roots.last()), SceneTreeAccess(views, reading), captured)
    }

    @RequiresApi(29)
    private fun globalWindows(): List<View> = WindowInspector.getGlobalWindowViews()

    private fun isShownWindow(root: View): Boolean =
        root.isAttachedToWindow && root.isShown && root.windowVisibility == View.VISIBLE && root.width > 0

    @Suppress("DEPRECATION") // Display.getRealSize: the WindowMetrics replacement needs API 30.
    private fun display(root: View): InspectorDisplay {
        val display = root.display
        if (display == null) {
            val metrics = root.resources.displayMetrics
            return InspectorDisplay(metrics.widthPixels, metrics.heightPixels, 0)
        }
        val size = Point().also(display::getRealSize)
        return InspectorDisplay(size.x, size.y, display.rotation * DEGREES_PER_ROTATION)
    }

    private companion object {
        const val DEGREES_PER_ROTATION = 90
        const val MAX_DESCENT = 8

        /** A DecorView's context is a DecorContext (app context): its content's views know the Activity. */
        fun windowActivity(root: View): Activity? {
            activityOf(root.context)?.let { return it }
            var view: View? = root
            var depth = 0
            while (view is ViewGroup && view.childCount > 0 && depth++ < MAX_DESCENT) {
                view = view.getChildAt(0)
                activityOf(view?.context)?.let { return it }
            }
            return null
        }

        @Volatile
        private var fragmentsAvailable: Boolean? = null

        /** Adds [activity]'s fragment roots; nothing without androidx.fragment or when its tree cannot be read. */
        fun fragmentRoots(activity: Activity, into: MutableMap<Any, String>) {
            val available = fragmentsAvailable ?: try {
                Class.forName("androidx.fragment.app.FragmentActivity")
                true
            } catch (e: ClassNotFoundException) {
                false
            } catch (e: LinkageError) {
                false
            }.also { fragmentsAvailable = it }
            if (!available) return
            try {
                AndroidxFragmentRoots.collect(activity, into)
            } catch (e: LinkageError) {
                fragmentsAvailable = false
            } catch (e: RuntimeException) {
                // A fragment tree in transition: owners stay unknown for this capture.
            }
        }
    }
}

/**
 * Views and composables as one tree. An AndroidComposeView whose composition [compose] read has its composables as
 * children (then the AndroidViewsHandler, only while it still holds an AndroidView that no composable claimed); its
 * other internal views (draw layers) are left out. Any other node is read by [views]; without [compose] (a link
 * below v6, Compose inspection off) the tree is exactly the View tree.
 */
internal class SceneTreeAccess(
    private val views: InspectorTreeAccess<View>,
    private val compose: ComposeReading?,
) : InspectorTreeAccess<Any> {
    private val reads = IdentityHashMap<View, ComposeRead>()
    private val claimed = IdentityHashMap<View, Unit>()
    private val semantics = IdentityHashMap<ComposeNode, ComposeSemantics>()
    private var cut = false

    override val truncated: Boolean
        get() = cut

    override fun children(node: Any): List<Any> = when (node) {
        is ComposeNode -> node.children
        is View -> {
            val read = composeRead(node)
            val children = views.children(node).filter { it !in claimed }
            if (read?.status != CompositionStatus.READ) {
                children
            } else {
                read.roots + children.filter { views.className(it) == VIEWS_HANDLER && views.children(it).any { holder -> holder !in claimed } }
            }
        }
        else -> emptyList()
    }

    override fun className(node: Any): String = if (node is ComposeNode) node.name else views.className(node as View)

    override fun fragmentRootOf(node: Any): String? = (node as? View)?.let(views::fragmentRootOf)

    override fun read(node: Any): NodeAttributes {
        if (node is View) {
            val attributes = views.read(node)
            return reads[node]?.let { attributes.copy(composition = it.status) } ?: attributes
        }
        val composable = node as ComposeNode
        val read = semantics[composable] ?: ComposeSemantics.NONE
        return NodeAttributes(
            className = composable.name,
            resourceId = read.testTag,
            text = if (read.secret) null else read.text,
            contentDescription = if (read.secret) null else read.contentDescription,
            bounds = composable.bounds ?: PixelRect(0, 0, 0, 0),
            visibility = ViewVisibility.VISIBLE,
            alpha = null,
            enabled = read.enabled,
            clickable = read.clickable,
            focused = read.focused,
            selected = read.selected,
            checked = read.checked,
            padding = null,
            margin = null,
            layoutWidth = null,
            layoutHeight = null,
            source = null,
            composable = composable.source.copy(draws = composable.draws),
            destination = composable.destination,
        )
    }

    /** Read once per capture, when first walked into. */
    private fun composeRead(view: View): ComposeRead? {
        val reading = compose ?: return null
        reads[view]?.let { return it }
        if (views.className(view) != InspectorWalker.COMPOSE_VIEW) return null
        val read = reading.read(view)
        reads[view] = read
        for (holder in read.claimed) claimed[holder] = Unit
        semantics.putAll(read.semantics)
        if (read.truncated) cut = true
        return read
    }

    private companion object {
        const val VIEWS_HANDLER = "androidx.compose.ui.platform.AndroidViewsHandler"
    }
}

/** Fragment roots (a fragment's view, a DialogFragment's window) → the fragment's class, over a whole fragment tree. */
internal object FragmentOwnership {
    const val MAX_FRAGMENTS = 512

    /** Depth-first, so a nested fragment's root overrides its parent's should they share one. */
    fun <F : Any> collect(
        top: List<F>,
        children: (F) -> List<F>,
        roots: (F) -> List<Any?>,
        name: (F) -> String,
        into: MutableMap<Any, String>,
    ) {
        val stack = ArrayList<F>(top.asReversed())
        var visited = 0
        while (stack.isNotEmpty() && visited++ < MAX_FRAGMENTS) {
            val fragment = stack.removeAt(stack.size - 1)
            for (root in roots(fragment)) if (root != null) into[root] = name(fragment)
            stack.addAll(children(fragment).asReversed())
        }
    }
}

/**
 * A ViewGroup's children in the order it draws them (`ViewGroup.buildOrderedChildList`): its custom drawing order
 * when enabled (`getChildDrawingOrder`), then sorted by Z (elevation + translationZ), stable for equal Z. A later
 * child draws over an earlier one.
 */
internal object DrawingOrder {
    /** [custom] is null when custom drawing order is off; one that is not a permutation is ignored (as if off). */
    fun order(count: Int, custom: ((Int) -> Int)?, z: (Int) -> Float): List<Int> {
        val natural = List(count) { it }
        val preordered = custom?.let { order -> natural.map(order).takeIf { isPermutation(it, count) } } ?: natural
        return preordered.sortedBy(z) // Stable: equal Z keeps the (custom) order.
    }

    private fun isPermutation(indexes: List<Int>, count: Int): Boolean {
        val seen = BooleanArray(count)
        for (index in indexes) {
            if (index !in 0 until count || seen[index]) return false
            seen[index] = true
        }
        return true
    }
}

/**
 * [InspectorTreeAccess] over real views; resource names and reflective lookups are cached per capture. With [keys]
 * (a v8 capture) each view read gets its key and editable state.
 */
internal class ViewInspectorAccess(
    private val origins: ViewOrigins?,
    private val fragmentRoots: Map<Any, String>,
    private val keys: ViewEditor<View>.Capture? = null,
) : InspectorTreeAccess<View> {
    private val classNames = HashMap<Class<*>, String>()
    private val ids = HashMap<Int, String?>()
    private val layouts = HashMap<Int, String?>()
    private val checkable = HashMap<Class<*>, Method?>()
    private val location = IntArray(2)

    override fun children(node: View): List<View> {
        val group = node as? ViewGroup ?: return emptyList()
        val count = group.childCount
        if (count == 0) return emptyList()
        val custom = if (count > 1 && customOrderEnabled(group)) { position: Int -> customOrder(group, count, position) } else null
        val order = try {
            DrawingOrder.order(count, custom) { group.getChildAt(it)?.z ?: 0f }
        } catch (e: RuntimeException) {
            DrawingOrder.order(count, null) { group.getChildAt(it)?.z ?: 0f } // A failing getChildDrawingOrder.
        }
        return order.mapNotNull(group::getChildAt)
    }
    override fun className(node: View): String = classNames.getOrPut(node.javaClass) { node.javaClass.name }
    override fun fragmentRootOf(node: View): String? = fragmentRoots[node]

    override fun read(node: View): NodeAttributes {
        node.getLocationOnScreen(location)
        val params = node.layoutParams
        val margins = params as? ViewGroup.MarginLayoutParams
        val secret = isPasswordView(node)
        return NodeAttributes(
            className = className(node),
            resourceId = resourceId(node),
            text = if (secret) null else text(node),
            contentDescription = if (secret) null else InspectorText.raw(node.contentDescription),
            bounds = PixelRect(location[0], location[1], location[0] + node.width, location[1] + node.height),
            visibility = when (node.visibility) {
                View.VISIBLE -> ViewVisibility.VISIBLE
                View.INVISIBLE -> ViewVisibility.INVISIBLE
                else -> ViewVisibility.GONE
            },
            alpha = node.alpha.toDouble(),
            enabled = node.isEnabled,
            clickable = node.isClickable,
            focused = node.isFocused,
            selected = node.isSelected,
            checked = checked(node),
            padding = PixelRect(node.paddingLeft, node.paddingTop, node.paddingRight, node.paddingBottom),
            margin = margins?.let { PixelRect(it.leftMargin, it.topMargin, it.rightMargin, it.bottomMargin) },
            layoutWidth = params?.let { DeviceMessages.layoutDimension(it.width) },
            layoutHeight = params?.let { DeviceMessages.layoutDimension(it.height) },
            source = source(node),
            view = keys?.let { AndroidViewEdits.state(node, it.keyOf(node), it.edited(node)) },
        )
    }

    /** Not called for secret views. */
    private fun text(node: View): String? {
        val textView = node as? TextView ?: return null
        val transformation = textView.transformationMethod
        return when (InspectorText.shown(transformation, textView.inputType)) {
            InspectorText.Shown.RAW -> InspectorText.raw(textView.text)
            InspectorText.Shown.TRANSFORMED -> try {
                InspectorText.raw(transformation.getTransformation(textView.text, textView))
            } catch (e: RuntimeException) {
                null
            }
            InspectorText.Shown.SECRET -> null
        }
    }

    /** The app's own ids (package id 0x7f) by entry name, others as `package:id/name`; generated ids have none. */
    private fun resourceId(node: View): String? {
        val id = node.id
        if (id == View.NO_ID || id ushr 24 == 0) return null
        if (ids.containsKey(id)) return ids[id]
        val name = try {
            val resources = node.resources
            val entry = resources.getResourceEntryName(id)
            if (id ushr 24 == APP_PACKAGE_ID) entry else "${resources.getResourcePackageName(id)}:id/$entry"
        } catch (e: Resources.NotFoundException) {
            null
        }
        ids[id] = name
        return name
    }

    private fun source(node: View): ViewSource? {
        val origin = origins?.get(node) ?: return null
        val layout = if (layouts.containsKey(origin.resId)) {
            layouts[origin.resId]
        } else {
            try {
                node.resources.getResourceEntryName(origin.resId)
            } catch (e: Resources.NotFoundException) {
                null
            }.also { layouts[origin.resId] = it }
        }
        return layout?.let { ViewSource(it, origin.line) }
    }

    /** Some Checkable widgets (MaterialButton, MaterialCardView) are only checkable when `isCheckable()` says so. */
    private fun checked(node: View): Boolean? {
        if (node !is Checkable) return null
        val type = node.javaClass
        val isCheckable = if (checkable.containsKey(type)) {
            checkable[type]
        } else {
            try {
                type.getMethod("isCheckable").takeIf { it.returnType == Boolean::class.javaPrimitiveType }
            } catch (e: NoSuchMethodException) {
                null
            } catch (e: SecurityException) {
                null
            }.also { checkable[type] = it }
        }
        if (isCheckable != null) {
            val answer = try {
                isCheckable.invoke(node) as? Boolean
            } catch (e: ReflectiveOperationException) {
                null
            } catch (e: RuntimeException) {
                null
            }
            if (answer == false) return null
        }
        return node.isChecked
    }

    private companion object {
        const val APP_PACKAGE_ID = 0x7f

        /** ViewGroup's protected `isChildrenDrawingOrderEnabled()` and `getChildDrawingOrder(int, int)` (public SDK). */
        private val drawingOrderMethods: Pair<Method, Method>? by lazy {
            try {
                val enabled = ViewGroup::class.java.getDeclaredMethod("isChildrenDrawingOrderEnabled")
                val order = ViewGroup::class.java.getDeclaredMethod(
                    "getChildDrawingOrder",
                    Int::class.javaPrimitiveType,
                    Int::class.javaPrimitiveType,
                )
                enabled.isAccessible = true
                order.isAccessible = true
                enabled to order
            } catch (e: ReflectiveOperationException) {
                null
            } catch (e: RuntimeException) {
                null
            }
        }

        fun customOrderEnabled(group: ViewGroup): Boolean = try {
            drawingOrderMethods?.first?.invoke(group) == true
        } catch (e: ReflectiveOperationException) {
            false
        } catch (e: RuntimeException) {
            false
        }

        /** Throws (e.g. IllegalStateException) when the group's own override fails; the caller falls back. */
        fun customOrder(group: ViewGroup, count: Int, position: Int): Int {
            val method = drawingOrderMethods?.second ?: return position
            return try {
                method.invoke(group, count, position) as Int
            } catch (e: ReflectiveOperationException) {
                throw IllegalStateException(e)
            }
        }
    }
}
