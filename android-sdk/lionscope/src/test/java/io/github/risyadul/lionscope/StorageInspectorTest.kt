package io.github.risyadul.lionscope

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The storage inspector against fake prefs and a real SQLite (sqlite-jdbc). */
class StorageInspectorTest {
    private val app = FakePrefs(
        linkedMapOf(
            "count" to 3,
            "big" to 9_000_000_000L,
            "ratio" to 0.5f,
            "dark" to true,
            "name" to "Ana",
            "tags" to setOf("b", "a"),
            "access_token" to "secret-value",
            "profile" to """{"id":1,"token":"abc"}""",
        ),
    )
    private val prefs = FakePrefsAccess(linkedMapOf("app" to app))
    private val db = JdbcDatabase()
    private val commits = ManualCommits()
    private val inspector = StorageInspector(prefs, registry("app.db" to db), commits.runner)

    @After
    fun close() = db.close()

    private fun json(line: String) = TestJson.parse(line) as Map<*, *>

    /** [text] as a JSON string literal. */
    private fun quote(text: String) = JsonWriter().beginArray().value(text).endArray().toString().removeSurrounding("[", "]")

    private fun read(store: String, name: String, cursor: String? = null, limit: Int? = null, pages: String? = null) =
        json(inspector.read(GatewayMessage.StorageRead(1, store, name, cursor, limit, pages)))

    private fun write(
        store: String,
        op: String,
        expected: String?,
        value: String? = null,
        key: String? = null,
        table: String? = null,
        column: String? = null,
        pk: String? = null,
        rowDigest: String? = null,
    ): List<Map<*, *>> {
        val lines = ArrayList<String>()
        val name = if (store == "prefs") "app" else "app.db"
        inspector.write(GatewayMessage.StorageWrite(7, "op1", store, name, op, key, table, column, pk, expected, value, rowDigest)) { lines += it }
        return lines.map(::json)
    }

    @Test
    fun theListingNamesPrefsFilesAndRegisteredDatabases() {
        val list = json(inspector.list(3))
        assertEquals(listOf(mapOf("name" to "app", "backupOnly" to false)), list["prefs"])
        assertEquals(listOf(mapOf("name" to "app.db", "status" to "ok")), list["databases"])
    }

    @Test
    fun prefsAreReadTypedSortedAndRedacted() {
        val page = read("prefs", "app")
        val entries = (page["entries"] as List<*>).map { it as Map<*, *> }.associate { it["key"] to it["value"] }
        assertEquals(listOf("access_token", "big", "count", "dark", "name", "profile", "ratio", "tags"), entries.keys.toList())
        assertEquals(mapOf("t" to "int", "v" to "3"), entries["count"])
        assertEquals(mapOf("t" to "long", "v" to "9000000000"), entries["big"])
        assertEquals("0x3f000000", (entries["ratio"] as Map<*, *>)["bits"])
        assertEquals(mapOf("t" to "redacted", "orig" to "string"), entries["access_token"])
        val profile = entries["profile"] as Map<*, *>
        assertEquals("redacted", profile["t"])
        assertFalse((profile["preview"] as String).contains("abc"))
        assertFalse(inspector.read(GatewayMessage.StorageRead(1, "prefs", "app", null, null, null)).contains("secret-value"))
        // Paging by key, through an opaque token (never the key itself).
        val first = read("prefs", "app", limit = 3)
        val token = first["nextCursor"] as String
        assertTrue(token, StorageCursors.TOKEN_PATTERN.matches(token))
        val rest = read("prefs", "app", cursor = token)
        assertEquals(listOf("dark", "name", "profile", "ratio", "tags"), (rest["entries"] as List<*>).map { (it as Map<*, *>)["key"] })
        assertNull(rest["nextCursor"])
        // A key is not a cursor, and a token of another file is not one here.
        assertEquals("invalid_identifier", read("prefs", "app", cursor = "count")["code"])
        prefs.files["other"] = FakePrefs(mapOf("a" to 1, "b" to 2))
        val other = read("prefs", "other", limit = 1)["nextCursor"] as String
        assertEquals("invalid_identifier", read("prefs", "app", cursor = other)["code"])
    }

