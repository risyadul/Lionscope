package io.github.risyadul.lionscope.sample

import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.fragment.app.Fragment

/** Its alias can change without a lifecycle event, like a pager fragment whose alias follows viewPager.currentItem. */
class HomeFragment : Fragment(R.layout.fragment_home), ScreenName {
    private var alternateAlias = false

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        view.findViewById<View>(R.id.toggle_alias).setOnClickListener { alternateAlias = !alternateAlias }
        SlowWork.prepareFile(requireContext())
        view.findViewById<View>(R.id.block_main).setOnClickListener { SlowWork.blockMainThread() }
        view.findViewById<View>(R.id.read_file).setOnClickListener {
            val bytes = SlowWork.readFileOnMainThread()
            Toast.makeText(requireContext(), getString(R.string.read_file_done, bytes), Toast.LENGTH_SHORT).show()
        }
    }

    override fun getScreen(): Screen = if (alternateAlias) Screen.HOME_ALT else Screen.HOME
}
