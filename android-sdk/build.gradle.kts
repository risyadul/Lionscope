plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.android) apply false
}

// JitPack's multi-module scheme (com.github.<user>.<repo>), so local and JitPack artifacts are identical.
val lionscopeGroup = "com.github.risyadul.Lionscope"

// On JitPack (JITPACK=true) the version is the git tag JitPack passes in VERSION.
val lionscopeVersion: String =
    if (providers.environmentVariable("JITPACK").orNull == "true") {
        providers.environmentVariable("VERSION").get()
    } else {
        providers.gradleProperty("lionscopeVersion").getOrElse("0.1.0")
    }

allprojects {
    group = lionscopeGroup
    version = lionscopeVersion
}

subprojects {
    plugins.withId("maven-publish") {
        extensions.configure<PublishingExtension> {
            publications.withType<MavenPublication>().configureEach {
                pom {
                    name.set(project.name)
                    description.set(provider { project.description })
                    url.set("https://github.com/risyadul/Lionscope")
                    licenses {
                        license {
                            name.set("The Apache License, Version 2.0")
                            url.set("https://www.apache.org/licenses/LICENSE-2.0.txt")
                            distribution.set("repo")
                        }
                    }
                    developers {
                        developer {
                            id.set("risyadul")
                            name.set("risyadul")
                            url.set("https://github.com/risyadul")
                        }
                    }
                    scm {
                        url.set("https://github.com/risyadul/Lionscope")
                        connection.set("scm:git:https://github.com/risyadul/Lionscope.git")
                        developerConnection.set("scm:git:ssh://git@github.com/risyadul/Lionscope.git")
                    }
                }
            }
        }
    }
}
