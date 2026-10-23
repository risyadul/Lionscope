package io.github.risyadul.lionscope

// Mirrors protocol/src/wire.ts, section "In-app SDK ↔ server (device gateway)".

/** Highest device protocol version this SDK speaks, sent in `hello`; the server answers min(sdk, server). */
internal const val DEVICE_PROTOCOL_VERSION = 8
internal const val MIN_DEVICE_PROTOCOL_VERSION = 1
/** First version with `stall` / `strictmode` (SDK → server) and `config` (server → SDK). */
internal const val DEVICE_PROTOCOL_V2 = 2
/** First version with `inflate` / `viewtree` (SDK → server) and `config.inflateTracking`. */
internal const val DEVICE_PROTOCOL_V3 = 3
/** First version with `inspect` (server → SDK) and `inspectBegin` / `inspectNodes` / `inspectError`. */
internal const val DEVICE_PROTOCOL_V4 = 4
/** First version with `welcome.mode`: `inspect` links run only screens, heartbeat and the Inspector. */
internal const val DEVICE_PROTOCOL_V5 = 5
/**
 * First version with Compose in Inspector snapshots (composables under AndroidComposeView, `composable`,
 * `composition`, `destination`) and `screen.kind` `destination`, on session and inspect links alike.
 */
internal const val DEVICE_PROTOCOL_V6 = 6
/**
 * First version with the network inspector (session links only): `httpRequest` / `httpResponse` / `mocksApplied`
 * (SDK → server) and `mocks` / `mock` (server → SDK).
 */
internal const val DEVICE_PROTOCOL_V7 = 7
/**
 * v7 link proof (protocol/src/wire.ts, `LINK_KEY_RECEIVER`): the server hands a [LINK_KEY_BYTES] key to
 * [LinkKeyReceiver] over adb, and its welcome carries hex(HMAC-SHA256(key, `<nonce>:<protocolVersion>:<mode>`)) over
 * the hello's [LINK_NONCE_BYTES] nonce. Network capture and mocks, and (v8) live view edits, need a matching proof;
 * nothing else does.
 */
internal const val LINK_KEY_BYTES = 32
internal const val LINK_NONCE_BYTES = 16
/**
 * First version with live view edits: `view` on Inspector View nodes, `inspectBegin.liveEdits`, `setViewProperty` /
 * `revertViewProperties` (server → SDK) and `viewPropertyResult`.
 */
internal const val DEVICE_PROTOCOL_V8 = 8
internal const val DEVICE_LINK_PORT = 8700
internal const val MAX_DEVICE_LINE_BYTES = 64 * 1024
/** Max bytes of one `httpRequest` / `httpResponse` line on a v7 link; every other line keeps [MAX_DEVICE_LINE_BYTES]. */
internal const val MAX_HTTP_LINE_BYTES = 256 * 1024
/** Max bytes of one server → SDK line (a `mock` with a 256 KB body in base64); longer lines are skipped. */
internal const val MAX_GATEWAY_LINE_BYTES = 512 * 1024
internal const val MAX_SDK_FRAMES_PER_BATCH = 256
/** Max frames per captured stack (innermost first); longer stacks are cut and flagged `truncated`. */
internal const val MAX_STACK_FRAMES = 64
/** `viewtree.deepestPath` keeps at most this many nodes (cut at the root end). */
internal const val MAX_VIEW_PATH_NODES = 64
/** `viewtree.topClasses` lists at most this many classes. */
internal const val MAX_VIEW_TREE_CLASSES = 10
/** Max serialized bytes of one `inspectNodes` line. */
internal const val MAX_INSPECT_CHUNK_BYTES = 32 * 1024
/** An Inspector snapshot keeps at most this many nodes (the deepest are dropped first). */
internal const val MAX_INSPECTOR_NODES = 5000
/** The server fails an answer (`inspectBegin` and its chunks) larger than this (`too_large`). */
internal const val MAX_INSPECT_ANSWER_BYTES = 8 * 1024 * 1024
/** The server accepts at most this many windows per snapshot. */
internal const val MAX_INSPECTOR_WINDOWS = 32
/** Live edits (one per view and property) an app process keeps at most; a further one is refused (`limit`). */
internal const val MAX_LIVE_EDITS = 256

