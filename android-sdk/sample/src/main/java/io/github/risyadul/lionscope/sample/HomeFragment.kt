package io.github.risyadul.lionscope.sample

import android.os.Bundle
import android.view.View
import androidx.fragment.app.Fragment

/** Its alias can change without a lifecycle event, like a pager fragment whose alias follows viewPager.currentItem. */
class HomeFragment : Fragment(R.layout.fragment_home), ScreenName {
    private var alternateAlias = false

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        view.findViewById<View>(R.id.toggle_alias).setOnClickListener { alternateAlias = !alternateAlias }
    }

    override fun getScreen(): Screen = if (alternateAlias) Screen.HOME_ALT else Screen.HOME
}
