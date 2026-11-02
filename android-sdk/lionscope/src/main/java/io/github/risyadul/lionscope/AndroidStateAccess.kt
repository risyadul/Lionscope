package io.github.risyadul.lionscope

import android.os.Bundle
import android.os.Parcel
import java.lang.reflect.Field

/**
 * [StateAccess] over real Bundles: sizes from Parcel writes (what the system sends), children read from COPIES
 * (`Bundle(Bundle)`, which copies a still-parceled bundle's raw data instead of unparceling it), so the bundle the
 * system sends is never touched. androidx.fragment's own records are opened by reflection when the app ships it
 * (`FragmentManagerState.mSavedState` in fragment 1.4, `FragmentState.mSavedFragmentState` / `mClassName`); without
 * androidx.fragment, or with its fields renamed, they are opaque values. [classLoader] reads the app's Parcelables.
 */
internal class AndroidStateAccess(private val classLoader: ClassLoader?) : StateAccess {

    override fun children(value: Any): List<Pair<String, Any?>>? = when (value) {
        is Bundle -> copy(value).let { copy -> copy.keySet().map { key -> key to read(copy, key) } }
        else -> FragmentRecords.children(value)
    }

    override fun entryBytes(key: String, value: Any?): Int = parcelSize { parcel ->
        parcel.writeString(key)
        parcel.writeValue(value)
    }

    override fun fragmentClass(value: Any): String? = when (value) {
        is Bundle -> read(copy(value), FRAGMENT_STATE_KEY)?.let(FragmentRecords::className)
        else -> FragmentRecords.className(value)
    }

    /** A 1.5+ `fragment_<who>` Bundle keeps its record under `state`; a FragmentState (1.4) is the record. */
    override fun fragmentRecordKey(value: Any): String? = if (value is Bundle) FRAGMENT_STATE_KEY else null

    override fun valueClass(value: Any?): String? = value?.javaClass?.let { type ->
        if (type.isArray) "${type.componentType?.name}[]" else type.name
    }

    private fun copy(bundle: Bundle): Bundle = Bundle(bundle).also { copy ->
        if (classLoader != null) copy.classLoader = classLoader
    }

    @Suppress("DEPRECATION") // Bundle.get(String): any value type, on every API level.
    private fun read(bundle: Bundle, key: String): Any? = bundle.get(key)

    companion object {
        /** 1.5+: each `fragment_<who>` Bundle keeps its FragmentState under this key. */
        private const val FRAGMENT_STATE_KEY = "state"

        /** Bytes [bundle] takes in a Parcel (`Parcel.writeBundle`): what the system sends for it. */
        fun totalBytes(bundle: Bundle): Int = parcelSize { it.writeBundle(bundle) }

        /** -1 when the write fails (a value the system could not send either). */
        private inline fun parcelSize(write: (Parcel) -> Unit): Int {
            val parcel = Parcel.obtain()
            return try {
                write(parcel)
                parcel.dataSize()
            } catch (e: RuntimeException) {
                -1
            } finally {
                parcel.recycle()
            }
        }

        /** [SavedStateProfiler]'s measurement: the total, then from [breakdownMinBytes] on the breakdown, each timed. */
        fun measure(bundle: Any, breakdownMinBytes: Int, classLoader: ClassLoader?): SavedStateMeasurement {
            val start = System.nanoTime()
            val total = if (bundle is Bundle) totalBytes(bundle) else -1
            val measured = System.nanoTime()
            val result = if (total >= breakdownMinBytes) {
                SavedStateBreakdown(AndroidStateAccess(classLoader)).of(bundle)
            } else {
                null
            }
            val done = System.nanoTime()
            return SavedStateMeasurement(
                totalBytes = total.coerceAtLeast(0),
                measureMs = (measured - start) / NANOS_PER_MS,
                breakdownMs = if (result == null) null else (done - measured) / NANOS_PER_MS,
                breakdown = result,
            )
        }

        private const val NANOS_PER_MS = 1_000_000.0
    }
}

/** androidx.fragment's saved records, by class name and reflection (no compile-time androidx.fragment needed). */
internal object FragmentRecords {
    private const val MANAGER_STATE = "androidx.fragment.app.FragmentManagerState"
    private const val FRAGMENT_STATE = "androidx.fragment.app.FragmentState"
    /** Main thread only (saves run there). Null: the class has no such field. */
    private val fields = HashMap<String, Field?>()

    /**
     * Up to fragment 1.4 the manager's record holds its fragments' records (`mSavedState`; 1.5+ keeps them in
     * `fragment_<who>` Bundles instead, and `mActive` lists `who` strings only).
     */
    fun children(value: Any): List<Pair<String, Any?>>? = when (value.javaClass.name) {
        MANAGER_STATE -> (field(value, "mSavedState") as? List<*>)
            ?.filter { it != null && it.javaClass.name == FRAGMENT_STATE }
            ?.mapIndexed { index, state -> "fragment_${field(state!!, "mWho") ?: index}" to state }
            ?.takeIf { it.isNotEmpty() }
        FRAGMENT_STATE -> (field(value, "mSavedFragmentState") as? Bundle)?.let { listOf("savedFragmentState" to it) }
        else -> null
    }

    fun className(value: Any): String? =
        if (value.javaClass.name == FRAGMENT_STATE) field(value, "mClassName") as? String else null

    private fun field(target: Any, name: String): Any? {
        val key = "${target.javaClass.name}#$name"
        val field = if (fields.containsKey(key)) fields[key] else lookup(target.javaClass, name).also { fields[key] = it }
        if (field == null) return null
        return try {
            field.get(target)
        } catch (e: Exception) {
            null
        }
    }

    private fun lookup(type: Class<*>, name: String): Field? = try {
        type.getDeclaredField(name).apply { isAccessible = true }
    } catch (e: Exception) {
        null
    } catch (e: LinkageError) {
        null
    }
}