/** Allowed watchdog thresholds; `config` values outside this set snap to the nearest one. */
internal val STALL_THRESHOLDS_MS = longArrayOf(100, 150, 250, 500, 1000)

internal enum class ScreenKind(val wire: String) {
    ACTIVITY("activity"),
    FRAGMENT("fragment"),
    DIALOG("dialog"),

    /** A navigation-compose destination (v6; sent as `fragment` to older servers). */
    DESTINATION("destination"),
}

internal data class ScreenRef(val name: String, val className: String, val kind: ScreenKind)

/** One FrameMetrics frame, durations in ms. */
internal class SdkFrame(
    val ts: Long,
    val totalMs: Double,
    val inputMs: Double,
    val animationMs: Double,
    val layoutMs: Double,
    val drawMs: Double,
    val syncMs: Double,
    val commandMs: Double,
    val swapMs: Double,
    val delayMs: Double,
    val gpuMs: Double?,
    val deadlineMs: Double?,
    val firstDraw: Boolean,
)

/**
 * Per-session options pushed by the server in `config`; [DEFAULT] until the first one arrives. [inflateTracking] is
 * v3 (a v2 server never sends it: on).
 */
internal data class SdkOptions(val stallThresholdMs: Long, val strictMode: Boolean, val inflateTracking: Boolean = true) {
    companion object {
        val DEFAULT = SdkOptions(stallThresholdMs = 150, strictMode = false, inflateTracking = true)
    }
}

internal enum class StrictModePolicy(val wire: String) {
    THREAD("thread"),
    VM("vm"),
}

/** One `StackTraceElement` as sent: [line] is null when unknown, -2 for native methods. */
internal data class StackFrame(
    val className: String,
    val method: String,
    val file: String?,
    val line: Int?,
    val inApp: Boolean,
)

/** One step of a view tree's deepest path: simple class name and id entry name (null without an id). */
internal data class ViewPathNode(val className: String, val id: String?)

internal data class ClassCount(val className: String, val count: Int)

/** [left, top, right, bottom] in screen pixels (or a padding / margin per side). */
internal data class PixelRect(val left: Int, val top: Int, val right: Int, val bottom: Int)

internal data class InspectorDisplay(val width: Int, val height: Int, val rotation: Int)

/** [type] is `WindowManager.LayoutParams.type`, null when unknown. */
internal data class InspectorWindow(val id: Int, val type: Int?, val bounds: PixelRect)

/** The XML layout entry name and the line where the view's start tag ends. */
internal data class ViewSource(val layout: String, val line: Int)

/**
 * Where a composable was called: the Kotlin file name and 1-based line, each null when the compiler recorded none;
 * [draws]: whether its own layout nodes paint anything (not its children), null when unknown.
 */
internal data class ComposableSource(val file: String?, val line: Int?, val draws: Boolean? = null)

/**
 * Whether an AndroidComposeView's composition was read (v6): [READ] its composables are its children; [DISABLED] it
 * was composed before Lionscope enabled Compose inspection (installed late, or the app opted out); [NO_SOURCE] it
 * has no source information (compiled without it); [FAILED] reading it threw.
 */
internal enum class CompositionStatus(val wire: String) {
    READ("read"),
    DISABLED("disabled"),
    NO_SOURCE("no_source"),
    FAILED("failed"),
}

internal enum class ViewVisibility(val wire: String) {
    VISIBLE("visible"),
    INVISIBLE("invisible"),
    GONE("gone"),
}

/**
 * One view or composable of an Inspector snapshot; see `InspectorNode` in protocol/src/wire.ts. Text is cleaned when
 * encoded. A composable has [composable] set, its name as [className], its testTag as [resourceId] and no alpha,
 * padding or layout params; [composition] is only set on AndroidComposeView nodes, [destination] only on composables.
 */
