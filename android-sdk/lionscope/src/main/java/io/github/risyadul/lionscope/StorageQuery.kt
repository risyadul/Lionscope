package io.github.risyadul.lionscope

/** Query results use the existing operation envelope so a timed-out mutation can still receive its late outcome. */
internal class StorageQuery(private val databases: DatabaseRegistry, private val db: DbInspector = DbInspector()) {
    fun run(message: GatewayMessage.StorageQuery): String = try {
        val plan = StorageSql.plan(message.sql)
        if (!plan.readOnly && message.offset != 0) throw StorageAbort("invalid_value")
        val database = databases.get(message.name) ?: throw StorageAbort("not_found")
        val result = db.query(database, plan, message.limit, message.offset)
        val rows = result.value.rows
        val json = header(message, "ok")
        json.name("query").beginObject().name("readOnly").value(plan.readOnly)
            .name("columns").beginArray()
        rows?.columns?.forEach { json.value(it) }
        json.endArray().name("rows").beginArray()
        rows?.rows?.forEach { cells ->
            json.beginArray()
            cells.forEach { StorageCodec.write(json, it) }
            json.endArray()
        }
        json.endArray().name("hasMore").value(rows?.hasMore ?: false)
            .name("truncated").value(rows?.truncated ?: false).name("offset").value(message.offset).endObject()
        result.value.changes?.let { json.name("changes").value(it) }
        result.value.delta?.let { json.name("totalChangesDelta").value(it) }
        if (!plan.readOnly) json.name("observers").value("room_invalidation")
        json.name("txMs").value(result.txMs)
        val line = json.endObject().toString()
        check(utf8Bytes(line) <= MAX_STORAGE_REPLY_BYTES)
        line
    } catch (abort: StorageAbort) {
        header(message, abort.code).endObject().toString()
    } catch (constraint: SqlConstraintException) {
        header(message, "constraint_failed").endObject().toString()
    } catch (t: Throwable) {
        if (isFatal(t)) throw t
        header(message, "failed").name("queryError").value((t.message ?: t.javaClass.simpleName).take(1024)).endObject().toString()
    }

    private fun header(message: GatewayMessage.StorageQuery, code: String): JsonWriter = JsonWriter().beginObject()
        .name("type").value("storageWriteResult").name("requestId").value(message.requestId)
        .name("opId").value(message.opId).name("phase").value("final").name("code").value(code)
}
