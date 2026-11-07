package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The SDK side of the storage inspector's fail-closed gates: proof, consent, queue, rate. */
class StorageRequestsTest {
    private val link = FakeLink()
    private val prefs = FakePrefsAccess(linkedMapOf("app" to FakePrefs(mapOf("count" to 3))))
    private val tasks = ArrayList<Runnable>()
    private var now = 0L
    private val worker = java.util.concurrent.Executor { tasks += it }

    private fun requests(maxQueued: Int = MAX_STORAGE_QUEUED) = StorageRequests(
        link,
        StorageInspector(prefs, DatabaseRegistry(), ManualCommits().runner),
        worker,
        maxQueued = maxQueued,
        nanoTime = { now },
    )

    private fun runAll() {
        while (tasks.isNotEmpty()) tasks.removeAt(0).run()
    }

    private fun codes(): List<Any?> = link.v11Lines.map { (TestJson.parse(it) as Map<*, *>)["code"] }

    private fun consent(consent: StorageConsent) = link.config(SdkOptions.DEFAULT.copy(storageConsent = consent))

    private val read = GatewayMessage.StorageRead(1, "prefs", "app", null, null, null)

    private fun write(id: Int) = GatewayMessage.StorageWrite(
        id, "op$id", "prefs", "app", "update", "count", null, null, null,
        """{"t":"int","v":"3"}""", """{"t":"int","v":"4"}""", null,
    )

    @Test
    fun nothingIsReadWithoutConsent() {
        requests()
        link.welcome(true, DEVICE_PROTOCOL_V11)
        link.storage(read)
        runAll()
        assertEquals(listOf("consent_required"), codes())
        assertTrue(prefs.opened.isEmpty())
    }

    @Test
    fun aLinkWithoutTheProofIsRefusedBeforeTheConsentIsLookedAt() {
        requests()
        link.welcome(true, DEVICE_PROTOCOL_V11, proven = false)
        consent(StorageConsent.READ_WRITE)
        link.storage(read)
        runAll()
        assertEquals(listOf("unauthenticated"), codes())
        assertTrue(prefs.opened.isEmpty())
    }

    @Test
    fun readConsentReadsButNeverWrites() {
        requests()
        link.welcome(true, DEVICE_PROTOCOL_V11)
        consent(StorageConsent.READ)
        link.storage(read)
        link.storage(write(2))
        runAll()
        assertEquals(listOf("consent_required", "ok"), codes()) // The write is refused on the link thread.
        assertEquals(3, prefs.files.getValue("app").values["count"])
    }

    @Test
    fun theConsentEndsWithItsConnection() {
        requests()
        link.welcome(true, DEVICE_PROTOCOL_V11)
        consent(StorageConsent.READ_WRITE)
        link.welcome(false)
        link.welcome(true, DEVICE_PROTOCOL_V11) // A new connection, no config yet.
        link.storage(read)
        runAll()
        assertEquals(listOf("consent_required"), codes())
    }

    @Test
    fun aRequestFromAConnectionThatEndedIsDroppedUnrun() {
        requests()
        link.welcome(true, DEVICE_PROTOCOL_V11)
        consent(StorageConsent.READ_WRITE)
        link.storage(write(1))
        link.welcome(false)
        link.welcome(true, DEVICE_PROTOCOL_V11)
        consent(StorageConsent.READ_WRITE)
        runAll()
        assertTrue(link.v11Lines.isEmpty())
        assertEquals(3, prefs.files.getValue("app").values["count"])
    }

    @Test
    fun aFullQueueAndAWriteBurstAreAnsweredBusy() {
        requests(maxQueued = 2)
        link.welcome(true, DEVICE_PROTOCOL_V11)
        consent(StorageConsent.READ_WRITE)
        repeat(3) { link.storage(read) }
        assertEquals(listOf("busy"), codes())
        runAll()
        link.v11Lines.clear()
        for (id in 1..STORAGE_WRITE_BURST + 1) {
            link.storage(write(id))
            runAll()
        }
        assertEquals("busy", codes().last())
        assertEquals(STORAGE_WRITE_BURST, codes().count { it != "busy" })
        now += 1_000_000_000L // A second later: STORAGE_WRITES_PER_SECOND more.
        link.storage(write(99))
        assertEquals(1, tasks.size)
    }

    @Test
    fun theConfigLineCarriesTheConsent() {
        val config = GatewayMessage.parse("""{"type":"config","stallThresholdMs":150,"storageConsent":"read_write"}""")
        assertEquals(StorageConsent.READ_WRITE, (config as GatewayMessage.Config).options.storageConsent)
        val old = GatewayMessage.parse("""{"type":"config","stallThresholdMs":150}""") as GatewayMessage.Config
        assertEquals(StorageConsent.OFF, old.options.storageConsent)
        val unknown = GatewayMessage.parse("""{"type":"config","storageConsent":"all"}""") as GatewayMessage.Config
        assertEquals(StorageConsent.OFF, unknown.options.storageConsent)
    }

