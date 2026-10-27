package com.silverhand.android

import android.content.Context
import android.system.Os
import java.io.File
import java.security.KeyStore

internal object NativeTrustBootstrap {
    fun install(context: Context) {
        // Failure must stop initialization, never reuse a previous acceptance CA
        // or silently choose a different curl trust source.
        Os.unsetenv("URLSessionCertificateAuthorityInfoFile")
        val store = KeyStore.getInstance("AndroidCAStore").apply { load(null) }
        val extra = if (BuildConfig.ACCEPTANCE) context.assets.open("acceptance-ca.pem") else null
        val bytes = extra.use { NativeTrust.bundle(store, BuildConfig.ACCEPTANCE, it) }
        val destination = File(context.filesDir, "urlsession-ca.pem")
        if (BuildConfig.ACCEPTANCE) {
            // Preserve the existing acceptance identity observer's exact asset
            // file. It is separate from the merged CAINFO bundle.
            val ca = File(context.filesDir, "acceptance-ca.pem")
            context.assets.open("acceptance-ca.pem").use { input -> ca.outputStream().use { input.copyTo(it) } }
            Os.chmod(ca.path, 0b110000000)
        }
        NativeTrust.install(bytes, destination) { path ->
            Os.setenv("URLSessionCertificateAuthorityInfoFile", path, true)
        }
    }
}
