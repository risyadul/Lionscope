package io.github.risyadul.lionscope.sample

import android.os.Bundle
import android.os.SystemClock
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.appcompat.widget.SwitchCompat
import androidx.fragment.app.Fragment
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView

/** A long list whose binding can be made deliberately slow to produce janky frames. */
class JankListFragment : Fragment(R.layout.fragment_list) {

    private val adapter = RowAdapter()

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        view.findViewById<SwitchCompat>(R.id.jank_toggle).setOnCheckedChangeListener { _, checked ->
            adapter.slowBind = checked
        }
        view.findViewById<RecyclerView>(R.id.list).apply {
            layoutManager = LinearLayoutManager(requireContext())
            adapter = this@JankListFragment.adapter
        }
    }

    private class RowAdapter : RecyclerView.Adapter<RowHolder>() {
        var slowBind = false

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RowHolder =
            RowHolder(LayoutInflater.from(parent.context).inflate(R.layout.item_row, parent, false))

        override fun onBindViewHolder(holder: RowHolder, position: Int) {
            if (slowBind) busyWait(SLOW_BIND_MS)
            holder.text.text = holder.text.context.getString(R.string.row_format, position)
        }

        override fun getItemCount(): Int = ROW_COUNT

        private fun busyWait(durationMs: Long) {
            val end = SystemClock.uptimeMillis() + durationMs
            while (SystemClock.uptimeMillis() < end) {
                // Spin on the main thread on purpose.
            }
        }
    }

    private class RowHolder(view: View) : RecyclerView.ViewHolder(view) {
        val text: TextView = view.findViewById(R.id.row_title)
    }

    private companion object {
        const val ROW_COUNT = 1_000
        const val SLOW_BIND_MS = 24L
    }
}
