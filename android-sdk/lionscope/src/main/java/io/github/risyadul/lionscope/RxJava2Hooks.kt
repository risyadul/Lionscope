package io.github.risyadul.lionscope

import android.util.Log
import io.reactivex.Completable
import io.reactivex.CompletableObserver
import io.reactivex.Flowable
import io.reactivex.Maybe
import io.reactivex.MaybeObserver
import io.reactivex.Observable
import io.reactivex.Observer
import io.reactivex.Single
import io.reactivex.SingleObserver
import io.reactivex.functions.BiFunction
import io.reactivex.functions.Function
import io.reactivex.plugins.RxJavaPlugins
import org.reactivestreams.Subscriber

/**
 * [RxTracking] for RxJava 2 (loaded only when the app has it). Two kinds of `RxJavaPlugins` hooks, each calling the
 * hook the app had installed before it:
 * - the schedule handler wraps every scheduled task so that, while it runs on the main thread, [currentTask] is the
 *   task (an `ObserveOnObserver`, a timer...): the watchdog reads it with each stack sample;
 * - the subscribe hooks keep, for each subscription of an `observeOn` operator, an unmaterialised [SubscribeSite]
 *   (the stack is only turned into frames for a stall), keyed weakly by the operator's downstream observer, at most
 *   [SITES_PER_SECOND] per second.
 * A hook is installed at most once until it is removed again: when the app replaced or wrapped one of ours, ours
 * stays where it is (a pass-through while off) and is not installed a second time. Should the app still end up
 * calling ours from the hook ours calls (it kept ours and wrapped it after we removed it), a per-thread guard makes the
 * inner call return its input untouched instead of recursing. Nothing is installed while `RxJavaPlugins` is locked
 * down.
 */
internal class RxJava2Hooks(private val mainThread: Thread) : RxTracking {
    @Volatile
    private var enabled = false

    /** False after a failure (an RxJava without these plugin methods): never tried again. */
    private var usable = true

    @Volatile
    override var currentTask: Any? = null
        private set

    private val sites = BoundedWeakIdentityMap<Any, SubscribeSite>(MAX_SITES)
    private val siteLimit = PerSecondLimit(SITES_PER_SECOND)

    private val schedule = ScheduleHook()
    private val observable = SubscribeHook<Observable<*>, Observer<*>>(OBSERVABLE_OBSERVE_ON)
    private val flowable = SubscribeHook<Flowable<*>, Subscriber<*>>(FLOWABLE_OBSERVE_ON)
    private val single = SubscribeHook<Single<*>, SingleObserver<*>>(SINGLE_OBSERVE_ON)
    private val maybe = SubscribeHook<Maybe<*>, MaybeObserver<*>>(MAYBE_OBSERVE_ON)
    private val completable = SubscribeHook<Completable, CompletableObserver>(COMPLETABLE_OBSERVE_ON)

    /** The stack of a `subscribe` call, kept as the VM captured it. */
    private class SubscribeSite : Throwable()

    override fun setEnabled(enabled: Boolean) {
        if (!usable || enabled == this.enabled) return
        try {
            if (enabled) {
                if (RxJavaPlugins.isLockdown()) {
                    Log.i(LOG_TAG, "Lionscope RxJava tracking off: RxJavaPlugins is locked down")
                    usable = false
                    return
                }
                install()
                this.enabled = true
            } else {
                this.enabled = false
                uninstall()
                sites.clear()
            }
        } catch (t: Throwable) {
            if (isFatal(t)) throw t
            this.enabled = false
            usable = false
            Log.w(LOG_TAG, "Lionscope RxJava tracking disabled: $t")
        }
    }

    private fun install() {
        schedule.install(RxJavaPlugins.getScheduleHandler()) { RxJavaPlugins.setScheduleHandler(it) }
        observable.install(RxJavaPlugins.getOnObservableSubscribe()) { RxJavaPlugins.setOnObservableSubscribe(it) }
        flowable.install(RxJavaPlugins.getOnFlowableSubscribe()) { RxJavaPlugins.setOnFlowableSubscribe(it) }
        single.install(RxJavaPlugins.getOnSingleSubscribe()) { RxJavaPlugins.setOnSingleSubscribe(it) }
        maybe.install(RxJavaPlugins.getOnMaybeSubscribe(), ::setMaybeHook)
        completable.install(RxJavaPlugins.getOnCompletableSubscribe()) { RxJavaPlugins.setOnCompletableSubscribe(it) }
    }

