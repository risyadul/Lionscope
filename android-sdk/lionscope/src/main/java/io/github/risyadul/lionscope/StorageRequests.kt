package io.github.risyadul.lionscope

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import java.io.File
import java.util.concurrent.Executor
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Answers the server's v11 storage requests on one worker thread (`lionscope-storage`, never the main thread), within
 * what the link allows: only a server-verified link ([LinkPort.isServerVerified], a session with the link proof)
 * gets anything, and only as far as its `config.storageConsent` goes (reads with `read`, writes with `read_write`;
 * `off` until a v11 config says otherwise, and again after every disconnect). A refused request is answered without
 * touching prefs or databases (on a link without the proof the answer is held back like every v11 line: none of these
 * types is an [UnprovenType]). Past [maxQueued] waiting requests, or a write past a burst of [burst] then [perSecond]
 * a second, a request is answered `busy` at once. A request whose connection ended before the worker got to it is
 * dropped unrun; one that ran sends its answer only on the connection it came from (a write's `final` too).
 */
internal class StorageRequests(
    private val link: LinkPort,
    private val inspector: StorageInspector,
    private val worker: Executor = defaultWorker(),
    private val maxQueued: Int = MAX_STORAGE_QUEUED,
    burst: Int = STORAGE_WRITE_BURST,
    perSecond: Double = STORAGE_WRITES_PER_SECOND,
    nanoTime: () -> Long = System::nanoTime,
) {
    private val queued = AtomicInteger()
    private val writes = RateBucket(burst, perSecond, nanoTime)

    @Volatile
    private var consent = StorageConsent.OFF

    /** The connection [consent] was set on: another connection starts at `off`. */
    @Volatile
    private var consentConnection = -1

    init {
        link.addConfigListener { options ->
            consent = options.storageConsent
            consentConnection = link.connection
        }
        link.addWelcomeListener { welcomed -> if (!welcomed) consent = StorageConsent.OFF }
        link.addStorageListener(::onRequest)
    }

    private fun currentConsent(): StorageConsent =
        if (consentConnection == link.connection) consent else StorageConsent.OFF

    /** Link thread: checks and hands off; nothing here reads storage. */
    private fun onRequest(message: GatewayMessage) {
        val connection = link.connection
        val refusal = refusalOf(message)
        if (refusal != null) return answerRefusal(message, refusal, connection)
        if (message is GatewayMessage.StorageWrite && !writes.take()) return answerRefusal(message, "busy", connection)
        if (!enqueue()) return answerRefusal(message, "busy", connection)
        try {
            worker.execute {
                queued.decrementAndGet()
                // The connection it came from is gone: its server gave up on it, and its id may mean another request now.
                if (!link.isWelcomed || link.connection != connection) return@execute
                guarded { run(message, connection) }
            }
        } catch (e: RejectedExecutionException) {
            queued.decrementAndGet()
            answerRefusal(message, "busy", connection)
        }
    }

    /** Why [message] may not run on the current link (null: it may). */
    private fun refusalOf(message: GatewayMessage): String? {
        if (!DeviceLink.speaks(link.negotiatedVersion, DEVICE_PROTOCOL_V11)) return "needs_sdk"
        if (!link.isServerVerified) return "unauthenticated"
        val consent = currentConsent()
        val needed = if (message is GatewayMessage.StorageWrite) StorageConsent.READ_WRITE else StorageConsent.READ
        return if (consent == StorageConsent.OFF || (needed == StorageConsent.READ_WRITE && consent != StorageConsent.READ_WRITE)) {
            "consent_required"
        } else {
            null
        }
    }

    private fun enqueue(): Boolean {
        if (queued.incrementAndGet() <= maxQueued) return true
        queued.decrementAndGet()
        return false
    }

    /** The connection the last request ran on: cursors of another one are forgotten. */
    private var cursorConnection = -1

    /** Worker thread. */
    private fun run(message: GatewayMessage, connection: Int) {
        // Consent may have changed (a new config) while it waited.
        refusalOf(message)?.let { return answerRefusal(message, it, connection) }
        if (connection != cursorConnection) {
            inspector.resetCursors()
            cursorConnection = connection
        }
        when (message) {
            is GatewayMessage.StorageList -> send(connection, inspector.list(message.requestId))
            is GatewayMessage.StorageRead -> send(connection, inspector.read(message))
            is GatewayMessage.StorageWrite -> {
                val drop = StorageTestHooks.dropNextWriteResult
                if (drop) StorageTestHooks.dropNextWriteResult = false
                val disconnect = StorageTestHooks.disconnectAfterNextCommit
                if (disconnect) StorageTestHooks.disconnectAfterNextCommit = false
                var dropped = false
                inspector.write(message) { line ->
                    when {
                        // Once: a later answer (a late final) must not break the link it reconnected with.
                        disconnect -> if (!dropped) {
                            dropped = true
                            if (link.connection == connection) link.dropConnection()
                        }
                        !drop -> send(connection, line)
                    }
                }
            }
            else -> Unit
        }
    }

    private fun answerRefusal(message: GatewayMessage, code: String, connection: Int) {
        val line = when (message) {
            is GatewayMessage.StorageList -> StorageInspector.codeLine(message.requestId, "storageListResult", code)
            is GatewayMessage.StorageRead -> StorageInspector.codeLine(message.requestId, "storageReadResult", code)
            is GatewayMessage.StorageWrite -> StorageInspector.writeRefusal(message.requestId, message.opId, code)
            else -> return
        }
        send(connection, line)
    }

    /** Only on the connection the request came from (a late `final` too). */
    private fun send(connection: Int, line: String) {
        if (link.connection != connection) return
        link.sendV11(line.length) { line.takeIf { link.connection == connection } }
    }

    internal companion object {
        /** One thread, a bounded queue (more than [MAX_STORAGE_QUEUED] is refused before it gets here). */
        fun defaultWorker(): Executor = ThreadPoolExecutor(
            1,
            1,
            0,
            TimeUnit.MILLISECONDS,
            LinkedBlockingQueue(MAX_STORAGE_QUEUED + 1),
        ) { task ->
            Thread({
                lowerThreadPriority()
                task.run()
            }, "lionscope-storage").apply { isDaemon = true }
        }
    }
}

/** The app's SharedPreferences: `shared_prefs/` of its data directory, and its own instances (`MODE_PRIVATE`). */
internal class AndroidPrefsAccess(private val context: Context) : PrefsAccess {
    override fun listFiles(): List<PrefsFile> {
        val dataDir = if (Build.VERSION.SDK_INT >= 24) context.dataDir else File(context.applicationInfo.dataDir)
        val names = File(dataDir, "shared_prefs").list() ?: return emptyList()
        val xml = HashSet<String>()
        val backups = HashSet<String>()
        for (file in names) {
            when {
                file.endsWith(".xml") -> xml += file.removeSuffix(".xml")
                file.endsWith(".xml.bak") -> backups += file.removeSuffix(".xml.bak")
            }
        }
        return (xml + backups)
            .filter { it.isNotEmpty() && '/' !in it && '\\' !in it && it.length <= MAX_STORAGE_NAME_CHARS }
            .sorted()
            .map { PrefsFile(it, it !in xml) }
    }

    override fun open(name: String): SharedPreferences = context.getSharedPreferences(name, Context.MODE_PRIVATE)
}
