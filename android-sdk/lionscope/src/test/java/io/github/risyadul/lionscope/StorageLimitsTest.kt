package io.github.risyadul.lionscope

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What can't leak through a read (cursors, views) and what keeps every answer under the production cap while paging
 * still reaches every key and row once.
 */
class StorageLimitsTest {
    private val prefsFile = FakePrefs()
    private val prefs = FakePrefsAccess(linkedMapOf("app" to prefsFile))
    private val db = JdbcDatabase()
    private val inspector = StorageInspector(prefs, registry("app.db" to db), ManualCommits().runner)

    @After
    fun close() = db.close()

    private fun json(line: String) = TestJson.parse(line) as Map<*, *>

    private fun quote(text: String) = JsonWriter().beginArray().value(text).endArray().toString().removeSurrounding("[", "]")

    private fun readLine(store: String, name: String, cursor: String? = null, limit: Int? = null, pages: String? = null): String =
        inspector.read(GatewayMessage.StorageRead(1, store, name, cursor, limit, pages))

    private fun pageRequest(table: String, cursor: String? = null, limit: Int? = null): String =
        "{\"table\":${quote(table)}" + (cursor?.let { ",\"cursor\":${quote(it)}" } ?: "") + (limit?.let { ",\"limit\":$it" } ?: "") + "}"

    private fun pages(line: String) = (json(line)["pages"] as List<*>).map { it as Map<*, *> }

    private fun rows(page: Map<*, *>) = (page["rows"] as List<*>).map { ((it as Map<*, *>)["cells"] as List<*>).map { cell -> cell as Map<*, *> } }

    private fun insert(sql: String, vararg rows: List<Any?>) {
        db.connection.prepareStatement(sql).use { statement ->
            for (row in rows) {
                row.forEachIndexed { i, value ->
                    when (value) {
                        is Long -> statement.setLong(i + 1, value)
                        is String -> statement.setString(i + 1, value)
                        else -> statement.setObject(i + 1, value)
                    }
                }
                statement.executeUpdate()
            }
        }
    }

    private fun assertUnderCap(line: String) = assertTrue("${utf8Bytes(line)} bytes", utf8Bytes(line) <= MAX_STORAGE_REPLY_BYTES)

    // --- cursors ------------------------------------------------------------------------------------------------

    @Test
    fun aCursorNeverCarriesAKeyValue() {
        db.exec(
            "CREATE TABLE vault (access_token TEXT PRIMARY KEY, label TEXT)",
            "INSERT INTO vault VALUES ('fixture-secret-alpha', 'a'), ('fixture-secret-beta', 'b')",
        )
        val line = readLine("db", "app.db", pages = "[${pageRequest("vault", limit = 1)}]")
        assertFalse(line, line.contains("fixture-secret"))
        val page = pages(line).single()
        assertEquals(mapOf("t" to "redacted", "orig" to "string"), rows(page).single()[0])
        val token = page["nextCursor"] as String
        assertTrue(token, StorageCursors.TOKEN_PATTERN.matches(token))
        // The token continues where the page stopped, on the device.
        val next = readLine("db", "app.db", pages = "[${pageRequest("vault", token, 1)}]")
        assertFalse(next.contains("fixture-secret"))
        assertEquals("b", rows(pages(next).single()).single()[1]["v"])
        // Not valid for another table, nor once the connection changed.
        db.exec("CREATE TABLE other (id INTEGER PRIMARY KEY)")
        assertEquals("invalid_identifier", json(readLine("db", "app.db", pages = "[${pageRequest("other", token)}]"))["code"])
        inspector.resetCursors()
        assertEquals("invalid_identifier", json(readLine("db", "app.db", pages = "[${pageRequest("vault", token)}]"))["code"])
        // A key value written as a cursor (the old format) is not one.
        val forged = """{"k":[{"t":"string","v":"fixture-secret-alpha"}]}"""
        assertEquals("invalid_identifier", json(readLine("db", "app.db", pages = "[${pageRequest("vault", forged)}]"))["code"])
    }

    @Test
    fun cursorsAreBoundedAndLeastRecentlyUsedGoFirst() {
        val cursors = StorageCursors(max = 2)
        val a = cursors.put("s", StorageCursors.Position.AfterOffset(1))
        val b = cursors.put("s", StorageCursors.Position.AfterOffset(2))
        assertNotNull(cursors.get(a, "s"))
        cursors.put("s", StorageCursors.Position.AfterOffset(3))
        assertNotNull(cursors.get(a, "s"))
        assertNull(cursors.get(b, "s"))
        assertNull(cursors.get(a, "other"))
        assertEquals(2, cursors.size)
    }