    private fun uninstall() {
        schedule.uninstall(RxJavaPlugins.getScheduleHandler()) { RxJavaPlugins.setScheduleHandler(it) }
        observable.uninstall(RxJavaPlugins.getOnObservableSubscribe()) { RxJavaPlugins.setOnObservableSubscribe(it) }
        flowable.uninstall(RxJavaPlugins.getOnFlowableSubscribe()) { RxJavaPlugins.setOnFlowableSubscribe(it) }
        single.uninstall(RxJavaPlugins.getOnSingleSubscribe()) { RxJavaPlugins.setOnSingleSubscribe(it) }
        maybe.uninstall(RxJavaPlugins.getOnMaybeSubscribe(), ::setMaybeHook)
        completable.uninstall(RxJavaPlugins.getOnCompletableSubscribe()) {
            RxJavaPlugins.setOnCompletableSubscribe(it)
        }
    }

    /** RxJava declares the Maybe hook's observer parameter invariant (`MaybeObserver`, not `? super`). */
    @Suppress("UNCHECKED_CAST")
    private fun setMaybeHook(hook: BiFunction<in Maybe<*>, in MaybeObserver<*>, out MaybeObserver<*>>?) {
        RxJavaPlugins.setOnMaybeSubscribe(hook as BiFunction<in Maybe<*>, MaybeObserver<*>, out MaybeObserver<*>>?)
    }

    /**
     * One plugin slot: [install] puts this hook in front of [previous] unless it is already in the chain; [uninstall]
     * puts [previous] back if this hook is still the installed one.
     */
    private abstract class Slot<H : Any> {
        @Volatile
        var previous: H? = null
            private set

        private var inChain = false

        abstract val self: H

        fun install(current: H?, set: (H?) -> Unit) {
            if (inChain) return
            if (current === self) {
                // The app put ours back itself: calling `current` from ours would loop.
                inChain = true
                return
            }
            previous = current
            set(self)
            inChain = true
        }

        private val entered = object : ThreadLocal<BooleanArray>() {
            override fun initialValue() = BooleanArray(1)
        }

        /**
         * [block], unless this hook is already running on this thread: then [input] as it came. A nested call from
         * the app's own hook (it schedules or subscribes inline) then skips the app's hook for the inner call too: rare,
         * and the price of never recursing.
         */
        protected inline fun <T> once(input: T, block: () -> T): T {
            val flag = entered.get() ?: return block()
            if (flag[0]) return input
            flag[0] = true
            try {
                return block()
            } finally {
                flag[0] = false
            }
        }

        fun uninstall(current: H?, set: (H?) -> Unit) {
            if (!inChain || current !== self) return
            set(previous)
            inChain = false
        }
    }

    private inner class ScheduleHook : Slot<Function<in Runnable, out Runnable>>(), Function<Runnable, Runnable> {
        override val self: Function<in Runnable, out Runnable> get() = this

        override fun apply(task: Runnable): Runnable = once(task) {
            val scheduled = previous?.apply(task) ?: task
            if (enabled) TrackedTask(task, scheduled) else scheduled
        }
    }

    /** Marks [task] as the main thread's current Rx task while [scheduled] (the app's wrapping of it) runs there. */
    private inner class TrackedTask(private val task: Runnable, private val scheduled: Runnable) : Runnable {
        override fun run() {
            if (Thread.currentThread() !== mainThread) return scheduled.run()
            val outer = currentTask
            currentTask = task
            try {
                scheduled.run()
            } finally {
                currentTask = outer
            }
        }
    }

    private inner class SubscribeHook<S : Any, O : Any>(observeOnName: String) :
        Slot<BiFunction<in S, in O, out O>>(), BiFunction<S, O, O> {
        private val observeOn: Class<*>? = loadClass(observeOnName)

        override val self: BiFunction<in S, in O, out O> get() = this

        override fun apply(source: S, observer: O): O = once(observer) {
            val downstream = previous?.apply(source, observer) ?: observer
            if (enabled && source.javaClass === observeOn) guarded { recordSite(downstream) }
            downstream
        }

        /** Our part only: an SDK failure must not fail the app's subscription (the app's own hook may throw). */
        private fun recordSite(downstream: O) {
            if (siteLimit.tryAcquire()) sites.put(downstream, SubscribeSite())
        }
    }

