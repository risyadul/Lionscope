package io.github.risyadul.lionscope

import android.view.View
import android.view.ViewGroup
import androidx.compose.runtime.tooling.CompositionData
import androidx.compose.runtime.tooling.CompositionGroup
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.LayoutInfo
import androidx.compose.ui.layout.findRootCoordinates
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.platform.isDebugInspectorInfoEnabled
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsConfiguration
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import java.lang.reflect.Field
import java.lang.reflect.Method
import java.lang.reflect.Modifier
import java.util.IdentityHashMap
import kotlin.math.roundToInt

// Everything in this file links against Compose (compileOnly): it is only loaded once ComposeSupport found it.

internal object ComposeInspectionSwitch {
    fun enable() {
        isDebugInspectorInfoEnabled = true
    }
}

/**
 * [ComposeReading] over Compose's tooling API: the compositions Compose records in the view's
 * `inspection_slot_table_set` tag (root and sub-compositions, kept for tools while inspection is enabled), layout
 * nodes through `LayoutInfo`, semantics through the view's unmerged semantics tree, AndroidView holders through
 * their `getLayoutNode()` and whether a composable paints through its modifier nodes ([ComposeDrawing]). Only public
 * API, except those reflective reads (on failure, AndroidViews stay under AndroidViewsHandler and `draws` is omitted).
 */
internal class ComposeViewReader : ComposeReading {
    private var budget = ComposeBudget()
    private var filter = ComposableFilter()
    private val drawing = ComposeDrawing()

    override fun beginCapture() {
        budget = ComposeBudget()
        filter = ComposableFilter()
    }

    override fun read(view: View): ComposeRead = try {
        readOrFail(view)
    } catch (e: LinkageError) {
        ComposeRead(CompositionStatus.FAILED) // A Compose version without an API used here.
    } catch (e: RuntimeException) {
        ComposeRead(CompositionStatus.FAILED) // e.g. a slot table that cannot be read right now.
    }

    // ViewRootForTest is the public interface through which AndroidComposeView (an internal class) gives its semantics.
    @Suppress("VisibleForTests")
    private fun readOrFail(view: View): ComposeRead {
        val tagId = slotTableSetTag ?: view.resources.getIdentifier(SLOT_TABLE_SET, "id", view.context.packageName)
            .takeIf { it != 0 } ?: return ComposeRead(CompositionStatus.FAILED)
        val tables = view.getTag(tagId) as? Set<*> ?: return ComposeRead(CompositionStatus.DISABLED)
        val owner = view as? ViewRootForTest ?: return ComposeRead(CompositionStatus.FAILED)
        val rootSemantics = owner.semanticsOwner.unmergedRootSemanticsNode
        val screen = IntArray(2).also(view::getLocationOnScreen)
        val window = IntArray(2).also(view::getLocationInWindow)
        val access = LayoutAccess(screen[0] - window[0], screen[1] - window[1])
        val compositions = tables.filterIsInstance<CompositionData>().map { it.compositionGroups }
        val tree = ComposeTreeBuilder(access, budget, filter).build(compositions, rootSemantics.layoutInfo)
        if (!tree.hasSourceInfo && compositions.any { it.any() }) return ComposeRead(CompositionStatus.NO_SOURCE)
        val configs = ComposeSemanticsReader.byLayout(rootSemantics)
        val semantics = IdentityHashMap<ComposeNode, ComposeSemantics>()
        forEachNode(tree.roots) { node ->
            semantics[node] = ComposeSemanticsReader.remembered(node, ComposeSemanticsReader.of(node.layouts, configs))
            node.draws = drawing.of(node.layouts)
        }
        val claimed = claimInteropViews(view, tree, semantics)
        return ComposeRead(CompositionStatus.READ, tree.roots, semantics, claimed, tree.truncated)
    }

    /**
     * AndroidView holders (children of AndroidViewsHandler) move under the composable owning their layout node, if
     * that composable is in the tree ([shown]); else they stay under the handler.
     */
    private fun claimInteropViews(view: View, tree: ComposeTree, shown: Map<ComposeNode, *>): Set<View> {
        val claimed = HashSet<View>()
        val group = view as? ViewGroup ?: return claimed
        for (i in 0 until group.childCount) {
            val handler = group.getChildAt(i) as? ViewGroup ?: continue
            if (handler.javaClass.name != VIEWS_HANDLER) continue
            for (j in 0 until handler.childCount) {
                val holder = handler.getChildAt(j) ?: continue
                val layout = layoutNodeOf(holder) ?: continue
                val owner = tree.ownerOf(layout)?.takeIf { it in shown } ?: continue
                owner.children += holder
                claimed += holder
            }
        }
        return claimed
    }