internal data class InspectorNode(
    val id: Int,
    val parent: Int?,
    val window: Int,
    val className: String,
    val resourceId: String?,
    val text: String?,
    val contentDescription: String?,
    val bounds: PixelRect,
    val visibleBounds: PixelRect?,
    val visibility: ViewVisibility,
    val alpha: Double?,
    val enabled: Boolean,
    val clickable: Boolean,
    val focused: Boolean,
    val selected: Boolean,
    val checked: Boolean?,
    val padding: PixelRect?,
    val margin: PixelRect?,
    val layoutWidth: String?,
    val layoutHeight: String?,
    val source: ViewSource?,
    val fragment: String?,
    val activity: String?,
    val composable: ComposableSource? = null,
    val composition: CompositionStatus? = null,
    val destination: String? = null,
    val view: ViewState? = null,
)

/** One live-editable View property, as named on the wire (`VIEW_PROPERTIES` in protocol/src/wire.ts, same order). */
internal enum class ViewProperty(val wire: String) {
    VISIBILITY("visibility"),
    ALPHA("alpha"),
    ENABLED("enabled"),
    PADDING_LEFT("paddingLeft"),
    PADDING_TOP("paddingTop"),
    PADDING_RIGHT("paddingRight"),
    PADDING_BOTTOM("paddingBottom"),
    MARGIN_LEFT("marginLeft"),
    MARGIN_TOP("marginTop"),
    MARGIN_RIGHT("marginRight"),
    MARGIN_BOTTOM("marginBottom"),
    LAYOUT_WIDTH("layoutWidth"),
    LAYOUT_HEIGHT("layoutHeight"),
    TRANSLATION_X("translationX"),
    TRANSLATION_Y("translationY"),
    ELEVATION("elevation"),
    BACKGROUND_COLOR("backgroundColor"),
    TEXT("text"),
    TEXT_SIZE("textSize"),
    TEXT_COLOR("textColor"),
    ;

    companion object {
        val PADDING = listOf(PADDING_LEFT, PADDING_TOP, PADDING_RIGHT, PADDING_BOTTOM)
        val MARGIN = listOf(MARGIN_LEFT, MARGIN_TOP, MARGIN_RIGHT, MARGIN_BOTTOM)

        fun of(wire: String): ViewProperty? = values().firstOrNull { it.wire == wire }

        /** A revert's `property`: one property, or the four sides of `padding` / `margin`; null when unknown. */
        fun group(wire: String): List<ViewProperty>? = when (wire) {
            "padding" -> PADDING
            "margin" -> MARGIN
            else -> of(wire)?.let(::listOf)
        }
    }
}

/**
 * What editing a View live needs (v8; `ViewState` in protocol/src/wire.ts): its [key], the values the snapshot has no
 * other field for (px; colors as ARGB ints), and the properties [edited] live and in effect. [textSize] (sp) and
 * [textColor] are null unless it is a TextView.
 */
internal data class ViewState(
    val key: Int,
    val translationX: Double,
    val translationY: Double,
    val elevation: Double,
    val backgroundColor: Int?,
    val textSize: Double?,
    val textColor: Int?,
    val password: Boolean,
    val edited: List<ViewProperty> = emptyList(),
)

/**
 * Why a live edit was refused: [STALE] no view with that key in the latest capture (or it is no longer attached);
 * [UNSUPPORTED] the property does not apply to the view; [PASSWORD] the text of a password field; [INVALID] a value out
 * of bounds; [LIMIT] [MAX_LIVE_EDITS] are in effect; [FAILED] the setter threw; [DISABLED] no editor in this process.
 */
internal enum class EditError(val wire: String) {
    STALE("stale"),
    UNSUPPORTED("unsupported"),
    PASSWORD("password"),
    INVALID("invalid"),
    LIMIT("limit"),
    FAILED("failed"),
    DISABLED("disabled"),
}

/**
 * Why an `inspect` got no snapshot: [BACKGROUND] no Activity of the app is started; [NO_WINDOW] none of its windows is
 * on screen; [DISABLED] the Inspector could not be set up when the SDK was installed (every request still gets this
 * answer, so the server falls back to uiautomator at once); [FAILED] the capture (or its encoding) threw.
 */
internal enum class InspectError(val wire: String) {
    BACKGROUND("background"),
    NO_WINDOW("no_window"),
    DISABLED("disabled"),
    FAILED("failed"),
}

// Network (0.7.0), mirrors protocol/src/wire.ts, section "Network (0.7.0)".

