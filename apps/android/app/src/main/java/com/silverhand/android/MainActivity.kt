package com.silverhand.android

import android.os.Bundle
import android.util.Log
import androidx.activity.BackEventCompat
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    private var backPending = false
    override fun onCreate(state: Bundle?) {
        registerPlugin(SilverhandClientPlugin::class.java)
        super.onCreate(state)
        // Capacitor SystemBars owns insets. Do not add a second WebView padding handler.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            private fun trace(event: String) {
                if (BuildConfig.ACCEPTANCE) Log.i("SilverhandBack", "$event activity=${System.identityHashCode(this@MainActivity)}")
            }
            override fun handleOnBackStarted(backEvent: BackEventCompat) { trace("gesture-start") }
            override fun handleOnBackCancelled() { trace("gesture-cancel") }
            override fun handleOnBackPressed() {
                trace("commit")
                // Usually the IME consumes Back before the Activity. Keep that
                // ordering when a keyboard routes the committed request here.
                val decor = window.decorView
                if (ViewCompat.getRootWindowInsets(decor)?.isVisible(WindowInsetsCompat.Type.ime()) == true) {
                    WindowCompat.getInsetsController(window, decor).hide(WindowInsetsCompat.Type.ime())
                    return
                }
                if (backPending || isFinishing || isDestroyed) return
                val view = bridge?.webView
                if (view == null) { moveTaskToBack(true); return }
                backPending = true
                view.evaluateJavascript(
                    "window.dispatchEvent(new Event('silverhand:system-back', {cancelable:true}))"
                ) { unconsumed ->
                    backPending = false
                    // A reply to a destroyed Activity cannot navigate its replacement.
                    if (!isFinishing && !isDestroyed && unconsumed != "false") {
                        trace("root-background")
                        moveTaskToBack(true)
                    }
                }
            }
        })
    }
}
