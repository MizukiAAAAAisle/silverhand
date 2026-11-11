package com.silverhand.android

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import org.json.JSONObject

/** Never obtains the presentation owner or creates a channel/session. */
internal object NotificationDiagnosticsReader {
    fun read(context: Context): JSObject {
        val snapshot = NotificationSnapshot.read(object : NotificationSnapshot.Reader {
            override fun runtimePermission(): String = when {
                Build.VERSION.SDK_INT < 33 -> "not-required"
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED -> "granted"
                else -> "not-granted"
            }
            override fun appEnabled(): Boolean = context.getSystemService(NotificationManager::class.java).areNotificationsEnabled()
            override fun channel(): NotificationSnapshot.Channel? =
                context.getSystemService(NotificationManager::class.java)
                    .getNotificationChannel(SystemNotifications.CHANNEL_ID)?.let {
                        NotificationSnapshot.Channel(it.importance == NotificationManager.IMPORTANCE_NONE)
                    }
        })
        return JSObject().put("runtimePermission", snapshot.runtimePermission)
            .put("appEnabled", snapshot.appEnabled ?: JSONObject.NULL)
            .put("channel", snapshot.channel).put("channelBlocked", snapshot.channelBlocked ?: JSONObject.NULL)
    }
}
