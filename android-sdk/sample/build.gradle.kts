import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

// Compose compatibility checks: `-PsampleComposeBom=2024.06.00 -PsampleNavigationCompose=2.7.7` (defaults: the catalog).
val composeBom = providers.gradleProperty("sampleComposeBom").getOrElse(libs.versions.composeBom.get())
val navigationCompose = providers.gradleProperty("sampleNavigationCompose").getOrElse(libs.versions.navigationCompose.get())

android {
    namespace = "io.github.risyadul.lionscope.sample"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.risyadul.lionscope.sample"
        minSdk = 23
        targetSdk = 36
        versionCode = 1
        versionName = project.version.toString()
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isDebuggable = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            // Demo only: lets `assembleRelease` produce an installable APK without a release keystore.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    buildFeatures {
        compose = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_1_8)
        // AGP 8.9's D8/R8 cannot parse Kotlin 2.2 metadata (warnings only); 2.0 matches the SDK modules.
        languageVersion.set(KotlinVersion.KOTLIN_2_0)
        apiVersion.set(KotlinVersion.KOTLIN_2_0)
    }
}

dependencies {
    implementation(libs.kotlin.stdlib.app)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.fragment.ktx)
    implementation(libs.androidx.recyclerview)
    implementation(libs.androidx.viewpager)
    implementation(libs.androidx.asynclayoutinflater)
    implementation(libs.material)
    implementation(platform("androidx.compose:compose-bom:$composeBom"))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.activity.compose)
    implementation("androidx.navigation:navigation-compose:$navigationCompose")
    // The network demo (NetworkActivity) only: the SDK itself does not bring OkHttp.
    implementation(libs.okhttp)
    // The Rx and coroutine stall demos (Home) only: the SDK itself brings neither.
    implementation(libs.rxjava2)
    implementation(libs.rxandroid2)
    implementation(libs.coroutines.android)

    debugImplementation(project(":lionscope"))
    releaseImplementation(project(":lionscope-noop"))
}
