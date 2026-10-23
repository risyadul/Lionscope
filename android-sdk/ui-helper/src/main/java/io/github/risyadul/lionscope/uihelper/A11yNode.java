package io.github.risyadul.lionscope.uihelper;

import android.graphics.Rect;
import android.os.Build;
import android.view.accessibility.AccessibilityNodeInfo;

/** An AccessibilityNodeInfo as the XML writer reads it. */
final class A11yNode implements UiXmlWriter.Node {
    private final AccessibilityNodeInfo node;

    A11yNode(AccessibilityNodeInfo node) {
        this.node = node;
    }

    @Override public CharSequence text() { return node.getText(); }

    @Override public CharSequence resourceId() { return node.getViewIdResourceName(); }

    @Override public CharSequence className() { return node.getClassName(); }

    @Override public CharSequence packageName() { return node.getPackageName(); }

    @Override public CharSequence contentDesc() { return node.getContentDescription(); }

    @Override
    public CharSequence hint() {
        return Build.VERSION.SDK_INT >= 26 ? node.getHintText() : null;
    }

    @Override
    public int drawingOrder() {
        return Build.VERSION.SDK_INT >= 24 ? node.getDrawingOrder() : 0;
    }

    @Override public boolean checkable() { return node.isCheckable(); }

    @Override public boolean checked() { return node.isChecked(); }

    @Override public boolean clickable() { return node.isClickable(); }

    @Override public boolean enabled() { return node.isEnabled(); }

    @Override public boolean focusable() { return node.isFocusable(); }

    @Override public boolean focused() { return node.isFocused(); }

    @Override public boolean scrollable() { return node.isScrollable(); }

    @Override public boolean longClickable() { return node.isLongClickable(); }

    @Override public boolean password() { return node.isPassword(); }

    @Override public boolean selected() { return node.isSelected(); }

    @Override public boolean visibleToUser() { return node.isVisibleToUser(); }

    @Override
    public int[] bounds() {
        Rect rect = new Rect();
        node.getBoundsInScreen(rect);
        return new int[] {rect.left, rect.top, rect.right, rect.bottom};
    }

    @Override public int childCount() { return node.getChildCount(); }

    @Override
    public UiXmlWriter.Node child(int index) {
        AccessibilityNodeInfo child = node.getChild(index);
        return child == null ? null : new A11yNode(child);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void recycle() {
        // A no-op from API 33.
        node.recycle();
    }
}