    @Test
    fun anUnlistedFileIsNeverOpened() {
        assertEquals("not_found", read("prefs", "../other")["code"])
        assertTrue(prefs.opened.isEmpty())
    }

    @Test
    fun encryptedPrefsAreNotRead() {
        prefs.files["secure"] = FakePrefs(mapOf("__androidx_security_crypto_encrypted_prefs_key_keyset__" to "x"))
        assertEquals("unsupported:encrypted", read("prefs", "secure")["code"])
    }

    @Test
    fun aPrefsEditIsCompareAndSet() {
        val conflict = write("prefs", "update", """{"t":"int","v":"2"}""", """{"t":"int","v":"9"}""", key = "count").single()
        assertEquals("conflict", conflict["code"])
        assertEquals(mapOf("t" to "int", "v" to "3"), conflict["current"])
        assertEquals(3, app.values["count"])
        assertEquals("type_mismatch", write("prefs", "update", """{"t":"int","v":"3"}""", """{"t":"long","v":"4"}""", key = "count").single()["code"])
        val ok = write("prefs", "update", """{"t":"int","v":"3"}""", """{"t":"int","v":"4"}""", key = "count").single()
        assertEquals("ok", ok["code"])
        assertEquals("final", ok["phase"])
        assertEquals("applied", ok["memory"])
        assertEquals(true, ok["persisted"])
        assertEquals("posted_unverified", ok["observers"])
        assertEquals(4, app.values["count"])
        // The same edit again (a retry after a lost answer): nothing written.
        val retry = write("prefs", "update", """{"t":"int","v":"3"}""", """{"t":"int","v":"4"}""", key = "count").single()
        assertEquals("already_applied_or_concurrent", retry["code"])
        assertEquals(1, app.commits)
    }

    @Test
    fun credentialsAndCutValuesAreNeverEdited() {
        assertEquals(
            "read_only:redacted",
            write("prefs", "update", """{"t":"string","v":"secret-value"}""", """{"t":"string","v":"x"}""", key = "access_token").single()["code"],
        )
        assertEquals(
            "read_only:redacted",
            write("prefs", "update", """{"t":"string","v":"{\"id\":1,\"token\":\"abc\"}"}""", """{"t":"string","v":"x"}""", key = "profile").single()["code"],
        )
        assertEquals("secret-value", app.values["access_token"])
        app.values["long"] = "x".repeat(MAX_STORAGE_VALUE_UNITS + 1)
        assertEquals(
            "read_only:truncated",
            write("prefs", "update", """{"t":"string","v":"x"}""", """{"t":"string","v":"y"}""", key = "long").single()["code"],
        )
    }

    @Test
    fun aPrefsRemoveNeedsTheExpectedValue() {
        assertEquals("conflict", write("prefs", "remove", """{"t":"bool","v":false}""", key = "dark").single()["code"])
        assertEquals("ok", write("prefs", "remove", """{"t":"bool","v":true}""", key = "dark").single()["code"])
        assertFalse(app.values.containsKey("dark"))
        assertEquals("already_applied_or_concurrent", write("prefs", "remove", """{"t":"bool","v":true}""", key = "dark").single()["code"])
    }

    @Test
    fun aPrefsFloatTakesOnlyTheCanonicalNaN() {
        // SharedPreferences compares with Float.equals (canonical bits): another NaN payload would be a silent no-op.
        val ratio = """{"t":"float","bits":"0x3f000000"}"""
        assertEquals("invalid_value:nan_payload", write("prefs", "update", ratio, """{"t":"float","bits":"0x7fc00001"}""", key = "ratio").single()["code"])
        assertEquals(0.5f, app.values["ratio"])
        assertEquals("ok", write("prefs", "update", ratio, """{"t":"float","bits":"0x7fc00000"}""", key = "ratio").single()["code"])
        assertTrue((app.values["ratio"] as Float).isNaN())
    }

