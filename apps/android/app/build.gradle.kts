plugins { alias(libs.plugins.android.application) }
System.getenv("SILVERHAND_ANDROID_RUN_ROOT")?.let {
    layout.buildDirectory.set(file(it).resolve("app-build"))
}
android {
    namespace = "com.silverhand.android"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.silverhand.android.stage1"
        minSdk = 28
        targetSdk = 36
        versionCode = 4
        versionName = "0.4"
        ndk { abiFilters += "arm64-v8a" }
        testInstrumentationRunner = "com.silverhand.android.B1Instrumentation"
    }
    buildFeatures { buildConfig = true }
    // Device controls live only in the separate androidTest APK; test the same
    // internally signed acceptance variant, without adding product endpoints.
    testBuildType = "acceptance"
    buildTypes {
        getByName("debug") { buildConfigField("boolean", "ACCEPTANCE", "false") }
        getByName("release") {
            buildConfigField("boolean", "ACCEPTANCE", "false")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro", project(":SilverhandCore").file("proguard-rules.pro"))
        }
    }
    buildTypes.create("acceptance") {
        initWith(buildTypes.getByName("release"))
        matchingFallbacks += "release"
        isDebuggable = true
        signingConfig = signingConfigs.getByName("debug")
        buildConfigField("boolean", "ACCEPTANCE", "true")
    }
    sourceSets {
        // Android SourceSet APIs accept paths/files, not Provider<Directory>; resolve the
        // build directory at configuration time so run-dir redirection still applies.
        getByName("main").assets.srcDirs(
            layout.buildDirectory.dir("core-assets").get().asFile,
        )
        for (variant in listOf("debug", "release")) {
            getByName(variant).java.srcDir("src/normal/java")
            getByName(variant).assets.srcDir(layout.buildDirectory.dir("web-assets/normal").get().asFile)
        }
        getByName("acceptance").assets.srcDirs(
            layout.buildDirectory.dir("web-assets/acceptance").get().asFile,
            layout.buildDirectory.dir("acceptance-assets").get().asFile,
        )
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_21; targetCompatibility = JavaVersion.VERSION_21 }
}
// Validate only at asset merge, after web preparation. Core-only builds configure
// this project before web outputs exist and must not consume or require them.
tasks.configureEach {
    val variant = when (name) {
        "mergeDebugAssets", "mergeReleaseAssets" -> "normal"
        "mergeAcceptanceAssets" -> "acceptance"
        else -> null
    }
    if (variant != null) doFirst {
        val root = layout.buildDirectory.dir("web-assets/$variant/public").get().asFile
        check(root.resolve("index.html").isFile) { "Missing $variant web entry" }
        val metadata = groovy.json.JsonSlurper().parse(root.resolve("android-web-build.json")) as Map<*, *>
        check(metadata["variant"] == variant && metadata["kind"] == "silverhand-android-web-v1") { "Mismatched $variant web assets" }
        val modules = metadata["modules"] as List<*>
        check(modules.contains("apps/android/src/notification-test.ts") == (variant == "acceptance")) { "Mismatched notification test module" }
    }
}
dependencies {
    implementation(project(":SilverhandCore"))
    implementation(project(":capacitor-android"))
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:rules:1.7.0")
}
