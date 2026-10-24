package io.github.risyadul.lionscope.sample

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.asynclayoutinflater.view.AsyncLayoutInflater
import androidx.compose.ui.platform.ComposeView
import androidx.fragment.app.Fragment

class MoreFragment : Fragment(R.layout.fragment_more) {

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        view.findViewById<View>(R.id.open_detail).setOnClickListener {
            startActivity(Intent(requireContext(), DetailActivity::class.java))
        }
        view.findViewById<View>(R.id.show_dialog).setOnClickListener {
            PromoDialogFragment().show(childFragmentManager, PromoDialogFragment.TAG)
        }
        view.findViewById<ComposeView>(R.id.compose_card).setContent {
            ComposeNoteCard(onOpenShop = { startActivity(Intent(requireContext(), ComposeShopActivity::class.java)) })
        }
        val results = view.findViewById<ViewGroup>(R.id.off_main_results)
        view.findViewById<View>(R.id.inflate_off_main).setOnClickListener { inflateOffMain(results) }
    }

    /**
     * Inflation off the main thread must work as without Lionscope and never be recorded: AsyncLayoutInflater (its own
     * inflater, no factory) and a clone of the Activity's inflater (Lionscope's factory included, which then only
     * delegates to AppCompat). Each note shows the class it was created as (AppCompat: MaterialTextView).
     */
    private fun inflateOffMain(results: ViewGroup) {
        AsyncLayoutInflater(requireContext()).inflate(R.layout.view_off_main_note, results) { note, _, parent ->
            (note as TextView).text = note.context.getString(R.string.off_main_async, note.javaClass.simpleName)
            parent?.addView(note)
        }
        val inflater = layoutInflater.cloneInContext(requireContext())
        Thread {
            val note = inflater.inflate(R.layout.view_off_main_note, results, false) as TextView
            results.post {
                note.text = note.context.getString(R.string.off_main_worker, note.javaClass.simpleName)
                results.addView(note)
            }
        }.start()
    }
}
