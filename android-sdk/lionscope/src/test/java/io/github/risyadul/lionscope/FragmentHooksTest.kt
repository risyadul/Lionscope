package io.github.risyadul.lionscope

import android.app.Dialog
import android.content.ContextWrapper
import android.os.Handler
import android.view.View
import androidx.fragment.app.DialogFragment
import androidx.fragment.app.Fragment
import androidx.fragment.app.FragmentHostCallback
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [FragmentHooks.isShown] against real androidx.fragment 1.4.1 classes. Fragment state is set through its
 * fields because a FragmentManager cannot run in a JVM test.
 */
class FragmentHooksTest {

    // Not named `context` / `host`: inside Fragment.apply {} those would resolve to Fragment.getContext()/getHost().
    private val testContext = ContextWrapper(null)
    private val testHost = object : FragmentHostCallback<Any>(testContext, @Suppress("DEPRECATION") Handler(), 0) {
        override fun onGetHost(): Any = this
    }
    private val hooks = FragmentHooks(ScreenTracker(FakeLink(), FakeScheduler()))

    private fun <T : Fragment> T.state(
        added: Boolean = true,
        hasView: Boolean = true,
        hidden: Boolean = false,
        userVisibleHint: Boolean = true,
        detached: Boolean = false,
        parent: Fragment? = null,
    ): T = apply {
        set("mHost", if (added) testHost else null)
        set("mAdded", added)
        set("mView", if (hasView) View(testContext) else null)
        set("mHidden", hidden)
        set("mUserVisibleHint", userVisibleHint)
        set("mDetached", detached)
        set("mParentFragment", parent)
    }

    private fun Fragment.set(field: String, value: Any?) {
        val f = Fragment::class.java.getDeclaredField(field)
        f.isAccessible = true
        f.set(this, value)
    }

    private class ShowingDialog(context: ContextWrapper, var showing: Boolean) : Dialog(context) {
        override fun isShowing(): Boolean = showing
    }

    private fun dialogFragment(dialog: Dialog?): DialogFragment = DialogFragment().state(hasView = false).also {
        val f = DialogFragment::class.java.getDeclaredField("mDialog")
        f.isAccessible = true
        f.set(it, dialog)
    }

    @Test
    fun visibleFragmentIsShown() {
        assertTrue(hooks.isShown(Fragment().state()))
    }

    @Test
    fun notAddedDetachedOrViewlessFragmentsAreNotShown() {
        assertFalse(hooks.isShown(Fragment().state(added = false)))
        assertFalse(hooks.isShown(Fragment().state(detached = true)))
        assertFalse(hooks.isShown(Fragment().state(hasView = false)))
    }

    @Test
    fun hiddenOrInvisibleAncestorHidesTheWholeSubtree() {
        val hiddenParent = Fragment().state(hidden = true)
        assertFalse(hooks.isShown(Fragment().state(parent = hiddenParent)))

        // Legacy ViewPager (BEHAVIOR_SET_USER_VISIBLE_HINT): off-screen page and its children.
        val offscreenPage = Fragment().state(userVisibleHint = false)
        val child = Fragment().state(parent = offscreenPage)
        assertFalse(hooks.isShown(offscreenPage))
        assertFalse(hooks.isShown(Fragment().state(parent = child)))

        val currentPage = Fragment().state(parent = Fragment().state())
        assertTrue(hooks.isShown(Fragment().state(parent = currentPage)))
    }

    @Test
    fun dialogFragmentIsShownOnlyWhileItsDialogIsShowing() {
        val dialog = ShowingDialog(testContext, showing = true)
        val fragment = dialogFragment(dialog)
        assertTrue(hooks.isShown(fragment)) // No fragment view needed for onCreateDialog dialogs.
        dialog.showing = false
        assertFalse(hooks.isShown(fragment))
        assertFalse(hooks.isShown(dialogFragment(null)))
    }

    @Test
    fun nonFragmentTargetsCountAsShown() {
        assertTrue(hooks.isShown(Any()))
    }
}