    // --- views --------------------------------------------------------------------------------------------------

    @Test
    fun aViewsValuesAreHiddenWhateverItNamesThem() {
        db.exec(
            "CREATE TABLE credential (id INTEGER PRIMARY KEY, access_token TEXT, n INTEGER)",
            "INSERT INTO credential VALUES (1, 'fixture-secret-in-view', 7), (2, NULL, 8)",
            "CREATE VIEW readable_view AS SELECT id, access_token AS value FROM credential",
            "CREATE VIEW expression_view AS SELECT id, substr(access_token, 1) || '' AS plain, n * 1 AS num FROM credential",
        )
        for (view in listOf("readable_view", "expression_view")) {
            val line = readLine("db", "app.db", pages = "[${pageRequest(view)}]")
            assertFalse(line, line.contains("fixture-secret"))
            val page = pages(line).single()
            assertEquals("view", page["readOnly"])
            val cells = rows(page)
            // Every value is hidden (its type kept), NULL stays NULL; no row can be edited (no digest).
            assertEquals(mapOf("t" to "redacted", "orig" to "integer"), cells[0][0])
            assertEquals(mapOf("t" to "redacted", "orig" to "string"), cells[0][1])
            assertEquals(mapOf("t" to "null"), cells[1][1])
            assertNull(((page["rows"] as List<*>)[0] as Map<*, *>)["digest"])
        }
    }

    // --- sizes and progress -------------------------------------------------------------------------------------

    @Test
    fun aHugeStringSetIsCutAsOneValueAndTheKeysAfterItAreReached() {
        prefsFile.values["a_set"] = (0 until 25).mapTo(LinkedHashSet()) { i -> ('a' + i).toString().repeat(16_383) }
        prefsFile.values["z_count"] = 3
        val line = readLine("prefs", "app")
        assertUnderCap(line)
        val entries = (json(line)["entries"] as List<*>).map { it as Map<*, *> }.associate { it["key"] to it["value"] as Map<*, *> }
        val set = entries.getValue("a_set")
        assertEquals(false, set["complete"])
        assertTrue((set["v"] as List<*>).sumOf { (it as String).length } <= MAX_STORAGE_VALUE_UNITS)
        assertEquals(mapOf("t" to "int", "v" to "3"), entries["z_count"])
        // Cut means read-only.
        assertEquals(
            "read_only:truncated",
            json(write("prefs", """{"t":"stringSet","v":["a"]}""", """{"t":"stringSet","v":["b"]}""", key = "a_set"))["code"],
        )
    }

    @Test
    fun aLongPrefsKeyIsSentCut() {
        val key = "k".repeat(MAX_STORAGE_KEY_UNITS + 10)
        prefsFile.values[key] = 1
        val entry = (json(readLine("prefs", "app"))["entries"] as List<*>).single() as Map<*, *>
        assertEquals(MAX_STORAGE_KEY_UNITS, (entry["key"] as String).length)
        assertEquals((MAX_STORAGE_KEY_UNITS + 10).toDouble(), entry["keyLength"])
    }

    @Test
    fun manyLargeKeysPageWithoutLossOrDuplicates() {
        for (i in 0 until 40) prefsFile.values["key%02d".format(i)] = "\u0001".repeat(MAX_STORAGE_VALUE_UNITS)
        val seen = ArrayList<String>()
        var cursor: String? = null
        var pagesRead = 0
        do {
            val line = readLine("prefs", "app", cursor)
            assertUnderCap(line)
            val answer = json(line)
            val keys = (answer["entries"] as List<*>).map { (it as Map<*, *>)["key"] as String }
            assertTrue(keys.isNotEmpty())
            seen += keys
            cursor = answer["nextCursor"] as String?
            pagesRead++
        } while (cursor != null)
        assertEquals((0 until 40).map { "key%02d".format(it) }, seen)
        assertTrue(pagesRead > 1)
    }

    @Test
    fun wideCompositeKeysStayUnderTheCapAndPageExactly() {
        val columns = (1..20).map { "k$it" }
        db.exec("CREATE TABLE wide (${columns.joinToString { "$it TEXT" }}, PRIMARY KEY (${columns.joinToString()}))")
        insert(
            "INSERT INTO wide VALUES (${columns.joinToString { "?" }})",
            *(0 until 15).map { row -> columns.map { "%02d".format(row) + "\u00e9".repeat(998) } }.toTypedArray(),
        )
        val seen = ArrayList<String>()
        var cursor: String? = null
        do {
            val line = readLine("db", "app.db", pages = "[${pageRequest("wide", cursor, 15)}]")
            assertUnderCap(line)
            val page = pages(line).single()
            seen += rows(page).map { (it[0]["v"] as String).take(2) }
            cursor = page["nextCursor"] as String?
        } while (cursor != null)
        assertEquals((0 until 15).map { "%02d".format(it) }, seen)
    }

