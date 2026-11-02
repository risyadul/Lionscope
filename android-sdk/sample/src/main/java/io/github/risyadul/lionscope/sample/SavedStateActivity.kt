@file:Suppress("DEPRECATION") // The legacy pager API mirrors the codebases this screen imitates.

package io.github.risyadul.lionscope.sample

import android.app.Activity
import android.app.Application
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Parcel
import android.util.Log
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import androidx.fragment.app.FragmentStatePagerAdapter
import androidx.viewpager.widget.ViewPager

/**
 * Saved-state harness (TransactionTooLargeException demo): a legacy ViewPager whose pages each hold a nested child
 * Fragment with a large saved state, and an Activity that adds its own large key AFTER `super.onSaveInstanceState()`.
 * Press Home to save its state without destroying it. Sizes come from intent extras (KiB):
 *
 * ```
 * adb shell am start -n io.github.risyadul.lionscope.sample/.SavedStateActivity --ei childKb 140 --ei lateKb 120
 * ```
 *
 * The payloads are filler bytes, never real data. `--ez spike true` logs (tag `LionscopeSpike`) which lifecycle hook
 * saw the complete bundle: `onActivitySaveInstanceState` runs inside `super.onSaveInstanceState()`, before the late key.
 */
class SavedStateActivity : AppCompatActivity(), ScreenName {

    private var spike: SpikeCallbacks? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        savedInstanceState?.getByteArray(LATE_KEY)?.let { Log.i(SPIKE_TAG, "restored $LATE_KEY: ${it.size} bytes") }
        if (intent.getBooleanExtra(EXTRA_SPIKE, false)) {
            spike = SpikeCallbacks(this).also(application::registerActivityLifecycleCallbacks)
        }
        val pager = ViewPager(this).apply { id = R.id.saved_state_pager }
        setContentView(FrameLayout(this).apply { addView(pager) })
        val childKb = intent.getIntExtra(EXTRA_CHILD_KB, DEFAULT_CHILD_KB)
        pager.offscreenPageLimit = PAGE_COUNT
        pager.adapter = object : FragmentStatePagerAdapter(supportFragmentManager, BEHAVIOR_SET_USER_VISIBLE_HINT) {
            override fun getCount(): Int = PAGE_COUNT
            override fun getItem(position: Int): Fragment = HeavyPageFragment.newInstance(position, childKb)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        // After super: the app's own callbacks (and Lionscope's pre-API-29 hook) have already run.
        val lateKb = intent.getIntExtra(EXTRA_LATE_KB, DEFAULT_LATE_KB)
        if (lateKb > 0) outState.putByteArray(LATE_KEY, ByteArray(lateKb * 1024))
        Log.i(SPIKE_TAG, "onSaveInstanceState done: keys=${outState.keySet().sorted()} finishing=$isFinishing")
    }

    override fun onStop() {
        super.onStop()
        Log.i(SPIKE_TAG, "onStop (isChangingConfigurations=$isChangingConfigurations, finishing=$isFinishing)")
    }

    override fun onDestroy() {
        spike?.let(application::unregisterActivityLifecycleCallbacks)
        Log.i(SPIKE_TAG, "onDestroy")
        super.onDestroy()
    }

    override fun getScreen(): Screen = Screen.SAVED_STATE

    /** Phase-0 spike: what each hook sees of the activity's bundle. */
    private class SpikeCallbacks(private val target: Activity) : Application.ActivityLifecycleCallbacks {
        private val main = Handler(Looper.getMainLooper())

        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {
            if (activity !== target) return
            report("onActivitySaveInstanceState", outState)
            main.post { report("posted-from-onActivitySaveInstanceState", outState) }
        }

        override fun onActivityPostSaveInstanceState(activity: Activity, outState: Bundle) {
            if (activity === target) report("onActivityPostSaveInstanceState", outState)
        }

        private fun report(hook: String, bundle: Bundle) {
            val parcel = Parcel.obtain()
            val started = System.nanoTime()
            val size = try {
                parcel.writeBundle(bundle)
                parcel.dataSize()
            } finally {
                parcel.recycle()
            }
            val micros = (System.nanoTime() - started) / 1000
            Log.i(
                SPIKE_TAG,
                "$hook api=${Build.VERSION.SDK_INT} hasLate=${bundle.containsKey(LATE_KEY)} bytes=$size " +
                    "writeUs=$micros keys=${bundle.keySet().sorted()}",
            )
        }

        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
        override fun onActivityStarted(activity: Activity) = Unit
        override fun onActivityResumed(activity: Activity) = Unit
        override fun onActivityPaused(activity: Activity) = Unit
        override fun onActivityStopped(activity: Activity) = Unit
        override fun onActivityDestroyed(activity: Activity) = Unit
    }

    companion object {
        const val EXTRA_CHILD_KB = "childKb"
        const val EXTRA_LATE_KB = "lateKb"
        const val EXTRA_SPIKE = "spike"
        const val LATE_KEY = "late_payload"
        const val SPIKE_TAG = "LionscopeSpike"
        const val PAGE_COUNT = 3
        const val DEFAULT_CHILD_KB = 100
        const val DEFAULT_LATE_KB = 120
    }
}

/** A pager page that hosts a nested child Fragment (the pattern that hides most of a large saved state). */
class HeavyPageFragment : Fragment() {

    override fun onCreateView(
        inflater: android.view.LayoutInflater,
        container: android.view.ViewGroup?,
        savedInstanceState: Bundle?,
    ): View = FrameLayout(inflater.context).apply { id = R.id.saved_state_child_container }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        if (childFragmentManager.findFragmentById(R.id.saved_state_child_container) == null) {
            val args = requireArguments()
            childFragmentManager.beginTransaction()
                .add(R.id.saved_state_child_container, HeavyChildFragment.newInstance(args.getInt(ARG_INDEX), args.getInt(ARG_KB)))
                .commitNow()
        }
    }

    companion object {
        private const val ARG_INDEX = "index"
        private const val ARG_KB = "kb"

        fun newInstance(index: Int, kb: Int) = HeavyPageFragment().apply {
            arguments = Bundle().apply {
                putInt(ARG_INDEX, index)
                putInt(ARG_KB, kb)
            }
        }
    }
}

/** Keeps a large filler payload in its saved state (like a cached list kept in `onSaveInstanceState`). */
class HeavyChildFragment : Fragment() {

    override fun onCreateView(
        inflater: android.view.LayoutInflater,
        container: android.view.ViewGroup?,
        savedInstanceState: Bundle?,
    ): View = TextView(inflater.context).apply {
        gravity = android.view.Gravity.CENTER
        text = context.getString(R.string.saved_state_page_format, requireArguments().getInt(ARG_INDEX) + 1)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Restored after process death: the payload must come back whole (Lionscope only reads the saved state).
        savedInstanceState?.getByteArray(CACHE_KEY)?.let {
            Log.i(SavedStateActivity.SPIKE_TAG, "restored $CACHE_KEY: ${it.size} bytes")
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putByteArray(CACHE_KEY, ByteArray(requireArguments().getInt(ARG_KB) * 1024))
    }

    companion object {
        private const val ARG_INDEX = "index"
        private const val ARG_KB = "kb"
        const val CACHE_KEY = "cached_items"

        fun newInstance(index: Int, kb: Int) = HeavyChildFragment().apply {
            arguments = Bundle().apply {
                putInt(ARG_INDEX, index)
                putInt(ARG_KB, kb)
            }
        }
    }
}
