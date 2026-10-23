package io.github.risyadul.lionscope

/** A fake view for [InspectorWalker]: [bounds] on screen, [children] in drawing order. */
internal class FakeView(
    val name: String,
    val bounds: PixelRect = PixelRect(0, 0, 100, 100),
    val visibility: ViewVisibility = ViewVisibility.VISIBLE,
    val className: String = "android.widget.FrameLayout",
    val text: String? = null,
    val children: List<FakeView> = emptyList(),
)

internal class FakeTreeAccess(private val fragmentRoots: Map<FakeView, String> = emptyMap()) : InspectorTreeAccess<FakeView> {
    var reads = 0

    override fun children(node: FakeView): List<FakeView> = node.children
    override fun className(node: FakeView): String = node.className
    override fun fragmentRootOf(node: FakeView): String? = fragmentRoots[node]

    override fun read(node: FakeView): NodeAttributes {
        reads++
        return NodeAttributes(
            className = node.className,
            resourceId = node.name,
            text = node.text,
            contentDescription = null,
            bounds = node.bounds,
            visibility = node.visibility,
            alpha = 1.0,
            enabled = true,
            clickable = false,
            focused = false,
            selected = false,
            checked = null,
            padding = PixelRect(0, 0, 0, 0),
            margin = null,
            layoutWidth = "match_parent",
            layoutHeight = "match_parent",
            source = null,
        )
    }
}

internal fun fakeWindow(root: FakeView, type: Int? = 1, activity: String? = "com.example.shop.ui.MainActivity") =
    WindowRoot(root, type, root.bounds, activity)
