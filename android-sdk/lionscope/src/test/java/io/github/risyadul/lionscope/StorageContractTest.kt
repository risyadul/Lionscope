package io.github.risyadul.lionscope

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.concurrent.TimeUnit

/** The storage inspector's contract, unit side. */
class StorageContractTest {
    /** A [JdbcDatabase] that keeps every statement and whether it ran inside [inTransaction]. */
    private class RecordingDatabase : TrackedDatabase, AutoCloseable {
        val inner = JdbcDatabase()
        val statements = ArrayList<String>()
        var outside = 0

        override fun status() = inner.status()

        override fun <T> inTransaction(block: (SqlConnection) -> T): T = inner.inTransaction { conn ->
            var open = true
            val result = block(object : SqlConnection {
                override fun query(sql: String, args: List<Any?>): SqlRows {
                    if (!open) outside++
                    statements += sql
                    return conn.query(sql, args)
                }

                override fun updateDelete(sql: String, args: List<Any?>): Int {
                    if (!open) outside++
                    statements += sql
                    return conn.updateDelete(sql, args)
                }
            })
            open = false
            result
        }

        override fun close() = inner.close()
    }

    private val db = RecordingDatabase()
    private val app = FakePrefs(
        linkedMapOf(
            "zero" to 0.0f,
            "nan" to java.lang.Float.intBitsToFloat(0x7fc00001),
            "tenth" to 0.1f,
            "count" to 3,
            "note" to "token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
            "callback" to "https://example.com/cb?sig=deadbeef&id=7",
            "user_json" to """{"token":"t0k","name":"x"}""",
        ),
    )
    private val inspector = StorageInspector(FakePrefsAccess(linkedMapOf("app" to app)), registry("app.db" to db), ManualCommits().runner)

    @After
    fun close() = db.close()

    private fun json(line: String) = TestJson.parse(line) as Map<*, *>

    private fun read(pages: String) = json(inspector.read(GatewayMessage.StorageRead(1, "db", "app.db", null, null, pages)))

    private fun page(response: Map<*, *>) = (response["pages"] as List<*>)[0] as Map<*, *>

    private fun rows(page: Map<*, *>) = (page["rows"] as List<*>).map { it as Map<*, *> }

    private fun write(
        op: String,
        table: String,
        pk: String,
        column: String? = null,
        expected: String? = null,
        value: String? = null,
        digest: String? = null,
        store: String = "db",
        key: String? = null,
    ): Map<*, *> {
        val lines = ArrayList<String>()
        val name = if (store == "db") "app.db" else "app"
        inspector.write(GatewayMessage.StorageWrite(7, "op1", store, name, op, key, table, column, pk, expected, value, digest)) { lines += it }
        return json(lines.single())
    }

    /** A source file without its comment lines (KDoc and `//`). */
    private fun code(file: File) = file.readText().lines().filterNot {
        val line = it.trimStart()
        line.startsWith("*") || line.startsWith("/**") || line.startsWith("//")
    }.joinToString("\n")

    private fun quote(text: String) = JsonWriter().beginArray().value(text).endArray().toString().removeSurrounding("[", "]")