    @Test
    fun storageLinesAreReadWholeAndStrictly() {
        val read = GatewayMessage.parse(
            """{"type":"storageRead","requestId":4,"store":"db","name":"app.db","pages":"[{\"table\":\"t\"}]"}""",
        ) as GatewayMessage.StorageRead
        assertEquals("[{\"table\":\"t\"}]", read.pages)
        val write = GatewayMessage.parse(
            """{"type":"storageWrite","requestId":5,"opId":"a1","store":"prefs","name":"app","op":"remove","key":"k","expected":"{\"t\":\"bool\",\"v\":true}"}""",
        ) as GatewayMessage.StorageWrite
        assertEquals("k", write.key)
        // A prefs `delete`, a db `remove`, a bad opId, an empty name: dropped.
        assertEquals(null, GatewayMessage.parse("""{"type":"storageWrite","requestId":5,"opId":"a1","store":"prefs","name":"app","op":"delete"}"""))
        assertEquals(null, GatewayMessage.parse("""{"type":"storageWrite","requestId":5,"opId":"a1","store":"db","name":"app","op":"remove"}"""))
        assertEquals(null, GatewayMessage.parse("""{"type":"storageWrite","requestId":5,"opId":"a b","store":"db","name":"app","op":"delete"}"""))
        assertEquals(null, GatewayMessage.parse("""{"type":"storageRead","requestId":5,"store":"prefs","name":""}"""))
    }

    @Test
    fun theDisconnectHookBreaksTheLinkAfterTheCommitInsteadOfAnswering() {
        requests()
        link.welcome(true, DEVICE_PROTOCOL_V11)
        consent(StorageConsent.READ_WRITE)
        StorageTestHooks.disconnectAfterNextCommit = true
        try {
            link.storage(write(2))
            runAll()
        } finally {
            StorageTestHooks.disconnectAfterNextCommit = false
        }
        // Applied once, its answer never sent: the link was dropped in its place (one time only).
        assertEquals(4, prefs.files.getValue("app").values["count"])
        assertEquals(1, link.drops)
        assertTrue(link.v11Lines.isEmpty())
        link.storage(write(3))
        runAll()
        assertEquals(listOf("already_applied_or_concurrent"), codes())
        assertEquals(1, link.drops)
    }

    @Test
    fun cursorsEndWithTheirConnection() {
        prefs.files.getValue("app").values["other"] = 1
        requests()
        link.welcome(true, DEVICE_PROTOCOL_V11)
        consent(StorageConsent.READ)
        link.storage(GatewayMessage.StorageRead(1, "prefs", "app", null, 1, null))
        runAll()
        val token = (TestJson.parse(link.v11Lines.single()) as Map<*, *>)["nextCursor"] as String
        link.storage(GatewayMessage.StorageRead(2, "prefs", "app", token, 1, null))
        runAll()
        assertEquals(listOf("ok", "ok"), codes())
        link.welcome(false)
        link.welcome(true, DEVICE_PROTOCOL_V11)
        consent(StorageConsent.READ)
        link.v11Lines.clear()
        link.storage(GatewayMessage.StorageRead(3, "prefs", "app", token, 1, null))
        runAll()
        assertEquals(listOf("invalid_identifier"), codes())
    }

    // --- a listing at its cap, and a listing that fails --------------------------------------------------------------

    private val tenFiles = FakePrefsAccess(LinkedHashMap((0 until 10).associate { "file_%02d".format(it) to FakePrefs() }))

    private fun listingSize(): Int = utf8Bytes(StorageInspector(tenFiles, DatabaseRegistry(), ManualCommits().runner, maxReplyBytes = Int.MAX_VALUE).list(1))

    private fun listThrough(inspector: StorageInspector): List<Map<*, *>> {
        StorageRequests(link, inspector, worker, nanoTime = { now })
        link.welcome(true, DEVICE_PROTOCOL_V11)
        consent(StorageConsent.READ)
        link.storage(GatewayMessage.StorageList(1))
        runAll()
        return link.v11Lines.map { TestJson.parse(it) as Map<*, *> }
    }

    @Test
    fun aListingOneByteUnderItsWholeSizeIsCutAndStillSent() {
        // Whole, the answer says prefsTruncated:false (a byte longer than true): measured with true, the last file
        // was let in at cap - 1 and the answer, over the cap, was never sent (a timeout).
        val whole = listingSize()
        val inspector = StorageInspector(tenFiles, DatabaseRegistry(), ManualCommits().runner, maxReplyBytes = whole - 1)
        val answers = listThrough(inspector)
        assertEquals(1, answers.size)
        val answer = answers.single()
        assertEquals("storageListResult", answer["type"])
        assertEquals("ok", answer["code"])
        assertEquals(true, answer["prefsTruncated"])
        assertEquals(9, (answer["prefs"] as List<*>).size)
        assertTrue(utf8Bytes(link.v11Lines.single()) <= whole - 1)
    }

    @Test
    fun aListingOfExactlyTheCapOrUnderIsWhole() {
        val whole = listingSize()
        for (cap in listOf(whole, whole + 1)) {
            val line = StorageInspector(tenFiles, DatabaseRegistry(), ManualCommits().runner, maxReplyBytes = cap).list(1)
            val answer = TestJson.parse(line) as Map<*, *>
            assertEquals(cap.toString(), 10, (answer["prefs"] as List<*>).size)
            assertEquals(false, answer["prefsTruncated"])
            assertEquals(whole, utf8Bytes(line))
        }
    }

    @Test
    fun aListingThatFailsIsAnsweredFailedNotLeftToTimeOut() {
        val broken = object : TrackedDatabase {
            override fun status(): String = throw IllegalStateException("broken")

            override fun <T> inTransaction(block: (SqlConnection) -> T): T = throw IllegalStateException("broken")
        }
        val inspector = StorageInspector(prefs, DatabaseRegistry().apply { register("broken.db", broken) }, ManualCommits().runner)
        val answer = listThrough(inspector).single()
        assertEquals("storageListResult", answer["type"])
        assertEquals("failed", answer["code"])
    }

}
