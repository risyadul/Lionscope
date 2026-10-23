package io.github.risyadul.lionscope

import android.content.res.ColorStateList
import android.graphics.PorterDuff
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.os.Build
import android.text.Editable
import android.text.Spanned
import android.text.TextUtils
import android.text.style.CharacterStyle
import android.text.style.ParagraphStyle
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import java.lang.reflect.Method

/**
 * [ViewEditAccess] over real views: only the platform setters, and AppCompat's support background tint (they may
 * call the app's own listeners, e.g. a TextWatcher or a custom view's `setPadding` override; no app method is called
 * otherwise). Padding is set relative when the view's is (`isPaddingRelative`), a margin also as its start / end
 * margin when the params are relative, so the side edited is the side that moves in either layout direction.
 *
 * A background color is a new ColorDrawable with the view's background tints cleared (else they would tint it); the
 * revert puts back the original Drawable, its tints and the padding the view had, as setting a Drawable resets the
 * padding to the Drawable's own. Text size is set in sp and restored in px; an autosizing TextView's is not set
 * (autosizing decides it). Styled text is restored with its spans when they are the framework's, else as plain text;
 * a field's editable text (selection, IME and spell-check spans that change as it is used) is compared and kept as
 * plain text.
 */
internal object AndroidViewEdits : ViewEditAccess<View> {
    private val supportTints = HashMap<Class<*>, Pair<Method, Method>?>()

    override fun isAttached(view: View): Boolean = view.isAttachedToWindow

    override fun supports(view: View, property: ViewProperty): Boolean = when (property) {
        ViewProperty.MARGIN_LEFT, ViewProperty.MARGIN_TOP, ViewProperty.MARGIN_RIGHT, ViewProperty.MARGIN_BOTTOM ->
            view.layoutParams is ViewGroup.MarginLayoutParams
        // A window root's size belongs to its window (WindowManager), not to its layout params.
        ViewProperty.LAYOUT_WIDTH, ViewProperty.LAYOUT_HEIGHT -> view.layoutParams != null && view.parent is View
        ViewProperty.TEXT, ViewProperty.TEXT_COLOR -> view is TextView
        ViewProperty.TEXT_SIZE -> view is TextView && !isAutosizing(view)
        else -> true
    }

    override fun isPassword(view: View): Boolean = isPasswordView(view)

    override fun save(view: View, property: ViewProperty): Any? = when (property) {
        ViewProperty.BACKGROUND_COLOR -> BackgroundSave(
            drawable = view.background,
            tint = view.backgroundTintList,
            tintMode = view.backgroundTintMode,
            supportTint = supportTint(view)?.let { (get, _) -> invokeQuietly(get, view) },
            padding = padding(view),
        )
        ViewProperty.TEXT_COLOR -> (view as TextView).textColors
        ViewProperty.TEXT -> savedText((view as TextView).text)
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
        ViewProperty.BACKGROUND_COLOR -> view.background.let { BackgroundState(it, (it as? ColorDrawable)?.color) }
        ViewProperty.TEXT -> (view as TextView).text.let { TextState(it?.toString() ?: "", styles(it)) }
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
            ViewProperty.BACKGROUND_COLOR -> {
                view.backgroundTintList = null
                supportTint(view)?.let { (_, set) -> invokeQuietly(set, view, null) }
                view.background = ColorDrawable(value as Int)
            }
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
                setPadding(view, EditSides.withSide(padding(view), property, saved as Int))
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
            ViewProperty.BACKGROUND_COLOR -> restoreBackground(view, saved as BackgroundSave)
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

    /** What a background edit restores: the Drawable and tints as they were, and the padding the view had then. */
    private class BackgroundSave(
        val drawable: Drawable?,
        val tint: ColorStateList?,
        val tintMode: PorterDuff.Mode?,
        val supportTint: Any?,
        val padding: PaddingState,
    )

    private fun restoreBackground(view: View, saved: BackgroundSave) {
        view.background = saved.drawable
        view.backgroundTintList = saved.tint
        view.backgroundTintMode = saved.tintMode
        supportTint(view)?.let { (_, set) -> invokeQuietly(set, view, saved.supportTint) }
        // A Drawable with padding (a 9-patch, an inset) has just replaced the view's own.
        setPadding(view, saved.padding)
    }

    private fun padding(view: View) =
        PaddingState(view.paddingLeft, view.paddingTop, view.paddingRight, view.paddingBottom, view.isPaddingRelative)

    private fun setPadding(view: View, padding: PaddingState) {
        if (padding.relative) {
            val (start, top, end, bottom) = EditSides.relative(padding, view.layoutDirection == View.LAYOUT_DIRECTION_RTL)
            view.setPaddingRelative(start, top, end, bottom)
        } else {
            view.setPadding(padding.left, padding.top, padding.right, padding.bottom)
        }
    }

    private fun setMargin(view: View, property: ViewProperty, value: Int) {
        val params = margins(view)
        when (property) {
            ViewProperty.MARGIN_LEFT -> params.leftMargin = value
            ViewProperty.MARGIN_RIGHT -> params.rightMargin = value
            ViewProperty.MARGIN_TOP -> params.topMargin = value
            else -> params.bottomMargin = value
        }
        // Relative params resolve left / right from start / end at the next layout: set that one too.
        if (params.isMarginRelative) {
            when (EditSides.relativeMargin(property, view.layoutDirection == View.LAYOUT_DIRECTION_RTL)) {
                RelativeSide.START -> params.marginStart = value
                RelativeSide.END -> params.marginEnd = value
                null -> Unit
            }
        }
        view.layoutParams = params
    }

    private fun margins(view: View) = view.layoutParams as ViewGroup.MarginLayoutParams

    /** The text to restore: styled as it was when its spans are the framework's, else plain (see [EditSides.keepsSpans]). */
    private fun savedText(text: CharSequence?): CharSequence? {
        if (text !is Spanned || text is Editable) return text?.toString()
        val spans = text.getSpans(0, text.length, Any::class.java).map { it.javaClass.name }
        return if (EditSides.keepsSpans(spans)) TextUtils.stringOrSpannedString(text) else text.toString()
    }

    /** Styling spans of a TextView's fixed text; 0 for plain or editable text. */
    private fun styles(text: CharSequence?): Int {
        if (text !is Spanned || text is Editable) return 0
        return text.getSpans(0, text.length, CharacterStyle::class.java).size +
            text.getSpans(0, text.length, ParagraphStyle::class.java).size
    }

    private fun isAutosizing(view: TextView): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && view.autoSizeTextType != TextView.AUTO_SIZE_TEXT_TYPE_NONE

    /**
     * AppCompat's `getSupportBackgroundTintList` / `setSupportBackgroundTintList` (TintableBackgroundView) when the
     * view has them: it tints a background set later too. Looked up once per class; null without them.
     */
    private fun supportTint(view: View): Pair<Method, Method>? {
        val type = view.javaClass
        if (supportTints.containsKey(type)) return supportTints[type]
        val methods = try {
            type.getMethod("getSupportBackgroundTintList") to
                type.getMethod("setSupportBackgroundTintList", ColorStateList::class.java)
        } catch (e: NoSuchMethodException) {
            null
        } catch (e: SecurityException) {
            null
        }
        supportTints[type] = methods
        return methods
    }

    private fun invokeQuietly(method: Method, view: View, vararg args: Any?): Any? = try {
        method.invoke(view, *args)
    } catch (e: ReflectiveOperationException) {
        null
    } catch (e: RuntimeException) {
        null
    }

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
}