    @Test
    fun aSlowCommitAnswersProvisionalThenFinal() {
        commits.hold = true
        val answers = ArrayList<Map<*, *>>()
        inspector.write(
            GatewayMessage.StorageWrite(7, "op1", "prefs", "app", "update", "dark", null, null, null, """{"t":"bool","v":true}""", """{"t":"bool","v":false}""", null),
        ) { answers += json(it) }
        assertEquals(1, answers.size)
        assertEquals("provisional", answers[0]["phase"])
        assertEquals("timeout", answers[0]["persisted"])
        commits.release()
        assertEquals(2, answers.size)
        assertEquals("final", answers[1]["phase"])
        assertEquals(true, answers[1]["persisted"])
        assertEquals("op1", answers[1]["opId"])
    }

    // --- databases -----------------------------------------------------------------------------------------------

    private fun seed() = db.exec(
        "CREATE TABLE user (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL, avatar BLOB, password TEXT)",
        "INSERT INTO user VALUES (1, 'Ana', 1.5, x'00ff', 'p1'), (2, 'Bo', NULL, NULL, 'p2'), (3, 'Cy', 0.0, NULL, NULL)",
        "CREATE TABLE pair (a TEXT, b INTEGER, v TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID",
        "INSERT INTO pair VALUES ('x', 2, 'x2'), ('x', 1, 'x1'), ('y', 1, 'y1')",
        "CREATE TABLE log (msg TEXT)",
        "INSERT INTO log VALUES ('a'), ('b'), ('c')",
        "CREATE VIEW names AS SELECT name FROM user",
        "CREATE TABLE room_master_table (id INTEGER PRIMARY KEY, identity_hash TEXT)",
    )

    private fun rows(page: Map<*, *>): List<List<Any?>> =
        (page["rows"] as List<*>).map { ((it as Map<*, *>)["cells"] as List<*>).map { cell -> cell } }

    private fun page(response: Map<*, *>, index: Int = 0) = (response["pages"] as List<*>)[index] as Map<*, *>

    @Test
    fun theSchemaSaysWhyATableIsReadOnly() {
        seed()
        val tables = (read("db", "app.db")["tables"] as List<*>).map { it as Map<*, *> }.associateBy { it["name"] }
        assertNull(tables.getValue("user")["readOnly"])
        assertEquals(listOf("id"), tables.getValue("user")["pk"])
        assertEquals(true, tables.getValue("pair")["withoutRowid"])
        assertEquals(listOf("a", "b"), tables.getValue("pair")["pk"])
        assertEquals("no_explicit_pk", tables.getValue("log")["readOnly"])
        assertEquals("view", tables.getValue("names")["readOnly"])
        assertEquals("internal", tables.getValue("room_master_table")["readOnly"])
    }

    @Test
    fun pagesFollowThePrimaryKeyAndContinueByCursor() {
        seed()
        val first = page(read("db", "app.db", pages = """[{"table":"pair","limit":2}]"""))
        assertEquals(
            listOf(
                listOf(mapOf("t" to "string", "v" to "x"), mapOf("t" to "integer", "v" to "1"), mapOf("t" to "string", "v" to "x1")),
                listOf(mapOf("t" to "string", "v" to "x"), mapOf("t" to "integer", "v" to "2"), mapOf("t" to "string", "v" to "x2")),
            ),
            rows(first),
        )
        val cursor = first["nextCursor"] as String
        val second = page(read("db", "app.db", pages = """[{"table":"pair","limit":2,"cursor":${quote(cursor)}}]"""))
        assertEquals("y1", ((rows(second).single()[2]) as Map<*, *>)["v"])
        assertNull(second["nextCursor"])
        // A table without a primary key pages by rowid; rows have no digest (read-only).
        val log = page(read("db", "app.db", pages = """[{"table":"log","limit":2}]"""))
        assertEquals(2, rows(log).size)
        assertNull(((log["rows"] as List<*>)[0] as Map<*, *>)["digest"])
        val more = page(read("db", "app.db", pages = """[{"table":"log","cursor":${quote(log["nextCursor"] as String)}}]"""))
        assertEquals(listOf(listOf(mapOf("t" to "string", "v" to "c"))), rows(more))
    }

