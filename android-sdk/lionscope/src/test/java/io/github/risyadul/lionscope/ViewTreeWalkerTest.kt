package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Test

class ViewTreeWalkerTest {

    private class Node(val className: String, val id: String? = null, val group: Boolean = false) {
        var parent: Node? = null
        val children = ArrayList<Node>()

        fun add(vararg nodes: Node): Node = apply {
            for (node in nodes) {
                node.parent = this
                children += node
            }
        }
    }

    private object Access : TreeAccess<Node> {
        override fun childCount(node: Node) = node.children.size
        override fun childAt(node: Node, index: Int) = node.children[index]
        override fun parentOf(node: Node) = node.parent
        override fun isGroup(node: Node) = node.group
        override fun className(node: Node) = node.className
        override fun idName(node: Node) = node.id
    }

    private fun group(className: String, id: String? = null) = Node(className, id, group = true)

    @Test
    fun countsViewsGroupsDepthTheDeepestPathAndTopClasses() {
        val title = Node("MaterialTextView", "title")
        val decor = group("DecorView").add(
            group("LinearLayout").add(
                group("FrameLayout", "content").add(
                    group("ConstraintLayout", "root").add(
                        title,
                        Node("MaterialTextView", "subtitle"), // Same depth, later: the first one wins.
                        Node("AppCompatImageView"),
                    ),
                ),
            ),
            Node("View", "statusBarBackground"),
        )

        val stats = ViewTreeWalker.walk(decor, Access)
        assertEquals(8, stats.views)
        assertEquals(4, stats.viewGroups)
        assertEquals(5, stats.maxDepth)
        assertEquals(
            listOf(
                ViewPathNode("DecorView", null),
                ViewPathNode("LinearLayout", null),
                ViewPathNode("FrameLayout", "content"),
                ViewPathNode("ConstraintLayout", "root"),
                ViewPathNode("MaterialTextView", "title"),
            ),
            stats.deepestPath,
        )
        // Most frequent first, ties by name.
        assertEquals(ClassCount("MaterialTextView", 2), stats.topClasses.first())
        assertEquals(listOf("AppCompatImageView", "ConstraintLayout"), stats.topClasses.drop(1).take(2).map { it.className })
        assertEquals(7, stats.topClasses.size)
    }

    @Test
    fun aDeepChainKeepsTheDeepestNodesWithoutRecursion() {
        val root = group("Root")
        var current = root
        repeat(5_000) { // Far deeper than a recursive walk would survive.
            val next = group("Level")
            current.add(next)
            current = next
        }
        current.add(Node("Leaf", "leaf"))

        val stats = ViewTreeWalker.walk(root, Access)
        assertEquals(5_002, stats.views)
        assertEquals(5_002, stats.maxDepth)
        assertEquals(MAX_VIEW_PATH_NODES, stats.deepestPath.size)
        assertEquals(ViewPathNode("Leaf", "leaf"), stats.deepestPath.last())
        assertEquals("Level", stats.deepestPath.first().className) // Cut at the root end.
    }

    @Test
    fun theWalkIsCappedAndAtMostTenClassesAreListed() {
        val root = group("Root")
        repeat(30) { i -> root.add(Node("Widget${i % 15}")) }

        val capped = ViewTreeWalker.walk(root, Access, maxViews = 10)
        assertEquals(10, capped.views)

        val stats = ViewTreeWalker.walk(root, Access)
        assertEquals(31, stats.views)
        assertEquals(MAX_VIEW_TREE_CLASSES, stats.topClasses.size)
        assertEquals(ClassCount("Widget0", 2), stats.topClasses.first())
    }
}