    override fun describe(task: Any, frames: (Array<StackTraceElement>) -> List<StackFrame>): RxOrigin? = try {
        var site: SubscribeSite? = sites.get(task)
        var last: Any = task
        for (hop in 0 until MAX_HOPS) {
            val next = downstreamOf(last) ?: break
            if (site == null) site = sites.get(next)
            last = next
        }
        RxOrigin(
            task = task.javaClass.name,
            consumer = if (last === task) null else consumerOf(last),
            // A site without app frames (an observeOn subscribed from a scheduler's thread) says nothing.
            subscribedAt = site?.let { frames(siteElements(it.stackTrace)) }?.takeIf { s -> s.any { it.inApp } }
                ?: emptyList(),
        )
    } catch (t: Throwable) {
        if (isFatal(t)) throw t
        null
    }

    internal companion object {
        private const val INTERNAL = "io.reactivex.internal.operators."
        const val OBSERVABLE_OBSERVE_ON = INTERNAL + "observable.ObservableObserveOn"
        const val FLOWABLE_OBSERVE_ON = INTERNAL + "flowable.FlowableObserveOn"
        const val SINGLE_OBSERVE_ON = INTERNAL + "single.SingleObserveOn"
        const val MAYBE_OBSERVE_ON = INTERNAL + "maybe.MaybeObserveOn"
        const val COMPLETABLE_OBSERVE_ON = INTERNAL + "completable.CompletableObserveOn"
        /** Each site holds its VM backtrace (about 1 KB at depth 60): a few MB at most, for long-lived chains. */
        const val MAX_SITES = 2048
        const val SITES_PER_SECOND = 100
        /** Downstream links followed from a task to its final consumer. */
        const val MAX_HOPS = 32
        /** Fields of RxJava 2's operators pointing downstream (`actual` before 2.2). */
        private val DOWNSTREAM_FIELDS = setOf("downstream", "actual")
        /** The callback fields of RxJava's lambda observers, in the order they name a consumer. */
        private val CALLBACK_FIELDS = listOf("onNext", "onSuccess", "onComplete", "onCallback")

        private fun loadClass(name: String): Class<*>? = try {
            Class.forName(name, false, RxJava2Hooks::class.java.classLoader)
        } catch (e: ClassNotFoundException) {
            null
        }

        /** The next observer of an RxJava operator (its `downstream` / `actual` field), null for any other object. */
        fun downstreamOf(node: Any): Any? {
            if (!node.javaClass.name.startsWith("io.reactivex.")) return null
            return fieldValue(node) { it in DOWNSTREAM_FIELDS }
        }

        /** The final observer's consumer: the lambda of a `subscribe(…)`, or the app's own observer class. */
        fun consumerOf(observer: Any): String {
            if (!observer.javaClass.name.startsWith("io.reactivex.")) return observer.javaClass.name
            for (name in CALLBACK_FIELDS) {
                val callback = fieldValue(observer) { it == name } ?: continue
                if (!callback.javaClass.name.startsWith("io.reactivex.")) return callback.javaClass.name
            }
            return observer.javaClass.name
        }

        /** The subscribe call's stack without the SDK's and RxJava's frames, at most [MAX_RX_SITE_FRAMES]. */
        fun siteElements(stack: Array<StackTraceElement>): Array<StackTraceElement> {
            val start = stack.indexOfFirst { !StackFrames.isSdkClass(it.className) && !it.className.startsWith("io.reactivex.") }
            if (start < 0) return emptyArray()
            return stack.copyOfRange(start, minOf(stack.size, start + MAX_RX_SITE_FRAMES))
        }

        private fun fieldValue(node: Any, matches: (String) -> Boolean): Any? {
            var type: Class<*>? = node.javaClass
            while (type != null && type != Any::class.java) {
                for (field in type.declaredFields) {
                    if (java.lang.reflect.Modifier.isStatic(field.modifiers) || !matches(field.name)) continue
                    field.isAccessible = true
                    return field.get(node)
                }
                type = type.superclass
            }
            return null
        }
    }
}
