package io.github.risyadul.lionscope.sample

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import io.github.risyadul.lionscope.Lionscope
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * The storage inspector demo: a Room database registered with [Lionscope.trackDatabase] (one screen part observes
 * its `item` table through a Flow, another reads it once) and prefs files, edited from the dashboard or an agent
 * (server flags `--allow-storage-read --allow-storage-write`).
 *
 * Debug builds take test hooks as extras (runtime proofs of the spec's AC; no effect in release, where the SDK is
 * the no-op one), e.g. `adb shell am start -n io.github.risyadul.lionscope.sample/.StorageActivity --el commitDelayMs 1500`:
 * `commitDelayMs` (a slow prefs commit), `dropNext` (the next write's answer is lost), `disconnectNext` (the link
 * really breaks right after the next write committed, before its answer goes out), `betweenPages` (`transfer`:
 * another writer moves balance between accounts during a multi-page read; `sleep`: the read overruns its budget),
 * `holdTxMs` (the app holds a Room transaction that long), `recordThreads` / `dumpThreads`, `prefsReadOnly` (the
 * prefs directory read-only: commit() fails), `appRename` (the app renames item 1 itself), `appCount` (the app
 * sets prefs `count`), `negativeControl` (two reads without a transaction around another writer), `appWrite`
 * (the app writes once and logs how long it waited), `deferForeignKeys` (edge.db: the app turns foreign keys and
 * `PRAGMA defer_foreign_keys` on outside a transaction and leaves them), `edgeAppWrite` (edge.db: the app renames pet 1
 * in its own transaction, then outside one, and logs whether its connection was left inside a transaction),
 * `edgeAppViolate` (edge.db, no inspector: the pragma left on, then the app's own transaction breaks pet.owner's key).
 */
class StorageActivity : AppCompatActivity(), ScreenName {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var flowText: TextView
    private lateinit var singleText: TextView
    private var emissions = 0

