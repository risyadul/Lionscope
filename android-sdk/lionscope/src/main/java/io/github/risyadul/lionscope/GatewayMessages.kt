package io.github.risyadul.lionscope

/** Server → SDK line, parsed just enough to react to `welcome` / `bye` / `config` / `inspect` / `mocks` / `mock`. */
internal sealed class GatewayMessage {
    /**
     * [protocolVersion] is the server's negotiated version as sent (1 when it is missing or not an integer).
     * [inspectOnly] is v5's `mode: "inspect"`; a missing or unknown mode is a profiling session. [proof] is v7's link
     * proof (64 lower-case hex digits, else null; see [LinkProof]).
     */
    class Welcome(val protocolVersion: Int, val inspectOnly: Boolean = false, val proof: String? = null) : GatewayMessage()
    class Bye(val reason: String) : GatewayMessage()

    /** v2: the session's SDK options, already normalised (see [parseConfig]). */
    class Config(val options: SdkOptions) : GatewayMessage()

    /** v4: take an Inspector snapshot now and answer with [requestId]. */
    class Inspect(val requestId: Int) : GatewayMessage()

    /** v7: a rule set [rev] with [count] rules follows (0 = none); see [MockSetAssembler]. */
    class Mocks(val rev: Int, val count: Int) : GatewayMessage()

    /** v7: rule [index] of set [rev]. */
    class Mock(val rev: Int, val index: Int, val rule: MockRule) : GatewayMessage()

    companion object {
        private const val ANY_METHOD = "*"
        private const val MIN_MOCK_STATUS = 100
        private const val MAX_MOCK_STATUS = 599
        private val TYPE = Regex("\"type\"\\s*:\\s*\"([A-Za-z_]+)\"")
        private val REASON = Regex("\"reason\"\\s*:\\s*\"([A-Za-z_]+)\"")
        /** A JSON integer only: `2.5`, `1e3` or `"2"` do not match. */
        private val PROTOCOL_VERSION = Regex("\"protocolVersion\"\\s*:\\s*(-?\\d+)(?![\\d.eE])")
        private val MODE = Regex("\"mode\"\\s*:\\s*\"([A-Za-z_]+)\"")
        private val PROOF = Regex("\"proof\"\\s*:\\s*\"([0-9a-f]{64})\"")
        private val STALL_THRESHOLD = Regex("\"stallThresholdMs\"\\s*:\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)")
        private val STRICT_MODE = Regex("\"strictMode\"\\s*:\\s*(true|false)(?![A-Za-z0-9_])")
        private val INFLATE_TRACKING = Regex("\"inflateTracking\"\\s*:\\s*(true|false)(?![A-Za-z0-9_])")
        /** A non-negative JSON integer that fits an Int. */
        private val REQUEST_ID = Regex("\"requestId\"\\s*:\\s*(\\d{1,10})(?![\\d.eE])")

        /**
         * Returns null for unknown or malformed lines; unknown fields are ignored. A top-level scan, not a JSON
         * parser: it relies on the server contract in protocol/src/wire.ts (`GatewayMessage`) that each line is a
         * flat object serialised with `type` first and no nested `type` / `protocolVersion` / `mode` / `proof` keys (the v7 `mocks` /
         * `mock` lines, whose strings may hold any text, are read with [FlatJson] instead). A welcome without
         * an integer `protocolVersion` means version 1; out-of-range values are passed on for [DeviceLink] to clamp. An
         * `inspect` without a valid `requestId` (a non-negative Int) is dropped.
         */
        fun parse(line: String): GatewayMessage? = when (TYPE.find(line)?.groupValues?.get(1)) {
            "welcome" -> Welcome(
                PROTOCOL_VERSION.find(line)?.groupValues?.get(1)?.toIntOrNull() ?: MIN_DEVICE_PROTOCOL_VERSION,
                MODE.find(line)?.groupValues?.get(1) == "inspect",
                PROOF.find(line)?.groupValues?.get(1),
            )
            "bye" -> Bye(REASON.find(line)?.groupValues?.get(1) ?: "unknown")
            "config" -> Config(parseConfig(line))
            "inspect" -> REQUEST_ID.find(line)?.groupValues?.get(1)?.toIntOrNull()?.let(::Inspect)
            "mocks" -> FlatJson.parse(line)?.takeIf { it.string("type") == "mocks" }?.let(::parseMocks)
            "mock" -> FlatJson.parse(line)?.takeIf { it.string("type") == "mock" }?.let(::parseMock)
            else -> null
        }

        /** A `mocks` line needs integer `rev` (≥ 0) and `count`; a count out of range is passed on (it clears). */
        private fun parseMocks(json: FlatJson): Mocks? {
            val rev = json.int("rev")?.takeIf { it >= 0 } ?: return null
            val count = json.int("count") ?: return null
            return Mocks(rev, count)
        }

        /**
         * A `mock` line with every field of the wire type, or null: unknown `match` / `action`, malformed base64 or a
         * missing field drop the line (its set then never completes, and the active set stays). `method` `*` = any.
         */
        private fun parseMock(json: FlatJson): Mock? {
            val rev = json.int("rev")?.takeIf { it >= 0 } ?: return null
            val index = json.int("index")?.takeIf { it >= 0 } ?: return null
            val id = json.string("id")?.takeIf { it.isNotEmpty() } ?: return null
            val method = json.string("method")?.takeIf { it.isNotEmpty() } ?: return null
            val match = MockMatch.values().firstOrNull { it.wire == json.string("match") } ?: return null
            val url = json.string("url")?.takeIf { it.isNotEmpty() } ?: return null
            val action = MockAction.values().firstOrNull { it.wire == json.string("action") } ?: return null
            val status = json.int("status") ?: return null
            val headers = json.string("headers") ?: return null
            val body = json.string("bodyBase64")?.let(MockWire::base64) ?: return null
            val delayMs = json.int("delayMs") ?: return null
            if (action == MockAction.RESPOND && status !in MIN_MOCK_STATUS..MAX_MOCK_STATUS) return null
            val rule = MockRule(
                id = id,
                method = if (method == ANY_METHOD) null else method,
                match = match,
                url = url,
                action = action,
                status = status,
                headers = MockWire.headers(headers),
                body = body,
                delayMs = delayMs.coerceIn(0, MAX_MOCK_DELAY_MS),
            )
            return Mock(rev, index, rule)
        }

        /**
         * A missing or non-numeric threshold is the default; any other number snaps to the nearest allowed value
         * (the lower one on a tie). `strictMode` is on only for a literal `true`; `inflateTracking` (v3) is off only for
         * a literal `false`, so a v2 server that never sends it leaves it on.
         */
        private fun parseConfig(line: String): SdkOptions {
            val threshold = STALL_THRESHOLD.find(line)?.groupValues?.get(1)?.toDoubleOrNull()
                ?.takeIf { !it.isNaN() && !it.isInfinite() }
                ?.let { value -> STALL_THRESHOLDS_MS.minByOrNull { Math.abs(it - value) } }
                ?: SdkOptions.DEFAULT.stallThresholdMs
            val strictMode = STRICT_MODE.find(line)?.groupValues?.get(1) == "true"
            val inflateTracking = INFLATE_TRACKING.find(line)?.groupValues?.get(1) != "false"
            return SdkOptions(threshold, strictMode, inflateTracking)
        }
    }
}
