package com.silverhand.android

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ComponentName
import android.content.Context
import android.content.IntentFilter
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import java.io.File
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Base64
import androidx.activity.result.ActivityResult
import com.getcapacitor.*
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.*
import silverhand.core.ClientBridge
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

@CapacitorPlugin(name = "SilverhandClient")
class SilverhandClientPlugin : Plugin() {
    private companion object {
        // One owner across plugin/Activity recreation in this process.
        val themes = ThemePreferences()
    }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var core: ClientBridge? = null
    private var stopped = false
    private var destroyed = false
    private var exportPending = false
    private class PendingShare(val token: String, val call: PluginCall, val file: File) {
        val result = ShareResult(token)
        var receiver: BroadcastReceiver? = null
        var sender: PendingIntent? = null
    }
    private var pendingShare: PendingShare? = null
    private fun pruneShareCache() {
        val cutoff = System.currentTimeMillis() - 24L * 60 * 60 * 1000
        File(context.cacheDir, "shared-images").listFiles()?.forEach {
            if (it.isFile && it != pendingShare?.file && it.lastModified() < cutoff) it.delete()
        }
    }
    override fun load() { pruneShareCache() }
    private fun finishShare(pending: PendingShare) {
        if (pendingShare !== pending) return
        pendingShare = null
        pending.receiver?.let { context.unregisterReceiver(it) }
        pending.sender?.cancel()
        val reason = pending.result.reason
        // Unknown outcomes may already have handed the URI to another app.
        // Never delete those files when the chooser Activity returns.
        if (reason == ShareResult.Reason.LAUNCH_FAILED) pending.file.delete()
        Log.i("SilverhandShare", "reason=$reason token=${pending.token}")
        when (reason) {
            ShareResult.Reason.SELECTED -> pending.call.resolve(JSObject().put("completed", true))
            ShareResult.Reason.LAUNCH_FAILED -> pending.call.reject("Unable to open image share sheet")
            else -> pending.call.reject("Share outcome not confirmed. Check the selected app before sharing again.", "UNCONFIRMED")
        }
    }
    private fun client(): ClientBridge = core ?: ClientBridge(KeystoreRecord(context)).also {
        core = it
        it.active(!stopped)
        it.listen { event, payload -> if (!destroyed) notifyListeners(event, JSObject(payload)) }
    }
    private fun invoke(call: PluginCall, method: String) {
        scope.launch {
            try {
                val bridge = client()
                val id = UUID.randomUUID().toString()
                val response = suspendCancellableCoroutine<String> { continuation ->
                    bridge.start(id, method, call.data.toString()) { result ->
                        if (continuation.isActive) continuation.resume(result)
                    }
                    continuation.invokeOnCancellation {
                        activity.runOnUiThread { bridge.cancel(id) }
                    }
                }
                val result = JSObject(response)
                if (result.getBoolean("ok", false) == true) call.resolve(JSObject(result.getJSONObject("value").toString()))
                else call.reject(result.getString("error", "Native request failed"))
            } catch (e: CancellationException) {
                call.reject("Native request canceled", "CANCELED")
            } catch (e: Throwable) { call.reject(e.message ?: "Native request failed") }
        }
    }
    @PluginMethod fun getProfile(call: PluginCall) = invoke(call, "getProfile")
    @PluginMethod fun saveProfile(call: PluginCall) = invoke(call, "saveProfile")
    @PluginMethod fun clearProfile(call: PluginCall) = invoke(call, "clearProfile")
    @PluginMethod fun authState(call: PluginCall) = invoke(call, "authState")
    @PluginMethod fun serverInfo(call: PluginCall) = invoke(call, "serverInfo")
    @PluginMethod fun passwordRecovery(call: PluginCall) = invoke(call, "passwordRecovery")
    @PluginMethod fun authenticate(call: PluginCall) = invoke(call, "authenticate")
    @PluginMethod fun logout(call: PluginCall) = invoke(call, "logout")
    @PluginMethod fun request(call: PluginCall) = invoke(call, "request")
    @PluginMethod fun upload(call: PluginCall) = invoke(call, "upload")
    @PluginMethod fun openSocket(call: PluginCall) = invoke(call, "openSocket")
    @PluginMethod fun sendSocket(call: PluginCall) = invoke(call, "sendSocket")
    @PluginMethod fun closeSocket(call: PluginCall) = invoke(call, "closeSocket")
    @PluginMethod fun appVersion(call: PluginCall) { call.resolve(JSObject().put("version", BuildConfig.VERSION_NAME)) }
    private fun themeCall(call: PluginCall, save: Boolean) {
        if (destroyed) { call.reject("Theme owner has closed", "CANCELED"); return }
        scope.launch {
            try {
                val value = withContext(Dispatchers.IO) {
                    val request = currentCoroutineContext()
                    val prefs = { context.applicationContext.getSharedPreferences("silverhand-appearance-v1", Context.MODE_PRIVATE) }
                    if (save) { themes.save(prefs, call.getString("theme")) { request.ensureActive() }; null }
                    else themes.read(prefs) { request.ensureActive() }
                }
                call.resolve(JSObject().put("theme", value ?: org.json.JSONObject.NULL))
            } catch (e: CancellationException) {
                call.reject("Theme request canceled", "CANCELED")
            } catch (e: Exception) {
                call.reject(e.message ?: "Theme save/read not confirmed", "THEME_UNCONFIRMED")
            }
        }
    }
    @PluginMethod fun getTheme(call: PluginCall) = themeCall(call, false)
    @PluginMethod fun saveTheme(call: PluginCall) = themeCall(call, true)
    @PluginMethod fun openExternal(call: PluginCall) {
        activity.runOnUiThread {
            try {
                val uri = Uri.parse(call.getString("url") ?: "")
                require(uri.scheme?.lowercase() in setOf("http", "https", "mailto")) { "Unsupported external URL" }
                activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
                call.resolve()
            } catch (e: Exception) { call.reject(e.message ?: "Unable to open URL") }
        }
    }
    @PluginMethod fun saveAttachment(call: PluginCall) {
        activity.runOnUiThread {
            if (exportPending || pendingShare != null) { call.reject("A file save is already pending"); return@runOnUiThread }
            try {
                require(call.getString("base64") != null) { "Missing file bytes" }
                val filename = (call.getString("filename") ?: "attachment").replace('\\', '/').substringAfterLast('/').ifBlank { "attachment" }
                val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE, filename)
                exportPending = true
                startActivityForResult(call, intent, "attachmentSaved")
            } catch (e: Exception) { exportPending = false; call.reject(e.message ?: "Unable to save") }
        }
    }
    @ActivityCallback private fun attachmentSaved(call: PluginCall?, result: ActivityResult) {
        exportPending = false
        if (call == null) return
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) { call.resolve(JSObject().put("completed", false)); return }
        scope.launch {
            try {
                withContext(Dispatchers.IO) {
                    val bytes = Base64.decode(call.getString("base64") ?: error("Missing bytes"), Base64.DEFAULT)
                    context.contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes); it.flush() } ?: error("Unable to open destination")
                }
                call.resolve(JSObject().put("completed", true))
            } catch (e: Exception) { call.reject(e.message ?: "Unable to save attachment") }
        }
    }
    @PluginMethod fun sharePng(call: PluginCall) {
        activity.runOnUiThread {
            if (destroyed || exportPending || pendingShare != null) {
                call.reject("An image share is already pending or its owner has closed")
                return@runOnUiThread
            }
            var file: File? = null
            var pending: PendingShare? = null
            try {
                pruneShareCache()
                val bytes = Base64.decode(call.getString("base64") ?: error("Missing image bytes"), Base64.DEFAULT)
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                require(bounds.outWidth > 0 && bounds.outHeight > 0 &&
                    bounds.outWidth.toLong() * bounds.outHeight <= 32L * 1024 * 1024) { "Invalid or oversized image" }
                val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: error("Unable to decode image")
                val token = UUID.randomUUID().toString()
                try {
                    val directory = File(context.cacheDir, "shared-images").apply { check(isDirectory || mkdirs()) }
                    file = File(directory, "$token.png")
                    file.outputStream().use { output ->
                        if (bounds.outMimeType == "image/png") output.write(bytes)
                        else check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) { "Unable to encode PNG" }
                    }
                } finally { bitmap.recycle() }
                val sharedFile = requireNotNull(file)
                val uri = FileProvider.getUriForFile(context, "${context.packageName}.shared-images", sharedFile)
                val item = PendingShare(token, call, sharedFile)
                pending = item
                pendingShare = item
                val action = "${context.packageName}.SHARE_CHOSEN.$token"
                val receiver = object : BroadcastReceiver() {
                    override fun onReceive(context: Context, intent: Intent) {
                        if (intent.action != action) return
                        @Suppress("DEPRECATION")
                        val component = intent.getParcelableExtra<ComponentName>(Intent.EXTRA_CHOSEN_COMPONENT)
                        // Retain pending ownership until the chooser result so a second
                        // activity call cannot replace Capacitor's saved call prematurely.
                        item.result.chosen(token, component != null)
                    }
                }
                ContextCompat.registerReceiver(context, receiver, IntentFilter(action), ContextCompat.RECEIVER_NOT_EXPORTED)
                item.receiver = receiver
                val flags = PendingIntent.FLAG_CANCEL_CURRENT or
                    (if (android.os.Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                val sender = PendingIntent.getBroadcast(context, 0, Intent(action).setPackage(context.packageName), flags)
                item.sender = sender
                val send = Intent(Intent.ACTION_SEND).setType("image/png")
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .apply { clipData = ClipData.newUri(context.contentResolver, "Image", uri) }
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                val chooser = Intent.createChooser(send, "Share image", sender.intentSender)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                startActivityForResult(call, chooser, "imageShared")
            } catch (e: Exception) {
                if (pending != null) {
                    if (pending.result.failed(pending.token)) finishShare(pending)
                } else {
                    file?.delete()
                    call.reject(e.message ?: "Unable to share image")
                }
            }
        }
    }
    @ActivityCallback private fun imageShared(call: PluginCall?, result: ActivityResult) {
        val pending = pendingShare ?: return
        if (call?.callbackId != pending.call.callbackId) return
        // RESULT_CANCELED is also used by some successful chooser routes. A
        // target callback received first confirms handoff; otherwise return neutral unknown.
        if (pending.result.returned(pending.token)) finishShare(pending)
    }
    override fun handleOnStart() {
        core?.active(true)
        if (stopped) notifyListeners("foreground", JSObject())
        stopped = false
    }
    override fun handleOnStop() { stopped = true; core?.active(false) }
    override fun handleOnDestroy() {
        destroyed = true
        pendingShare?.let { if (it.result.destroyed(it.token)) finishShare(it) }
        core?.shutdown()
        scope.cancel()
        core = null
    }
}

/** Theme-only state. SharedPreferences can change its in-memory map before a
 * failed commit; reading that map must not turn a failed save into an ack. */
internal class ThemePreferences {
    private var writeUnconfirmed = false
    private val ids = setOf("glass", "studio-light", "poster", "iris", "slack-dark")

    @Synchronized fun read(prefs: () -> SharedPreferences, checkActive: () -> Unit): String? {
        checkActive()
        check(!writeUnconfirmed) { "Previous theme save not confirmed" }
        val theme = prefs().getString("theme", null)
        check(theme == null || theme in ids) { "Invalid stored theme" }
        return theme
    }

    @Synchronized fun save(prefs: () -> SharedPreferences, theme: String?, checkActive: () -> Unit) {
        // Cancellation while blocked on this monitor must prevent a stale write.
        // Once commit has begun, cancellation is not a rollback guarantee.
        checkActive()
        require(theme in ids) { "Invalid theme" }
        writeUnconfirmed = true
        check(prefs().edit().putString("theme", theme).commit()) { "Theme save not confirmed" }
        writeUnconfirmed = false
    }
}
