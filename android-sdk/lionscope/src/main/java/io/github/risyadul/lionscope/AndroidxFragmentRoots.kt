package io.github.risyadul.lionscope

import android.app.Activity
import androidx.fragment.app.DialogFragment
import androidx.fragment.app.Fragment
import androidx.fragment.app.FragmentActivity

/**
 * androidx.fragment side of [FragmentOwnership]: only called when the app ships androidx.fragment (see
 * [ViewScene]); without it, this fails with a LinkageError the caller contains.
 */
internal object AndroidxFragmentRoots {
    /** Each fragment's view and, for a DialogFragment, its dialog's decor view (a dialog built in `onCreateDialog`). */
    fun collect(activity: Activity, into: MutableMap<Any, String>) {
        val manager = (activity as? FragmentActivity)?.supportFragmentManager ?: return
        FragmentOwnership.collect<Fragment>(
            top = manager.fragments,
            children = { if (it.isAdded) it.childFragmentManager.fragments else emptyList() },
            roots = { listOf(it.view, (it as? DialogFragment)?.dialog?.window?.peekDecorView()) },
            name = { it.javaClass.name },
            into = into,
        )
    }
}
