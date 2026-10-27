package com.silverhand.android;

import android.app.Activity;
import android.app.Application;
import android.content.Intent;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;
import android.webkit.WebView;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import org.json.JSONObject;
import org.json.JSONArray;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.ExecutionException;

/** A separate test-APK controller. Commands are private run-as files, never a
 * product receiver, intent extra, Web method or network endpoint. */
public class B1DeviceControlTest {
    private volatile MainActivity current;
    private volatile int created;
    private volatile int destroyed;
    private volatile int lastDestroyed;
    private InputConnection connection;
    private MainActivity connectionActivity;
    private WebView connectionWebView;
    private int connectionGeneration;
    private void traceConnection(String event, String reason, MainActivity activity, WebView web) {
        android.util.Log.i("B1InputConnection", event + " generation=" + connectionGeneration
            + " ownerActivity=" + System.identityHashCode(connectionActivity) + " ownerWebView=" + System.identityHashCode(connectionWebView)
            + " currentActivity=" + System.identityHashCode(activity) + " currentWebView=" + System.identityHashCode(web)
            + " connection=" + System.identityHashCode(connection) + " reason=" + reason);
    }
    private void clearConnection(String reason) {
        if (connection!=null) traceConnection("invalidate",reason,current,null);
        connection=null; connectionActivity=null; connectionWebView=null;
    }
    private final android.app.Instrumentation instrumentation;
    B1DeviceControlTest(android.app.Instrumentation instrumentation) { this.instrumentation = instrumentation; }
    private final Application.ActivityLifecycleCallbacks lifecycle = new Application.ActivityLifecycleCallbacks() {
        public void onActivityCreated(Activity a, Bundle b) { if (a instanceof MainActivity) { if (current!=a) { current=(MainActivity)a; clearConnection("lifecycle-create"); } created++; } }
        public void onActivityResumed(Activity a) { if (a instanceof MainActivity) { if (current!=a) { current=(MainActivity)a; clearConnection("lifecycle-resume"); } } }
        public void onActivityDestroyed(Activity a) { if (a instanceof MainActivity) { if (connectionActivity==a) clearConnection("lifecycle-destroy"); if (current==a) current=null; destroyed++; lastDestroyed=System.identityHashCode(a); } }
        public void onActivityStarted(Activity a) {} public void onActivityPaused(Activity a) {}
        public void onActivityStopped(Activity a) {} public void onActivitySaveInstanceState(Activity a, Bundle b) {}
    };
    private JSONObject main(Action action) throws Exception {
        FutureTask<JSONObject> task = new FutureTask<>(() -> action.run());
        new android.os.Handler(android.os.Looper.getMainLooper()).post(task);
        try { return task.get(10, TimeUnit.SECONDS); }
        catch (TimeoutException error) {
            task.cancel(false); // A queued action must not run late. A running action is not claimed cancelled.
            throw new IllegalStateException("Main-thread action exceeded 10 seconds", error);
        } catch (ExecutionException error) {
            Throwable cause=error.getCause();
            if (cause instanceof Exception) throw (Exception)cause;
            if (cause instanceof Error) throw (Error)cause;
            throw new IllegalStateException("Main-thread action failed: " + cause, cause);
        }
    }

