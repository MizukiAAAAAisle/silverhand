package com.silverhand.android

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import org.json.JSONObject

/** One process owner across Activity replacements; never retains an Activity or JS listener. */
internal class SystemNotifications private constructor(private val context: Context) {
    companion object {
        private const val CHANNEL_ID = "silverhand.activity.v1"
        private const val ITEM_ID = 1
        private var instance: SystemNotifications? = null
        @Synchronized fun get(context: Context): SystemNotifications = instance
            ?: SystemNotifications(context.applicationContext).also { instance = it }
        @Synchronized fun existing(): SystemNotifications? = instance
    }
    private val manager = context.getSystemService(NotificationManager::class.java)
    private val state = NotificationState()
    private val action = "${context.packageName}.NOTIFICATION_OPEN"
    private val deleteAction = "${context.packageName}.NOTIFICATION_DELETE"
    private val permission = context.getSharedPreferences("silverhand-notification-permission-v1", Context.MODE_PRIVATE)

    init {
        // A previous process's identity/click registry cannot be rebound to a new login.
        // Process-death notification restoration is outside this local-delivery scope.
        manager.cancelAll()
    }
    fun session(): String = state.session()
    fun current(session: String?): Boolean = session != null && state.current(session)
    fun reset() {
        for (ticket in state.reset()) cancelIntents(ticket)
        manager.cancelAll()
    }
    fun permitted(): Boolean = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    fun prompted(): Boolean = permission.getBoolean("prompted", false)
    fun markPrompted() { check(permission.edit().putBoolean("prompted", true).commit()) { "Notification prompt state not saved" } }

    private fun ensureChannel(): NotificationChannel {
        // Existing channels belong to the user/system. Do not reapply defaults,
        // lower importance or delete/recreate a channel to reset their choices.
        manager.getNotificationChannel(CHANNEL_ID)?.let { return it }
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Silverhand", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Mentions and agent activity"
            setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
            enableVibration(false)
        })
        return manager.getNotificationChannel(CHANNEL_ID) ?: error("Notification channel registration not confirmed")
    }

    private fun uri(ticket: NotificationState.Ticket): Uri = Uri.Builder()
        .scheme("silverhand-notification").authority(context.packageName)
        .appendPath(ticket.session).appendPath(ticket.token).appendPath(ticket.tag).build()
    private fun intent(ticket: NotificationState.Ticket): Intent = Intent(context, MainActivity::class.java)
        .setAction(action)
        .setData(uri(ticket))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    private fun pending(ticket: NotificationState.Ticket, flags: Int): PendingIntent? =
        PendingIntent.getActivity(context, 0, intent(ticket), flags or PendingIntent.FLAG_IMMUTABLE)
    private fun deletePending(ticket: NotificationState.Ticket, flags: Int): PendingIntent? =
        PendingIntent.getBroadcast(context, 0,
            Intent(context, NotificationDismissReceiver::class.java).setAction(deleteAction).setData(uri(ticket)),
            flags or PendingIntent.FLAG_IMMUTABLE)
    private fun cancelIntents(ticket: NotificationState.Ticket?) {
        if (ticket != null) {
            pending(ticket, PendingIntent.FLAG_NO_CREATE)?.cancel()
            deletePending(ticket, PendingIntent.FLAG_NO_CREATE)?.cancel()
        }
    }
    fun post(input: JSObject): String {
        val session = input.getString("session")
        if (!current(session)) return "session-expired"
        if (!permitted()) return "not-authorized-or-undecided"
        if (!manager.areNotificationsEnabled()) return "notifications-disabled"
        if (ensureChannel().importance == NotificationManager.IMPORTANCE_NONE)
            return "channel-disabled"
        val title = input.getString("title") ?: error("Notification title missing")
        val id = input.getString("notificationId")
        require(id == null || id.isNotBlank()) { "Notification identity is empty" }
        val coordinates = if (input.has("clickTarget") && !input.isNull("clickTarget")) {
            val value = input.optJSONObject("clickTarget") ?: error("Invalid notification click target")
            fun coordinate(key: String, nullable: Boolean = false): String? {
                val field = value.opt(key)
                if (nullable && field === JSONObject.NULL) return null
                require(field is String) { "Invalid notification click coordinate" }
                return field
            }
            NotificationState.ClickTarget(coordinate("channelId"), coordinate("messageId"),
                coordinate("threadRootId", true), coordinate("workspaceId", true))
        } else null
        val ticket = state.prepare(session, id, coordinates)
        val text = listOfNotNull(input.getString("subtitle"), input.getString("body"))
            .filter { it.isNotBlank() }.joinToString("\n")
        try {
            val builder = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_launcher_monochrome)
                .setContentTitle(title).setContentText(text).setStyle(NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(pending(ticket, PendingIntent.FLAG_UPDATE_CURRENT))
                .setDeleteIntent(deletePending(ticket, PendingIntent.FLAG_UPDATE_CURRENT))
                .setAutoCancel(true).setOnlyAlertOnce(true)
            input.getString("groupId")?.takeIf { it.isNotBlank() }?.let { builder.setGroup(it) }
            cancelIntents(state.post(ticket) { manager.notify(ticket.tag, ITEM_ID, builder.build()) })
        } catch (error: Exception) { cancelIntents(ticket); throw error }
        return "posted" // OS delivery/heads-up/DND remain controlled by the system/user.
    }
    fun dismiss(session: String, ids: List<String>): String {
        if (!current(session)) return "session-expired"
        for (id in ids) {
            cancelIntents(state.dismiss(session, id))
            manager.cancel(state.tag(id), ITEM_ID)
        }
        return "dismissed"
    }
    private fun credentials(intent: Intent, expectedAction: String): List<String>? {
        val uri = intent.data ?: return null
        if (intent.action != expectedAction || uri.scheme != "silverhand-notification" || uri.authority != context.packageName)
            return null
        val parts = uri.pathSegments
        return if (parts.size == 3) parts else null
    }
    fun acceptClick(intent: Intent): Boolean {
        val parts = credentials(intent, action) ?: return false
        val ticket = state.click(parts[0], parts[2], parts[1]) ?: return false
        manager.cancel(ticket.tag, ITEM_ID)
        cancelIntents(ticket)
        return ticket.notificationId != null // Anonymous errors just open the app; no invented target.
    }
    fun acceptDelete(intent: Intent) {
        val parts = credentials(intent, deleteAction) ?: return
        cancelIntents(state.deleted(parts[0], parts[2], parts[1]))
    }
    fun takeClicks(session: String): JSArray = JSArray().apply {
        for (ticket in state.takeClicks(session)) {
            val click = JSObject().put("id", ticket.notificationId).put("token", ticket.token)
            ticket.clickTarget?.let { target ->
                click.put("clickTarget", JSObject().put("channelId", target.channelId).put("messageId", target.messageId)
                    .put("threadRootId", target.threadRootId ?: JSONObject.NULL)
                    .put("workspaceId", target.workspaceId ?: JSONObject.NULL))
            }
            put(click)
        }
    }
}