    private val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        // The key only (never a value), and the thread Android called the listener on.
        Log.i(TAG, "prefs listener: key=$key thread=${Thread.currentThread().name}")
    }

    override fun getScreen(): Screen = Screen.STORAGE

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        flowText = TextView(this).apply { textSize = 18f }
        singleText = TextView(this).apply { textSize = 18f }
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
            addView(TextView(context).apply { text = "Observed (Room Flow)" })
            addView(flowText)
            addView(TextView(context).apply { text = "Loaded once (like a Single)" })
            addView(singleText)
        }
        setContentView(ScrollView(this).apply { addView(column) })

        StoragePrefsFixture.seed(this).registerOnSharedPreferenceChangeListener(listener)
        val db = StorageDemo.shop(this)
        scope.launch {
            db.items().observeAll().collect { items ->
                emissions++
                flowText.text = "Flow #$emissions\n" + items.joinToString("\n") { "${it.id}: ${it.name} × ${it.qty}" }
                Log.i(TAG, "flow emission #$emissions rows=${items.size}")
            }
        }
        Thread {
            val items = db.items().all()
            runOnUiThread { singleText.text = items.joinToString("\n") { "${it.id}: ${it.name} × ${it.qty}" } }
        }.start()
        hooks(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        hooks(intent)
    }

    override fun onDestroy() {
        getSharedPreferences(StoragePrefsFixture.NAME, Context.MODE_PRIVATE).unregisterOnSharedPreferenceChangeListener(listener)
        scope.cancel()
        super.onDestroy()
    }

    private fun hooks(intent: Intent) {
        val extras = intent.extras ?: return
        val db = StorageDemo.shop(this)
        if (extras.containsKey("commitDelayMs")) hook("commitDelayMs", extras.getLong("commitDelayMs"))
        if (extras.containsKey("dropNext")) hook("dropNextWriteResult", extras.getBoolean("dropNext"))
        if (extras.containsKey("disconnectNext")) hook("disconnectAfterNextCommit", extras.getBoolean("disconnectNext"))
        if (extras.containsKey("recordThreads")) hook("recordThreads", extras.getBoolean("recordThreads"))
        if (extras.getBoolean("dumpThreads")) {
            val threads = runCatching { Class.forName(HOOKS).getField("threads").get(null) }.getOrNull()
            Log.i(TAG, "storage threads: $threads")
        }
        when (extras.getString("betweenPages")) {
            "transfer" -> hook("betweenPages", Runnable { transferDuringRead(db) })
            "sleep" -> hook("betweenPages", Runnable { SystemClock.sleep(400) })
            "off" -> hook("betweenPages", null)
        }
        if (extras.containsKey("holdTxMs")) {
            val ms = extras.getLong("holdTxMs")
            Thread({
                val started = SystemClock.uptimeMillis()
                db.runInTransaction { SystemClock.sleep(ms) }
                Log.i(TAG, "app held a transaction for ${SystemClock.uptimeMillis() - started} ms")
            }, "app-holder").start()
        }
        if (extras.containsKey("prefsReadOnly")) {
            val dir = File(applicationInfo.dataDir, "shared_prefs")
            val readOnly = extras.getBoolean("prefsReadOnly")
            val changed = dir.setWritable(!readOnly, false)
            Log.i(TAG, "shared_prefs writable=${!readOnly} changed=$changed")
        }
        extras.getString("appRename")?.let { name ->
            Thread { Log.i(TAG, "app rename changes=${db.items().rename(1, name)}") }.start()
        }
        if (extras.containsKey("appCount")) {
            val ok = getSharedPreferences(StoragePrefsFixture.NAME, Context.MODE_PRIVATE).edit()
                .putInt("count", extras.getInt("appCount")).commit()
            Log.i(TAG, "app count commit=$ok")
        }
        if (extras.getBoolean("negativeControl")) Thread { negativeControl(db) }.start()
        if (extras.getBoolean("appWrite")) {
            Thread({
                val started = SystemClock.uptimeMillis()
                db.runInTransaction { db.items().addBalance(1, 0) }
                Log.i(TAG, "app write waited ${SystemClock.uptimeMillis() - started} ms inTransaction=${db.inTransaction()}")
            }, "app-writer").start()
        }
        if (extras.getBoolean("deferForeignKeys")) {
            Thread({
                val edge = StorageDemo.edge(this).openHelper.writableDatabase
                // Outside a transaction, on the primary connection; nothing runs on it after, so it stays on until the
                // end of the next transaction there.
                edge.execSQL("PRAGMA foreign_keys = ON")
                edge.execSQL("PRAGMA defer_foreign_keys = ON")
                Log.i(TAG, "edge.db foreign_keys and defer_foreign_keys on, left on")
            }, "app-defer").start()
        }
        if (extras.getBoolean("edgeAppViolate")) {
            // The threat without the inspector (control G0): the app leaves the pragma on, then its own transaction
            // breaks the immediate key of pet.owner; then it tries another transaction and a write outside one.
            Thread({
                val edge = StorageDemo.edge(this)
                val raw = edge.openHelper.writableDatabase
                raw.execSQL("PRAGMA foreign_keys = ON")
                raw.execSQL("PRAGMA defer_foreign_keys = ON")
                val violate = runCatching { edge.runInTransaction { raw.execSQL("UPDATE pet SET owner = 99 WHERE id = 1") } }
                val next = runCatching { edge.runInTransaction { raw.execSQL("UPDATE pet SET name = 'g0-tx' WHERE id = 1") } }
                val outside = runCatching { raw.execSQL("UPDATE pet SET name = 'g0-out' WHERE id = 1") }
                fun r(result: Result<*>) = "${result.isSuccess} ${result.exceptionOrNull()?.javaClass?.simpleName ?: ""}".trim()
                Log.i(TAG, "edge app violate violate=${r(violate)} next=${r(next)} outside=${r(outside)} inTransaction=${edge.inTransaction()}")
            }, "app-edge-violate").start()
        }
        extras.getString("edgeAppWrite")?.let { name ->
            Thread({
                val edge = StorageDemo.edge(this)
                val inTx = runCatching {
                    edge.runInTransaction { edge.openHelper.writableDatabase.execSQL("UPDATE pet SET name = ? WHERE id = 1", arrayOf<Any?>(name)) }
                }
                val outside = runCatching { edge.openHelper.writableDatabase.execSQL("UPDATE pet SET name = ? WHERE id = 1", arrayOf<Any?>("$name-out")) }
                Log.i(
                    TAG,
                    "edge app write inTx=${inTx.isSuccess} ${inTx.exceptionOrNull()?.javaClass?.simpleName} " +
                        "outside=${outside.isSuccess} ${outside.exceptionOrNull()?.javaClass?.simpleName} inTransaction=${edge.inTransaction()}",
                )
            }, "app-edge-writer").start()
        }
        if (extras.getBoolean("readCount")) {
            // What the app's own getInt sees (a wrong type would throw ClassCastException here).
            val result = runCatching { getSharedPreferences(StoragePrefsFixture.NAME, Context.MODE_PRIVATE).getInt("count", -1) }
            Log.i(TAG, "app getInt(count) ok=${result.isSuccess} error=${result.exceptionOrNull()?.javaClass?.simpleName}")
        }
    }

    /** Another writer moves 100 from account 1 to 2 while a read holds its transaction (it waits until it ends). */
    private fun transferDuringRead(db: ShopDatabase) {
        val done = CountDownLatch(1)
        Thread({
            db.runInTransaction {
                db.items().addBalance(1, -100)
                db.items().addBalance(2, 100)
            }
            done.countDown()
        }, "app-transfer").start()
        val finished = done.await(100, TimeUnit.MILLISECONDS)
        Log.i(TAG, "transfer during read finished inside it: $finished")
    }

    /** Without a transaction another writer gets between two reads: the invariant breaks (the control). */
    private fun negativeControl(db: ShopDatabase) {
        val first = db.items().balance(1)
        db.runInTransaction {
            db.items().addBalance(1, -100)
            db.items().addBalance(2, 100)
        }
        val second = db.items().balance(2)
        Log.i(TAG, "negative control: sum of two reads without a transaction=${first + second} (total ${db.items().totalBalance()})")
    }

    private fun hook(name: String, value: Any?) {
        try {
            Class.forName(HOOKS).getField(name).set(null, value)
            Log.i(TAG, "hook $name set")
        } catch (e: ReflectiveOperationException) {
            Log.i(TAG, "hook $name unavailable (release build)")
        }
    }

    companion object {
        const val TAG = "LionscopeStorageFixture"
        private const val HOOKS = "io.github.risyadul.lionscope.StorageTestHooks"
    }
}

/** The demo databases, one instance each per process, registered with Lionscope when first opened. */
object StorageDemo {
    @Volatile
    private var shop: ShopDatabase? = null

    /** Held here: Lionscope keeps registered databases only weakly (one the app dropped reads as closed). */
    private var driver: DriverDatabase? = null
    private var edge: EdgeDatabase? = null

    fun edge(context: Context): EdgeDatabase {
        shop(context)
        return edge!!
    }

    fun shop(context: Context): ShopDatabase = shop ?: synchronized(this) {
        shop ?: ShopDatabase.build(context.applicationContext).also {
            shop = it
            Lionscope.trackDatabase("shop.db", it)
            driver = DriverDatabase.build(context.applicationContext).also { db -> Lionscope.trackDatabase("driver.db", db) }
            edge = EdgeDatabase.build(context.applicationContext).also { db -> Lionscope.trackDatabase("edge.db", db) }
            StoragePrefsFixture.seedLongKeys(context.applicationContext)
        }
    }
}
