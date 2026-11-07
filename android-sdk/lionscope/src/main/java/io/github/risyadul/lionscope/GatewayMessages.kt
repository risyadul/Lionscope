package io.github.risyadul.lionscope

/** Server → SDK line, parsed just enough to react to `welcome` / `bye` / `config` / `inspect` / `mocks` / `mock` and the v8 edits. */
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
    /** v8: set [property] of the view with [viewKey] to [value] (a String, Double or Boolean, checked by the editor). */
    class SetViewProperty(val requestId: Int, val viewKey: Int, val property: ViewProperty, val value: Any) : GatewayMessage()

    /** v8: revert [properties] (all when null) of [viewKey], or every live edit when [viewKey] is null. */
    class RevertViewProperties(val requestId: Int, val viewKey: Int?, val properties: List<ViewProperty>?) : GatewayMessage()

    /** v11: list the prefs files and registered databases. */
    class StorageList(val requestId: Int) : GatewayMessage()

    /** v11: read a prefs file ([cursor] / [limit]) or a database (schema, or [pages]: a JSON array as text). */
    class StorageRead(
        val requestId: Int,
        val store: String,
        val name: String,
        val cursor: String?,
        val limit: Int?,
        val pages: String?,
    ) : GatewayMessage()

    /** v11: one compare-and-set edit; [pk], [expected] and [value] are JSON texts ([StorageCodec]). */
    class StorageWrite(
        val requestId: Int,
        val opId: String,
        val store: String,
        val name: String,
        val op: String,
        val key: String?,
        val table: String?,
        val column: String?,
        val pk: String?,
        val expected: String?,
        val value: String?,
        val rowDigest: String?,
    ) : GatewayMessage()

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
        private val RX_TRACKING = Regex("\"rxTracking\"\\s*:\\s*(true|false)(?![A-Za-z0-9_])")
        private val STORAGE_CONSENT = Regex("\"storageConsent\"\\s*:\\s*\"([a-z_]+)\"")
        private val OP_ID = Regex("[A-Za-z0-9_-]{1,64}")
        private val SAVED_STATE_TRACKING = Regex("\"savedStateTracking\"\\s*:\\s*(true|false)(?![A-Za-z0-9_])")
        /** A non-negative JSON integer that fits an Int. */
        private val REQUEST_ID = Regex("\"requestId\"\\s*:\\s*(\\d{1,10})(?![\\d.eE])")

        /**
         * Returns null for unknown or malformed lines; unknown fields are ignored. A top-level scan, not a JSON
         * parser: it relies on the server contract in protocol/src/wire.ts (`GatewayMessage`) that each line is a
         * flat object serialised with `type` first and no nested `type` / `protocolVersion` / `mode` / `proof` keys (the v7 `mocks` /
         * `mock` lines, whose strings may hold any text, are read with [FlatJson] instead). A welcome without
         * an integer `protocolVersion` means version 1; out-of-range values are passed on for [DeviceLink] to clamp. An
         * `inspect` without a valid `requestId` (a non-negative Int) is dropped. The v8 edit lines carry app text and are
         * read whole by [FlatJson]; one with an unknown property, a missing value or a bad id is dropped.
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
            "setViewProperty" -> FlatJson.parse(line)?.let(::setViewProperty)
            "revertViewProperties" -> FlatJson.parse(line)?.let(::revertViewProperties)
            "storageList" -> FlatJson.parse(line)?.let(::storageList)
            "storageRead" -> FlatJson.parse(line)?.let(::storageRead)
            "storageWrite" -> FlatJson.parse(line)?.let(::storageWrite)
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

        private fun setViewProperty(fields: FlatJson): SetViewProperty? {
            if (fields.string("type") != "setViewProperty") return null
            val requestId = fields.int("requestId")?.takeIf { it >= 0 } ?: return null
            val viewKey = fields.int("viewKey")?.takeIf { it >= 1 } ?: return null
            val property = fields.string("property")?.let(ViewProperty::of) ?: return null
            val value: Any = fields.string("value") ?: fields.double("value") ?: fields.boolean("value") ?: return null
            return SetViewProperty(requestId, viewKey, property, value)
        }

        /** A `viewKey` or `property` that is there (and not null) must be valid. */
        private fun revertViewProperties(fields: FlatJson): RevertViewProperties? {
            if (fields.string("type") != "revertViewProperties") return null
            val requestId = fields.int("requestId")?.takeIf { it >= 0 } ?: return null
            val viewKey = if (isAbsent(fields, "viewKey")) null else fields.int("viewKey")?.takeIf { it >= 1 } ?: return null
            val properties = if (isAbsent(fields, "property")) {
                null
            } else {
                fields.string("property")?.let(ViewProperty::group) ?: return null
            }
            if (properties != null && viewKey == null) return null
            return RevertViewProperties(requestId, viewKey, properties)
        }

        /** Missing, or JSON null. */
        private fun isAbsent(fields: FlatJson, key: String): Boolean =
            !fields.has(key) || (fields.string(key) == null && fields.double(key) == null && fields.boolean(key) == null)

        /**
         * A missing or non-numeric threshold is the default; any other number snaps to the nearest allowed value
         * (the lower one on a tie). `strictMode` is on only for a literal `true`; `inflateTracking` (v3) is off only for
         * a literal `false`, so a v2 server that never sends it leaves it on; so are `rxTracking` (v9) and
         * `savedStateTracking` (v10).
         */
        private fun parseConfig(line: String): SdkOptions {
            val threshold = STALL_THRESHOLD.find(line)?.groupValues?.get(1)?.toDoubleOrNull()
                ?.takeIf { !it.isNaN() && !it.isInfinite() }
                ?.let { value -> STALL_THRESHOLDS_MS.minByOrNull { Math.abs(it - value) } }
                ?: SdkOptions.DEFAULT.stallThresholdMs
            val strictMode = STRICT_MODE.find(line)?.groupValues?.get(1) == "true"
            val inflateTracking = INFLATE_TRACKING.find(line)?.groupValues?.get(1) != "false"
            val rxTracking = RX_TRACKING.find(line)?.groupValues?.get(1) != "false"
            val savedStateTracking = SAVED_STATE_TRACKING.find(line)?.groupValues?.get(1) != "false"
            val storageConsent = StorageConsent.of(STORAGE_CONSENT.find(line)?.groupValues?.get(1))
            return SdkOptions(threshold, strictMode, inflateTracking, rxTracking, savedStateTracking, storageConsent)
        }

        private fun storageName(fields: FlatJson, key: String): String? =
            fields.string(key)?.takeIf { it.isNotEmpty() && it.length <= MAX_STORAGE_NAME_CHARS }

        /** An optional string field: absent or null is null; there, it must be a string of at most [max] chars. */
        private fun optional(fields: FlatJson, key: String, max: Int): Result<String?> {
            if (!fields.has(key) || fields.isNull(key)) return Result.success(null)
            val text = fields.string(key)?.takeIf { it.length <= max } ?: return Result.failure(IllegalArgumentException(key))
            return Result.success(text)
        }

        private fun storageList(fields: FlatJson): StorageList? {
            if (fields.string("type") != "storageList") return null
            return StorageList(fields.int("requestId")?.takeIf { it >= 0 } ?: return null)
        }

        /** A storage read with a bad field is dropped (the server then times the request out). */
        private fun storageRead(fields: FlatJson): StorageRead? {
            if (fields.string("type") != "storageRead") return null
            val requestId = fields.int("requestId")?.takeIf { it >= 0 } ?: return null
            val store = fields.string("store")?.takeIf { it == "prefs" || it == "db" } ?: return null
            val name = storageName(fields, "name") ?: return null
            val cursor = optional(fields, "cursor", MAX_STORAGE_CURSOR_CHARS).getOrElse { return null }
            val pages = optional(fields, "pages", MAX_STORAGE_REQUEST_FIELD_CHARS).getOrElse { return null }
            val limit = if (fields.has("limit") && !fields.isNull("limit")) fields.int("limit") ?: return null else null
            return StorageRead(requestId, store, name, cursor, limit, pages)
        }

        private fun storageWrite(fields: FlatJson): StorageWrite? {
            if (fields.string("type") != "storageWrite") return null
            val requestId = fields.int("requestId")?.takeIf { it >= 0 } ?: return null
            val opId = fields.string("opId")?.takeIf { OP_ID.matches(it) } ?: return null
            val store = fields.string("store")?.takeIf { it == "prefs" || it == "db" } ?: return null
            val name = storageName(fields, "name") ?: return null
            val op = fields.string("op")?.takeIf {
                (store == "prefs" && (it == "update" || it == "remove")) || (store == "db" && (it == "update" || it == "delete"))
            } ?: return null
            val text = MAX_STORAGE_REQUEST_FIELD_CHARS
            return StorageWrite(
                requestId = requestId,
                opId = opId,
                store = store,
                name = name,
                op = op,
                key = optional(fields, "key", MAX_STORAGE_NAME_CHARS).getOrElse { return null },
                table = optional(fields, "table", MAX_STORAGE_NAME_CHARS).getOrElse { return null },
                column = optional(fields, "column", MAX_STORAGE_NAME_CHARS).getOrElse { return null },
                pk = optional(fields, "pk", text).getOrElse { return null },
                expected = optional(fields, "expected", text).getOrElse { return null },
                value = optional(fields, "value", text).getOrElse { return null },
                rowDigest = optional(fields, "rowDigest", 64).getOrElse { return null },
            )
        }
    }
}
