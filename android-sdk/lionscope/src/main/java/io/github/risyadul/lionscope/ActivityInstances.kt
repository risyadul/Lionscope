package io.github.risyadul.lionscope

import android.app.Activity
import java.util.ArrayDeque
import java.util.WeakHashMap

/** One Activity object alive in the app, as `liveActivities` lists it. Immutable: lists of it are encoded later. */
internal class LiveActivity(val id: Int, val activity: String, val prevId: Int?)

/** The live Activity objects at one moment ([ActivityInstances.snapshot]). */
internal class LiveActivities(val entries: List<LiveActivity>, val truncated: Boolean)

/**
 * Numbers the app's Activity objects for `savedState.instanceId` and `liveActivities`: 1, 2, 3… per process, in the
 * order they are first seen (created, or for one created before the SDK was installed, its first callback). An Activity
 * recreated by a configuration change (rotation) gets a new number and, as `prevId`, the number of the one it replaces:
 * Android destroys the old one with `isChangingConfigurations` and creates the new one with a saved state in the same
 * main-thread message (ActivityThread.handleRelaunchActivity), so a destroy waits for its successor only until the
 * messages already queued have run, per class, oldest first. Any other recreation ("Don't keep activities", process
 * death) is a new instance without `prevId`. Keeps no Activity alive (weak keys). Main thread only.
 */
internal class ActivityInstances(
    private val main: MainScheduler,
    private val changingConfigurations: (Activity) -> Boolean = { it.isChangingConfigurations },
    private val maxListed: Int = MAX_LIVE_ACTIVITIES,
) {
    private val ids = WeakHashMap<Activity, Int>()
    /** By id, ascending: ids only grow. */
    private val live = LinkedHashMap<Int, LiveActivity>()
    /** Ids destroyed for a configuration change in this message, by Activity class, oldest first. */
    private val replaced = HashMap<String, ArrayDeque<Int>>()
    private var clearPosted = false
    private var nextId = 1

    /** [activity]'s number, given now (without `prevId`) to one not seen before. */
    fun idOf(activity: Activity): Int = ids[activity] ?: add(activity, prevId = null)

    /** Whether [activity] has no number yet ([idOf] would give it one). */
    fun isNew(activity: Activity): Boolean = !ids.containsKey(activity)

    /** `onActivityCreated`; [restored]: it got a saved state. Returns its number. */
    fun onCreated(activity: Activity, restored: Boolean): Int {
        ids[activity]?.let { return it }
        val prevId = if (restored) replaced[activity.javaClass.name]?.pollFirst() else null
        return add(activity, prevId)
    }

    /** `onActivityDestroyed`; false when [activity] was not numbered (nothing changed). */
    fun onDestroyed(activity: Activity): Boolean {
        val id = ids.remove(activity) ?: return false
        live.remove(id)
        if (changingConfigurations(activity)) {
            replaced.getOrPut(activity.javaClass.name) { ArrayDeque() }.addLast(id)
            if (!clearPosted) {
                clearPosted = true
                // Runs after the rest of this message: a successor created later is not this one's.
                main.post(Runnable {
                    clearPosted = false
                    replaced.clear()
                })
            }
        }
        return true
    }

    /** A copy of the live instances, by id; the newest [maxListed] when there are more (`truncated`). */
    fun snapshot(): LiveActivities {
        val all = live.values.toList()
        return if (all.size > maxListed) LiveActivities(all.takeLast(maxListed), truncated = true) else LiveActivities(all, false)
    }

    private fun add(activity: Activity, prevId: Int?): Int {
        val id = nextId++
        ids[activity] = id
        live[id] = LiveActivity(id, activity.javaClass.name, prevId)
        return id
    }
}
