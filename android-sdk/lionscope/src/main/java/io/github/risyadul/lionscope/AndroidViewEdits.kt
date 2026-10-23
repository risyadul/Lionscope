package io.github.risyadul.lionscope

import android.content.res.ColorStateList
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.os.Build
import android.text.TextUtils
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.widget.TextView

/**
 * [ViewEditAccess] over real views: only the platform setters (they may call the app's own listeners, e.g. a
 * TextWatcher or a custom view's `setPadding` override; no app method is called otherwise). Padding is set relative
 * when the view's is (`isPaddingRelative`), a margin also as its start / end margin when the params are relative, so
 * the side edited is the side that moves in either layout direction. A background color is a new ColorDrawable (the
 * original Drawable is kept untouched for the revert). Text size is set in sp and restored in px.
 */
internal object AndroidViewEdits : ViewEditAccess<View> {
    override fun isAttached(view: View): Boolean = view.isAttachedToWindow

    override fun supports(view: View, property: ViewProperty): Boolean = when (property) {
        ViewProperty.MARGIN_LEFT, ViewProperty.MARGIN_TOP, ViewProperty.MARGIN_RIGHT, ViewProperty.MARGIN_BOTTOM ->
            view.layoutParams is ViewGroup.MarginLayoutParams
        // A window root's size belongs to its window (WindowManager), not to its layout params.
        ViewProperty.LAYOUT_WIDTH, ViewProperty.LAYOUT_HEIGHT -> view.layoutParams != null && view.parent is View
        ViewProperty.TEXT, ViewProperty.TEXT_SIZE, ViewProperty.TEXT_COLOR -> view is TextView
        else -> true
    }

    override fun isPassword(view: View): Boolean = isPasswordView(view)

    override fun save(view: View, property: ViewProperty): Any? = when (property) {
        ViewProperty.BACKGROUND_COLOR -> view.background
        ViewProperty.TEXT_COLOR -> (view as TextView).textColors
        // Styled text keeps its spans; an Editable is copied, as the field goes on editing it.
        ViewProperty.TEXT -> TextUtils.stringOrSpannedString((view as TextView).text)
        else -> read(view, property)
    }

    override fun read(view: View, property: ViewProperty): Any? = when (property) {
        ViewProperty.VISIBILITY -> view.visibility
        ViewProperty.ALPHA -> view.alpha
        ViewProperty.ENABLED -> view.isEnabled
        ViewProperty.PADDING_LEFT -> view.paddingLeft
        ViewProperty.PADDING_TOP -> view.paddingTop
        ViewProperty.PADDING_RIGHT -> view.paddingRight
        ViewProperty.PADDING_BOTTOM -> view.paddingBottom
        ViewProperty.MARGIN_LEFT -> margins(view).leftMargin
        ViewProperty.MARGIN_TOP -> margins(view).topMargin
        ViewProperty.MARGIN_RIGHT -> margins(view).rightMargin
        ViewProperty.MARGIN_BOTTOM -> margins(view).bottomMargin
        ViewProperty.LAYOUT_WIDTH -> view.layoutParams.width
        ViewProperty.LAYOUT_HEIGHT -> view.layoutParams.height
        ViewProperty.TRANSLATION_X -> view.translationX
        ViewProperty.TRANSLATION_Y -> view.translationY
        ViewProperty.ELEVATION -> view.elevation
        ViewProperty.BACKGROUND_COLOR -> view.background
        ViewProperty.TEXT -> (view as TextView).text?.toString()
        ViewProperty.TEXT_SIZE -> (view as TextView).textSize
        ViewProperty.TEXT_COLOR -> (view as TextView).textColors
    }

    override fun write(view: View, property: ViewProperty, value: Any) {
        when (property) {
            ViewProperty.VISIBILITY -> view.visibility = when (value as ViewVisibility) {
                ViewVisibility.VISIBLE -> View.VISIBLE
                ViewVisibility.INVISIBLE -> View.INVISIBLE
                ViewVisibility.GONE -> View.GONE
            }
            ViewProperty.BACKGROUND_COLOR -> view.background = ColorDrawable(value as Int)
            ViewProperty.TEXT -> (view as TextView).text = value as String
            ViewProperty.TEXT_SIZE -> (view as TextView).setTextSize(TypedValue.COMPLEX_UNIT_SP, value as Float)
            ViewProperty.TEXT_COLOR -> (view as TextView).setTextColor(value as Int)
            else -> restore(view, property, value)
        }
    }

