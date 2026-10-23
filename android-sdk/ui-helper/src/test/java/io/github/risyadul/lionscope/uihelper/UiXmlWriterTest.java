package io.github.risyadul.lionscope.uihelper;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public class UiXmlWriterTest {

    private static final class FakeNode implements UiXmlWriter.Node {
        String text;
        String resourceId = "";
        String className = "android.widget.FrameLayout";
        String contentDesc;
        String hint;
        int drawingOrder;
        boolean clickable;
        boolean password;
        boolean visible = true;
        int[] bounds = {0, 0, 1080, 2400};
        final List<FakeNode> children = new ArrayList<>();
        int recycled;

        FakeNode add(FakeNode... nodes) {
            children.addAll(Arrays.asList(nodes));
            return this;
        }

        @Override public CharSequence text() { return text; }
        @Override public CharSequence resourceId() { return resourceId; }
        @Override public CharSequence className() { return className; }
        @Override public CharSequence packageName() { return "com.example.shop"; }
        @Override public CharSequence contentDesc() { return contentDesc; }
        @Override public CharSequence hint() { return hint; }
        @Override public int drawingOrder() { return drawingOrder; }
        @Override public boolean checkable() { return false; }
        @Override public boolean checked() { return false; }
        @Override public boolean clickable() { return clickable; }
        @Override public boolean enabled() { return true; }
        @Override public boolean focusable() { return false; }
        @Override public boolean focused() { return false; }
        @Override public boolean scrollable() { return false; }
        @Override public boolean longClickable() { return false; }
        @Override public boolean password() { return password; }
        @Override public boolean selected() { return false; }
        @Override public boolean visibleToUser() { return visible; }
        @Override public int[] bounds() { return bounds.clone(); }
        @Override public int childCount() { return children.size(); }
        @Override public UiXmlWriter.Node child(int index) { return children.get(index); }
        @Override public void recycle() { recycled++; }
    }

    private static FakeNode node(String className, int... bounds) {
        FakeNode node = new FakeNode();
        node.className = className;
        node.bounds = bounds;
        return node;
    }

    @Test
    public void writesUiautomatorsFormat() {
        FakeNode root = new FakeNode();
        FakeNode label = node("android.widget.TextView", 0, 100, 500, 200);
        label.text = "Cart & checkout";
        label.drawingOrder = 2;
        label.hint = "Hint";
        root.add(label);
        String xml = UiXmlWriter.write(root, 1, 1080, 2400, true, true);
        assertEquals(
            "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"1\">"
                + "<node index=\"0\" text=\"\" resource-id=\"\" class=\"android.widget.FrameLayout\" package=\"com.example.shop\""
                + " content-desc=\"\" checkable=\"false\" checked=\"false\" clickable=\"false\" enabled=\"true\""
                + " focusable=\"false\" focused=\"false\" scrollable=\"false\" long-clickable=\"false\" password=\"false\""
                + " selected=\"false\" bounds=\"[0,0][1080,2400]\" drawing-order=\"0\" hint=\"\">"
                + "<node index=\"0\" text=\"Cart &amp; checkout\" resource-id=\"\" class=\"android.widget.TextView\""
                + " package=\"com.example.shop\" content-desc=\"\" checkable=\"false\" checked=\"false\" clickable=\"false\""
                + " enabled=\"true\" focusable=\"false\" focused=\"false\" scrollable=\"false\" long-clickable=\"false\""
                + " password=\"false\" selected=\"false\" bounds=\"[0,100][500,200]\" drawing-order=\"2\" hint=\"Hint\" />"
                + "</node></hierarchy>",
            xml);
        assertEquals(1, label.recycled);
    }

    @Test
    public void leavesOutAttributesTheDevicesDumperDoesNotWrite() {
        String xml = UiXmlWriter.write(new FakeNode(), 0, 1080, 2400, false, false);
        assertFalse(xml.contains("drawing-order"));
        assertFalse(xml.contains("hint"));
        assertTrue(xml.contains("bounds=\"[0,0][1080,2400]\" />"));
    }

    @Test
    public void neverWritesPasswordText() {
        FakeNode field = node("android.widget.EditText", 0, 0, 100, 100);
        field.text = "hunter2";
        field.password = true;
        String xml = UiXmlWriter.write(new FakeNode().add(field), 0, 1080, 2400, true, true);
        assertFalse(xml.contains("hunter2"));
        assertTrue(xml.contains("text=\"\" resource-id=\"\" class=\"android.widget.EditText\""));
        assertTrue(xml.contains("password=\"true\""));
    }

    @Test
    public void escapesValuesOnOneLine() {
        FakeNode label = node("android.widget.TextView", 0, 0, 10, 10);
        label.text = "a<b>\"c\"\n\r\t\u0001\u0000￿ 😀 \uD83D x";
        String xml = UiXmlWriter.write(new FakeNode().add(label), 0, 1080, 2400, true, true);
        assertTrue(xml.contains("text='a&lt;b&gt;\"c\"&#10;&#13;&#9;... &#128512; . x'"));
        label.text = "it's \"q\" & 'a'";
        xml = UiXmlWriter.write(new FakeNode().add(label), 0, 1080, 2400, true, true);
        assertTrue(xml.contains("text='it&apos;s \"q\" &amp; &apos;a&apos;'"));
        label.text = "it's";
        xml = UiXmlWriter.write(new FakeNode().add(label), 0, 1080, 2400, true, true);
        assertTrue(xml.contains("text=\"it's\""));
        assertFalse(xml.contains("\n"));
    }

    @Test
    public void clipsBoundsToTheDisplayLikeRectIntersect() {
        FakeNode partly = node("android.view.View", -10, 2300, 500, 2500);
        FakeNode outside = node("android.view.View", 1100, 0, 1200, 10);
        String xml = UiXmlWriter.write(new FakeNode().add(partly, outside), 0, 1080, 2400, true, true);
        assertTrue(xml.contains("bounds=\"[0,2300][500,2400]\""));
        assertTrue(xml.contains("bounds=\"[1100,0][1200,10]\""));
    }

    @Test
    public void skipsInvisibleChildrenButKeepsTheirIndex() {
        FakeNode hidden = node("android.view.View", 0, 0, 10, 10);
        hidden.visible = false;
        FakeNode shown = node("android.widget.Button", 0, 0, 10, 10);
        shown.text = "OK";
        String xml = UiXmlWriter.write(new FakeNode().add(hidden, shown), 0, 1080, 2400, true, true);
        assertFalse(xml.contains("class=\"android.view.View\""));
        assertTrue(xml.contains("<node index=\"1\" text=\"OK\""));
        assertEquals(1, hidden.recycled);
    }

    @Test
    public void marksClickableNodesWithoutALabelAsNaf() {
        FakeNode bare = node("android.widget.ImageView", 0, 0, 10, 10);
        bare.clickable = true;
        FakeNode labelled = node("android.widget.LinearLayout", 0, 0, 10, 10);
        labelled.clickable = true;
        FakeNode text = node("android.widget.TextView", 0, 0, 10, 10);
        text.text = "Row";
        labelled.add(text);
        FakeNode list = node("android.widget.ListView", 0, 0, 10, 10);
        list.clickable = true;
        String xml = UiXmlWriter.write(new FakeNode().add(bare, labelled, list), 0, 1080, 2400, true, true);
        assertTrue(xml.contains("<node NAF=\"true\" index=\"0\""));
        assertTrue(xml.contains("<node index=\"1\""));
        assertTrue(xml.contains("<node index=\"2\""));
    }
}
