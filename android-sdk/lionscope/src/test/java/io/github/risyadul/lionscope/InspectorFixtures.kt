package io.github.risyadul.lionscope

/** Decoding of Inspector wire objects (parsed by [TestJson]) back into SDK types. */
internal object InspectorFixtures {
    fun rect(value: Any?): PixelRect? = (value as List<*>?)?.map { (it as Double).toInt() }?.let { PixelRect(it[0], it[1], it[2], it[3]) }

    fun node(json: Map<*, *>): InspectorNode = InspectorNode(
        id = (json["id"] as Double).toInt(),
        parent = (json["parent"] as Double?)?.toInt(),
        window = (json["window"] as Double).toInt(),
        className = json["className"] as String,
        resourceId = json["resourceId"] as String?,
        text = json["text"] as String?,
        contentDescription = json["contentDescription"] as String?,
        bounds = rect(json["bounds"])!!,
        visibleBounds = rect(json["visibleBounds"]),
        visibility = ViewVisibility.values().single { it.wire == json["visibility"] },
        alpha = json["alpha"] as Double?,
        enabled = json["enabled"] as Boolean,
        clickable = json["clickable"] as Boolean,
        focused = json["focused"] as Boolean,
        selected = json["selected"] as Boolean,
        checked = json["checked"] as Boolean?,
        padding = rect(json["padding"]),
        margin = rect(json["margin"]),
        layoutWidth = json["layoutWidth"] as String?,
        layoutHeight = json["layoutHeight"] as String?,
        source = (json["source"] as Map<*, *>?)?.let { ViewSource(it["layout"] as String, (it["line"] as Double).toInt()) },
        fragment = json["fragment"] as String?,
        activity = json["activity"] as String?,
        composable = (json["composable"] as Map<*, *>?)?.let {
            ComposableSource(it["file"] as String?, (it["line"] as Double?)?.toInt(), it["draws"] as Boolean?)
        },
        composition = json["composition"]?.let { wire -> CompositionStatus.values().single { it.wire == wire } },
        destination = json["destination"] as String?,
    )

    fun window(json: Map<*, *>): InspectorWindow =
        InspectorWindow((json["id"] as Double).toInt(), (json["type"] as Double?)?.toInt(), rect(json["bounds"])!!)

    /** A plain visible node with the given place in the tree; everything else as a simple view would have it. */
    fun plainNode(id: Int, parent: Int?, className: String = "android.widget.FrameLayout", text: String? = null) = InspectorNode(
        id = id,
        parent = parent,
        window = 0,
        className = className,
        resourceId = null,
        text = text,
        contentDescription = null,
        bounds = PixelRect(0, 0, 100, 100),
        visibleBounds = PixelRect(0, 0, 100, 100),
        visibility = ViewVisibility.VISIBLE,
        alpha = 1.0,
        enabled = true,
        clickable = false,
        focused = false,
        selected = false,
        checked = null,
        padding = PixelRect(0, 0, 0, 0),
        margin = null,
        layoutWidth = "match_parent",
        layoutHeight = "wrap_content",
        source = null,
        fragment = null,
        activity = null,
    )
}