    @Test
    fun aRowLargerThanAnyAnswerIsSentCutAndPagingMovesOn() {
        val columns = (1..20).map { "c$it" }
        db.exec("CREATE TABLE fat (id INTEGER PRIMARY KEY, ${columns.joinToString { "$it TEXT" }})")
        // 20 cells of 16 K control characters: 6 bytes each escaped, ~2 MB a row.
        insert(
            "INSERT INTO fat VALUES (?, ${columns.joinToString { "?" }})",
            *(1..3).map { id -> listOf<Any?>(id.toLong()) + columns.map { "\u0001".repeat(MAX_STORAGE_VALUE_UNITS) } }.toTypedArray(),
        )
        val seen = ArrayList<String>()
        var cursor: String? = null
        do {
            val line = readLine("db", "app.db", pages = "[${pageRequest("fat", cursor)}]")
            assertUnderCap(line)
            val page = pages(line).single()
            val rows = rows(page)
            assertEquals(1, rows.size)
            assertEquals(true, page["truncated"])
            assertEquals(false, rows[0][1]["complete"])
            assertEquals(MAX_STORAGE_VALUE_UNITS.toDouble(), rows[0][1]["length"])
            seen += rows[0][0]["v"] as String
            // The digest is of the whole row: a delete still names it.
            assertNotNull(((page["rows"] as List<*>)[0] as Map<*, *>)["digest"])
            cursor = page["nextCursor"] as String?
        } while (cursor != null)
        assertEquals(listOf("1", "2", "3"), seen)
    }

    @Test
    fun fourPagesShareOneAnswerAndAPageWithoutRoomIsReadAgain() {
        db.exec("CREATE TABLE big (id INTEGER PRIMARY KEY, body TEXT)")
        insert("INSERT INTO big VALUES (?, ?)", *(1..30).map { listOf<Any?>(it.toLong(), "x".repeat(MAX_STORAGE_VALUE_UNITS)) }.toTypedArray())
        val request = (1..4).joinToString(",", "[", "]") { pageRequest("big", limit = 20) }
        val line = readLine("db", "app.db", pages = request)
        assertUnderCap(line)
        val all = pages(line)
        assertEquals(4, all.size)
        val first = all[0]
        assertEquals(true, first["truncated"])
        assertTrue(rows(first).isNotEmpty())
        // The later pages found no room: no rows, and a cursor that reads them from where they started.
        val last = all[3]
        assertTrue(rows(last).isEmpty())
        assertEquals(true, last["truncated"])
        val again = pages(readLine("db", "app.db", pages = "[${pageRequest("big", last["nextCursor"] as String, 20)}]")).single()
        assertEquals("1", rows(again)[0][0]["v"])
        // And the first page continues right after its last row.
        val shown = rows(first).size
        val next = pages(readLine("db", "app.db", pages = "[${pageRequest("big", first["nextCursor"] as String, 20)}]")).single()
        assertEquals((shown + 1).toString(), rows(next)[0][0]["v"])
    }

    // --- constraints on delete ----------------------------------------------------------------------------------

    private fun write(store: String, expected: String?, value: String? = null, key: String? = null, table: String? = null, column: String? = null, pk: String? = null, op: String = "update", rowDigest: String? = null): String {
        val lines = ArrayList<String>()
        val name = if (store == "prefs") "app" else "app.db"
        inspector.write(GatewayMessage.StorageWrite(7, "op1", store, name, op, key, table, column, pk, expected, value, rowDigest)) { lines += it }
        return lines.single()
    }

