package com.silverhand.android

import android.content.Context
import android.system.Os
import android.util.Log
import java.io.File
import java.security.KeyStore

internal object NativeTrustBootstrap {
    fun install(context: Context) {
        // Root-store, storage and environment failures still stop initialization.
        // Never reuse a previous bundle or select an implicit curl trust source.
        Os.unsetenv("URLSessionCertificateAuthorityInfoFile")
        val store = KeyStore.getInstance("AndroidCAStore").apply { load(null) }
        val extra = if (BuildConfig.ACCEPTANCE) {
            NativeTrust.Asset { context.assets.open("acceptance-ca.pem") }
        } else null
        val bundle = NativeTrust.bundle(store, BuildConfig.ACCEPTANCE, extra)
        if (BuildConfig.ACCEPTANCE) {
            // Bounded status codes only: no certificate, credential or raw exception.
            Log.i("NativeTrust", "Acceptance CA: ${bundle.status}")
        }
        NativeTrust.install(
            bundle,
            File(context.filesDir, "urlsession-ca.pem"),
            File(context.filesDir, "acceptance-ca.pem"),
        ) { path -> Os.setenv("URLSessionCertificateAuthorityInfoFile", path, true) }
    }
}
