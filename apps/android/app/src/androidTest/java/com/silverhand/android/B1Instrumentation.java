package com.silverhand.android;

import android.app.Activity;
import android.app.Instrumentation;
import android.os.Bundle;

/** Test-APK-only entry. The minified product may strip transitive JUnit runner
 * classes, so this controller uses the platform instrumentation lifecycle. */
public final class B1Instrumentation extends Instrumentation {
    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        start();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            new B1DeviceControlTest(this).controlSession();
            result.putString("stream", "B1_DEVICE_CONTROL_COMPLETED\n");
            finish(Activity.RESULT_OK, result);
        } catch (Throwable error) {
            result.putString("stream", "B1_DEVICE_CONTROL_FAILED: " + error + "\n");
            result.putString("shortMsg", error.toString());
            finish(Activity.RESULT_CANCELED, result);
        }
    }
}
