package io.github.risyadul.lionscope

import io.github.risyadul.lionscope.testapp.ShopChains
import io.reactivex.Flowable
import io.reactivex.Observable
import io.reactivex.Observer
import io.reactivex.Single
import io.reactivex.disposables.Disposable
import io.reactivex.functions.BiFunction
import io.reactivex.functions.Function
import io.reactivex.plugins.RxJavaPlugins
import io.reactivex.schedulers.Schedulers
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.Executor

class RxJava2HooksTest {
    /** The test thread plays the main thread. */
    private val hooks = RxJava2Hooks(Thread.currentThread())

    /** Runs scheduled tasks on the calling thread: unlike trampoline, `observeOn` keeps its operator for it. */
    private val immediate = Schedulers.from(Executor { it.run() })

    private val ownership = AppOwnership("io.github.risyadul.lionscope")

    private fun frames(elements: Array<StackTraceElement>): List<StackFrame> =
        StackFrames.map(elements) { ownership.isOwned(it, null) }.frames

    @After
    fun resetPlugins() {
        RxJavaPlugins.reset()
    }

    @Test
    fun marksTheRxTaskThatRunsOnTheMainThread() {
        hooks.setEnabled(true)
        var seen: Any? = null
        Observable.just(1).observeOn(immediate).subscribe { seen = hooks.currentTask }
        assertEquals(RxJava2Hooks.OBSERVABLE_OBSERVE_ON + "\$ObserveOnObserver", seen?.javaClass?.name)
        assertNull(hooks.currentTask)
    }

    @Test
    fun aTaskOnAnotherThreadIsNotTheMainThreadsTask() {
        hooks.setEnabled(true)
        var seen: Any? = "unset"
        Observable.just(1).observeOn(Schedulers.newThread()).blockingSubscribe { }
        Single.just(1).observeOn(Schedulers.single()).doOnSuccess { seen = hooks.currentTask }.blockingGet()
        assertNull(seen)
    }

    @Test
    fun describesTheChainsConsumerAndSubscribeSite() {
        hooks.setEnabled(true)
        var origin: RxOrigin? = null
        val consumer = io.reactivex.functions.Consumer<Int> { origin = hooks.describe(hooks.currentTask!!, ::frames) }
        ShopChains.subscribeItems(immediate, consumer)

        val described = checkNotNull(origin)
        assertEquals(RxJava2Hooks.OBSERVABLE_OBSERVE_ON + "\$ObserveOnObserver", described.task)
        assertEquals(consumer.javaClass.name, described.consumer)
        // The subscribe call is the "app's"; RxJava's and the SDK's own frames are dropped.
        val site = described.subscribedAt.first()
        assertEquals(ShopChains::class.java.name, site.className)
        assertEquals("subscribeItems", site.method)
        assertTrue(described.subscribedAt.size <= MAX_RX_SITE_FRAMES)
        assertTrue(described.subscribedAt.none { it.className.startsWith("io.reactivex.") })
    }

    @Test
    fun anObserverOfTheAppIsItsOwnConsumer() {
        hooks.setEnabled(true)
        var origin: RxOrigin? = null
        val observer = object : Observer<Int> {
            override fun onSubscribe(d: Disposable) = Unit
            override fun onNext(t: Int) {
                origin = hooks.describe(hooks.currentTask!!, ::frames)
            }
            override fun onError(e: Throwable) = Unit
            override fun onComplete() = Unit
        }
        Flowable.just(1).observeOn(immediate).toObservable().subscribe(observer)
        assertEquals(observer.javaClass.name, origin?.consumer)
        assertEquals(RxJava2Hooks.FLOWABLE_OBSERVE_ON + "\$ObserveOnSubscriber", origin?.task)
    }

    @Test
    fun withoutACapturedSiteTheOriginHasNoFrames() {
        var origin: RxOrigin? = null
        val chain = Observable.just(1).observeOn(immediate)
        // Subscribed while off (before the session): no site; scheduled while on.
        val subject = io.reactivex.subjects.PublishSubject.create<Int>()
        subject.observeOn(immediate).subscribe { origin = hooks.describe(hooks.currentTask!!, ::frames) }
        hooks.setEnabled(true)
        subject.onNext(1)
        assertNotNull(origin)
        assertEquals(emptyList<StackFrame>(), origin?.subscribedAt)
        chain.subscribe()
    }

    @Test
    fun callsTheAppsOwnHooksAndPutsThemBack() {
        val scheduled = ArrayList<Runnable>()
        val subscribed = ArrayList<Any>()
        val appSchedule = Function<Runnable, Runnable> { scheduled += it; it }
        val appSubscribe = BiFunction<Observable<*>, Observer<*>, Observer<*>> { source, observer ->
            subscribed += source
            observer
        }
        RxJavaPlugins.setScheduleHandler(appSchedule)
        RxJavaPlugins.setOnObservableSubscribe(appSubscribe)

        hooks.setEnabled(true)
        var seen: Any? = null
        Observable.just(1).observeOn(immediate).subscribe { seen = hooks.currentTask }
        assertNotNull(seen)
        assertEquals(1, scheduled.size)
        assertTrue(subscribed.isNotEmpty())

        hooks.setEnabled(false)
        assertSame(appSchedule, RxJavaPlugins.getScheduleHandler())
        assertSame(appSubscribe, RxJavaPlugins.getOnObservableSubscribe())
    }

