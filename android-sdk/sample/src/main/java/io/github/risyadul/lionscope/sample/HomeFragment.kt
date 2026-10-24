package io.github.risyadul.lionscope.sample

import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.fragment.app.Fragment
import io.reactivex.disposables.CompositeDisposable
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel

/** Its alias can change without a lifecycle event, like a pager fragment whose alias follows viewPager.currentItem. */
class HomeFragment : Fragment(R.layout.fragment_home), ScreenName {
    private var alternateAlias = false
    private val disposables = CompositeDisposable()
    private var scope: CoroutineScope? = null

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        view.findViewById<View>(R.id.toggle_alias).setOnClickListener { alternateAlias = !alternateAlias }
        SlowWork.prepareFile(requireContext())
        view.findViewById<View>(R.id.block_main).setOnClickListener { SlowWork.blockMainThread() }
        view.findViewById<View>(R.id.read_file).setOnClickListener {
            val bytes = SlowWork.readFileOnMainThread()
            Toast.makeText(requireContext(), getString(R.string.read_file_done, bytes), Toast.LENGTH_SHORT).show()
        }
        val coroutines = MainScope()
        scope = coroutines
        view.findViewById<View>(R.id.rx_stall).setOnClickListener {
            disposables.add(AsyncWork.loadPricesWithRx(::showDone))
        }
        view.findViewById<View>(R.id.coroutine_stall).setOnClickListener {
            AsyncWork.refreshCartWithCoroutine(coroutines, ::showDone)
        }
    }

    override fun onDestroyView() {
        disposables.clear()
        scope?.cancel()
        scope = null
        super.onDestroyView()
    }

    private fun showDone(value: Int) {
        Toast.makeText(requireContext(), getString(R.string.async_done, value), Toast.LENGTH_SHORT).show()
    }

    override fun getScreen(): Screen = if (alternateAlias) Screen.HOME_ALT else Screen.HOME
}
