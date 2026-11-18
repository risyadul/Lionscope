export const PREVIEW_TEST = 'io.github.risyadul.lionscope.preview.XmlLayoutPreview';

export const GRADLE_INIT = String.raw`
gradle.beforeProject { project ->
    if (project.path != System.getenv('LIONSCOPE_PREVIEW_MODULE')) return

    project.buildscript.repositories.google()
    project.buildscript.repositories.mavenCentral()
    project.buildscript.dependencies.add('classpath', 'app.cash.paparazzi:paparazzi-gradle-plugin:2.0.0-alpha05.1') {
        // Let the project's AGP supply sdk-common on the buildscript classpath.
        exclude group: 'com.android.tools', module: 'sdk-common'
    }
    // Paparazzi checks for the Kotlin extension even in Java-only modules.
    project.buildscript.dependencies.add('classpath', 'org.jetbrains.kotlin:kotlin-gradle-plugin') {
        version { prefer '2.2.0' }
    }

    def configurePreview = {
        project.pluginManager.apply('app.cash.paparazzi')
        project.android.sourceSets.getByName('test').java.srcDir(System.getenv('LIONSCOPE_PREVIEW_SOURCE'))
        project.dependencies.add('testImplementation', 'junit:junit:4.13.2')
        project.tasks.withType(Test).configureEach { test ->
            if (test.name != System.getenv('LIONSCOPE_PREVIEW_TASK')) return
            test.useJUnit()
            for (def name : ['LAYOUT', 'REPORT', 'THEME']) {
                test.systemProperty('lionscope.preview.' + name, System.getenv('LIONSCOPE_PREVIEW_' + name))
            }
            test.outputs.dir(System.getenv('LIONSCOPE_PREVIEW_REPORT'))
            test.testLogging.exceptionFormat = 'full'
        }
    }

    project.pluginManager.withPlugin('com.android.application') { configurePreview() }
    project.pluginManager.withPlugin('com.android.library') { configurePreview() }
}
`;

export const JAVA_PREVIEW = String.raw`
package io.github.risyadul.lionscope.preview;

import android.util.TypedValue;
import app.cash.paparazzi.DeviceConfig;
import app.cash.paparazzi.Environment;
import app.cash.paparazzi.EnvironmentKt;
import app.cash.paparazzi.HtmlReportWriter;
import app.cash.paparazzi.Paparazzi;
import com.android.ide.common.rendering.api.SessionParams.RenderingMode;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.Rule;
import org.junit.Test;

public final class XmlLayoutPreview {
    private final Environment environment = EnvironmentKt.detectEnvironment();

    @Rule public final Paparazzi paparazzi = new Paparazzi(
        environment, DeviceConfig.PIXEL_5, setting("THEME"), RenderingMode.NORMAL, true, 0.0,
        new HtmlReportWriter("Lionscope", new File(setting("REPORT")), 0.0)
    );

    @Test public void render() throws Exception {
        Path input = new File(setting("LAYOUT")).toPath();
        String file = input.getFileName().toString();
        String resource = file.substring(0, file.length() - ".xml".length());
        int id = paparazzi.getResources().getIdentifier(resource, "layout", environment.getPackageName());
        if (id == 0) {
            throw new IllegalArgumentException("Layout is not in the selected module and variant: " + input);
        }

        TypedValue value = new TypedValue();
        paparazzi.getResources().getValue(id, value, true);
        if (value.string == null || !Files.isSameFile(input, new File(value.string.toString()).toPath())) {
            throw new IllegalArgumentException("Selected preview configuration resolves this layout to " + value.string);
        }
        paparazzi.snapshot(paparazzi.inflate(id), null, 0L);
    }

    private static String setting(String name) {
        return System.getProperty("lionscope.preview." + name);
    }
}
`;
