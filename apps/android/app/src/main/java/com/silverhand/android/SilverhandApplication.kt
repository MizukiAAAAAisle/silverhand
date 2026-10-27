package com.silverhand.android

import android.app.Application
import android.system.Os
import java.io.File

class SilverhandApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // Volatile SwiftPM resource layout is isolated here, before loading Swift.
        for (suffix in listOf("bundle", "resources")) {
            val bundle = File(filesDir, "SilverhandNative_SilverhandNative.$suffix").apply { mkdirs() }
            assets.open("SilverhandNative_SilverhandNative.resources/Protocol.json").use { input ->
                File(bundle, "Protocol.json").outputStream().use { input.copyTo(it) }
            }
        }
        if (BuildConfig.ACCEPTANCE && assets.list("")!!.contains("acceptance-ca.pem")) {
            val ca = File(filesDir, "acceptance-ca.pem")
            assets.open("acceptance-ca.pem").use { input -> ca.outputStream().use { input.copyTo(it) } }
            Os.setenv("URLSessionCertificateAuthorityInfoFile", ca.path, true)
        }
        skip.foundation.ProcessInfo.launch(this)
        System.loadLibrary("SilverhandCore")
    }
}