    @Test
    fun aForeignKeyRefusingADeleteIsAConstraintAndRollsBack() {
        db.exec(
            "PRAGMA foreign_keys = ON",
            "CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT)",
            "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))",
            "INSERT INTO parent VALUES (1, 'p')",
            "INSERT INTO child VALUES (10, 1)",
        )
        val digest = ((pages(readLine("db", "app.db", pages = "[${pageRequest("parent")}]")).single()["rows"] as List<*>)[0] as Map<*, *>)["digest"] as String
        val answer = json(write("db", null, table = "parent", pk = """[{"t":"integer","v":"1"}]""", op = "delete", rowDigest = digest))
        assertEquals("constraint_failed", answer["code"])
        assertEquals(1, db.connection.createStatement().executeQuery("SELECT count(*) FROM parent").let { it.next(); it.getInt(1) })
        // An UPDATE refused by a foreign key too.
        val update = json(write("db", """{"t":"integer","v":"1"}""", """{"t":"integer","v":"99"}""", table = "child", column = "parent_id", pk = """[{"t":"integer","v":"10"}]"""))
        assertEquals("constraint_failed", update["code"])
        assertEquals(1, db.connection.createStatement().executeQuery("SELECT parent_id FROM child").let { it.next(); it.getInt(1) })
    }

    @Test
    fun tablesOfADeferredForeignKeyAreNotEdited() {
        db.exec(
            "PRAGMA foreign_keys = ON",
            "CREATE TABLE artist (id INTEGER PRIMARY KEY, name TEXT)",
            "CREATE TABLE track (id INTEGER PRIMARY KEY, artist INTEGER REFERENCES artist(id) DEFERRABLE INITIALLY DEFERRED, title TEXT)",
            "CREATE TABLE plain (id INTEGER PRIMARY KEY, v TEXT)",
            "INSERT INTO artist VALUES (1, 'a')",
            "INSERT INTO track VALUES (1, 1, 't')",
            "INSERT INTO plain VALUES (1, 'x')",
        )
        // Child and parent alike (a COMMIT failing on it would leave the app's connection in the transaction).
        assertEquals(
            "unsupported:deferred_fk",
            json(write("db", """{"t":"string","v":"t"}""", """{"t":"string","v":"u"}""", table = "track", column = "title", pk = """[{"t":"integer","v":"1"}]"""))["code"],
        )
        assertEquals(
            "unsupported:deferred_fk",
            json(write("db", """{"t":"string","v":"a"}""", """{"t":"string","v":"b"}""", table = "artist", column = "name", pk = """[{"t":"integer","v":"1"}]"""))["code"],
        )
        assertEquals(
            "ok",
            json(write("db", """{"t":"string","v":"x"}""", """{"t":"string","v":"y"}""", table = "plain", column = "v", pk = """[{"t":"integer","v":"1"}]"""))["code"],
        )
    }

    @Test
    fun aConstraintFailingAtCommitIsAConstraintToo() {
        // The fake's COMMIT fails like Android's does on a deferred constraint (reached here with the guard bypassed:
        // a deferred key declared through PRAGMA defer_foreign_keys rather than in the schema).
        val failing = object : TrackedDatabase {
            override fun status() = "ok"
            override fun <T> inTransaction(block: (SqlConnection) -> T): T {
                db.inTransaction(block)
                throw SqlConstraintException("FOREIGN KEY constraint failed")
            }
        }
        db.exec("CREATE TABLE plain (id INTEGER PRIMARY KEY, v TEXT)", "INSERT INTO plain VALUES (1, 'x')")
        val inspector = StorageInspector(prefs, registry("app.db" to failing), ManualCommits().runner)
        val lines = ArrayList<String>()
        inspector.write(
            GatewayMessage.StorageWrite(7, "op1", "db", "app.db", "update", null, "plain", "v", """[{"t":"integer","v":"1"}]""", """{"t":"string","v":"x"}""", """{"t":"string","v":"y"}""", null),
        ) { lines += it }
        assertEquals("constraint_failed", json(lines.single())["code"])
    }

    // --- listing size, nullable primary keys --------------------------------------------------------------------

    @Test
    fun aListingOfNamesThatNeedEscapingStaysUnderTheCapAndSaysItWasCut() {
        // Names of allowed length whose every char is sent as \uXXXX (6 bytes): 128 prefs files and 16 databases
        // would make 286 KB, over the cap and the gateway's line limit.
        val control = "\u0001"
        val files = (0 until MAX_STORAGE_PREFS_FILES).associate { i -> "%03d".format(i) + control.repeat(252) to FakePrefs() }
        val many = FakePrefsAccess(LinkedHashMap(files))
        val dbs = DatabaseRegistry().apply {
            for (i in 0 until MAX_STORAGE_DATABASES) register("%02d".format(i) + control.repeat(MAX_STORAGE_NAME_CHARS - 2), JdbcDatabase())
        }
        val line = StorageInspector(many, dbs, ManualCommits().runner).list(4)
        assertTrue(utf8Bytes(line).toString(), utf8Bytes(line) <= MAX_STORAGE_REPLY_BYTES)
        val list = json(line)
        assertEquals("ok", list["code"])
        assertEquals(MAX_STORAGE_DATABASES, (list["databases"] as List<*>).size)
        val listed = (list["prefs"] as List<*>).map { (it as Map<*, *>)["name"] as String }
        assertTrue(listed.size in 1 until MAX_STORAGE_PREFS_FILES)
        assertEquals(files.keys.sorted().take(listed.size), listed)
        assertEquals(true, list["prefsTruncated"])
        // Still a valid answer of the protocol (escaped names are exact after parsing).
        assertTrue(listed.all { it.endsWith(control.repeat(252)) })
    }

