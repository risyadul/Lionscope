import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    `maven-publish`
}

description = "Lionscope in-app SDK for debug builds: screen tracking, FrameMetrics, main-thread stalls, layout inflation and the Layout Inspector view tree."

android {
    namespace = "io.github.risyadul.lionscope"
    compileSdk = 36

    defaultConfig {
        minSdk = 23
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
        unitTests.all { it.lionscopeTestInputs() }
    }

    publishing {
        singleVariant("release") {
            withSourcesJar()
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_1_8)
        languageVersion.set(KotlinVersion.KOTLIN_2_0)
        apiVersion.set(KotlinVersion.KOTLIN_2_0)
    }
}

dependencies {
    implementation(libs.androidx.startup)
    compileOnly(libs.androidx.fragment)
    // Read when the app has them (detected at runtime); an app without Compose / Navigation never loads that code.
    compileOnly(libs.compose.ui.sdk)
    compileOnly(libs.navigation.runtime.sdk)
    compileOnly(libs.kotlin.stdlib)
    compileOnly(libs.okhttp)

    testImplementation(libs.junit)
    testImplementation(libs.kotlin.stdlib)
    testImplementation(libs.androidx.fragment)
    testImplementation(libs.compose.ui.sdk)
    testImplementation(libs.compose.foundation.sdk)
    // NoopParityTest loads the API, whose trackNavigation(NavController) needs it.
    testImplementation(libs.navigation.runtime.sdk)
    testImplementation(libs.okhttp)
    testImplementation(libs.okhttp.mockwebserver)
}

/** Inputs every unit-test run gets (the AGP ones and [testOkHttp5]). */
fun Test.lionscopeTestInputs() {
    // Golden NDJSON shared with the server tests.
    val fixtures = rootProject.file("../protocol/fixtures")
    inputs.dir(fixtures)
    systemProperty("lionscope.fixtures", fixtures.absolutePath)
    // Lionscope.VERSION must equal the version this build publishes.
    systemProperty("lionscope.version", project.version.toString())
    // The no-op artifact's classes, for the API parity test (loaded in their own class loader).
    dependsOn(":lionscope-noop:compileReleaseKotlin")
    val noopClasses = rootProject.file("lionscope-noop/build/tmp/kotlin-classes/release")
    inputs.dir(noopClasses)
    systemProperty("lionscope.noopClasses", noopClasses.absolutePath)
    // Both manifests, for the link key receiver's declaration (and its absence from the no-op artifact).
    val manifest = file("src/main/AndroidManifest.xml")
    val noopManifest = rootProject.file("lionscope-noop/src/main/AndroidManifest.xml")
    inputs.files(manifest, noopManifest)
    systemProperty("lionscope.manifest", manifest.absolutePath)
    systemProperty("lionscope.noopManifest", noopManifest.absolutePath)
}

// The same unit tests once more against OkHttp 5: the debug unit-test classes (compiled against OkHttp 4.12) with
// OkHttp 4, MockWebServer 4, Okio and the Kotlin stdlib swapped for OkHttp 5's. `test` runs both.
val okHttp5TestRuntime: Configuration by configurations.creating {
    isCanBeConsumed = false
    isCanBeResolved = true
    attributes {
        attribute(Usage.USAGE_ATTRIBUTE, objects.named(Usage.JAVA_RUNTIME))
        attribute(Category.CATEGORY_ATTRIBUTE, objects.named(Category.LIBRARY))
    }
}

dependencies {
    okHttp5TestRuntime(libs.okhttp5)
    okHttp5TestRuntime(libs.okhttp5.mockwebserver)
}

/** Jars the OkHttp 5 run replaces (their OkHttp 5 versions come from [okHttp5TestRuntime]). */
val okHttp4TestJars = Regex("(okhttp|okhttp-jvm|mockwebserver|mockwebserver3|okio|okio-jvm|kotlin-stdlib(-jdk7|-jdk8)?)-\\d.*\\.jar")

val testOkHttp5 = tasks.register<Test>("testOkHttp5") {
    description = "Runs the debug unit tests against OkHttp ${libs.versions.okhttp5.get()}."
    group = LifecycleBasePlugin.VERIFICATION_GROUP
    // The file collections themselves (not providers of the task), so this run needs the compiled classes only.
    val unitTests = tasks.named<Test>("testDebugUnitTest").get()
    testClassesDirs = unitTests.testClassesDirs
    classpath = unitTests.classpath.filter { !okHttp4TestJars.matches(it.name) } + okHttp5TestRuntime
    lionscopeTestInputs()
    systemProperty("lionscope.okhttpMajor", "5")
    reports.html.outputLocation.set(layout.buildDirectory.dir("reports/tests/testOkHttp5"))
}

tasks.matching { it.name == "test" }.configureEach { dependsOn(testOkHttp5) }

afterEvaluate {
    publishing {
        publications {
            create<MavenPublication>("release") {
                from(components["release"])
                artifactId = "lionscope"
            }
        }
    }
}