/** What replaces a redacted header value, query parameter value or form field value. */
internal const val HTTP_REDACTED = "‹redacted›"
/** Max UTF-8 bytes of a captured body's text (and of the raw bytes kept for it); longer bodies are cut. */
internal const val MAX_HTTP_BODY_BYTES = 64 * 1024
internal const val MAX_HTTP_URL_CHARS = 4096
internal const val MAX_HTTP_METHOD_CHARS = 16
/** Headers per request or response side; the SDK keeps the first ones that fit [MAX_HTTP_HEADER_BYTES]. */
internal const val MAX_HTTP_HEADERS = 64
internal const val MAX_HTTP_HEADER_NAME_CHARS = 256
internal const val MAX_HTTP_HEADER_VALUE_CHARS = 4096
/** UTF-8 bytes of all header names and values of one side. */
internal const val MAX_HTTP_HEADER_BYTES = 16 * 1024
internal const val MAX_HTTP_CONTENT_TYPE_CHARS = 256
internal const val MAX_HTTP_ERROR_CHARS = 256
/** Exchanges recorded per second at most (a token bucket with [HTTP_EXCHANGE_BURST]); the rest are counted. */
internal const val HTTP_EXCHANGES_PER_SECOND = 20
internal const val HTTP_EXCHANGE_BURST = 50
/** `httpRequest.dropped` at most. */
internal const val MAX_HTTP_DROPPED = 1_000_000
/** `headersMs` / `durationMs` at most (the server's MAX_SDK_DURATION_MS). */
internal const val MAX_HTTP_DURATION_MS = 3_600_000.0
internal const val MAX_NETWORK_MOCKS = 32
/** A rule with a longer url, or a glob with more `*`, never matches (the server never sends one). */
internal const val MAX_MOCK_URL_CHARS = 2048
internal const val MAX_MOCK_GLOB_STARS = 8
internal const val MAX_MOCK_DELAY_MS = 30_000

/**
 * Why a body's text was not captured: [TYPE] not a text type, [STREAMING] SSE / WebSocket upgrade / duplex,
 * [ENCODING] a Content-Encoding the SDK can't decode, [ONE_SHOT] a request body that can be written only once,
 * [ERROR] reading it for the capture failed (the app's call was unaffected).
 */
internal enum class HttpBodyOmission(val wire: String) {
    TYPE("type"),
    STREAMING("streaming"),
    ENCODING("encoding"),
    ONE_SHOT("one_shot"),
    ERROR("error"),
}

/** A body as sent (`HttpBody`): [size] in bytes as the app sent or read it, null when unknown. */
internal data class HttpBody(
    val size: Long?,
    val contentType: String?,
    val text: String?,
    val truncated: Boolean,
    val omitted: HttpBodyOmission?,
)

internal enum class HttpFailureKind(val wire: String) {
    TIMEOUT("timeout"),
    CONNECTION("connection"),
    CANCELED("canceled"),
    IO("io"),
}

/** Why an exchange failed; [message] is `SimpleClassName: message`, cleaned when encoded. */
internal data class HttpFailure(val kind: HttpFailureKind, val message: String?)

internal enum class MockMatch(val wire: String) {
    EXACT("exact"),
    PREFIX("prefix"),
    GLOB("glob"),
}

internal enum class MockAction(val wire: String) {
    RESPOND("respond"),
    TIMEOUT("timeout"),
    CONNECTION_ERROR("connection_error"),
}

/**
 * One mock rule as the server sends it (`mock`): [method] null = any; [headers] in order; [body] the UTF-8 body
 * (respond only); [delayMs] clamped to 0..[MAX_MOCK_DELAY_MS]. Out of bounds ([MAX_MOCK_URL_CHARS],
 * [MAX_MOCK_GLOB_STARS]) it stays in its set but is not [matchable].
 */
internal class MockRule(
    val id: String,
    val method: String?,
    val match: MockMatch,
    val url: String,
    val action: MockAction,
    val status: Int,
    val headers: List<Pair<String, String>>,
    val body: ByteArray,
    val delayMs: Int,
) {
    val matchable: Boolean = url.length <= MAX_MOCK_URL_CHARS &&
        (match != MockMatch.GLOB || url.count { it == '*' } <= MAX_MOCK_GLOB_STARS)
}
