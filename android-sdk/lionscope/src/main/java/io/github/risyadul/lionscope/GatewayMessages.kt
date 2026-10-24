package io.github.risyadul.lionscope

/** Server → SDK line, parsed just enough to react to `welcome` / `bye` / `config` / `inspect`. */
internal sealed class GatewayMessage {
    /**
     * [protocolVersion] is the server's negotiated version as sent (1 when it is missing or not an integer).
     * [inspectOnly] is v5's `mode: "inspect"`; a missing or unknown mode is a profiling session.
     */
    class Welcome(val protocolVersion: Int, val inspectOnly: Boolean = false) : GatewayMessage()
    class Bye(val reason: String) : GatewayMessage()

    /** v2: the session's SDK options, already normalised (see [parseConfig]). */
    class Config(val options: SdkOptions) : GatewayMessage()

    /** v4: take an Inspector snapshot now and answer with [requestId]. */
    class Inspect(val requestId: Int) : GatewayMessage()

    companion object {
        private val TYPE = Regex("\"type\"\\s*:\\s*\"([A-Za-z_]+)\"")
        private val REASON = Regex("\"reason\"\\s*:\\s*\"([A-Za-z_]+)\"")
        /** A JSON integer only: `2.5`, `1e3` or `"2"` do not match. */
        private val PROTOCOL_VERSION = Regex("\"protocolVersion\"\\s*:\\s*(-?\\d+)(?![\\d.eE])")
        private val MODE = Regex("\"mode\"\\s*:\\s*\"([A-Za-z_]+)\"")
        private val STALL_THRESHOLD = Regex("\"stallThresholdMs\"\\s*:\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)")
        private val STRICT_MODE = Regex("\"strictMode\"\\s*:\\s*(true|false)(?![A-Za-z0-9_])")
        private val INFLATE_TRACKING = Regex("\"inflateTracking\"\\s*:\\s*(true|false)(?![A-Za-z0-9_])")
        /** A non-negative JSON integer that fits an Int. */
        private val REQUEST_ID = Regex("\"requestId\"\\s*:\\s*(\\d{1,10})(?![\\d.eE])")

        /**
         * Returns null for unknown or malformed lines; unknown fields are ignored. A top-level scan, not a JSON
         * parser: it relies on the server contract in protocol/src/wire.ts (`GatewayMessage`) that each line is a
         * flat object serialised with `type` first and no nested `type` / `protocolVersion` / `mode` keys. A welcome without
         * an integer `protocolVersion` means version 1; out-of-range values are passed on for [DeviceLink] to clamp. An
         * `inspect` without a valid `requestId` (a non-negative Int) is dropped.
         */
        fun parse(line: String): GatewayMessage? = when (TYPE.find(line)?.groupValues?.get(1)) {
            "welcome" -> Welcome(
                PROTOCOL_VERSION.find(line)?.groupValues?.get(1)?.toIntOrNull() ?: MIN_DEVICE_PROTOCOL_VERSION,
                MODE.find(line)?.groupValues?.get(1) == "inspect",
            )
            "bye" -> Bye(REASON.find(line)?.groupValues?.get(1) ?: "unknown")
            "config" -> Config(parseConfig(line))
            "inspect" -> REQUEST_ID.find(line)?.groupValues?.get(1)?.toIntOrNull()?.let(::Inspect)
            else -> null
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