    @Test
    fun everyStatementIsAllowlistedAndRunsInsideTheAppsTransaction() {
        db.inner.exec(
            "CREATE TABLE user (id INTEGER PRIMARY KEY, name TEXT)",
            "INSERT INTO user VALUES (1, 'Ana'), (2, 'Bo')",
        )
        read("""[{"table":"user"}]""")
        json(inspector.read(GatewayMessage.StorageRead(1, "db", "app.db", null, null, null)))
        write("update", "user", """[{"t":"integer","v":"1"}]""", "name", """{"t":"string","v":"Ana"}""", """{"t":"string","v":"Ann"}""")
        val digest = rows(page(read("""[{"table":"user"}]""")))[1]["digest"] as String
        assertEquals("ok", write("delete", "user", """[{"t":"integer","v":"2"}]""", digest = digest)["code"])
        val allowed = listOf(
            Regex("""SELECT type, name, sql FROM sqlite_master WHERE type IN \('table', 'view'\)( AND .*)?( ORDER BY name LIMIT \d+)?"""),
            Regex("""PRAGMA table_info\("[^;]*"\)"""),
            Regex("""PRAGMA foreign_key_list\("[^;]*"\)"""),
            Regex("""PRAGMA defer_foreign_keys"""),
            Regex("""SELECT name, sql FROM sqlite_master WHERE type = 'table' AND instr\(upper\(sql\), 'DEFERRED'\) > 0"""),
            Regex("""SELECT name FROM sqlite_master WHERE type = 'table'"""),
            Regex("""SELECT tbl_name FROM sqlite_master WHERE type = 'trigger'"""),
            Regex("""SELECT total_changes\(\)"""),
            Regex("""SELECT [^;]* FROM "[^;]*"( WHERE [^;]*)?( ORDER BY [^;]*)? ?(LIMIT \d+( OFFSET \d+)?)?"""),
            Regex("""UPDATE "[^;]*" SET "[^;]*" = \? WHERE [^;]*"""),
            Regex("""DELETE FROM "[^;]*" WHERE [^;]*"""),
        )
        assertTrue(db.statements.size > 5)
        for (sql in db.statements) {
            assertTrue(sql, allowed.any { it.matches(sql) })
            for (word in listOf("wal_checkpoint", "journal_mode", "VACUUM", "ATTACH", "load_extension", "BEGIN", "COMMIT", ";")) {
                assertFalse(sql, sql.contains(word, ignoreCase = true))
            }
        }
        assertEquals(0, db.outside)
    }

    @Test
    fun theStorageCodeNeverOpensAConnectionOrTransactionOfItsOwn() {
        val dir = File("src/main/java/io/github/risyadul/lionscope")
        val files = listOf("DbInspector.kt", "StorageDatabases.kt", "StorageInspector.kt", "StorageRequests.kt", "StorageAccess.kt")
        val forbidden = listOf(
            "openDatabase", "openOrCreateDatabase", "SQLiteOpenHelper", "FrameworkSQLiteOpenHelperFactory", "Room.databaseBuilder",
            "beginTransaction", "setTransactionSuccessful", "endTransaction", "execSQL", "getInvalidationTracker", "invalidationTracker",
            "refreshVersionsAsync", "notifyObserversByTableNames", "getDeclaredField", "getDeclaredMethod", "setAccessible", ".apply()",
        )
        for (file in files) {
            val text = code(File(dir, file))
            for (word in forbidden) assertFalse("$file uses $word", text.contains(word))
        }
        // Writes go through runInTransaction only, and Room's own writable connection inside it.
        val room = code(File(dir, "StorageDatabases.kt"))
        assertTrue(room.contains("database.runInTransaction(Callable"))
        assertEquals(1, Regex("""openHelper\.writableDatabase""").findAll(room).count())
    }

    @Test
    fun columnsAreSchemaNamesNeverExpressions() {
        db.inner.exec(
            "CREATE TABLE session (id INTEGER PRIMARY KEY, access_token TEXT, label TEXT)",
            "INSERT INTO session VALUES (1, 'tok-123', 'main')",
        )
        for (column in listOf("access_token AS value", "substr(access_token,1)", "\"access_token\"--", "value", "label\" FROM session --")) {
            val response = read("""[{"table":"session","columns":[${quote(column)}]}]""")
            assertEquals(column, "invalid_identifier", response["code"])
            assertNull(response["pages"])
        }
        val ok = read("""[{"table":"session","columns":["access_token","label"]}]""")
        val cells = rows(page(ok))[0]["cells"] as List<*>
        assertEquals(mapOf("t" to "redacted", "orig" to "string"), cells[0])
        assertFalse(inspector.read(GatewayMessage.StorageRead(1, "db", "app.db", null, null, """[{"table":"session"}]""")).contains("tok-123"))
    }

