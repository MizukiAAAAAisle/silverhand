package com.silverhand.android
import silverhand.core.PlatformStorage

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// One origin-bound atomic record. Never persist credentials in WebView storage.
class KeystoreRecord(context: Context): PlatformStorage {
    val file = File(context.noBackupFilesDir, "session-v1.bin")
    private val atomic = AtomicFile(file)
    private val alias = "silverhand-android-session-v1"
    private fun key(create: Boolean): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        check(create) { "record key missing" }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    override fun readRecord(): String? {
        if (!file.exists()) return null
        val data = atomic.readFully()
        require(data.size >= 28) { "truncated record" }
        return Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, data.copyOfRange(0, 12)))
            String(doFinal(data.copyOfRange(12, data.size)), Charsets.UTF_8)
        }
    }
    override fun writeRecord(value: String?) {
        if (value == null) { atomic.delete(); check(!file.exists()); return }
        val bytes = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.ENCRYPT_MODE, key(true)); iv + doFinal(value.toByteArray(Charsets.UTF_8))
        }
        val stream = atomic.startWrite()
        try { stream.write(bytes); atomic.finishWrite(stream) }
        catch (e: Exception) { atomic.failWrite(stream); throw e }
    }
}