    @Test
    fun severalPagesAreReadInOneTransaction() {
        seed()
        val before = db.transactions
        val response = read("db", "app.db", pages = """[{"table":"user","columns":["id","password","avatar"]},{"table":"log"}]""")
        assertEquals(before + 1, db.transactions)
        val user = page(response)
        assertEquals(listOf("id", "password", "avatar"), user["columns"])
        assertEquals(mapOf("t" to "redacted", "orig" to "string"), rows(user)[0][1])
        assertEquals(mapOf("t" to "blob", "b64" to "AP8=", "size" to 2.0, "complete" to true), rows(user)[0][2])
        assertEquals(3, rows(page(response, 1)).size)
        assertEquals("invalid_identifier", read("db", "app.db", pages = """[{"table":"user","columns":["nope"]}]""")["code"])
        assertEquals("not_found", read("db", "app.db", pages = """[{"table":"nope"}]""")["code"])
    }

    @Test
    fun aCellEditIsCompareAndSetByPrimaryKey() {
        seed()
        val conflict = write("db", "update", """{"t":"string","v":"Zed"}""", """{"t":"string","v":"Ann"}""", table = "user", column = "name", pk = """[{"t":"integer","v":"1"}]""").single()
        assertEquals("conflict", conflict["code"])
        assertEquals(mapOf("t" to "string", "v" to "Ana"), conflict["current"])
        val ok = write("db", "update", """{"t":"string","v":"Ana"}""", """{"t":"string","v":"Ann"}""", table = "user", column = "name", pk = """[{"t":"integer","v":"1"}]""").single()
        assertEquals("ok", ok["code"])
        assertEquals(1.0, ok["changes"])
        assertEquals("room_invalidation", ok["observers"])
        assertEquals(mapOf("t" to "string", "v" to "Ann"), ok["stored"])
        assertEquals("already_applied_or_concurrent", write("db", "update", """{"t":"string","v":"Ana"}""", """{"t":"string","v":"Ann"}""", table = "user", column = "name", pk = """[{"t":"integer","v":"1"}]""").single()["code"])
        // A string key never finds an integer one ('1' = 1 in SQL).
        assertEquals("not_found", write("db", "update", """{"t":"string","v":"Ann"}""", """{"t":"string","v":"B"}""", table = "user", column = "name", pk = """[{"t":"string","v":"1"}]""").single()["code"])
        // 0.0 is not -0.0.
        assertEquals("conflict", write("db", "update", """{"t":"real","bits":"0x8000000000000000"}""", """{"t":"real","bits":"0x3ff0000000000000"}""", table = "user", column = "score", pk = """[{"t":"integer","v":"3"}]""").single()["code"])
    }

    @Test
    fun whatMustNotBeWrittenIsRefusedBeforeAnySql() {
        seed()
        fun code(column: String, expected: String, value: String, pk: String = """[{"t":"integer","v":"2"}]""", table: String = "user") =
            write("db", "update", expected, value, table = table, column = column, pk = pk).single()["code"]
        assertEquals("invalid_value:nan_not_storable", code("score", """{"t":"null"}""", """{"t":"real","bits":"0x7ff8000000000000"}"""))
        assertEquals("invalid_value:lone_surrogate", code("name", """{"t":"string","v":"Bo"}""", """{"t":"string","v":"a\ud800 b"}"""))
        assertEquals("read_only:redacted", code("password", """{"t":"string","v":"p2"}""", """{"t":"string","v":"x"}"""))
        assertEquals("read_only:pk_column", code("id", """{"t":"integer","v":"2"}""", """{"t":"integer","v":"9"}"""))
        assertEquals("type_mismatch", code("name", """{"t":"string","v":"Bo"}""", """{"t":"integer","v":"9"}"""))
        assertEquals("type_mismatch", code("score", """{"t":"null"}""", """{"t":"string","v":"9"}""")) // REAL affinity.
        assertEquals("ok", code("score", """{"t":"null"}""", """{"t":"real","bits":"0x4000000000000000"}"""))
        assertEquals("constraint_failed", code("name", """{"t":"string","v":"Bo"}""", """{"t":"null"}"""))
        assertEquals("read_only:no_explicit_pk", code("msg", """{"t":"string","v":"a"}""", """{"t":"string","v":"b"}""", table = "log"))
        assertEquals("read_only:view", code("name", """{"t":"string","v":"Bo"}""", """{"t":"string","v":"b"}""", table = "names"))
        assertEquals("invalid_identifier", code("nope", """{"t":"string","v":"Bo"}""", """{"t":"string","v":"b"}"""))
        assertEquals("Bo", db.connection.createStatement().executeQuery("SELECT name FROM user WHERE id = 2").let { it.next(); it.getString(1) })
    }

