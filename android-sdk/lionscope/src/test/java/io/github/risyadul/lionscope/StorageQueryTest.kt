package io.github.risyadul.lionscope

import org.junit.Assert.*
import org.junit.Test
import java.io.File

class StorageQueryTest {
    private val fixtures get() = File(checkNotNull(System.getProperty("lionscope.fixtures")))
    private fun request(sql: String, limit: Int = 50, offset: Int = 0) = GatewayMessage.StorageQuery(1, "op1", "shop.db", sql, limit, offset)

    @Test fun matchesSharedSqlGrammar() {
        val entries = StrictJson.parse(File(fixtures, "storage-sql-plans.json").readText()) as List<*>
        entries.forEach { value ->
            val entry = value as Map<*, *>
            val sql = entry["sql"] as String
            try {
                val plan = StorageSql.plan(sql)
                assertNotEquals(sql, true, entry["reject"])
                assertEquals(sql, entry["readOnly"], plan.readOnly)
                assertEquals(sql, entry["table"].takeUnless { it === StrictJson.NULL }, plan.table)
            } catch (abort: StorageAbort) {
                assertEquals(sql, true, entry["reject"])
            }
        }
    }

    @Test fun answersGoldenQueriesThroughTheRegisteredTransaction() {
        JdbcDatabase().use { database ->
            database.exec("CREATE TABLE item(id INTEGER PRIMARY KEY, label TEXT)")
            val inspector = StorageQuery(registry("shop.db" to database), DbInspector(nanoTime = { 0L }))
            val actual = File(fixtures, "gateway-storage-query.ndjson").readLines().map { line ->
                inspector.run(GatewayMessage.parse(line) as GatewayMessage.StorageQuery)
            }
            assertEquals(File(fixtures, "storage-query-results.ndjson").readLines(), actual)
        }
    }

    @Test fun joinsCtesPagingAndExactValues() {
        JdbcDatabase().use { database ->
            database.exec("CREATE TABLE item(id INTEGER PRIMARY KEY, qty INTEGER)", "INSERT INTO item VALUES(1,3),(2,4),(3,5)")
            val inspector = StorageQuery(registry("shop.db" to database))
            val first = inspector.run(request("WITH x AS (SELECT * FROM item) SELECT a.id, b.qty, x'00ff' AS data FROM x a JOIN item b ON a.id=b.id ORDER BY a.id", 2))
            assertTrue(first, first.contains("\"hasMore\":true"))
            assertTrue(first, first.contains("\"b64\":\"AP8=\""))
            val second = inspector.run(request("SELECT id FROM item ORDER BY id", 2, 2))
            assertTrue(second, second.contains("\"v\":\"3\""))
            assertTrue(second, second.contains("\"hasMore\":false"))
            assertFalse(second, second.contains("\"v\":\"1\""))
        }
    }

    @Test fun writesRollbackOnConstraintAndBudgetFailures() {
        JdbcDatabase().use { database ->
            database.exec("CREATE TABLE item(id INTEGER PRIMARY KEY, qty INTEGER CHECK(qty>=0))", "INSERT INTO item VALUES(1,3),(2,4)")
            val inspector = StorageQuery(registry("shop.db" to database))
            val failed = inspector.run(request("UPDATE OR FAIL item SET qty=CASE id WHEN 1 THEN 8 ELSE -1 END"))
            assertTrue(failed, failed.contains("\"code\":\"constraint_failed\""))
            assertEquals(listOf(3L, 4L), database.inTransaction { it.query("SELECT qty FROM item ORDER BY id").rows.map { row -> row[0] } })
            var time = 0L
            val slow = StorageQuery(registry("shop.db" to database), DbInspector(nanoTime = { time += 300_000_000; time }))
            assertTrue(slow.run(request("DELETE FROM item")).contains("\"code\":\"timeout\""))
            assertEquals(2, database.inTransaction { it.query("SELECT * FROM item").rows.size })
            assertTrue(inspector.run(request("DELETE FROM item WHERE id=2")).contains("\"changes\":1"))
        }
    }

    @Test fun preservesTechnicalRestrictionsAndBoundsResults() {
        JdbcDatabase().use { database ->
            database.exec("CREATE TABLE item(id INTEGER PRIMARY KEY, label TEXT)", "CREATE VIEW names AS SELECT label FROM item", "INSERT INTO item VALUES(1,printf('%100000s','x'))")
            val inspector = StorageQuery(registry("shop.db" to database))
            assertTrue(inspector.run(request("DELETE FROM names")).contains("read_only:view"))
            val large = inspector.run(request("SELECT * FROM item"))
            assertTrue(large.contains("\"truncated\":true"))
            assertTrue(large.contains("\"complete\":false"))
            assertTrue(utf8Bytes(large) <= MAX_STORAGE_REPLY_BYTES)
            assertTrue(inspector.run(request("SELECT missing FROM item")).contains("queryError"))
            database.exec("CREATE TRIGGER refuse BEFORE DELETE ON item BEGIN SELECT RAISE(ROLLBACK,'refused'); END")
            assertTrue(inspector.run(request("DELETE FROM item")).contains("unsupported:rollback_conflict"))
            assertEquals(1, database.inTransaction { it.query("SELECT * FROM item").rows.size })
        }
    }

    @Test fun temporaryTablesCannotRetargetAMutation() {
        JdbcDatabase().use { database ->
            database.exec("CREATE TABLE item(id INTEGER PRIMARY KEY)", "INSERT INTO item VALUES(1)", "CREATE TEMP TABLE item(id INTEGER)", "INSERT INTO temp.item VALUES(2)")
            val inspector = StorageQuery(registry("shop.db" to database))
            assertTrue(inspector.run(request("DELETE FROM item")).contains("unsupported:temporary_shadow"))
            assertEquals(1, database.inTransaction { it.query("SELECT id FROM main.item").rows.size })
            assertEquals(1, database.inTransaction { it.query("SELECT id FROM temp.item").rows.size })
        }
    }

    @Test fun temporaryTriggersCannotBypassDeferredForeignKeyRestrictions() {
        JdbcDatabase().use { database ->
            database.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY)", "CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)", "CREATE TABLE item(id INTEGER PRIMARY KEY)", "INSERT INTO item VALUES(1)", "CREATE TEMP TRIGGER deferred_write AFTER DELETE ON main.item BEGIN INSERT INTO child VALUES(1,99); END")
            val inspector = StorageQuery(registry("shop.db" to database))
            assertTrue(inspector.run(request("DELETE FROM item")).contains("unsupported:deferred_fk"))
            assertEquals(1, database.inTransaction { it.query("SELECT * FROM item").rows.size })
        }
    }
}
