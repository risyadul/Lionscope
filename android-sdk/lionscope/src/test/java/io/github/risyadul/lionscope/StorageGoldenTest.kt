package io.github.risyadul.lionscope

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * protocol/fixtures/storage-results.ndjson: the SDK's v11 answers, byte for byte, for the requests of
 * gateway-messages.ndjson (request ids 30-35) on a fixed app (the server tests parse the same lines). The lines this
 * build produces are also written to build/storage-results.actual.ndjson, for review when the format changes.
 */
class StorageGoldenTest {
    private val db = JdbcDatabase()

    @After
    fun close() = db.close()

    private fun gatewayLines(): List<GatewayMessage> {
        val dir = System.getProperty("lionscope.fixtures") ?: "../../protocol/fixtures"
        return File(dir, "gateway-messages.ndjson").readLines(Charsets.UTF_8)
            .filter { it.startsWith("{\"type\":\"storage") }
            .map { checkNotNull(GatewayMessage.parse(it)) { it } }
    }

    @Test
    fun theSdkAnswersAsTheGoldenLines() {
        val prefs = FakePrefsAccess(
            linkedMapOf(
                "app_settings" to FakePrefs(
                    linkedMapOf(
                        "count" to 3,
                        "dark" to true,
                        "ratio" to 0.5f,
                        "session_token" to "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
                        "tags" to setOf("beta", "alpha"),
                        "url" to "https://api.example.com/v1?id=7&access_token=abc",
                    ),
                ),
            ),
        )
        db.exec(
            "CREATE TABLE user (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL, avatar BLOB, password TEXT)",
            "INSERT INTO user VALUES (1, 'Ana', 1.5, x'00ff', 'p1'), (2, 'Bo', NULL, NULL, 'p2'), (3, 'Cy', -0.0, NULL, NULL)",
            "CREATE TABLE pair (a TEXT, b INTEGER, v TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID",
            "INSERT INTO pair VALUES ('x', 1, 'x1'), ('x', 2, 'x2'), ('y', 1, 'y1')",
        )
        // Predictable tokens: 01 and 02 are the cursors the fixture requests name, later ones are handed out.
        var token = 0
        val cursors = StorageCursors(fill = { bytes -> bytes.fill(0); bytes[bytes.size - 1] = (++token).toByte() })
        cursors.put(StorageCursors.prefsScope("app_settings"), StorageCursors.Position.AfterKey("count"))
        cursors.put(StorageCursors.tableScope("app.db", "pair"), StorageCursors.Position.AfterKeys(listOf("x", 1L)))
        val inspector = StorageInspector(
            prefs,
            registry("app.db" to db),
            ManualCommits(nanoTime = { 0L }).runner,
            DbInspector(nanoTime = { 0L }),
            cursors = cursors,
        )
        val lines = ArrayList<String>()
        for (message in gatewayLines()) {
            when (message) {
                is GatewayMessage.StorageList -> lines += inspector.list(message.requestId)
                is GatewayMessage.StorageRead -> lines += inspector.read(message)
                is GatewayMessage.StorageWrite -> inspector.write(message) { lines += it }
                else -> Unit
            }
        }
        // Refusals: the answer is only a code.
        lines += StorageInspector.codeLine(36, "storageListResult", "consent_required")
        lines += StorageInspector.codeLine(37, "storageReadResult", "unsupported:encrypted")
        lines += StorageInspector.writeRefusal(38, "d2e4f6a8-1b3c-4d5e-8f70-9a1b2c3d4e5f", "busy")
        val actual = lines.joinToString("") { "$it\n" }
        File("build/storage-results.actual.ndjson").writeText(actual, Charsets.UTF_8)
        val dir = System.getProperty("lionscope.fixtures") ?: "../../protocol/fixtures"
        assertEquals(File(dir, "storage-results.ndjson").readText(Charsets.UTF_8), actual)
    }
}
