package io.github.risyadul.lionscope.uihelper;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.ActivityManager;
import android.app.UiAutomation;
import android.graphics.Point;
import android.os.Build;
import android.os.Bundle;
import android.os.HandlerThread;
import android.os.Looper;
import android.view.Display;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.charset.Charset;
import java.util.concurrent.TimeoutException;
import java.util.regex.Pattern;

/**
 * A long-lived `uiautomator dump` for Lionscope (server/src/agent/uiHelper.ts). Started by the server as the shell
 * user with `CLASSPATH=<jar> app_process / io.github.risyadul.lionscope.uihelper.UiHelper`, it connects a
 * UiAutomation the way uiautomator's shell wrapper does, then answers requests on stdin, one line each:
 *
 * <pre>
 *   dump &lt;nonce&gt;   →  OK &lt;nonce&gt; &lt;the dump's XML, one line&gt;   or   ERR &lt;nonce&gt; &lt;code&gt;
 *   ping &lt;nonce&gt;   →  PONG &lt;nonce&gt;
 *   exit
 * </pre>
 *
 * Its first line is {@code READY <protocol>}, or {@code ERR - busy|connect} when it cannot connect (only one
 * UiAutomation can be connected at a time, e.g. not while Appium or a `uiautomator dump` runs); it then exits.
 * It exits on stdin EOF, on `exit`, and after {@link #IDLE_EXIT_MS} without a request. It never opens a socket.
 * Unlike uiautomator, a dump waits at most {@link #IDLE_MAX_MS} for the screen to settle and then reads it as it
 * is, so an animating screen never blocks it. Needs API 23+.
 *
 * <p>Run with two arguments instead, it connects nothing, does one thing, prints {@code OK <command> <value>} or
 * {@code ERR <command>}, and exits: {@code always-finish 0|1} switches Developer options' "Don't keep
 * activities" the way Settings does; {@code task-to-front <taskId>} brings a task back the way Recents does.
 */
public final class UiHelper {
    static final String PROTOCOL = "1";
    /** The server stops an idle helper much sooner; this covers a server that went away without closing stdin. */
    private static final long IDLE_EXIT_MS = 3 * 60_000L;
    /** waitForIdle: this long without accessibility events counts as idle; never waits longer than IDLE_MAX_MS. */
    private static final long IDLE_QUIET_MS = 100;
    private static final long IDLE_MAX_MS = 500;
    /** UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES (API 24): TalkBack & co. keep running meanwhile. */
    private static final int FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES = 1;
    private static final Pattern NONCE = Pattern.compile("[0-9a-f]{1,32}");
    private static final Pattern TASK_ID = Pattern.compile("[0-9]{1,9}");
    private static final Pattern OWN_JAR = Pattern.compile("/data/local/tmp/lionscope-ui-helper-[\\w.-]+\\.jar");

    private final UiAutomation automation;
    private final PrintStream out;
    private volatile long lastRequest = System.nanoTime();

    private UiHelper(UiAutomation automation, PrintStream out) {
        this.automation = automation;
        this.out = out;
    }

    public static void main(String[] args) throws IOException {
        PrintStream out = new PrintStream(new FileOutputStream(FileDescriptor.out), false, "UTF-8");
        removeOwnJar();
        if (args.length == 2 && (args[0].equals("always-finish") || args[0].equals("task-to-front"))) {
            System.exit(runOnce(args[0], args[1], out));
            return;
        }
        if (Looper.getMainLooper() == null) Looper.prepareMainLooper();
        UiAutomation automation;
        try {
            automation = connect();
        } catch (Throwable error) {
            error.printStackTrace();
            out.println("ERR - " + (isBusy(error) ? "busy" : "connect"));
            out.flush();
            System.exit(2);
            return;
        }
        out.println("READY " + PROTOCOL);
        out.flush();
        new UiHelper(automation, out).serve();
        disconnect(automation);
        System.exit(0);
    }

    /**
     * Like scrcpy's cleanup: the jar is deleted as soon as the process runs (the open file stays readable), so it
     * is never left behind on the device, however the server ends.
     */
    private static void removeOwnJar() {
        String classpath = System.getenv("CLASSPATH");
        if (classpath != null && OWN_JAR.matcher(classpath).matches()) {
            if (!new File(classpath).delete()) System.err.println("Could not delete " + classpath);
        }
    }

