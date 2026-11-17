package io.github.risyadul.lionscope

/**
 * The storage inspector's redaction, applied to parsed values (a prefs key's value from `getAll()`, a database cell
 * of a column named in the schema), never to file text: `redactXmlText` would miss `<string name="access_token">`.
 * The server applies the same rules again (protocol/src/storage.ts). A credential-looking key or column name hides the
 * value whole; a string with a credential inside (a JSON object with a `token` key, a JWT, `Bearer …`, a URL with a
 * sensitive query parameter) is shown with those parts replaced as a read-only `preview`.
 */
internal object StorageRedaction {
    private val JWT = Regex("eyJ[A-Za-z0-9_-]{2,}\\.[A-Za-z0-9_-]{2,}\\.[A-Za-z0-9_-]*")

    fun isSensitiveName(name: String): Boolean = HttpRedaction.isSensitiveName(name)

    /** [text] with what looks like a credential replaced (unchanged when nothing does). */
    fun redactText(text: String): String {
        var out = text
        val trimmed = out.trimStart()
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) out = HttpRedaction.redactJsonText(out)
        out = JWT.replace(out, HTTP_REDACTED)
        return HttpRedaction.redactFreeText(out)
    }

    /** [value] as it may be sent for a key or column called [name]. */
    fun redact(name: String, value: StorageValue): StorageValue = when {
        value is StorageValue.Null || value is StorageValue.Redacted -> value
        isSensitiveName(name) -> StorageValue.Redacted(value.wireType)
        value is StorageValue.Text -> {
            val redacted = redactText(value.value)
            if (redacted == value.value) value else StorageValue.Redacted("string", cut(redacted))
        }
        value is StorageValue.StringSet && value.values.any { redactText(it) != it } -> StorageValue.Redacted("stringSet")
        else -> value
    }

    /** Whether [redact] would hide any of [value] (such a value is never edited). */
    fun hides(name: String, value: StorageValue): Boolean = redact(name, value) is StorageValue.Redacted

    private fun cut(text: String): String = StorageCut.text(text).value
}