    override fun restore(view: View, property: ViewProperty, saved: Any?) {
        when (property) {
            ViewProperty.VISIBILITY -> view.visibility = saved as Int
            ViewProperty.ALPHA -> view.alpha = saved as Float
            ViewProperty.ENABLED -> view.isEnabled = saved as Boolean
            ViewProperty.PADDING_LEFT, ViewProperty.PADDING_TOP, ViewProperty.PADDING_RIGHT, ViewProperty.PADDING_BOTTOM ->
                setPadding(view, property, saved as Int)
            ViewProperty.MARGIN_LEFT, ViewProperty.MARGIN_TOP, ViewProperty.MARGIN_RIGHT, ViewProperty.MARGIN_BOTTOM ->
                setMargin(view, property, saved as Int)
            ViewProperty.LAYOUT_WIDTH, ViewProperty.LAYOUT_HEIGHT -> {
                val params = view.layoutParams
                if (property == ViewProperty.LAYOUT_WIDTH) params.width = saved as Int else params.height = saved as Int
                view.layoutParams = params
            }
            ViewProperty.TRANSLATION_X -> view.translationX = saved as Float
            ViewProperty.TRANSLATION_Y -> view.translationY = saved as Float
            ViewProperty.ELEVATION -> view.elevation = saved as Float
            ViewProperty.BACKGROUND_COLOR -> view.background = saved as Drawable?
            ViewProperty.TEXT -> (view as TextView).text = saved as CharSequence?
            ViewProperty.TEXT_SIZE -> (view as TextView).setTextSize(TypedValue.COMPLEX_UNIT_PX, saved as Float)
            ViewProperty.TEXT_COLOR -> (saved as ColorStateList?)?.let((view as TextView)::setTextColor)
        }
    }

    override fun refresh(view: View) {
        view.requestLayout()
        view.invalidate()
    }

    /** What a snapshot reports of [view] for editing it, with [key] and its [edited] properties. */
    fun state(view: View, key: Int, edited: List<ViewProperty>): ViewState {
        val text = view as? TextView
        return ViewState(
            key = key,
            translationX = view.translationX.toDouble(),
            translationY = view.translationY.toDouble(),
            elevation = view.elevation.toDouble(),
            backgroundColor = (view.background as? ColorDrawable)?.color,
            textSize = text?.let { sp(it) },
            textColor = text?.currentTextColor,
            password = isPasswordView(view),
            edited = edited,
        )
    }

    private fun margins(view: View) = view.layoutParams as ViewGroup.MarginLayoutParams

    @Suppress("DEPRECATION") // scaledDensity: deriveDimension (API 34) replaces it where font scaling is non-linear.
    private fun sp(view: TextView): Double {
        val metrics = view.resources.displayMetrics
        val px = view.textSize
        val sp = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            TypedValue.deriveDimension(TypedValue.COMPLEX_UNIT_SP, px, metrics)
        } else {
            px / metrics.scaledDensity
        }
        return sp.toDouble()
    }

    private fun setPadding(view: View, property: ViewProperty, value: Int) {
        var left = view.paddingLeft
        var top = view.paddingTop
        var right = view.paddingRight
        var bottom = view.paddingBottom
        when (property) {
            ViewProperty.PADDING_LEFT -> left = value
            ViewProperty.PADDING_TOP -> top = value
            ViewProperty.PADDING_RIGHT -> right = value
            else -> bottom = value
        }
        if (view.isPaddingRelative) {
            val rtl = view.layoutDirection == View.LAYOUT_DIRECTION_RTL
            view.setPaddingRelative(if (rtl) right else left, top, if (rtl) left else right, bottom)
        } else {
            view.setPadding(left, top, right, bottom)
        }
    }

    private fun setMargin(view: View, property: ViewProperty, value: Int) {
        val params = margins(view)
        val rtl = view.layoutDirection == View.LAYOUT_DIRECTION_RTL
        when (property) {
            ViewProperty.MARGIN_LEFT -> {
                params.leftMargin = value
                if (params.isMarginRelative) {
                    if (rtl) params.marginEnd = value else params.marginStart = value
                }
            }
            ViewProperty.MARGIN_RIGHT -> {
                params.rightMargin = value
                if (params.isMarginRelative) {
                    if (rtl) params.marginStart = value else params.marginEnd = value
                }
            }
            ViewProperty.MARGIN_TOP -> params.topMargin = value
            else -> params.bottomMargin = value
        }
        view.layoutParams = params
    }
}