    /** A one-shot command; its exit code. */
    static int runOnce(String command, String value, PrintStream out) {
        try {
            String result;
            if (command.equals("always-finish") && (value.equals("0") || value.equals("1"))) {
                alwaysFinish(value.equals("1"));
                result = value;
            } else if (command.equals("task-to-front") && TASK_ID.matcher(value).matches()) {
                result = String.valueOf(taskToFront(Integer.parseInt(value)));
            } else {
                out.print("ERR " + command + "\n");
                out.flush();
                return 2;
            }
            out.print("OK " + command + " " + result + "\n");
            out.flush();
            return 0;
        } catch (Throwable error) {
            error.printStackTrace();
            out.print("ERR " + command + "\n");
            out.flush();
            return 1;
        }
    }

    /**
     * IActivityManager.setAlwaysFinish, as Settings calls it (the shell user holds SET_ALWAYS_FINISH): it writes the
     * global setting and switches the flag the activity manager acts on. Writing the setting alone (`settings put
     * global always_finish_activities`) takes effect only after a reboot.
     */
    private static void alwaysFinish(boolean enabled) throws ReflectiveOperationException {
        Class.forName("android.app.IActivityManager").getMethod("setAlwaysFinish", boolean.class)
            .invoke(activityManager(), enabled);
    }

    /**
     * startActivityFromRecents(taskId, null), as Recents calls it (the shell user holds START_TASKS_FROM_RECENTS):
     * the task comes to the front as it is and its top activity resumes, started again if its process died. Unlike
     * `am start` with the launcher intent, it never adds an activity to the task. Returns the start result
     * (ActivityManager.START_TASK_TO_FRONT, 2, when the task had an activity).
     */
    private static int taskToFront(int taskId) throws ReflectiveOperationException {
        Object service;
        Class<?> serviceInterface;
        if (Build.VERSION.SDK_INT >= 29) {
            service = Class.forName("android.app.ActivityTaskManager").getDeclaredMethod("getService").invoke(null);
            serviceInterface = Class.forName("android.app.IActivityTaskManager");
        } else {
            service = activityManager();
            serviceInterface = Class.forName("android.app.IActivityManager");
        }
        Method start = serviceInterface.getMethod("startActivityFromRecents", int.class, Bundle.class);
        return (Integer) start.invoke(service, taskId, null);
    }

    /** ActivityManager.getService() (API 26+), else ActivityManagerNative.getDefault(). */
    private static Object activityManager() throws ReflectiveOperationException {
        try {
            return ActivityManager.class.getDeclaredMethod("getService").invoke(null);
        } catch (NoSuchMethodException e) {
            return Class.forName("android.app.ActivityManagerNative").getDeclaredMethod("getDefault").invoke(null);
        }
    }

