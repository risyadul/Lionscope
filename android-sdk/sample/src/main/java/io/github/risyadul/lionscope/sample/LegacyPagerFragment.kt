@file:Suppress("DEPRECATION") // The legacy pager API is the point of this screen.

package io.github.risyadul.lionscope.sample

import android.os.Bundle
import android.view.View
import android.widget.TextView
import androidx.fragment.app.Fragment
import androidx.fragment.app.FragmentStatePagerAdapter
import androidx.viewpager.widget.ViewPager

/**
 * Old-style ViewPager with BEHAVIOR_SET_USER_VISIBLE_HINT (still the default in many older codebases): all
 * pages stay resumed and a swipe only flips userVisibleHint, so no lifecycle callback reports it.
 */
class LegacyPagerFragment : Fragment(R.layout.fragment_pager) {

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        view.findViewById<ViewPager>(R.id.legacy_pager).adapter = PagesAdapter()
    }

    private inner class PagesAdapter : FragmentStatePagerAdapter(childFragmentManager, BEHAVIOR_SET_USER_VISIBLE_HINT) {
        override fun getCount(): Int = PAGE_COUNT
        override fun getItem(position: Int): Fragment = PageFragment.newInstance(position)
    }

    private companion object {
        const val PAGE_COUNT = 3
    }
}

class PageFragment : Fragment(R.layout.fragment_page), ScreenName {

    private val index: Int
        get() = requireArguments().getInt(ARG_INDEX)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        view.findViewById<TextView>(R.id.page_text).text = getString(R.string.page_format, index + 1)
    }

    override fun getScreen(): Screen = when (index) {
        0 -> Screen.PAGE_1
        1 -> Screen.PAGE_2
        else -> Screen.PAGE_3
    }

    companion object {
        private const val ARG_INDEX = "index"

        fun newInstance(index: Int) = PageFragment().apply { arguments = Bundle().apply { putInt(ARG_INDEX, index) } }
    }
}
