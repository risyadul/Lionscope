package io.github.risyadul.lionscope.sample

import android.os.Bundle
import android.view.View
import androidx.fragment.app.Fragment

/** Container that hosts [MoreFragment] in its child FragmentManager (exercises nested resolution). */
class MoreContainerFragment : Fragment(R.layout.fragment_more_container) {

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        if (savedInstanceState == null) {
            childFragmentManager.beginTransaction()
                .replace(R.id.child_container, MoreFragment())
                .commit()
        }
    }
}