    private interface Action { JSONObject run() throws Exception; }
    private MainActivity activity() { if (current==null || current.isDestroyed()) throw new IllegalStateException("No live Activity"); return current; }
    private void collectWebViews(android.view.View view, java.util.List<WebView> found) {
        if (view instanceof WebView) found.add((WebView)view);
        if (view instanceof android.view.ViewGroup) {
            android.view.ViewGroup group=(android.view.ViewGroup)view;
            for (int i=0;i<group.getChildCount();i++) collectWebViews(group.getChildAt(i),found);
        }
    }
    private WebView webView() {
        java.util.List<WebView> found=new java.util.ArrayList<>();
        collectWebViews(activity().getWindow().getDecorView(),found);
        if (found.size()!=1) throw new IllegalStateException("Expected one current Activity WebView; found " + found.size());
        return found.get(0);
    }
    private JSONObject fault(Throwable error) throws Exception {
        JSONArray chain=new JSONArray();
        for (Throwable item=error; item!=null && chain.length()<8; item=item.getCause()) {
            JSONArray frames=new JSONArray();
            for (StackTraceElement frame:item.getStackTrace()) { if (frames.length()==8) break; frames.put(frame.toString()); }
            chain.put(new JSONObject().put("type",item.getClass().getName()).put("message",String.valueOf(item.getMessage())).put("frames",frames));
        }
        return new JSONObject().put("causeChain",chain);
    }
    private JSONObject identity() throws Exception {
        return main(() -> {
            MainActivity a=activity(); WebView web=webView(); Rect rect=new Rect(); web.getGlobalVisibleRect(rect);
            WindowInsetsCompat insets=ViewCompat.getRootWindowInsets(a.getWindow().getDecorView());
            return new JSONObject().put("pid",android.os.Process.myPid()).put("activity",System.identityHashCode(a))
                .put("webViewIdentity",System.identityHashCode(web)).put("connectionGeneration",connectionGeneration)
                .put("connectionActivity",System.identityHashCode(connectionActivity)).put("connectionWebView",System.identityHashCode(connectionWebView))
                .put("created",created).put("destroyed",destroyed).put("lastDestroyed",lastDestroyed)
                .put("orientation",a.getResources().getConfiguration().orientation).put("fontScale",a.getResources().getConfiguration().fontScale)
                .put("webView",new JSONObject().put("left",rect.left).put("top",rect.top).put("right",rect.right).put("bottom",rect.bottom))
                .put("imeVisible",insets!=null && insets.isVisible(WindowInsetsCompat.Type.ime()));
        });
    }
    private void inject(int action, long start, float x, float y, boolean system) throws Exception {
        if (system) {
            MotionEvent event=MotionEvent.obtain(start,SystemClock.uptimeMillis(),action,x,y,0); event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
            try {
                if (!instrumentation.getUiAutomation().injectInputEvent(event,true)) throw new IllegalStateException("System input rejected");
            } finally { event.recycle(); }
        } else main(() -> {
            MotionEvent event=MotionEvent.obtain(start,SystemClock.uptimeMillis(),action,x,y,0); event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
            try { webView().dispatchTouchEvent(event); return new JSONObject(); }
            finally { event.recycle(); }
        });
    }
    private JSONObject execute(JSONObject request) throws Exception {
        String operation=request.getString("operation");
        if (operation.equals("identity")) return identity();
        if (operation.equals("recreate")) {
            int old=System.identityHashCode(activity());
            main(() -> { clearConnection("explicit-recreate"); activity().recreate(); return new JSONObject(); });
            long end=SystemClock.uptimeMillis()+15000;
            while (SystemClock.uptimeMillis()<end) {
                if (current!=null && System.identityHashCode(current)!=old && !current.isDestroyed() && lastDestroyed==old) {
                    JSONObject result=identity(); result.put("oldActivity",old); result.put("actualRecreate",true); return result;
                }
                SystemClock.sleep(50);
            }
            throw new AssertionError("Activity did not recreate with new identity");
        }
        if (operation.startsWith("ime-")) return main(() -> {
            MainActivity owner=activity(); WebView web=webView(); web.requestFocus();
            if (connection!=null && (connectionActivity!=owner || connectionWebView!=web)) clearConnection("owner-mismatch-before-action");
            if (connection==null) {
                connection=web.onCreateInputConnection(new EditorInfo());
                if (connection!=null) { connectionActivity=owner; connectionWebView=web; connectionGeneration++; traceConnection("create",operation,owner,web); }
            }
            if (connection==null) throw new IllegalStateException("Missing actual WebView InputConnection");
            if (connectionActivity!=owner || connectionWebView!=web) throw new IllegalStateException("InputConnection owner mismatch");
            traceConnection("use",operation,owner,web);
            boolean ok;
            switch (operation) {
                case "ime-compose": ok=connection.setComposingText(request.getString("text"),1); break;
                case "ime-finish": ok=connection.finishComposingText(); break;
                case "ime-enter": ok=connection.sendKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_ENTER)); connection.sendKeyEvent(new KeyEvent(KeyEvent.ACTION_UP,KeyEvent.KEYCODE_ENTER)); break;
                case "ime-select": ok=connection.setSelection(request.getInt("start"),request.getInt("end")); break;
                case "ime-commit": ok=connection.commitText(request.getString("text"),1); break;
                case "ime-show": ok=((InputMethodManager)activity().getSystemService(Activity.INPUT_METHOD_SERVICE)).showSoftInput(web,InputMethodManager.SHOW_IMPLICIT); break;
                default: throw new IllegalArgumentException("Unknown IME operation");
            }
            return new JSONObject().put("accepted",ok).put("path","Android WebView InputConnection")
                .put("activity",System.identityHashCode(owner)).put("webView",System.identityHashCode(web))
                .put("connectionActivity",System.identityHashCode(connectionActivity)).put("connectionWebView",System.identityHashCode(connectionWebView))
                .put("connection",System.identityHashCode(connection)).put("generation",connectionGeneration);
        });
        if (operation.equals("page-touch-cancel") || operation.equals("system-gesture-cancel") || operation.equals("system-gesture-commit")) {
            boolean system=operation.startsWith("system-");
            JSONObject geometry=main(() -> {
                Rect display=new Rect(); activity().getWindow().getDecorView().getWindowVisibleDisplayFrame(display);
                return new JSONObject().put("width",activity().getResources().getDisplayMetrics().widthPixels)
                    .put("y",system ? display.centerY() : webView().getHeight()/2f);
            });
            float width=(float)geometry.getDouble("width"), y=(float)geometry.getDouble("y");
            float first=system ? 1f : 3f;
            long down=SystemClock.uptimeMillis(); inject(MotionEvent.ACTION_DOWN,down,first,y,system);
            for (int i=1;i<=8;i++) { SystemClock.sleep(30); inject(MotionEvent.ACTION_MOVE,down,first+width*.65f*i/8f,y,system); }
            inject(operation.equals("system-gesture-commit") ? MotionEvent.ACTION_UP : MotionEvent.ACTION_CANCEL,down,width*.65f,y,system);
            return new JSONObject().put("injected",true).put("target",system?"system UiAutomation":"WebView.dispatchTouchEvent")
                .put("terminalAction",operation.equals("system-gesture-commit")?"UP":"CANCEL");
        }
        throw new IllegalArgumentException("Unknown test operation");
    }
    public void controlSession() throws Exception {
        if (!BuildConfig.ACCEPTANCE) throw new AssertionError("Internal acceptance only");
        Application app=(Application)instrumentation.getTargetContext().getApplicationContext();
        File input=new File(app.getFilesDir(),"b1-request.json"), output=new File(app.getFilesDir(),"b1-response.json");
        boolean registered=false;
        try {
            app.registerActivityLifecycleCallbacks(lifecycle); registered=true;
            input.delete(); output.delete();
            Intent launch=new Intent(app,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); instrumentation.startActivitySync(launch);
            long deadline=SystemClock.uptimeMillis()+20*60*1000; String previous="";
            Bundle ready = new Bundle(); ready.putString("stream", "B1_DEVICE_CONTROL_READY\n"); instrumentation.sendStatus(1, ready);
            while (SystemClock.uptimeMillis()<deadline) {
                if (!input.exists()) { SystemClock.sleep(50); continue; }
                JSONObject request=new JSONObject(new String(Files.readAllBytes(input.toPath()),StandardCharsets.UTF_8));
                String id=request.getString("id"); if (id.equals(previous)) { SystemClock.sleep(50); continue; } previous=id;
                JSONObject response=new JSONObject().put("id",id);
                boolean stop=request.getString("operation").equals("stop");
                try { response.put("ok",true).put("result",stop?new JSONObject().put("stopped",true):execute(request)); }
                catch (Throwable error) { response.put("ok",false).put("error",error.toString()).put("diagnostic",fault(error)); }
                File temporary=new File(app.getFilesDir(),"b1-response.tmp"); Files.write(temporary.toPath(),response.toString().getBytes(StandardCharsets.UTF_8));
                if (!temporary.renameTo(output)) throw new AssertionError("Cannot publish device response");
                if (stop) return;
            }
            throw new AssertionError("B1 controller deadline exceeded");
        } finally {
            if (registered) app.unregisterActivityLifecycleCallbacks(lifecycle); clearConnection("session-end"); input.delete(); output.delete();
            new File(app.getFilesDir(),"b1-request.tmp").delete(); new File(app.getFilesDir(),"b1-response.tmp").delete();
        }
    }
}
