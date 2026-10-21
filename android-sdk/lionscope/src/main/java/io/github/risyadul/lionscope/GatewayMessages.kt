package io.github.risyadul.lionscope

/** Server → SDK line, parsed just enough to react to `welcome` / `bye`. */
internal sealed class GatewayMessage {
    object Welcome : GatewayMessage()
    class Bye(val reason: String) : GatewayMessage()

    companion object {
        private val TYPE = Regex("\"type\"\\s*:\\s*\"([A-Za-z_]+)\"")
        private val REASON = Regex("\"reason\"\\s*:\\s*\"([A-Za-z_]+)\"")

        /** Returns null for unknown or malformed lines. */
        fun parse(line: String): GatewayMessage? = when (TYPE.find(line)?.groupValues?.get(1)) {
            "welcome" -> Welcome
            "bye" -> Bye(REASON.find(line)?.groupValues?.get(1) ?: "unknown")
            else -> null
        }
    }
}
