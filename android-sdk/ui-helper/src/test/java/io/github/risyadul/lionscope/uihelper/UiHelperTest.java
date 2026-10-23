package io.github.risyadul.lionscope.uihelper;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

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
}
