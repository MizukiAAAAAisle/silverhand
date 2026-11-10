package com.silverhand.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/** Explicit, non-exported deleteIntent target; never initializes a session or starts networking. */
class NotificationDismissReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        try { SystemNotifications.existing()?.acceptDelete(intent) }
        catch (error: Exception) { Log.e("SilverhandNotifications", "Notification delete failed", error) }
    }
}
