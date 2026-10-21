package io.github.risyadul.lionscope.sample

import android.content.Intent
import android.os.Bundle
import android.view.View
import androidx.fragment.app.Fragment

class MoreFragment : Fragment(R.layout.fragment_more) {

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        view.findViewById<View>(R.id.open_detail).setOnClickListener {
            startActivity(Intent(requireContext(), DetailActivity::class.java))
        }
        view.findViewById<View>(R.id.show_dialog).setOnClickListener {
            PromoDialogFragment().show(childFragmentManager, PromoDialogFragment.TAG)
        }
    }
}
