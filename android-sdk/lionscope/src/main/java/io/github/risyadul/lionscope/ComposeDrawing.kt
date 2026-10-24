package io.github.risyadul.lionscope

import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.DrawModifier
import androidx.compose.ui.node.DelegatingNode
import androidx.compose.ui.node.DrawModifierNode
import java.lang.reflect.Field
import java.lang.reflect.Method

// Links against Compose (compileOnly): only loaded by ComposeViewReader.

/**
 * Whether a composable's own layout nodes paint anything (its shown children don't count): a draw modifier node in
 * their modifier chains, as `background`, `border`, `paint`, `drawBehind`/`drawWithContent`/`drawWithCache`, text and
 * images have, directly or through a delegate, or a graphics layer with a shadow. Size, padding, click, semantics and
 * plain layers paint nothing, and neither do indications (a ripple draws only while pressed). Read from the live
 * modifier nodes through four private fields, the same in Compose 1.6 to 1.12 (`LayoutNode.nodes`, `NodeChain.head`,
 * `Modifier.Node.child`, `DelegatingNode.delegate`); null whenever that fails or a node cannot be classified (a layer
 * set by a lambda may draw a shadow), so the dashboard is never told "nothing" by a guess. Main thread, one instance
 * per process.
 */
internal class ComposeDrawing {
    private enum class Kind { PAINTS, NONE, INDICATION, COMPAT, LAYER, UNKNOWN }

    private val kinds = HashMap<Class<*>, Kind>()
    private var shadowGetter: Method? = null

    /** True when any of [layouts] paints, false when none does, null when unsure. */
    fun of(layouts: List<Any>): Boolean? {
        val fields = fields ?: return null
        var unsure = false
        var visited = 0
        val stack = ArrayList<Modifier.Node>()
        try {
            for (layout in layouts) {
                val chain = fields.nodes.get(layout) ?: return null
                var node = fields.head.get(chain) as Modifier.Node?
                while (node != null) {
                    stack += node
                    node = fields.child.get(node) as Modifier.Node?
                }
                while (stack.isNotEmpty()) {
                    if (++visited > MAX_NODES) return null
                    val modifier = stack.removeAt(stack.size - 1)
                    when (paints(modifier, fields)) {
                        true -> return true
                        null -> unsure = true
                        false -> Unit
                    }
                    if (modifier !is DelegatingNode || kindOf(modifier) == Kind.INDICATION) continue
                    var delegate = fields.delegate.get(modifier) as Modifier.Node?
                    while (delegate != null) {
                        stack += delegate
                        delegate = fields.child.get(delegate) as Modifier.Node?
                    }
                }
            }
        } catch (e: ReflectiveOperationException) {
            return null
        } catch (e: RuntimeException) {
            return null // e.g. a field of another type in a later Compose.
        } catch (e: LinkageError) {
            return null
        }
        return if (unsure) null else false
    }

    /** Whether [node] itself paints (not its delegates). */
    private fun paints(node: Modifier.Node, fields: Fields): Boolean? = when (kindOf(node)) {
        Kind.PAINTS -> true
        Kind.NONE, Kind.INDICATION -> false
        Kind.UNKNOWN -> null
        // A pre-node Modifier.Element (wrapped in a node that implements every node interface).
        Kind.COMPAT -> when (val element = fields.element.get(node)) {
            is DrawModifier -> !isIndication(element.javaClass)
            null -> null
            else -> false
        }
        Kind.LAYER -> shadowOf(node)?.let { it > 0f }
    }

    private fun kindOf(node: Modifier.Node): Kind = kinds.getOrPut(node.javaClass) {
        val type = node.javaClass
        when {
            type.name == BACKWARDS_COMPAT_NODE -> Kind.COMPAT
            isIndication(type) -> Kind.INDICATION
            node is DrawModifierNode -> Kind.PAINTS
            type.name == SIMPLE_LAYER -> Kind.LAYER
            type.name == BLOCK_LAYER -> Kind.UNKNOWN // Its shadow is set by a lambda.
            else -> Kind.NONE
        }
    }

    /** The shadow elevation of a `graphicsLayer(...)` node (its class is not public), null when it cannot be read. */
    private fun shadowOf(node: Modifier.Node): Float? {
        val getter = shadowGetter
            ?: node.javaClass.getMethod(SHADOW_GETTER).apply { isAccessible = true }.also { shadowGetter = it }
        return (getter.invoke(node) as? Float)?.takeUnless { it.isNaN() }
    }

    private class Fields(val nodes: Field, val head: Field, val child: Field, val delegate: Field, val element: Field)

    private companion object {
        /** Modifier nodes read per composable (with delegates) before giving up: a chain is a few dozen at most. */
        const val MAX_NODES = 512

        const val LAYOUT_NODE = "androidx.compose.ui.node.LayoutNode"
        const val NODE_CHAIN = "androidx.compose.ui.node.NodeChain"
        const val BACKWARDS_COMPAT_NODE = "androidx.compose.ui.node.BackwardsCompatNode"
        const val SIMPLE_LAYER = "androidx.compose.ui.graphics.SimpleGraphicsLayerModifier"
        const val BLOCK_LAYER = "androidx.compose.ui.graphics.BlockGraphicsLayerModifier"
        const val SHADOW_GETTER = "getShadowElevation"
        const val COMPOSE_PACKAGE = "androidx.compose."

        val fields: Fields? by lazy {
            try {
                Fields(
                    nodes = declared(LAYOUT_NODE, "nodes"),
                    head = declared(NODE_CHAIN, "head"),
                    child = Modifier.Node::class.java.getDeclaredField("child").apply { isAccessible = true },
                    delegate = DelegatingNode::class.java.getDeclaredField("delegate").apply { isAccessible = true },
                    element = declared(BACKWARDS_COMPAT_NODE, "element"),
                )
            } catch (e: ReflectiveOperationException) {
                null
            } catch (e: RuntimeException) {
                null
            } catch (e: LinkageError) {
                null
            }
        }

        fun declared(className: String, name: String): Field =
            Class.forName(className, false, ComposeDrawing::class.java.classLoader).getDeclaredField(name)
                .apply { isAccessible = true }

        /** Compose's ripples and indications (foundation, material, material3): they draw only during interaction. */
        fun isIndication(type: Class<*>): Boolean {
            if (!type.name.startsWith(COMPOSE_PACKAGE)) return false
            val simple = type.name.substringAfterLast('.')
            return simple.contains("Ripple") || simple.contains("Indication")
        }
    }
}
