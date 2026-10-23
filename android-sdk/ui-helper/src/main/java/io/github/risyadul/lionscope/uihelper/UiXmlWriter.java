package io.github.risyadul.lionscope.uihelper;

/**
 * Writes a window's node tree in exactly the format of `uiautomator dump` (the platform's
 * AccessibilityNodeInfoDumper with Android's KXmlSerializer), on one line: attribute values escape line breaks, so
 * a dump never contains a newline. Plain Java, so the JVM tests can run it.
 */
final class UiXmlWriter {

    /** One accessibility node, as the dumper reads it. */
    interface Node {
        CharSequence text();

        CharSequence resourceId();

        CharSequence className();

        CharSequence packageName();

        CharSequence contentDesc();

        CharSequence hint();

        int drawingOrder();

        boolean checkable();

        boolean checked();

        boolean clickable();

        boolean enabled();

        boolean focusable();

        boolean focused();

        boolean scrollable();

        boolean longClickable();

        boolean password();

        boolean selected();

        boolean visibleToUser();

        /** Bounds in screen pixels: left, top, right, bottom. */
        int[] bounds();

        int childCount();

        /** Null when the child is gone. */
        Node child(int index);

        /** Done with this node (AccessibilityNodeInfo.recycle). */
        void recycle();
    }

    /** uiautomator's NAF check skips these containers (they are clickable without a label by design). */
    private static final String[] NAF_EXCLUDED_CLASSES = {
        "android.widget.GridView", "android.widget.GridLayout", "android.widget.ListView", "android.widget.TableLayout",
    };

    private final int width;
    private final int height;
    /** drawing-order (API 24+) and hint (API 26+) are written where the platform's dumper writes them. */
    private final boolean withDrawingOrder;
    private final boolean withHint;
    private final StringBuilder out = new StringBuilder(64 * 1024);

    private UiXmlWriter(int width, int height, boolean withDrawingOrder, boolean withHint) {
        this.width = width;
        this.height = height;
        this.withDrawingOrder = withDrawingOrder;
        this.withHint = withHint;
    }

    /** The dump of `root` for a display of `width` × `height` (current orientation) at `rotation` (0-3). */
    static String write(Node root, int rotation, int width, int height, boolean withDrawingOrder, boolean withHint) {
        UiXmlWriter writer = new UiXmlWriter(width, height, withDrawingOrder, withHint);
        StringBuilder out = writer.out;
        out.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>");
        out.append("<hierarchy rotation=\"").append(rotation).append("\">");
        writer.node(root, 0);
        out.append("</hierarchy>");
        return out.toString();
    }

    private void node(Node node, int index) {
        out.append("<node");
        if (!nafExcluded(node) && !nafCheck(node)) attribute("NAF", "true");
        attribute("index", Integer.toString(index));
        // A password field's text never leaves the device, whatever the platform reports for it.
        attribute("text", node.password() ? "" : safe(node.text()));
        attribute("resource-id", safe(node.resourceId()));
        attribute("class", safe(node.className()));
        attribute("package", safe(node.packageName()));
        attribute("content-desc", safe(node.contentDesc()));
        attribute("checkable", Boolean.toString(node.checkable()));
        attribute("checked", Boolean.toString(node.checked()));
        attribute("clickable", Boolean.toString(node.clickable()));
        attribute("enabled", Boolean.toString(node.enabled()));
        attribute("focusable", Boolean.toString(node.focusable()));
        attribute("focused", Boolean.toString(node.focused()));
        attribute("scrollable", Boolean.toString(node.scrollable()));
        attribute("long-clickable", Boolean.toString(node.longClickable()));
        attribute("password", Boolean.toString(node.password()));
        attribute("selected", Boolean.toString(node.selected()));
        attribute("bounds", visibleBounds(node.bounds()));
        if (withDrawingOrder) attribute("drawing-order", Integer.toString(node.drawingOrder()));
        if (withHint) attribute("hint", safe(node.hint()));
        int count = node.childCount();
        boolean empty = true;
        for (int i = 0; i < count; i++) {
            Node child = node.child(i);
            if (child == null) continue;
            if (child.visibleToUser()) {
                if (empty) out.append('>');
                empty = false;
                node(child, i);
            }
            child.recycle();
        }
        out.append(empty ? " />" : "</node>");
    }

    /** Rect.intersect with the display, which leaves the bounds as they are when they do not overlap it. */
    private String visibleBounds(int[] b) {
        int left = b[0];
        int top = b[1];
        int right = b[2];
        int bottom = b[3];
        if (left < width && 0 < right && top < height && 0 < bottom) {
            left = Math.max(left, 0);
            top = Math.max(top, 0);
            right = Math.min(right, width);
            bottom = Math.min(bottom, height);
        }
        return "[" + left + "," + top + "][" + right + "," + bottom + "]";
    }

    private static boolean nafExcluded(Node node) {
        String className = safe(node.className());
        for (String excluded : NAF_EXCLUDED_CLASSES) {
            if (className.endsWith(excluded)) return true;
        }
        return false;
    }

    /** False for a clickable, enabled node with no text or description in it or below it ("not accessibility friendly"). */
    private static boolean nafCheck(Node node) {
        boolean naf = node.clickable() && node.enabled() && safe(node.contentDesc()).isEmpty() && safe(node.text()).isEmpty();
        return !naf || childNafCheck(node);
    }

    private static boolean childNafCheck(Node node) {
        int count = node.childCount();
        for (int i = 0; i < count; i++) {
            Node child = node.child(i);
            if (child == null) continue;
            try {
                if (!safe(child.contentDesc()).isEmpty() || !safe(child.text()).isEmpty()) return true;
                if (childNafCheck(child)) return true;
            } finally {
                child.recycle();
            }
        }
        return false;
    }

    /** uiautomator's safeCharSeqToString: null is empty, characters XML cannot hold become '.'. */
    static String safe(CharSequence value) {
        if (value == null) return "";
        StringBuilder result = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            boolean invalid = (c <= 0x8) || (c >= 0xB && c <= 0xC) || (c >= 0xE && c <= 0x1F)
                || (c >= 0x7F && c <= 0x84) || (c >= 0x86 && c <= 0x9F)
                || (c >= 0xFDD0 && c <= 0xFDDF) || c >= 0xFFFE;
            result.append(invalid ? '.' : c);
        }
        return result.toString();
    }

    /**
     * KXmlSerializer's attribute for UTF-8: in single quotes when the value has a double quote, supplementary
     * characters as character references.
     */
    private void attribute(String name, String value) {
        char quote = value.indexOf('"') == -1 ? '"' : '\'';
        out.append(' ').append(name).append('=').append(quote);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '&': out.append("&amp;"); break;
                case '<': out.append("&lt;"); break;
                case '>': out.append("&gt;"); break;
                case '"': out.append(quote == '"' ? "&quot;" : "\""); break;
                case '\'': out.append(quote == '\'' ? "&apos;" : "'"); break;
                case '\n': out.append("&#10;"); break;
                case '\r': out.append("&#13;"); break;
                case '\t': out.append("&#9;"); break;
                default:
                    if (Character.isHighSurrogate(c) && i + 1 < value.length() && Character.isLowSurrogate(value.charAt(i + 1))) {
                        out.append("&#").append(Character.toCodePoint(c, value.charAt(i + 1))).append(';');
                        i++;
                    } else if (Character.isSurrogate(c)) {
                        // KXmlSerializer throws on a lone surrogate (uiautomator's dump fails); this one survives.
                        out.append('.');
                    } else {
                        out.append(c);
                    }
            }
        }
        out.append(quote);
    }
}
