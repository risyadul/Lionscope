package io.github.risyadul.lionscope

/** Server → SDK line, parsed just enough to react to `welcome` / `bye`. */
internal sealed class GatewayMessage {
    /** [protocolVersion] is the server's negotiated version as sent (1 when it is missing or not an integer). */
    class Welcome(val protocolVersion: Int) : GatewayMessage()
    class Bye(val reason: String) : GatewayMessage()

    companion object {
        private val TYPE = Regex("\"type\"\\s*:\\s*\"([A-Za-z_]+)\"")
        private val REASON = Regex("\"reason\"\\s*:\\s*\"([A-Za-z_]+)\"")
        /** A JSON integer only: `2.5`, `1e3` or `"2"` do not match. */
        private val PROTOCOL_VERSION = Regex("\"protocolVersion\"\\s*:\\s*(-?\\d+)(?![\\d.eE])")

        /**
         * Returns null for unknown or malformed lines; unknown fields are ignored. A top-level scan, not a JSON
         * parser: it relies on the server contract in protocol/src/wire.ts (`GatewayMessage`) that each line is a
         * flat object serialised with `type` first and no nested `type` / `protocolVersion` keys. A welcome without
         * an integer `protocolVersion` means version 1; out-of-range values are passed on for [DeviceLink] to clamp.
         */
        fun parse(line: String): GatewayMessage? = when (TYPE.find(line)?.groupValues?.get(1)) {
            "welcome" -> Welcome(
                PROTOCOL_VERSION.find(line)?.groupValues?.get(1)?.toIntOrNull() ?: MIN_DEVICE_PROTOCOL_VERSION,
            )
            "bye" -> Bye(REASON.find(line)?.groupValues?.get(1) ?: "unknown")
            else -> null
        }
    }
}
