package io.github.risyadul.lionscope.sample

import android.app.Dialog
import android.os.Bundle
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.DialogFragment

/** Dialog built in onCreateDialog (no fragment view), like most app dialogs. */
class PromoDialogFragment : DialogFragment() {

    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog =
        AlertDialog.Builder(requireContext())
            .setTitle(R.string.dialog_title)
            .setMessage(R.string.dialog_message)
            .setPositiveButton(R.string.dialog_dismiss, null)
            .create()

    companion object {
        const val TAG = "promo"
    }
}
