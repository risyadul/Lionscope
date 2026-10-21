import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    `maven-publish`
}

description = "Lionscope in-app SDK: screen tracking and FrameMetrics for debug builds."

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
        unitTests.all {
            // Golden NDJSON shared with the server tests.
            val fixtures = rootProject.file("../protocol/fixtures")
            it.inputs.dir(fixtures)
            it.systemProperty("lionscope.fixtures", fixtures.absolutePath)
            // Lionscope.VERSION must equal the version this build publishes.
            it.systemProperty("lionscope.version", project.version.toString())
        }
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
    compileOnly(libs.kotlin.stdlib)

    testImplementation(libs.junit)
    testImplementation(libs.kotlin.stdlib)
    testImplementation(libs.androidx.fragment)
}

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