    @Test
    fun prefsValuesWithCredentialsInsideAreRedactedWithoutTheXmlRedactor() {
        val line = inspector.read(GatewayMessage.StorageRead(1, "prefs", "app", null, null, null))
        assertFalse(line.contains("eyJzdWIiOiIxIn0"))
        assertFalse(line.contains("deadbeef"))
        assertFalse(line.contains("t0k"))
        assertTrue(line.contains("id=7"))
        assertTrue(line.contains("\\\"name\\\":\\\"x\\\""))
        assertFalse(code(File("src/main/java/io/github/risyadul/lionscope/StorageRedaction.kt")).contains("redactXmlText"))
    }

    @Test
    fun theRowDigestChangesWithAnyBitOfAnyCellCutOnesIncluded() {
        val long = "y".repeat(MAX_STORAGE_VALUE_UNITS + 10)
        val row = listOf<Any?>(1L, 1.5, "abc", byteArrayOf(0, 1), long, null)
        val base = RowDigest.of(row)
        val variants = listOf(
            listOf<Any?>(2L, 1.5, "abc", byteArrayOf(0, 1), long, null),
            listOf<Any?>(1L, Math.nextUp(1.5), "abc", byteArrayOf(0, 1), long, null),
            listOf<Any?>(1L, 1.5, "abd", byteArrayOf(0, 1), long, null),
            listOf<Any?>(1L, 1.5, "abc", byteArrayOf(0, 3), long, null),
            listOf<Any?>(1L, 1.5, "abc", byteArrayOf(0, 1), long.dropLast(1) + "z", null),
            listOf<Any?>(1L, 1.5, "abc", byteArrayOf(0, 1), long, byteArrayOf()),
            listOf<Any?>(1L, 1.5, "abc", byteArrayOf(0, 1), long, ""),
            listOf<Any?>(1L, 1.5, "abc", byteArrayOf(0, 1), long, 0L),
        )
        for (variant in variants) assertNotEquals(base, RowDigest.of(variant))
        assertEquals(base, RowDigest.of(row.toList()))
        assertNotEquals(RowDigest.of(listOf(0.0)), RowDigest.of(listOf(-0.0)))
    }

    @Test
    fun aTriggerRowStaysAfterUndoAndCountsOnlyInTheDelta() {
        db.inner.exec(
            "CREATE TABLE item (id INTEGER PRIMARY KEY, qty INTEGER)",
            "CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, item INTEGER)",
            "CREATE TRIGGER item_log AFTER UPDATE ON item BEGIN INSERT INTO audit_log (item) VALUES (NEW.id); END",
            "INSERT INTO item VALUES (1, 5)",
        )
        val ok = write("update", "item", """[{"t":"integer","v":"1"}]""", "qty", """{"t":"integer","v":"5"}""", """{"t":"integer","v":"6"}""")
        assertEquals(1.0, ok["changes"])
        assertTrue((ok["totalChangesDelta"] as Double) >= 2.0)
        val undo = write("update", "item", """[{"t":"integer","v":"1"}]""", "qty", """{"t":"integer","v":"6"}""", """{"t":"integer","v":"5"}""")
        assertEquals("ok", undo["code"])
        val logs = db.inner.connection.createStatement().executeQuery("SELECT count(*) FROM audit_log").let { it.next(); it.getLong(1) }
        assertEquals(2L, logs)
    }