    @Test
    fun aSmallListingIsWholeAndNotTruncated() {
        val list = json(inspector.list(5))
        assertEquals(listOf("app"), (list["prefs"] as List<*>).map { (it as Map<*, *>)["name"] })
        assertEquals(false, list["prefsTruncated"])
        assertEquals(listOf("app.db"), (list["databases"] as List<*>).map { (it as Map<*, *>)["name"] })
    }

    @Test
    fun aListingWhoseDatabasesAloneOverrunTheCapIsRefusedNotSent() {
        val dbs = registry("x".repeat(MAX_STORAGE_NAME_CHARS) to JdbcDatabase())
        val line = StorageInspector(prefs, dbs, ManualCommits().runner, maxReplyBytes = 512).list(6)
        assertTrue(utf8Bytes(line) <= 512)
        assertEquals("invalid_value:too_large", json(line)["code"])
    }

    private fun walk(table: String, column: String): List<String> {
        val seen = ArrayList<String>()
        var cursor: String? = null
        var guard = 0
        do {
            val page = pages(readLine("db", "app.db", pages = "[" + pageRequest(table, cursor, 1) + "]")).single()
            val index = (page["columns"] as List<*>).indexOf(column)
            rows(page).forEach { seen += it[index]["v"] as String }
            cursor = page["nextCursor"] as String?
        } while (cursor != null && ++guard < 20)
        return seen
    }

    @Test
    fun pagingANullablePrimaryKeyReadsEveryRowOnce() {
        db.exec(
            "CREATE TABLE single (k TEXT PRIMARY KEY, v TEXT)",
            "INSERT INTO single VALUES (NULL, 'first'), (NULL, 'second'), ('x', 'third'), (NULL, 'fourth'), ('a', 'fifth')",
            "CREATE TABLE pair (a TEXT, b INTEGER, v TEXT, PRIMARY KEY (a, b))",
            "INSERT INTO pair VALUES (NULL, NULL, 'p1'), (NULL, NULL, 'p2'), (NULL, 1, 'p3'), ('k', NULL, 'p4'), ('k', NULL, 'p5'), ('k', 1, 'p6')",
        )
        assertEquals(listOf("first", "second", "fourth", "fifth", "third"), walk("single", "v"))
        assertEquals(setOf("p1", "p2", "p3", "p4", "p5", "p6"), walk("pair", "v").also { assertEquals(6, it.size) }.toSet())
        // Paging by rowid opens no edit: a NULL key still finds no row.
        val write = mutableListOf<String>()
        inspector.write(GatewayMessage.StorageWrite(9, "op9", "db", "app.db", "update", null, "single", "v", """[{"t":"null"}]""",
            """{"t":"string","v":"first"}""", """{"t":"string","v":"z"}""", null)) { write += it }
        assertEquals("not_found", json(write.single())["code"])
        assertEquals(0L, db.connection.createStatement().executeQuery("SELECT count(*) FROM single WHERE v = 'z'").let { it.next(); it.getLong(1) })
    }

    @Test
    fun aNotNullOrWithoutRowidKeyPagesByTheKeyAlone() {
        db.exec(
            "CREATE TABLE strict_key (k TEXT NOT NULL PRIMARY KEY, v TEXT)",
            "INSERT INTO strict_key VALUES ('b', '2'), ('a', '1'), ('c', '3')",
            "CREATE TABLE wr (k TEXT PRIMARY KEY, v TEXT) /* c */ WITHOUT \uFEFFROWID",
            "INSERT INTO wr VALUES ('b', '2'), ('a', '1')",
        )
        assertEquals(listOf("1", "2", "3"), walk("strict_key", "v"))
        assertEquals(listOf("1", "2"), walk("wr", "v"))
        val tables = (json(readLine("db", "app.db"))["tables"] as List<*>).map { it as Map<*, *> }.associateBy { it["name"] }
        assertEquals(true, tables["wr"]!!["withoutRowid"])
    }

}
