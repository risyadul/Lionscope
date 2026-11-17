package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class StorageRowEditTest {
    private val id = """[{"t":"integer","v":"1"}]"""
    private fun integer(n: Long) = StorageValue.Integer(StorageValue.INTEGER, n)
    private fun text(s: String) = StorageValue.Text(s)

    @Test
    fun v12GoldenUpdateChangesKeyAndCredentialTogether() {
        JdbcDatabase().use { db ->
            db.exec("CREATE TABLE account (id INTEGER PRIMARY KEY, password TEXT)", "INSERT INTO account VALUES (1, 'old')")
            val inspector = StorageInspector(FakePrefsAccess(), registry("app.db" to db), db = DbInspector(nanoTime = { 0L }))
            inspector.originalValues = true
            val dir = System.getProperty("lionscope.fixtures") ?: "../../protocol/fixtures"
            val message = GatewayMessage.parse(File(dir, "gateway-storage-row.ndjson").readText().trim()) as GatewayMessage.StorageWrite
            val lines = ArrayList<String>()
            inspector.write(message) { lines += it }
            assertEquals(File(dir, "storage-row-results.ndjson").readText().trim(), lines.single())
            assertEquals(listOf(7L, "new"), db.inTransaction {it.query("SELECT id,password FROM account").rows.single()})
        }
    }

    @Test
    fun compositeKeysAndOtherFieldsApplyAndRevertAtomically() {
        JdbcDatabase().use { db ->
            db.exec("CREATE TABLE pair (a TEXT, b INTEGER, v TEXT, PRIMARY KEY(a,b)) WITHOUT ROWID", "INSERT INTO pair VALUES ('x',1,'old')")
            val inspector = DbInspector()
            val edits = listOf(FieldEdit("a", text("x"), text("y")), FieldEdit("b", integer(1), integer(2)), FieldEdit("v", text("old"), text("new")))
            val result = inspector.updateRow(db, "pair", listOf(text("x"), integer(1)), edits).value
            assertEquals("ok", result.code)
            assertTrue(result.pk!![0].same(text("y")))
            assertTrue(result.pk!![1].same(integer(2)))
            val undo = edits.map {edit -> FieldEdit(edit.column, result.storedFields!!.first {it.column == edit.column}.value, edit.expected)}
            assertEquals("ok", inspector.updateRow(db, "pair", result.pk!!, undo).value.code)
            assertEquals(listOf("x",1L,"old"), db.inTransaction {it.query("SELECT a,b,v FROM pair").rows.single()})
        }
    }

    @Test
    fun conflictOrConstraintFailureLeavesEveryFieldUnchanged() {
        JdbcDatabase().use { db ->
            db.exec("CREATE TABLE item (id INTEGER PRIMARY KEY, qty INTEGER CHECK(qty>=0))", "INSERT INTO item VALUES (1,3),(2,4)")
            val inspector = DbInspector()
            val pk = listOf(integer(1))
            val key = FieldEdit("id", integer(1), integer(7))
            val conflict = inspector.updateRow(db, "item", pk, listOf(key, FieldEdit("qty", integer(2), integer(5)))).value
            assertEquals("conflict", conflict.code)
            assertEquals(2, conflict.currentFields!!.size)
            try {
                inspector.updateRow(db, "item", pk, listOf(key, FieldEdit("qty", integer(3), integer(-1))))
                fail("constraint must reject entire statement")
            } catch (_: SqlConstraintException) { }
            assertEquals(listOf(1L,3L), db.inTransaction {it.query("SELECT id,qty FROM item WHERE id=1").rows.single()})
            try {
                inspector.updateRow(db, "item", pk, listOf(FieldEdit("id", integer(1), integer(2))))
                fail("duplicate key must fail")
            } catch (_: SqlConstraintException) { }
            assertEquals(2, db.inTransaction {it.query("SELECT id FROM item").rows.size})
        }
    }

    @Test
    fun originalValuesAreNegotiatedAndViewsRemainReadOnly() {
        JdbcDatabase().use { db ->
            db.exec("CREATE TABLE account (id INTEGER PRIMARY KEY, password TEXT)", "INSERT INTO account VALUES (1,'synthetic-secret')", "CREATE VIEW names AS SELECT password AS value FROM account")
            val prefs = FakePrefsAccess(linkedMapOf("app" to FakePrefs(mapOf("access_token" to "synthetic-token"))))
            val inspector = StorageInspector(prefs, registry("app.db" to db))
            val request = GatewayMessage.StorageRead(1, "prefs", "app", null, null, null)
            assertFalse(inspector.read(request).contains("synthetic-token"))
            inspector.originalValues = true
            assertTrue(inspector.read(request).contains("synthetic-token"))
            val views = inspector.read(GatewayMessage.StorageRead(2, "db", "app.db", null, null, """[{"table":"names"}]"""))
            assertTrue(views.contains("synthetic-secret"))
            assertTrue(views.contains("\"readOnly\":\"view\""))
        }
    }

    @Test
    fun rowResultsStayBoundedAfterATriggerExpandsTheRow() {
        JdbcDatabase().use { db ->
            db.exec("CREATE TABLE item (id INTEGER PRIMARY KEY, v TEXT)", "INSERT INTO item VALUES (1,'x')", "CREATE TRIGGER expand AFTER UPDATE ON item BEGIN UPDATE item SET v=printf('%10000s','x') WHERE id=NEW.id; END")
            val inspector = StorageInspector(FakePrefsAccess(), registry("app.db" to db), maxReplyBytes = 1600)
            inspector.originalValues = true
            val edit = """[{"column":"v","expected":{"t":"string","v":"x"},"value":{"t":"string","v":"y"}}]"""
            val lines = ArrayList<String>()
            inspector.write(GatewayMessage.StorageWrite(1,"op1","db","app.db","updateRow",null,"item",null,id,null,null,null,edit)) { lines += it }
            assertTrue(utf8Bytes(lines.single()) <= 1600)
            assertTrue(lines.single().contains("\"code\":\"ok\""))
            assertTrue(lines.single().contains("\"complete\":false"))
        }
    }
    @Test
    fun oversizedReadbackMetadataIsOmittedWithoutLosingTheCommittedOutcome() {
        JdbcDatabase().use { db ->
            val columns = (1..25).joinToString(",") { "\"${"long_column_".repeat(20)}$it\" TEXT" }
            db.exec("CREATE TABLE item (id INTEGER PRIMARY KEY, v TEXT, $columns)", "INSERT INTO item (id,v) VALUES (1,'x')")
            val inspector = StorageInspector(FakePrefsAccess(), registry("app.db" to db), maxReplyBytes = 1600)
            inspector.originalValues = true
            val edits = """[{"column":"v","expected":{"t":"string","v":"x"},"value":{"t":"string","v":"y"}}]"""
            val lines = ArrayList<String>()
            inspector.write(GatewayMessage.StorageWrite(1,"op1","db","app.db","updateRow",null,"item",null,id,null,null,null,edits)) { lines += it }
            assertTrue(utf8Bytes(lines.single()) <= 1600)
            assertTrue(lines.single().contains("\"code\":\"ok\""))
            assertFalse(lines.single().contains("storedFields"))
            assertEquals("y", db.inTransaction {it.query("SELECT v FROM item").rows.single().single()})
        }
    }

}
