// One AGP version for the Skip-generated modules and Capacitor's library.
allprojects {
    if (path == ":capacitor-android") {
        System.getenv("SILVERHAND_ANDROID_RUN_ROOT")?.let {
            layout.buildDirectory.set(file(it).resolve("capacitor-build"))
        }
    }
    buildscript.configurations.configureEach {
        resolutionStrategy.eachDependency {
            if (requested.group == "com.android.tools.build" && requested.name == "gradle") useVersion("9.2.0")
        }
    }
}
