package io.github.risyadul.lionscope

import android.app.Activity
import android.os.Bundle
import android.view.View
import androidx.fragment.app.DialogFragment
import androidx.fragment.app.Fragment
import androidx.fragment.app.FragmentActivity
import androidx.fragment.app.FragmentManager

/**
 * androidx.fragment integration. Only instantiated when the app ships androidx.fragment: loading this class
 * without it fails (missing superclass), so the availability check lives in [ScreenTracker].
 */
internal class FragmentHooks(private val tracker: ScreenTracker) : FragmentManager.FragmentLifecycleCallbacks() {

    fun register(activity: Activity) {
        if (activity is FragmentActivity) {
            activity.supportFragmentManager.registerFragmentLifecycleCallbacks(this, true)
        }
    }

    fun isShown(target: Any): Boolean {
        val fragment = target as? Fragment ?: return true
        if (!fragment.isAdded || fragment.isDetached) return false
        if (fragment is DialogFragment && fragment.showsDialog) return fragment.dialog?.isShowing == true
        if (fragment.view == null) return false
        var current: Fragment? = fragment
        while (current != null) {
            if (current.isHidden || !isUserVisible(current)) return false
            current = current.parentFragment
        }
        return true
    }

    override fun onFragmentViewCreated(fm: FragmentManager, f: Fragment, v: View, savedInstanceState: Bundle?) =
        tracker.onFragmentViewCreated(f, f.activity, v)

    override fun onFragmentStarted(fm: FragmentManager, f: Fragment) = guarded {
        if (f is DialogFragment && f.showsDialog) {
            val window = f.dialog?.window ?: return@guarded
            tracker.onDialogShown(f, f.activity, window, f.javaClass.name)
        }
    }

    override fun onFragmentResumed(fm: FragmentManager, f: Fragment) = guarded {
        val activity = f.activity ?: return@guarded
        val kind = if (f is DialogFragment && f.showsDialog) ScreenKind.DIALOG else ScreenKind.FRAGMENT
        tracker.onFragmentResumed(f, activity, f.parentFragment, kind)
    }

    override fun onFragmentPaused(fm: FragmentManager, f: Fragment) = tracker.onFragmentPaused(f)

    override fun onFragmentStopped(fm: FragmentManager, f: Fragment) {
        tracker.onDialogHidden(f)
        tracker.onFragmentGone(f)
    }

    override fun onFragmentViewDestroyed(fm: FragmentManager, f: Fragment) {
        tracker.onFragmentViewDestroyed(f)
        tracker.onFragmentGone(f)
    }

    override fun onFragmentDestroyed(fm: FragmentManager, f: Fragment) = tracker.onFragmentGone(f)

    override fun onFragmentDetached(fm: FragmentManager, f: Fragment) = tracker.onFragmentGone(f)

    /** Legacy ViewPager adapters signal the current page through userVisibleHint; failures count as visible. */
    @Suppress("DEPRECATION")
    private fun isUserVisible(fragment: Fragment): Boolean = try {
        fragment.userVisibleHint
    } catch (t: Throwable) {
        true
    }
}