    private class LayoutAccess(private val dx: Int, private val dy: Int) : SlotTableAccess<CompositionGroup, LayoutInfo> {
        override fun children(group: CompositionGroup): Iterable<CompositionGroup> = group.compositionGroups
        override fun sourceInfo(group: CompositionGroup): String? = group.sourceInfo
        override fun layoutNode(group: CompositionGroup): LayoutInfo? = group.node as? LayoutInfo
        override fun parent(node: LayoutInfo): LayoutInfo? = node.parentInfo
        /** A node mid-transform can report a non-finite position: it counts as not placed rather than failing the read. */
        override fun isPlaced(node: LayoutInfo): Boolean {
            if (!node.isPlaced || !node.isAttached || !node.coordinates.isAttached) return false
            val box = boxInRoot(node.coordinates)
            return box.left.isFinite() && box.top.isFinite() && box.right.isFinite() && box.bottom.isFinite()
        }

        /**
         * navigation-compose's `NavBackStackEntry.LocalOwnersProvider` is not skippable, so its entry is not in the
         * group's slots: it is captured by the restart lambda of the group's recompose scope (as Compose tooling
         * reads parameters).
         */
        override fun destination(group: CompositionGroup): String? = try {
            group.data.firstNotNullOfOrNull { value ->
                when {
                    value == null -> null
                    value.javaClass.name == NAV_BACK_STACK_ENTRY -> value
                    else -> capturedEntry(value)
                }
            }?.let(NavigationScreens::destinationName)
        } catch (e: LinkageError) {
            null // A Navigation version without an API used here: no destinations, the rest is read.
        } catch (e: RuntimeException) {
            null
        }

        /**
         * The content box (inside the node's padding modifiers), like accessibility and Compose tooling report, as
         * drawn: through any scale or rotation of a graphics layer (the box around its corners), not clipped.
         */
        override fun bounds(node: LayoutInfo): PixelRect {
            val coordinates = node.coordinates
            val box = boxInRoot(coordinates)
            val root = coordinates.findRootCoordinates().positionInWindow()
            return PixelRect(
                (box.left + root.x).roundToInt() + dx,
                (box.top + root.y).roundToInt() + dy,
                (box.right + root.x).roundToInt() + dx,
                (box.bottom + root.y).roundToInt() + dy,
            )
        }

        private fun boxInRoot(coordinates: LayoutCoordinates) =
            coordinates.findRootCoordinates().localBoundingBoxOf(coordinates, false)
    }

    private companion object {
        const val VIEWS_HANDLER = "androidx.compose.ui.platform.AndroidViewsHandler"
        const val NAV_BACK_STACK_ENTRY = "androidx.navigation.NavBackStackEntry"
        const val RECOMPOSE_SCOPE = ".RecomposeScopeImpl"
        const val SCOPE_BLOCK = "block"

        const val SLOT_TABLE_SET = "inspection_slot_table_set"

        /**
         * `androidx.compose.ui.R.id.inspection_slot_table_set` in the app (its R ids are not constants here); when R8
         * removed the R class, the resource is looked up by name instead.
         */
        val slotTableSetTag: Int? by lazy {
            try {
                Class.forName("androidx.compose.ui.R\$id").getField(SLOT_TABLE_SET).getInt(null)
            } catch (e: ReflectiveOperationException) {
                null
            } catch (e: LinkageError) {
                null
            }
        }

        private val layoutNodeGetters = HashMap<Class<*>, Method?>()
        private val capturedFields = HashMap<Class<*>, List<Field>>()

        /** A NavBackStackEntry captured by [scope]'s restart lambda, if [scope] is a recompose scope. */
        fun capturedEntry(scope: Any): Any? {
            if (!scope.javaClass.name.endsWith(RECOMPOSE_SCOPE)) return null
            return try {
                val block = fieldsOf(scope.javaClass).firstOrNull { it.name == SCOPE_BLOCK }?.get(scope) ?: return null
                fieldsOf(block.javaClass).firstNotNullOfOrNull { field ->
                    field.get(block)?.takeIf { it.javaClass.name == NAV_BACK_STACK_ENTRY }
                }
            } catch (e: ReflectiveOperationException) {
                null
            } catch (e: RuntimeException) {
                null
            }
        }

        private fun fieldsOf(type: Class<*>): List<Field> = capturedFields.getOrPut(type) {
            type.declaredFields.filter { !Modifier.isStatic(it.modifiers) }.onEach { it.isAccessible = true }
        }

        fun layoutNodeOf(holder: View): LayoutInfo? {
            val type = holder.javaClass
            val getter = if (layoutNodeGetters.containsKey(type)) {
                layoutNodeGetters[type]
            } else {
                try {
                    type.getMethod("getLayoutNode")
                } catch (e: NoSuchMethodException) {
                    null
                } catch (e: SecurityException) {
                    null
                }.also { layoutNodeGetters[type] = it }
            }
            return try {
                getter?.invoke(holder) as? LayoutInfo
            } catch (e: ReflectiveOperationException) {
                null
            }
        }

        inline fun forEachNode(roots: List<ComposeNode>, action: (ComposeNode) -> Unit) {
            val stack = ArrayList<ComposeNode>(roots)
            while (stack.isNotEmpty()) {
                val node = stack.removeAt(stack.size - 1)
                action(node)
                for (child in node.children) if (child is ComposeNode) stack += child
            }
        }
    }
}