    private void serve() throws IOException {
        // An anonymous class, not a lambda: android.jar has no LambdaMetafactory to compile one against.
        Thread watchdog = new Thread(new Runnable() {
            @Override
            public void run() {
                while (true) {
                    try {
                        Thread.sleep(10_000);
                    } catch (InterruptedException e) {
                        return;
                    }
                    if (System.nanoTime() - lastRequest > IDLE_EXIT_MS * 1_000_000L) {
                        disconnect(automation);
                        System.exit(0);
                    }
                }
            }
        }, "lionscope-idle");
        watchdog.setDaemon(true);
        watchdog.start();
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, Charset.forName("UTF-8")));
        String line;
        while ((line = in.readLine()) != null) {
            lastRequest = System.nanoTime();
            String[] parts = line.trim().split(" ");
            String command = parts[0];
            if (command.equals("exit")) return;
            if (parts.length != 2 || !NONCE.matcher(parts[1]).matches()) continue;
            String nonce = parts[1];
            if (command.equals("ping")) reply("PONG " + nonce);
            else if (command.equals("dump")) reply(dump(nonce));
            lastRequest = System.nanoTime();
        }
    }

    private void reply(String line) {
        out.print(line);
        out.print('\n');
        out.flush();
    }

    private String dump(String nonce) {
        AccessibilityNodeInfo root = null;
        try {
            // Setting the service info clears UiAutomation's node cache: the dump is read fresh, as uiautomator's.
            AccessibilityServiceInfo info = automation.getServiceInfo();
            if (info != null) automation.setServiceInfo(info);
            try {
                automation.waitForIdle(IDLE_QUIET_MS, IDLE_MAX_MS);
            } catch (TimeoutException e) {
                // Still animating: read the screen as it is.
            }
            root = automation.getRootInActiveWindow();
            if (root == null) return "ERR " + nonce + " no-root";
            Display display = defaultDisplay();
            Point size = new Point();
            display.getSize(size);
            String xml = UiXmlWriter.write(new A11yNode(root), display.getRotation(), size.x, size.y,
                Build.VERSION.SDK_INT >= 24, Build.VERSION.SDK_INT >= 26);
            return "OK " + nonce + " " + xml;
        } catch (Throwable error) {
            error.printStackTrace();
            return "ERR " + nonce + " failed";
        } finally {
            if (root != null) new A11yNode(root).recycle();
        }
    }

    /** uiautomator's UiAutomationShellWrapper: `new UiAutomation(looper, new UiAutomationConnection())`, connect. */
    private static UiAutomation connect() throws ReflectiveOperationException {
        HandlerThread thread = new HandlerThread("lionscope-ui-automation");
        thread.start();
        Class<?> connectionClass = Class.forName("android.app.UiAutomationConnection");
        Class<?> connectionInterface = Class.forName("android.app.IUiAutomationConnection");
        Object connection = connectionClass.getConstructor().newInstance();
        UiAutomation automation;
        try {
            Constructor<UiAutomation> constructor =
                UiAutomation.class.getDeclaredConstructor(Looper.class, connectionInterface);
            constructor.setAccessible(true);
            automation = constructor.newInstance(thread.getLooper(), connection);
        } catch (NoSuchMethodException e) {
            // Should the deprecated constructor go: the one it delegates to, on the default display.
            Constructor<UiAutomation> constructor =
                UiAutomation.class.getDeclaredConstructor(int.class, Looper.class, connectionInterface);
            constructor.setAccessible(true);
            automation = constructor.newInstance(Display.DEFAULT_DISPLAY, thread.getLooper(), connection);
        }
        if (Build.VERSION.SDK_INT >= 24) {
            Method connect = UiAutomation.class.getDeclaredMethod("connect", int.class);
            connect.setAccessible(true);
            connect.invoke(automation, FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        } else {
            Method connect = UiAutomation.class.getDeclaredMethod("connect");
            connect.setAccessible(true);
            connect.invoke(automation);
        }
        // uiautomator dump without --compressed: views that are not important for accessibility are included.
        AccessibilityServiceInfo info = automation.getServiceInfo();
        info.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;
        automation.setServiceInfo(info);
        return automation;
    }

    private static void disconnect(UiAutomation automation) {
        try {
            Method disconnect = UiAutomation.class.getDeclaredMethod("disconnect");
            disconnect.setAccessible(true);
            disconnect.invoke(automation);
        } catch (Throwable error) {
            // Exiting unregisters it too (the system watches the connection's binder).
        }
    }

    /**
     * Another UiAutomation is connected: the system refuses a second one with "UiAutomationService … already
     * registered!" (an IllegalStateException). Anything else, a connect timeout included, is no "busy".
     */
    static boolean isBusy(Throwable error) {
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            String message = cause.getMessage();
            if (cause instanceof IllegalStateException && message != null && message.contains("already registered")) {
                return true;
            }
        }
        return false;
    }

    /** DisplayManagerGlobal.getInstance().getRealDisplay(DEFAULT_DISPLAY), as uiautomator's DumpCommand; read per dump. */
    private static Display defaultDisplay() throws ReflectiveOperationException {
        Class<?> global = Class.forName("android.hardware.display.DisplayManagerGlobal");
        Object instance = global.getDeclaredMethod("getInstance").invoke(null);
        return (Display) global.getDeclaredMethod("getRealDisplay", int.class).invoke(instance, Display.DEFAULT_DISPLAY);
    }
}
