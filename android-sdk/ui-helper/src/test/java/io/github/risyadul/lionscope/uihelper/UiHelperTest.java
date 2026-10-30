package io.github.risyadul.lionscope.uihelper;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.lang.reflect.InvocationTargetException;
import java.util.concurrent.TimeoutException;
import org.junit.Test;

public class UiHelperTest {

    @Test
    public void isBusyOnlyWhenAnotherUiAutomationIsRegistered() {
        IllegalStateException registered = new IllegalStateException(
            "UiAutomationService android.accessibilityservice.IAccessibilityServiceClient$Stub$Proxy@c1519e1already registered!");
        assertTrue(UiHelper.isBusy(new InvocationTargetException(registered)));
        assertFalse(UiHelper.isBusy(new RuntimeException("Error while connecting UiAutomation", new TimeoutException())));
        assertFalse(UiHelper.isBusy(new InvocationTargetException(new IllegalStateException("Cannot call disconnect() while connecting"))));
        assertFalse(UiHelper.isBusy(new IllegalStateException()));
    }

    @Test
    public void oneShotCommandsRefuseMalformedValues() throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        PrintStream out = new PrintStream(bytes, true, "UTF-8");
        assertEquals(2, UiHelper.runOnce("always-finish", "true", out));
        assertEquals(2, UiHelper.runOnce("task-to-front", "12; reboot", out));
        assertEquals(2, UiHelper.runOnce("task-to-front", "-1", out));
        assertEquals("ERR always-finish\nERR task-to-front\nERR task-to-front\n", bytes.toString("UTF-8"));
    }
}