    @Test
    fun realCellsKeepTheirBitsAndMinusZeroIsStoredAsZero() {
        db.inner.exec(
            "CREATE TABLE m (id INTEGER PRIMARY KEY, x REAL NOT NULL, y REAL)",
            "INSERT INTO m VALUES (1, 1.5, 2.5)",
        )
        val pk = """[{"t":"integer","v":"1"}]"""
        val minusZero = write("update", "m", pk, "x", """{"t":"real","bits":"0x3ff8000000000000"}""", """{"t":"real","bits":"0x8000000000000000"}""")
        assertEquals("ok", minusZero["code"])
        assertEquals(true, minusZero["normalized"])
        assertEquals("0x0000000000000000", (minusZero["stored"] as Map<*, *>)["bits"])
        // The next edit (or undo) names what is stored, not what was sent.
        assertEquals("conflict", write("update", "m", pk, "x", """{"t":"real","bits":"0x8000000000000000"}""", """{"t":"real","bits":"0x3ff8000000000000"}""")["code"])
        for (bits in listOf("0x7ff0000000000000", "0xfff0000000000000", "0x0000000000000001")) {
            val current = (rows(page(read("""[{"table":"m"}]""")))[0]["cells"] as List<*>)[1] as Map<*, *>
            val result = write("update", "m", pk, "x", """{"t":"real","bits":"${current["bits"]}"}""", """{"t":"real","bits":"$bits"}""")
            assertEquals("ok", result["code"])
            assertEquals(bits, (result["stored"] as Map<*, *>)["bits"])
            assertEquals(false, result["normalized"])
        }
        for (column in listOf("x", "y")) {
            val current = (rows(page(read("""[{"table":"m"}]""")))[0]["cells"] as List<*>)[if (column == "x") 1 else 2] as Map<*, *>
            val nan = write("update", "m", pk, column, """{"t":"real","bits":"${current["bits"]}"}""", """{"t":"real","bits":"0x7ff8000000000000"}""")
            assertEquals("invalid_value:nan_not_storable", nan["code"])
        }
    }

    @Test
    fun prefsFloatsGoByBitsMinusZeroAndNanIncluded() {
        assertEquals(
            "conflict",
            write("update", "", "", store = "prefs", key = "zero", expected = """{"t":"float","bits":"0x80000000"}""", value = """{"t":"float","bits":"0x3f800000"}""")["code"],
        )
        val minus = write("update", "", "", store = "prefs", key = "zero", expected = """{"t":"float","bits":"0x00000000"}""", value = """{"t":"float","bits":"0x80000000"}""")
        assertEquals("ok", minus["code"])
        assertEquals("0x80000000", (minus["stored"] as Map<*, *>)["bits"])
        assertEquals(0x80000000.toInt(), java.lang.Float.floatToRawIntBits(app.values["zero"] as Float))
        // Real SharedPreferences keep one NaN (Float.equals compares canonical bits; the XML says "NaN"), shown on
        // API 28: a payload write would be a silent no-op, so it is refused and only the canonical NaN goes in.
        val payload = write("update", "", "", store = "prefs", key = "nan", expected = """{"t":"float","bits":"0x7fc00001"}""", value = """{"t":"float","bits":"0x7fc00002"}""")
        assertEquals("invalid_value:nan_payload", payload["code"])
        assertEquals(0x7fc00001, java.lang.Float.floatToRawIntBits(app.values["nan"] as Float))
        val nan = write("update", "", "", store = "prefs", key = "zero", expected = """{"t":"float","bits":"0x80000000"}""", value = """{"t":"float","bits":"0x7fc00000"}""")
        assertEquals("ok", nan["code"])
        assertEquals(0x7fc00000, java.lang.Float.floatToRawIntBits(app.values["zero"] as Float))
        val tenth = json(inspector.read(GatewayMessage.StorageRead(1, "prefs", "app", null, null, null)))
        val entry = (tenth["entries"] as List<*>).map { it as Map<*, *> }.first { it["key"] == "tenth" }
        assertEquals("0x3dcccccd", (entry["value"] as Map<*, *>)["bits"])
    }