    @Test
    fun aHookTheAppReplacedStaysAPassThroughAndIsNeverInstalledTwice() {
        hooks.setEnabled(true)
        val ours = RxJavaPlugins.getScheduleHandler()!!
        // The app wraps our handler in its own.
        val appSchedule = Function<Runnable, Runnable> { ours.apply(it) }
        RxJavaPlugins.setScheduleHandler(appSchedule)

        hooks.setEnabled(false)
        assertSame(appSchedule, RxJavaPlugins.getScheduleHandler())
        hooks.setEnabled(true)
        assertSame(appSchedule, RxJavaPlugins.getScheduleHandler())
        // Ours is called once through the app's, not in a loop.
        var seen: Any? = null
        Observable.just(1).observeOn(immediate).subscribe { seen = hooks.currentTask }
        assertNotNull(seen)
    }

    @Test
    fun offRemovesOurHooksAndTracksNothing() {
        hooks.setEnabled(true)
        hooks.setEnabled(false)
        assertNull(RxJavaPlugins.getScheduleHandler())
        assertNull(RxJavaPlugins.getOnObservableSubscribe())
        assertNull(RxJavaPlugins.getOnFlowableSubscribe())
        assertNull(RxJavaPlugins.getOnSingleSubscribe())
        assertNull(RxJavaPlugins.getOnMaybeSubscribe())
        assertNull(RxJavaPlugins.getOnCompletableSubscribe())
        var seen: Any? = "unset"
        Observable.just(1).observeOn(immediate).subscribe { seen = hooks.currentTask }
        assertNull(seen)
    }

    @Test
    fun anUnreadableTaskDescribesAsNoConsumer() {
        val origin = hooks.describe(Runnable { }, ::frames)
        assertEquals(null, origin?.consumer)
        assertEquals(emptyList<StackFrame>(), origin?.subscribedAt)
    }

    @Test
    fun createIfPresentFindsRxJava() {
        assertTrue(RxTracking.createIfPresent(Thread.currentThread()) is LazyRxTracking)
    }

    @Test
    fun anAppWrapperAroundOurSavedHookDoesNotRecurse() {
        hooks.setEnabled(true)
        val saved = RxJavaPlugins.getScheduleHandler()!! // The app keeps a reference to ours...
        hooks.setEnabled(false) // ...we take ours out (still the installed one)...
        assertNull(RxJavaPlugins.getScheduleHandler())
        // ...and the app installs a wrapper that calls the one it kept.
        var wrapped = 0
        RxJavaPlugins.setScheduleHandler(Function<Runnable, Runnable> { wrapped++; saved.apply(it) })
        hooks.setEnabled(true) // Ours now goes in front of that wrapper: ours → wrapper → ours.
        var seen: Any? = null
        Observable.just(1).observeOn(immediate).subscribe { seen = hooks.currentTask }
        assertNotNull(seen)
        assertEquals(1, wrapped)
    }

    @Test
    fun aHookTheAppPutBackItselfIsNotChainedToItself() {
        hooks.setEnabled(true)
        val ours = RxJavaPlugins.getScheduleHandler()
        hooks.setEnabled(false)
        RxJavaPlugins.setScheduleHandler(ours) // The app restores the reference it kept.
        hooks.setEnabled(true)
        assertSame(ours, RxJavaPlugins.getScheduleHandler())
        var seen: Any? = null
        Observable.just(1).observeOn(immediate).subscribe { seen = hooks.currentTask }
        assertNotNull(seen)
    }

    @Test
    fun aLockedDownRxJavaGetsNoHooks() {
        RxJavaPlugins.lockdown()
        try {
            hooks.setEnabled(true)
            assertNull(RxJavaPlugins.getScheduleHandler())
            var seen: Any? = "unset"
            Observable.just(1).observeOn(immediate).subscribe { seen = hooks.currentTask }
            assertNull(seen)
        } finally {
            // Package-private, for RxJava's own tests.
            RxJavaPlugins::class.java.getDeclaredMethod("unlock").apply { isAccessible = true }.invoke(null)
        }
    }

    @Test
    fun aSiteWithoutAppFramesIsDropped() {
        hooks.setEnabled(true)
        var origin: RxOrigin? = null
        val subscribed = java.util.concurrent.CountDownLatch(1)
        val subject = io.reactivex.subjects.PublishSubject.create<Int>()
        // observeOn below subscribeOn: it is subscribed on the scheduler's thread, far from the app's subscribe call.
        subject.observeOn(immediate).doOnSubscribe { subscribed.countDown() }.subscribeOn(Schedulers.single())
            .subscribe { origin = hooks.describe(hooks.currentTask!!, ::frames) }
        assertTrue(subscribed.await(5, java.util.concurrent.TimeUnit.SECONDS))
        subject.onNext(1)
        assertNotNull(origin)
        assertEquals(emptyList<StackFrame>(), origin?.subscribedAt)
    }

    @Test
    fun createIfPresentCreatesTheHooksOnTheFirstEnableOnly() {
        var created = 0
        val lazy = LazyRxTracking { created++; hooks }
        lazy.setEnabled(false)
        assertNull(lazy.currentTask)
        assertEquals(0, created)
        lazy.setEnabled(true)
        lazy.setEnabled(false)
        lazy.setEnabled(true)
        assertEquals(1, created)
        assertNotNull(RxJavaPlugins.getScheduleHandler())
    }

    @Test
    fun aFailingCreationLeavesTrackingOff() {
        var tries = 0
        val lazy = LazyRxTracking { tries++; throw NoSuchMethodError("RxJavaPlugins.getOnMaybeSubscribe") }
        lazy.setEnabled(true)
        lazy.setEnabled(true)
        assertEquals(1, tries)
        assertNull(lazy.describe(Any()) { emptyList() })
    }
}
