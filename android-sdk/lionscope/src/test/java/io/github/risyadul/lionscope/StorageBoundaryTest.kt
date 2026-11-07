package io.github.risyadul.lionscope

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Boundaries of the SDK side: a cut prefs key keeps its identity, a
 * row digest covers every column, a write's answer stays under the cap whatever the app stored,
 * the provisional answer always precedes the final one, and edits that could fail at COMMIT
 * on a deferred foreign key are refused before any SQL, and said so in the schema.
 */
class StorageBoundaryTest {
    private val app = FakePrefs()
    private val prefs = FakePrefsAccess(linkedMapOf("app" to app))
    private val db = JdbcDatabase()
    private val commits = ManualCommits()
    private val inspector = StorageInspector(prefs, registry("app.db" to db), commits.runner)

    @After
    fun close() = db.close()

    private fun json(line: String) = TestJson.parse(line) as Map<*, *>

    private fun quote(text: String) = JsonWriter().beginArray().value(text).endArray().toString().removeSurrounding("[", "]")

    private fun read(store: String, name: String, pages: String? = null) =
        inspector.read(GatewayMessage.StorageRead(1, store, name, null, null, pages))

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
        target: StorageInspector = inspector,
    ): List<String> {
        val lines = ArrayList<String>()
        val name = if (store == "prefs") "app" else "app.db"
        target.write(GatewayMessage.StorageWrite(7, "op1", store, name, op, key, table, column, pk, expected, value, rowDigest)) { lines += it }
        return lines
    }

    private fun scalar(sql: String): Long = db.connection.createStatement().executeQuery(sql).let { it.next(); it.getLong(1) }

    private fun tables(): Map<String, Map<*, *>> =
        (json(read("db", "app.db"))["tables"] as List<*>).map { it as Map<*, *> }.associateBy { it["name"] as String }

    // --- a cut key -----------------------------------------------------------------------------------------------

    @Test
    fun aCutKeyIsSentWithItsLengthNextToTheKeyItsPrefixNames() {
        val prefix = "k".repeat(MAX_STORAGE_KEY_UNITS)
        app.values[prefix] = 3
        app.values[prefix + "suffix"] = 3
        val entries = (json(read("prefs", "app"))["entries"] as List<*>).map { it as Map<*, *> }
        assertEquals(2, entries.size)
        // Both show the same key; only keyLength tells the long one (and that it can't be named in a write).
        assertEquals(listOf(prefix, prefix), entries.map { it["key"] })
        assertEquals(listOf(null, MAX_STORAGE_KEY_UNITS + 6), entries.map { (it["keyLength"] as Number?)?.toInt() })
        // What the cut key names in a write is the other key: why no client may offer it for editing.
        val answer = json(write("prefs", "update", """{"t":"int","v":"3"}""", """{"t":"int","v":"4"}""", key = prefix).single())
        assertEquals("ok", answer["code"])
        assertEquals(4, app.values[prefix])
        assertEquals(3, app.values[prefix + "suffix"])
    }

    // --- digests cover every column ------------------------------------------------------------------------------

    private fun wideTable(columns: Int) {
        val names = (1..columns).joinToString(", ") { "c$it TEXT" }
        db.exec("CREATE TABLE wide (id INTEGER PRIMARY KEY, $names)")
        val values = (1..columns).joinToString(", ") { "'before'" }
        db.exec("INSERT INTO wide VALUES (1, $values)")
    }

    @Test
    fun aTableWiderThanWhatIsSentIsReadOnlyAndItsDigestCoversEveryColumn() {
        wideTable(MAX_STORAGE_COLUMNS) // 257 columns with the key.
        val schema = tables().getValue("wide")
        assertEquals("truncated", schema["readOnly"])
        assertEquals(MAX_STORAGE_COLUMNS, (schema["columns"] as List<*>).size)
        assertEquals(listOf("id"), schema["pk"])
        val page = (json(read("db", "app.db", pages = """[{"table":"wide"}]"""))["pages"] as List<*>).single() as Map<*, *>
        assertEquals(MAX_STORAGE_COLUMNS, (page["columns"] as List<*>).size)
        assertEquals("truncated", page["readOnly"])
        assertNull(((page["rows"] as List<*>).single() as Map<*, *>)["digest"])
        // Nothing of it is edited: not the row, not a cell.
        assertEquals(
            "read_only:truncated",
            json(write("db", "delete", null, table = "wide", pk = """[{"t":"integer","v":"1"}]""", rowDigest = "0".repeat(64)).single())["code"],
        )
        assertEquals(
            "read_only:truncated",
            json(write("db", "update", """{"t":"string","v":"before"}""", """{"t":"string","v":"x"}""", table = "wide", column = "c1", pk = """[{"t":"integer","v":"1"}]""").single())["code"],
        )
        assertEquals(1L, scalar("SELECT count(*) FROM wide"))
        // A column past the ones sent may still be asked for by name (a page sends at most MAX_STORAGE_COLUMNS).
        val last = (json(read("db", "app.db", pages = """[{"table":"wide","columns":["c$MAX_STORAGE_COLUMNS"]}]"""))["pages"] as List<*>).single() as Map<*, *>
        assertEquals(listOf("c$MAX_STORAGE_COLUMNS"), last["columns"])
    }

    @Test
    fun aDeleteConflictsWhenTheLastColumnChangedSinceTheRead() {
        wideTable(MAX_STORAGE_COLUMNS - 1) // 256 columns with the key: all sent, editable.
        val page = (json(read("db", "app.db", pages = """[{"table":"wide"}]"""))["pages"] as List<*>).single() as Map<*, *>
        val digest = ((page["rows"] as List<*>).single() as Map<*, *>)["digest"] as String
        db.exec("UPDATE wide SET c${MAX_STORAGE_COLUMNS - 1} = 'after' WHERE id = 1")
        val answer = json(write("db", "delete", null, table = "wide", pk = """[{"t":"integer","v":"1"}]""", rowDigest = digest).single())
        assertEquals("conflict", answer["code"])
        assertEquals(1L, scalar("SELECT count(*) FROM wide"))
        // The digest is over all of the row: one column fewer gives another one.
        val raw = db.connection.createStatement().executeQuery("SELECT * FROM wide").let { rs ->
            rs.next()
            (1..rs.metaData.columnCount).map { rs.getObject(it).let { v -> if (v is Int) v.toLong() else v } }
        }
        assertEquals(RowDigest.of(raw), (((json(read("db", "app.db", pages = """[{"table":"wide"}]"""))["pages"] as List<*>).single() as Map<*, *>)["rows"] as List<*>).let { (it.single() as Map<*, *>)["digest"] })
        assertFalse(RowDigest.of(raw) == RowDigest.of(raw.dropLast(1)))
    }

    // --- a write's answer under the cap --------------------------------------------------------------------------

    @Test
    fun aTriggerThatGrowsTheCellLeavesAnHonestAnswerUnderTheCap() {
        db.exec(
            "CREATE TABLE doc (id INTEGER PRIMARY KEY, body BLOB, note TEXT)",
            "INSERT INTO doc VALUES (1, x'00', 'a')",
            // After the edit the app's trigger makes both cells far larger than anything that may be sent.
            "CREATE TRIGGER grow AFTER UPDATE OF body ON doc BEGIN " +
                "UPDATE doc SET body = zeroblob(300000), note = substr(hex(zeroblob(150000)), 1, 300000) WHERE id = NEW.id; END",
        )
        val lines = write("db", "update", """{"t":"blob","b64":"AA==","size":1,"complete":true}""", """{"t":"blob","b64":"AQ==","size":1,"complete":true}""", table = "doc", column = "body", pk = """[{"t":"integer","v":"1"}]""")
        val line = lines.single()
        assertTrue("${utf8Bytes(line)} bytes", utf8Bytes(line) <= MAX_STORAGE_REPLY_BYTES)
        val answer = json(line)
        // Committed, and said so: not rolled back, not reported as nothing written.
        assertEquals("ok", answer["code"])
        assertEquals(1L, (answer["changes"] as Number).toLong())
        assertEquals(300000L, scalar("SELECT length(body) FROM doc"))
        // What is stored now, cut: read-only, so never an undo's expected.
        val stored = answer["stored"] as Map<*, *>
        assertEquals(false, stored["complete"])
        assertEquals(300000L, (stored["size"] as Number).toLong())
        assertEquals(true, answer["normalized"])
        // The protocol (and so the server) takes it.
        assertTrue(line.length < 262144)
    }

    @Test
    fun aCellTooLargeToSendIsRefusedReadOnlyWithASmallAnswer() {
        db.exec("CREATE TABLE doc (id INTEGER PRIMARY KEY, note TEXT)", "INSERT INTO doc VALUES (1, 'a')")
        db.exec("UPDATE doc SET note = substr(hex(zeroblob(200000)), 1, 400000) WHERE id = 1")
        // Its current value is never sent back whole (nor compared: it was never sent whole to be expected).
        val line = write("db", "update", """{"t":"string","v":"a"}""", """{"t":"string","v":"b"}""", table = "doc", column = "note", pk = """[{"t":"integer","v":"1"}]""").single()
        assertTrue("${utf8Bytes(line)} bytes", utf8Bytes(line) < 1024)
        assertEquals("read_only:truncated", json(line)["code"])
        assertEquals(400000L, scalar("SELECT length(note) FROM doc"))
    }

    @Test
    fun aValueCutForTheWireIsMarkedIncomplete() {
        val text = StorageCut.forWire(StorageValue.Text("x".repeat(MAX_STORAGE_VALUE_UNITS + 1))) as StorageValue.Text
        assertFalse(text.complete)
        assertEquals(MAX_STORAGE_VALUE_UNITS, text.value.length)
        assertEquals(MAX_STORAGE_VALUE_UNITS + 1, text.length)
        val blob = StorageCut.forWire(StorageValue.Blob(ByteArray(MAX_STORAGE_VALUE_UNITS + 1), MAX_STORAGE_VALUE_UNITS + 1, true)) as StorageValue.Blob
        assertFalse(blob.complete)
        assertEquals(MAX_STORAGE_VALUE_UNITS, blob.bytes.size)
        val set = StorageCut.forWire(StorageValue.StringSet((1..600).map { "e$it" }.toSet())) as StorageValue.StringSet
        assertFalse(set.complete)
        assertTrue(set.values.size <= MAX_STORAGE_SET_ELEMENTS)
        val small = StorageValue.Text("ok")
        assertTrue(StorageCut.forWire(small) === small)
    }

    @Test
    fun aPrefsReadBackChangedByAnotherWriterToSomethingLargeIsCut() {
        app.values["name"] = "Ana"
        // Another writer, between the commit and the read back.
        val other = object : SharedPreferencesProxy(app) {
            var reads = 0

            override fun getAll(): Map<String, *> {
                reads++
                if (reads == 2) app.values["name"] = "x".repeat(300_000)
                return super.getAll()
            }
        }
        val inspector = StorageInspector(FakePrefsAccess(linkedMapOf()).also { it.files["app"] = app }.let { access ->
            object : PrefsAccess by access {
                override fun open(name: String) = other
            }
        }, DatabaseRegistry(), commits.runner)
        val line = write("prefs", "update", """{"t":"string","v":"Ana"}""", """{"t":"string","v":"Bo"}""", key = "name", target = inspector).single()
        assertTrue("${utf8Bytes(line)} bytes", utf8Bytes(line) <= MAX_STORAGE_REPLY_BYTES)
        val answer = json(line)
        assertEquals("concurrent_after_write", answer["code"])
        assertEquals(false, (answer["stored"] as Map<*, *>)["complete"])
    }

    @Test
    fun aWrittenSetLargerThanOneValueSentIsStillReportedApplied() {
        app.values["tags"] = setOf("a")
        val big = (1..40).map { "e$it-" + "y".repeat(500) }
        val value = "{\"t\":\"stringSet\",\"v\":[" + big.sorted().joinToString(",") { quote(it) } + "]}"
        val answer = json(write("prefs", "update", """{"t":"stringSet","v":["a"]}""", value, key = "tags").single())
        // Compared whole: applied, though what is sent back is cut (read-only, no undo).
        assertEquals("ok", answer["code"])
        assertEquals("applied", answer["memory"])
        assertEquals(false, (answer["stored"] as Map<*, *>)["complete"])
    }

    @Test
    fun anAnswerIsCutFurtherWhenTheCapIsSmallerStill() {
        db.exec("CREATE TABLE doc (id INTEGER PRIMARY KEY, note TEXT)", "INSERT INTO doc VALUES (1, 'a')")
        db.exec("UPDATE doc SET note = '" + "\u00e9".repeat(MAX_STORAGE_VALUE_UNITS) + "' WHERE id = 1")
        val small = StorageInspector(prefs, registry("app.db" to db), commits.runner, maxReplyBytes = 4096)
        val line = write("db", "update", """{"t":"string","v":"a"}""", """{"t":"string","v":"b"}""", table = "doc", column = "note", pk = """[{"t":"integer","v":"1"}]""", target = small).single()
        assertTrue("${utf8Bytes(line)} bytes", utf8Bytes(line) <= 4096)
        assertEquals("conflict", json(line)["code"])
    }

    // --- provisional, then final ---------------------------------------------------------------------------------

    @Test
    fun aCommitThatEndsWhileTheProvisionalAnswerIsBeingSentStillComesSecond() {
        app.values["dark"] = true
        commits.hold = true
        val order = ArrayList<String>()
        inspector.write(
            GatewayMessage.StorageWrite(7, "op1", "prefs", "app", "update", "dark", null, null, null, """{"t":"bool","v":true}""", """{"t":"bool","v":false}""", null),
        ) { line ->
            val phase = json(line)["phase"] as String
            // The commit finishes on its thread right as the provisional answer goes out (the review's interleaving).
            if (phase == "provisional") commits.release()
            order += phase
        }
        assertEquals(listOf("provisional", "final"), order)
    }

    @Test
    fun aCommitThatEndsOnItsOwnThreadAfterTheProvisionalAnswerSendsTheFinalOnceFromThere() {
        app.values["dark"] = true
        val started = CountDownLatch(1)
        val finish = CountDownLatch(1)
        var commitThread: Thread? = null
        val runner = CommitRunner({ task ->
            commitThread = Thread { started.countDown(); finish.await(5, TimeUnit.SECONDS); task.run() }.apply { start() }
        })
        val inspector = StorageInspector(prefs, DatabaseRegistry(), runner)
        val answers = java.util.Collections.synchronizedList(ArrayList<Pair<String, String>>())
        inspector.write(
            GatewayMessage.StorageWrite(7, "op1", "prefs", "app", "update", "dark", null, null, null, """{"t":"bool","v":true}""", """{"t":"bool","v":false}""", null),
        ) { answers += (json(it)["phase"] as String) to Thread.currentThread().name }
        assertTrue(started.await(5, TimeUnit.SECONDS))
        assertEquals(listOf("provisional"), answers.map { it.first })
        finish.countDown()
        commitThread!!.join(5_000)
        assertEquals(listOf("provisional", "final"), answers.map { it.first })
        assertEquals(commitThread!!.name, answers[1].second)
    }

    @Test
    fun whenDoneRunsOnceWhicheverSideFinishesFirst() {
        val held = ArrayList<Runnable>()
        val runner = CommitRunner({ held += it })
        // The commit finishes before whenDone: run at once, on the caller's thread.
        val early = runner.commit({ true }, budgetMs = 1)
        assertNull(early.persisted)
        held.removeAt(0).run()
        val got = ArrayList<Boolean>()
        early.whenDone { persisted, _ -> got += persisted }
        assertEquals(listOf(true), got)
        // whenDone before the commit finishes: run by the commit, once.
        val late = runner.commit({ false }, budgetMs = 1)
        late.whenDone { persisted, _ -> got += persisted }
        assertEquals(listOf(true), got)
        held.removeAt(0).run()
        assertEquals(listOf(true, false), got)
        // A second whenDone is a bug, not a second final answer.
        assertEquals(
            "whenDone is for a commit still running, once",
            runCatching { late.whenDone { _, _ -> got += true } }.exceptionOrNull()?.message,
        )
        assertEquals(listOf(true, false), got)
    }

    // --- deferred foreign keys -----------------------------------------------------------------------------------

    @Test
    fun theSchemaSaysWhichTablesCouldFailAtCommitOnADeferredKey() {
        db.exec(
            "PRAGMA foreign_keys = ON",
            "CREATE TABLE artist (id INTEGER PRIMARY KEY, name TEXT)",
            "CREATE TABLE track (id INTEGER PRIMARY KEY, artist INTEGER REFERENCES artist(id) DEFERRABLE INITIALLY DEFERRED, title TEXT)",
            // Deleting a label cascades into artist (a parent of the deferred key): could fail at COMMIT too.
            "CREATE TABLE label (id INTEGER PRIMARY KEY, name TEXT)",
            "ALTER TABLE artist ADD COLUMN label INTEGER REFERENCES label(id) ON DELETE CASCADE",
            // A trigger may write anywhere (here: into track).
            "CREATE TABLE audit (id INTEGER PRIMARY KEY, v TEXT)",
            "CREATE TRIGGER audit_touch AFTER UPDATE ON audit BEGIN UPDATE track SET artist = 99 WHERE id = 1; END",
            // An immediate key, a NOT DEFERRABLE INITIALLY DEFERRED one (immediate), and a plain table: editable.
            "CREATE TABLE owner (id INTEGER PRIMARY KEY)",
            "CREATE TABLE pet (id INTEGER PRIMARY KEY, owner INTEGER REFERENCES owner(id) NOT DEFERRABLE INITIALLY DEFERRED, name TEXT)",
            "CREATE TABLE plain (id INTEGER PRIMARY KEY, v TEXT)",
            "INSERT INTO label VALUES (1, 'l')",
            "INSERT INTO artist VALUES (1, 'a', 1)",
            "INSERT INTO track VALUES (1, 1, 't')",
            "INSERT INTO audit VALUES (1, 'x')",
            "INSERT INTO plain VALUES (1, 'x')",
        )
        val readOnly = tables().mapValues { it.value["readOnly"] }
        for (table in listOf("artist", "track", "label", "audit")) assertEquals(table, "unsupported:deferred_fk", readOnly[table])
        for (table in listOf("owner", "pet", "plain")) assertNull(table, readOnly[table])
        // Pages say so too (and carry no digest), and every write to them is refused before any SQL changes a row.
        val page = (json(read("db", "app.db", pages = """[{"table":"label"}]"""))["pages"] as List<*>).single() as Map<*, *>
        assertEquals("unsupported:deferred_fk", page["readOnly"])
        assertNull(((page["rows"] as List<*>).single() as Map<*, *>)["digest"])
        assertEquals(
            "unsupported:deferred_fk",
            json(write("db", "delete", null, table = "label", pk = """[{"t":"integer","v":"1"}]""", rowDigest = "0".repeat(64)).single())["code"],
        )
        assertEquals(
            "unsupported:deferred_fk",
            json(write("db", "update", """{"t":"string","v":"x"}""", """{"t":"string","v":"y"}""", table = "audit", column = "v", pk = """[{"t":"integer","v":"1"}]""").single())["code"],
        )
        assertEquals(1L, scalar("SELECT artist FROM track WHERE id = 1"))
        assertEquals(1L, scalar("SELECT count(*) FROM label"))
        assertEquals("ok", json(write("db", "update", """{"t":"string","v":"x"}""", """{"t":"string","v":"y"}""", table = "plain", column = "v", pk = """[{"t":"integer","v":"1"}]""").single())["code"])
    }

    @Test
    fun aLowerCaseDeferredKeyIsFoundEvenWithCaseSensitiveLike() {
        // The app's connection is the inspector's connection, so its pragmas apply: with case_sensitive_like ON a
        // `LIKE '%DEFERRED%'` prefilter would miss hand-written lower-case DDL and leave the table editable.
        db.exec(
            "PRAGMA foreign_keys = ON",
            "PRAGMA case_sensitive_like = ON",
            "create table artist (id integer primary key, name text)",
            "create table track (id integer primary key, artist integer references artist(id) deferrable initially deferred, title text)",
            "create table plain (id integer primary key, v text)",
            "insert into artist values (1, 'a')",
            "insert into track values (1, 1, 't')",
            "insert into plain values (1, 'x')",
        )
        assertEquals(0L, scalar("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND sql LIKE '%DEFERRED%'"))
        val readOnly = tables().mapValues { it.value["readOnly"] }
        for (table in listOf("artist", "track")) assertEquals(table, "unsupported:deferred_fk", readOnly[table])
        assertNull(readOnly["plain"])
        assertEquals(
            "unsupported:deferred_fk",
            json(write("db", "update", """{"t":"integer","v":"1"}""", """{"t":"integer","v":"99"}""", table = "track", column = "artist", pk = """[{"t":"integer","v":"1"}]""").single())["code"],
        )
        assertEquals(1L, scalar("SELECT artist FROM track WHERE id = 1"))
    }

    @Test
    fun aDeferredKeyWrittenWithCommentsIsStillFound() {
        // SQLite keeps the DDL as written, comments included; the guard must read through them.
        db.exec(
            "PRAGMA foreign_keys = ON",
            "CREATE TABLE parent (id INTEGER PRIMARY KEY)",
            "CREATE TABLE block (id INTEGER PRIMARY KEY, p INTEGER REFERENCES parent(id) DEFERRABLE /* c */ INITIALLY DEFERRED, v TEXT)",
            "CREATE TABLE line (id INTEGER PRIMARY KEY, p INTEGER REFERENCES parent(id) DEFERRABLE -- c\n INITIALLY\tDEFERRED, v TEXT)",
            "CREATE TABLE glued (id INTEGER PRIMARY KEY, p INTEGER REFERENCES parent(id) DEFERRABLE/**/INITIALLY/**/DEFERRED, v TEXT)",
            // Immediate, with a comment between NOT and DEFERRABLE, and a comment marker inside a string: editable.
            "CREATE TABLE owner (id INTEGER PRIMARY KEY)",
            "CREATE TABLE pet (id INTEGER PRIMARY KEY, o INTEGER REFERENCES owner(id) NOT /* c */ DEFERRABLE INITIALLY DEFERRED, v TEXT DEFAULT '/* DEFERRED')",
            "INSERT INTO parent VALUES (1)",
            "INSERT INTO block VALUES (1, 1, 'x')",
            "INSERT INTO line VALUES (1, 1, 'x')",
            "INSERT INTO glued VALUES (1, 1, 'x')",
            "INSERT INTO owner VALUES (1)",
            "INSERT INTO pet VALUES (1, 1, 'x')",
        )
        val readOnly = tables().mapValues { it.value["readOnly"] }
        for (table in listOf("parent", "block", "line", "glued")) assertEquals(table, "unsupported:deferred_fk", readOnly[table])
        for (table in listOf("owner", "pet")) assertNull(table, readOnly[table])
        for (table in listOf("block", "line", "glued")) {
            assertEquals(
                table,
                "unsupported:deferred_fk",
                json(write("db", "update", """{"t":"integer","v":"1"}""", """{"t":"integer","v":"99"}""", table = table, column = "p", pk = """[{"t":"integer","v":"1"}]""").single())["code"],
            )
            assertEquals(table, 1L, scalar("SELECT p FROM $table WHERE id = 1"))
        }
        assertEquals(
            "unsupported:deferred_fk",
            json(write("db", "delete", null, table = "parent", pk = """[{"t":"integer","v":"1"}]""", rowDigest = "0".repeat(64)).single())["code"],
        )
        assertEquals(1L, scalar("SELECT count(*) FROM parent"))
    }

    @Test
    fun aDeferredKeyBehindAByteOrderMarkIsStillFound() {
        // SQLite's tokenizer takes a UTF-8 byte order mark for a separator.
        db.exec(
            "PRAGMA foreign_keys = ON",
            "CREATE TABLE parent (id INTEGER PRIMARY KEY)",
            "CREATE TABLE child (id INTEGER PRIMARY KEY, p INTEGER REFERENCES parent(id) DEFERRABLE \uFEFF INITIALLY \uFEFFDEFERRED, v TEXT)",
            "INSERT INTO parent VALUES (1)",
            "INSERT INTO child VALUES (1, 1, 'x')",
        )
        val readOnly = tables().mapValues { it.value["readOnly"] }
        for (table in listOf("parent", "child")) assertEquals(table, "unsupported:deferred_fk", readOnly[table])
        assertEquals(
            "unsupported:deferred_fk",
            json(write("db", "update", """{"t":"integer","v":"1"}""", """{"t":"integer","v":"99"}""", table = "child", column = "p", pk = """[{"t":"integer","v":"1"}]""").single())["code"],
        )
        assertEquals(
            "unsupported:deferred_fk",
            json(write("db", "delete", null, table = "parent", pk = """[{"t":"integer","v":"1"}]""", rowDigest = "0".repeat(64)).single())["code"],
        )
        assertEquals(1L, scalar("SELECT p FROM child WHERE id = 1"))
        assertEquals(1L, scalar("SELECT count(*) FROM parent"))
    }

    @Test
    fun ddlIsReadTokenByTokenAndUnreadableDdlCountsAsDeferred() {
        val deferred = listOf(
            "CREATE TABLE t (p REFERENCES q(id) DEFERRABLE INITIALLY DEFERRED)",
            "create table t (p references q(id) deferrable\r\n\u000cinitially   deferred)",
            "CREATE TABLE t (p REFERENCES q(id) DEFERRABLE /* a */ /* b */ INITIALLY -- c\nDEFERRED)",
            "CREATE TABLE t (p REFERENCES q(id) DEFERRABLE INITIALLY DEFERRED, v DEFAULT 'unterminated)",
            "CREATE TABLE \"a--b\" (p REFERENCES q(id) DEFERRABLE INITIALLY DEFERRED)",
            "CREATE TABLE t (p REFERENCES q(id) DEFERRABLE\uFEFFINITIALLY DEFERRED)",
            // Any other character outside printable ASCII, unquoted: not read as a separator, counted deferred.
            "CREATE TABLE t (p REFERENCES q(id) DEFERRABLE\u00a0INITIALLY DEFERRED)",
            "CREATE TABLE t (p REFERENCES q(id) DEFERRABLE INITIALLY IMMEDIATE, café TEXT)",
            "CREATE TABLE t (p REFERENCES q(id) NOT  DEFERRABLE INITIALLY DEFERRED)",
        )
        val immediate = listOf(
            "CREATE TABLE t (p REFERENCES q(id))",
            "CREATE TABLE t (p REFERENCES q(id) DEFERRABLE INITIALLY IMMEDIATE)",
            "CREATE TABLE t (p REFERENCES q(id) NOT DEFERRABLE INITIALLY DEFERRED)",
            "CREATE TABLE t (p REFERENCES q(id) NOT /* c */ DEFERRABLE INITIALLY DEFERRED)",
            "CREATE TABLE t (v DEFAULT 'DEFERRABLE INITIALLY DEFERRED'' -- ')",
            "CREATE TABLE t (\"DEFERRABLE INITIALLY DEFERRED\" TEXT)",
            "CREATE TABLE t (v TEXT) -- DEFERRABLE INITIALLY DEFERRED",
            "CREATE TABLE t (v TEXT) /* an unterminated comment runs to the end: DEFERRABLE INITIALLY DEFERRED",
        )
        for (sql in deferred.dropLast(1)) assertTrue(sql, DbInspector.declaresDeferredKey(sql))
        // Whitespace runs collapse, so NOT followed by two spaces is still NOT: immediate.
        assertFalse(DbInspector.declaresDeferredKey(deferred.last()))
        for (sql in immediate.take(4)) assertFalse(sql, DbInspector.declaresDeferredKey(sql))
        // Quoted text and comments never make a key deferred.
        for (sql in immediate.drop(4)) assertFalse(sql, DbInspector.declaresDeferredKey(sql))
        assertNull(DbInspector.sqlTokens("CREATE TABLE t (v DEFAULT 'open"))
        assertEquals("CREATE TABLE T (V DEFAULT '')", DbInspector.sqlTokens("create  table t /* x */ (v default 'a -- b')"))
    }

    @Test
    fun anEditIsRefusedWhileTheAppLeftDeferForeignKeysOn() {
        db.exec(
            "PRAGMA foreign_keys = ON",
            "CREATE TABLE owner (id INTEGER PRIMARY KEY)",
            "CREATE TABLE pet (id INTEGER PRIMARY KEY, o INTEGER REFERENCES owner(id), v TEXT)",
            "INSERT INTO owner VALUES (1)",
            "INSERT INTO pet VALUES (1, 1, 'x')",
            // Outside a transaction, left on: the next transaction on this connection (the inspector's) defers every key.
            "PRAGMA defer_foreign_keys = ON",
        )
        val violating = { write("db", "update", """{"t":"integer","v":"1"}""", """{"t":"integer","v":"99"}""", table = "pet", column = "o", pk = """[{"t":"integer","v":"1"}]""").single() }
        assertEquals(DbInspector.DEFER_FK_REFUSAL, json(violating())["code"])
        assertEquals(1L, scalar("SELECT o FROM pet WHERE id = 1"))
        // Our rollback switched the pragma off (SQLite does at the end of any transaction): the same edit now meets an
        // immediate key, refused at its statement and rolled back.
        assertEquals(0L, scalar("PRAGMA defer_foreign_keys"))
        assertEquals("constraint_failed", json(violating())["code"])
        assertEquals(1L, scalar("SELECT o FROM pet WHERE id = 1"))
        assertEquals("ok", json(write("db", "update", """{"t":"string","v":"x"}""", """{"t":"string","v":"y"}""", table = "pet", column = "v", pk = """[{"t":"integer","v":"1"}]""").single())["code"])
    }

    @Test
    fun aDeferForeignKeysAnswerThatIsNotZeroIsRefused() {
        db.exec("CREATE TABLE plain (id INTEGER PRIMARY KEY, v TEXT)", "INSERT INTO plain VALUES (1, 'x')")
        for (answer in listOf<List<List<Any?>>>(emptyList(), listOf(listOf("0")), listOf(listOf(null)), listOf(listOf(1L)), listOf(listOf(0L, 0L)))) {
            val faked = object : TrackedDatabase {
                override fun status() = db.status()

                override fun <T> inTransaction(block: (SqlConnection) -> T): T = db.inTransaction { conn ->
                    block(object : SqlConnection {
                        override fun query(sql: String, args: List<Any?>): SqlRows =
                            if (sql == "PRAGMA defer_foreign_keys") SqlRows(listOf("defer_foreign_keys"), answer) else conn.query(sql, args)

                        override fun updateDelete(sql: String, args: List<Any?>): Int = conn.updateDelete(sql, args)
                    })
                }
            }
            val inspector = StorageInspector(prefs, registry("app.db" to faked), commits.runner)
            val line = write("db", "update", """{"t":"string","v":"x"}""", """{"t":"string","v":"y"}""", table = "plain", column = "v", pk = """[{"t":"integer","v":"1"}]""", target = inspector).single()
            assertEquals(answer.toString(), DbInspector.DEFER_FK_REFUSAL, json(line)["code"])
            assertEquals("x", db.connection.createStatement().executeQuery("SELECT v FROM plain").let { it.next(); it.getString(1) })
        }
    }

    @Test
    fun aSchemaWithoutDeferredKeysCostsOneQueryAndRestrictsNothing() {
        val recording = StatementLog(db)
        val inspector = StorageInspector(prefs, registry("app.db" to recording), commits.runner)
        db.exec(
            "CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT)",
            "CREATE TABLE b (id INTEGER PRIMARY KEY, a INTEGER REFERENCES a(id) ON DELETE CASCADE)",
            "CREATE TRIGGER t AFTER UPDATE ON a BEGIN SELECT 1; END",
        )
        val tables = (json(inspector.read(GatewayMessage.StorageRead(1, "db", "app.db", null, null, null)))["tables"] as List<*>)
            .map { it as Map<*, *> }
        assertTrue(tables.all { it["readOnly"] == null })
        assertEquals(1, recording.statements.count { "sqlite_master" in it && "DEFERRED" in it })
        assertFalse(recording.statements.any { "type = 'trigger'" in it || it.startsWith("PRAGMA foreign_key_list") })
    }
}

/** [inner], recording every statement the inspector runs. */
internal class StatementLog(private val inner: TrackedDatabase) : TrackedDatabase {
    val statements = ArrayList<String>()

    override fun status() = inner.status()

    override fun <T> inTransaction(block: (SqlConnection) -> T): T = inner.inTransaction { conn ->
        block(object : SqlConnection {
            override fun query(sql: String, args: List<Any?>): SqlRows = conn.query(sql, args).also { statements += sql }

            override fun updateDelete(sql: String, args: List<Any?>): Int = conn.updateDelete(sql, args).also { statements += sql }
        })
    }
}

/** A SharedPreferences that forwards to [inner] (to change what one read sees). */
internal open class SharedPreferencesProxy(private val inner: android.content.SharedPreferences) : android.content.SharedPreferences by inner