    @Test
    fun aRowDeleteNeedsItsDigest() {
        seed()
        val row = (page(read("db", "app.db", pages = """[{"table":"user","limit":1}]"""))["rows"] as List<*>)[0] as Map<*, *>
        val digest = row["digest"] as String
        assertEquals("conflict", write("db", "delete", null, table = "user", pk = """[{"t":"integer","v":"1"}]""", rowDigest = "0".repeat(64)).single()["code"])
        assertEquals("ok", write("db", "delete", null, table = "user", pk = """[{"t":"integer","v":"1"}]""", rowDigest = digest).single()["code"])
        assertEquals("already_applied_or_concurrent", write("db", "delete", null, table = "user", pk = """[{"t":"integer","v":"1"}]""", rowDigest = digest).single()["code"])
    }

    @Test
    fun aTransactionPastItsBudgetIsRolledBack() {
        seed()
        var now = 0L
        val slow = StorageInspector(prefs, registry("app.db" to db), commits.runner, DbInspector(nanoTime = { now.also { now += 100_000_000L } }))
        val lines = ArrayList<String>()
        slow.write(
            GatewayMessage.StorageWrite(7, "op1", "db", "app.db", "update", null, "user", "name", """[{"t":"integer","v":"2"}]""", """{"t":"string","v":"Bo"}""", """{"t":"string","v":"B"}""", null),
        ) { lines += it }
        assertEquals("timeout", json(lines.single())["code"])
        assertEquals("Bo", db.connection.createStatement().executeQuery("SELECT name FROM user WHERE id = 2").let { it.next(); it.getString(1) })
    }

    @Test
    fun aClosedOrDriverDatabaseIsNotRead() {
        db.status = "unsupported:driver"
        assertEquals("unsupported:driver", read("db", "app.db")["code"])
        assertEquals("not_found", read("db", "other.db")["code"])
    }

    @Test
    fun answersStayUnderTheReplyLimit() {
        db.exec("CREATE TABLE big (id INTEGER PRIMARY KEY, body TEXT)")
        val body = "x".repeat(MAX_STORAGE_VALUE_UNITS)
        db.connection.prepareStatement("INSERT INTO big VALUES (?, ?)").use { statement ->
            for (id in 1..40) {
                statement.setLong(1, id.toLong())
                statement.setString(2, body)
                statement.executeUpdate()
            }
        }
        val line = inspector.read(GatewayMessage.StorageRead(1, "db", "app.db", null, null, """[{"table":"big","limit":40}]"""))
        assertTrue(utf8Bytes(line) <= MAX_STORAGE_REPLY_BYTES)
        val page = page(json(line))
        assertEquals(true, page["truncated"])
        val shown = rows(page).size
        assertTrue(shown in 1 until 40)
        val next = page(read("db", "app.db", pages = """[{"table":"big","limit":40,"cursor":${quote(page["nextCursor"] as String)}}]"""))
        assertEquals(mapOf("t" to "integer", "v" to (shown + 1).toString()), rows(next)[0][0])
    }
}