/**
 * A composable's semantics as the Inspector sends them, from Compose's unmerged semantics tree. A password field
 * (password semantics, or a password content type) sends neither its text nor its description; text is capped like
 * a TextView's.
 */
internal object ComposeSemanticsReader {
    private const val CONTENT_TYPE = "ContentType"
    private const val PASSWORD_HINT = "password"

    /** Call sites (`name@file:line`) seen with password semantics, kept for the process: at most this many. */
    private const val MAX_SECRET_SITES = 256
    private val secretSites = HashSet<String>()

    /**
     * [semantics] of [node], kept secret when its call site was a password field before: a "show password" toggle
     * drops the password semantics (a visible password is a password all the same, as for TextViews).
     */
    fun remembered(node: ComposeNode, semantics: ComposeSemantics): ComposeSemantics {
        val file = node.source.file ?: return semantics
        val site = "${node.name}@$file:${node.source.line}"
        if (semantics.secret) {
            if (secretSites.size < MAX_SECRET_SITES) secretSites += site
            return semantics
        }
        if (site !in secretSites) return semantics
        return ComposeSemantics(null, null, semantics.testTag, semantics.enabled, semantics.clickable, semantics.focused,
            semantics.selected, semantics.checked, secret = true)
    }

    /** By name, so a state a later Compose adds reads as unknown instead of failing. */
    private fun checkedOf(state: Any): Boolean? = when (state.toString()) {
        "On" -> true
        "Off" -> false
        else -> null
    }

    /** The unmerged semantics configuration of every layout node that has one. */
    fun byLayout(root: SemanticsNode): Map<Any, SemanticsConfiguration> {
        val configs = IdentityHashMap<Any, SemanticsConfiguration>()
        val stack = arrayListOf(root)
        while (stack.isNotEmpty()) {
            val node = stack.removeAt(stack.size - 1)
            configs[node.layoutInfo] = node.config
            stack.addAll(node.children)
        }
        return configs
    }

    /** A composable's semantics from those of its own [layouts]: the first text, description and tag; any flag. */
    fun of(layouts: List<Any>, configs: Map<Any, SemanticsConfiguration>): ComposeSemantics {
        val own = layouts.mapNotNull { configs[it] }
        if (own.isEmpty()) return ComposeSemantics.NONE
        val secret = own.any(::isSecret)
        return ComposeSemantics(
            text = if (secret) null else own.firstNotNullOfOrNull(::textOf),
            contentDescription = if (secret) null else own.firstNotNullOfOrNull {
                it.getOrNull(SemanticsProperties.ContentDescription)?.joinToString(" ")?.let(InspectorText::raw)
            },
            testTag = own.firstNotNullOfOrNull { it.getOrNull(SemanticsProperties.TestTag) },
            enabled = own.none { SemanticsProperties.Disabled in it },
            clickable = own.any { SemanticsActions.OnClick in it },
            focused = own.any { it.getOrNull(SemanticsProperties.Focused) == true },
            selected = own.any { it.getOrNull(SemanticsProperties.Selected) == true },
            checked = own.firstNotNullOfOrNull { it.getOrNull(SemanticsProperties.ToggleableState) }?.let(::checkedOf),
            secret = secret,
        )
    }

    /** A text field's text as shown (Compose puts the visually transformed text there), else the text. */
    private fun textOf(config: SemanticsConfiguration): String? {
        config.getOrNull(SemanticsProperties.EditableText)?.let { return InspectorText.raw(it.text) }
        val text = config.getOrNull(SemanticsProperties.Text) ?: return null
        return InspectorText.raw(text.joinToString(" ") { it.text })
    }

    /**
     * Password semantics (PasswordVisualTransformation, secure text fields), or a ContentType (Compose 1.8+, not in
     * the API this SDK compiles against: matched by key name) whose autofill hints name a password.
     */
    private fun isSecret(config: SemanticsConfiguration): Boolean {
        if (SemanticsProperties.Password in config) return true
        for ((key, value) in config) {
            if (key.name == CONTENT_TYPE && value != null && contentTypeIsPassword(value)) return true
        }
        return false
    }

    /** Any String in the content type's fields (Android: its autofill hints) that contains "password". */
    private fun contentTypeIsPassword(value: Any): Boolean = try {
        value.javaClass.declaredFields.any { field ->
            field.isAccessible = true
            when (val hints = field.get(value)) {
                is String -> hints.contains(PASSWORD_HINT, ignoreCase = true)
                is Collection<*> -> hints.any { it is String && it.contains(PASSWORD_HINT, ignoreCase = true) }
                is Array<*> -> hints.any { it is String && it.contains(PASSWORD_HINT, ignoreCase = true) }
                else -> false
            }
        }
    } catch (e: ReflectiveOperationException) {
        true // Unreadable: treat as a password rather than risk sending one.
    } catch (e: RuntimeException) {
        true
    }
}