    @Test
    fun textAndBlobsRoundTripExactlyAndCutOnesAreReadOnly() {
        db.inner.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT, b BLOB)")
        val blob = ByteArray(1024) { (it * 37 + 11).toByte() }
        db.inner.connection.prepareStatement("INSERT INTO t VALUES (1, 'a', ?), (2, ?, ?)").use {
            it.setBytes(1, blob)
            it.setString(2, "z".repeat(20 * 1024))
            it.setBytes(3, ByteArray(20 * 1024))
            it.executeUpdate()
        }
        val pk = """[{"t":"integer","v":"1"}]"""
        for (text in listOf("emoji \uD83D\uDE00", "nul \u0000 inside", "quote \" back \\")) {
            val current = (rows(page(read("""[{"table":"t","limit":1}]""")))[0]["cells"] as List<*>)[1] as Map<*, *>
            val ok = write("update", "t", pk, "s", StorageCodec.encode(StorageValue.Text(current["v"] as String)), StorageCodec.encode(StorageValue.Text(text)))
            assertEquals(text, "ok", ok["code"])
            val back = (rows(page(read("""[{"table":"t","limit":1}]""")))[0]["cells"] as List<*>)[1] as Map<*, *>
            assertEquals(text, back["v"])
        }
        // Android's SQLite binding mangles a lone surrogate and the code unit after it: refused before any SQL.
        val before = (rows(page(read("""[{"table":"t","limit":1}]""")))[0]["cells"] as List<*>)[1] as Map<*, *>
        for (text in listOf("lone \uD800 high", "low \uDC00", "end \uD800", "swapped \uDC00\uD800")) {
            val refused = write("update", "t", pk, "s", StorageCodec.encode(StorageValue.Text(before["v"] as String)), StorageCodec.encode(StorageValue.Text(text)))
            assertEquals(text, "invalid_value:lone_surrogate", refused["code"])
        }
        val unchanged = (rows(page(read("""[{"table":"t","limit":1}]""")))[0]["cells"] as List<*>)[1] as Map<*, *>
        assertEquals(before["v"], unchanged["v"])
        val blobCell = (rows(page(read("""[{"table":"t","limit":1}]""")))[0]["cells"] as List<*>)[2] as Map<*, *>
        assertEquals(1024.0, blobCell["size"])
        val changed = blob.copyOf().also { it[512] = (it[512] + 1).toByte() }
        val edit = write("update", "t", pk, "b", StorageCodec.encode(StorageValue.Blob(blob, blob.size, true)), StorageCodec.encode(StorageValue.Blob(changed, changed.size, true)))
        assertEquals("ok", edit["code"])
        val stored = db.inner.connection.createStatement().executeQuery("SELECT b FROM t WHERE id = 1").let { it.next(); it.getBytes(1) }
        assertTrue(stored.contentEquals(changed))
        // 20 KiB cells: cut on the wire, read-only.
        val cut = rows(page(read("""[{"table":"t"}]""")))[1]["cells"] as List<*>
        assertEquals(false, (cut[1] as Map<*, *>)["complete"])
        assertEquals((20 * 1024).toDouble(), (cut[1] as Map<*, *>)["length"])
        assertEquals(false, (cut[2] as Map<*, *>)["complete"])
        val pk2 = """[{"t":"integer","v":"2"}]"""
        assertEquals("read_only:truncated", write("update", "t", pk2, "s", """{"t":"string","v":"z"}""", """{"t":"string","v":"y"}""")["code"])
        assertEquals("read_only:truncated", write("update", "t", pk2, "b", """{"t":"null"}""", """{"t":"null"}""")["code"])
    }

    @Test
    fun prefsStringsKeepNulAndPairsAndRefuseLoneSurrogates() {
        app.values["s"] = "a"
        var current = "a"
        for (text in listOf("nul \u0000", "emoji \uD83D\uDE00", "quote \" back \\")) {
            val ok = write("update", "", "", store = "prefs", key = "s", expected = StorageCodec.encode(StorageValue.Text(current)), value = StorageCodec.encode(StorageValue.Text(text)))
            assertEquals(text, "ok", ok["code"])
            assertEquals(text, app.values["s"])
            val entry = (json(inspector.read(GatewayMessage.StorageRead(1, "prefs", "app", null, null, null)))["entries"] as List<*>)
                .map { it as Map<*, *> }.first { it["key"] == "s" }
            assertEquals(text, (entry["value"] as Map<*, *>)["v"])
            current = text
        }
        // Android's XML serializer writes a lone surrogate to the file as '?': refused before any edit, String and
        // every StringSet element alike.
        for (text in listOf("lone \uD800 high", "low \uDC00", "end \uD800", "swapped \uDC00\uD800")) {
            val refused = write("update", "", "", store = "prefs", key = "s", expected = StorageCodec.encode(StorageValue.Text(current)), value = StorageCodec.encode(StorageValue.Text(text)))
            assertEquals(text, "invalid_value:lone_surrogate", refused["code"])
            assertEquals(current, app.values["s"])
        }
        app.values["tags"] = setOf("a", "b")
        val set = StorageCodec.encode(StorageValue.StringSet(setOf("a", "b")))
        val loneSet = write("update", "", "", store = "prefs", key = "tags", expected = set, value = StorageCodec.encode(StorageValue.StringSet(setOf("a", "lone \uD800 x"))))
        assertEquals("invalid_value:lone_surrogate", loneSet["code"])
        assertEquals(setOf("a", "b"), app.values["tags"])
        val pairSet = write("update", "", "", store = "prefs", key = "tags", expected = set, value = StorageCodec.encode(StorageValue.StringSet(setOf("a", "emoji \uD83D\uDE00"))))
        assertEquals("ok", pairSet["code"])
        assertEquals(setOf("a", "emoji \uD83D\uDE00"), app.values["tags"])
        // A lone surrogate the app put there itself is still compared (expected): editing it away is allowed.
        app.values["s"] = "app \uD800 own"
        val away = write("update", "", "", store = "prefs", key = "s", expected = StorageCodec.encode(StorageValue.Text("app \uD800 own")), value = StorageCodec.encode(StorageValue.Text("fixed")))
        assertEquals("ok", away["code"])
        assertEquals("fixed", app.values["s"])
    }

    @Test
    fun readOnlyTargetsSayWhy() {
        db.inner.exec(
            "CREATE TABLE pair (a TEXT, b INTEGER, v TEXT, PRIMARY KEY (a, b))",
            "INSERT INTO pair VALUES ('x', 1, 'v')",
            "CREATE VIRTUAL TABLE docs USING fts4(body)",
            "INSERT INTO docs (body) VALUES ('hello')",
            "CREATE TABLE room_master_table (id INTEGER PRIMARY KEY, identity_hash TEXT)",
            "INSERT INTO room_master_table VALUES (42, 'h')",
        )
        val tables = (json(inspector.read(GatewayMessage.StorageRead(1, "db", "app.db", null, null, null)))["tables"] as List<*>)
            .map { it as Map<*, *> }.associateBy { it["name"] }
        assertEquals("virtual", tables.getValue("docs")["readOnly"])
        assertTrue(tables.keys.filter { (it as String).startsWith("docs_") }.all { tables.getValue(it)["readOnly"] == "virtual" })
        assertEquals("internal", tables.getValue("room_master_table")["readOnly"])
        // A partial key is not a key.
        assertEquals("invalid_identifier", write("update", "pair", """[{"t":"string","v":"x"}]""", "v", """{"t":"string","v":"v"}""", """{"t":"string","v":"w"}""")["code"])
        assertEquals("read_only:pk_column", write("update", "pair", """[{"t":"string","v":"x"},{"t":"integer","v":"1"}]""", "b", """{"t":"integer","v":"1"}""", """{"t":"integer","v":"2"}""")["code"])
        assertEquals("read_only:virtual", write("update", "docs", """[{"t":"integer","v":"1"}]""", "body", """{"t":"string","v":"hello"}""", """{"t":"string","v":"x"}""")["code"])
        assertEquals("read_only:internal", write("update", "room_master_table", """[{"t":"integer","v":"42"}]""", "identity_hash", """{"t":"string","v":"h"}""", """{"t":"string","v":"x"}""")["code"])
        assertEquals("ok", write("update", "pair", """[{"t":"string","v":"x"},{"t":"integer","v":"1"}]""", "v", """{"t":"string","v":"v"}""", """{"t":"string","v":"w"}""")["code"])
    }

    @Test
    fun aPageHoldsAtMost200RowsAndALargerLimitIsInvalid() {
        db.inner.exec("CREATE TABLE n (id INTEGER PRIMARY KEY)")
        db.inner.connection.prepareStatement("INSERT INTO n VALUES (?)").use { statement ->
            for (id in 1..201) {
                statement.setLong(1, id.toLong())
                statement.executeUpdate()
            }
        }
        val full = page(read("""[{"table":"n","limit":200}]"""))
        assertEquals(200, rows(full).size)
        assertTrue(full["nextCursor"] is String)
        assertEquals(50, rows(page(read("""[{"table":"n"}]"""))).size)
        assertEquals("invalid_value", read("""[{"table":"n","limit":201}]""")["code"])
        assertEquals("invalid_value", read("""[{"table":"n"},{"table":"n"},{"table":"n"},{"table":"n"},{"table":"n"}]""")["code"])
    }

    @Test
    fun theRegistryHoldsSixteenReplacesByNameAndReportsClosedOnes() {
        val registry = DatabaseRegistry()
        val first = JdbcDatabase()
        val second = JdbcDatabase()
        try {
            for (i in 1..16) assertTrue(registry.register("db$i", first))
            assertFalse(registry.register("db17", first))
            assertTrue(registry.register("db3", second))
            assertTrue(registry.get("db3") === second)
            assertEquals(16, registry.all().size)
            second.status = "unsupported:closed"
            val closed = StorageInspector(FakePrefsAccess(), registry, ManualCommits().runner)
            assertEquals("unsupported:closed", json(closed.read(GatewayMessage.StorageRead(1, "db", "db3", null, null, null)))["code"])
            val listed = (json(closed.list(1))["databases"] as List<*>).map { it as Map<*, *> }.associate { it["name"] to it["status"] }
            assertEquals("unsupported:closed", listed["db3"])
            assertEquals("ok", listed["db1"])
        } finally {
            first.close()
            second.close()
        }
    }

    @Test
    fun anOlderServerGetsNoStorageLinesAndNothingRuns() {
        // A v11 SDK on a v10 server (which never sends storage requests) stays silent and touches nothing.
        val link = FakeLink()
        StorageTestHooks.recordThreads = true
        StorageTestHooks.threads.clear()
        try {
            StorageRequests(link, inspector)
            link.welcome(true, DEVICE_PROTOCOL_V10)
            link.config(SdkOptions.DEFAULT.copy(storageConsent = StorageConsent.READ_WRITE))
            link.storage(GatewayMessage.StorageList(5))
            link.storage(GatewayMessage.StorageRead(6, "db", "app.db", null, null, null))
            Thread.sleep(100)
            assertEquals(emptyList<String>(), link.v11Lines.toList())
            assertEquals(emptyList<String>(), StorageTestHooks.threads.toList())
            assertEquals(emptyList<String>(), db.statements.toList())
        } finally {
            StorageTestHooks.recordThreads = false
            StorageTestHooks.threads.clear()
        }
    }

    @Test
    fun requestsRunOnTheStorageWorkerNeverTheCallersThread() {
        val link = FakeLink()
        StorageTestHooks.recordThreads = true
        StorageTestHooks.threads.clear()
        try {
            StorageRequests(link, inspector)
            link.welcome(true, DEVICE_PROTOCOL_V11)
            link.config(SdkOptions.DEFAULT.copy(storageConsent = StorageConsent.READ_WRITE))
            link.storage(GatewayMessage.StorageList(5))
            link.storage(GatewayMessage.StorageRead(6, "prefs", "app", null, null, null))
            link.storage(GatewayMessage.StorageRead(7, "db", "app.db", null, null, null))
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (link.v11Lines.size < 3 && System.nanoTime() < deadline) Thread.sleep(5)
            assertEquals(3, link.v11Lines.size)
            assertEquals(setOf("lionscope-storage"), StorageTestHooks.threads.toSet())
        } finally {
            StorageTestHooks.recordThreads = false
            StorageTestHooks.threads.clear()
        }
    }
}
