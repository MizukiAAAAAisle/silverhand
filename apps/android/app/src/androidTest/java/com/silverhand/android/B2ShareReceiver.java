package com.silverhand.android;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import org.json.JSONObject;
import java.io.File;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.security.MessageDigest;

/** Test APK only: observe a real cross-UID stream grant, then end the task. */
public final class B2ShareReceiver extends Activity {
    private static String hash(byte[] bytes) throws Exception {
        StringBuilder out = new StringBuilder();
        for (byte value : MessageDigest.getInstance("SHA-256").digest(bytes))
            out.append(String.format("%02x", value & 255));
        return out.toString();
    }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        JSONObject record = new JSONObject();
        try {
            Intent intent = getIntent();
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (!Intent.ACTION_SEND.equals(intent.getAction()) || uri == null)
                throw new IllegalArgumentException("Expected ACTION_SEND stream");
            record.put("uid", android.os.Process.myUid());
            record.put("uri", uri.toString());
            record.put("intentMime", intent.getType());
            record.put("resolvedMime", getContentResolver().getType(uri));
            record.put("flags", intent.getFlags());
            record.put("readGranted", checkUriPermission(uri, android.os.Process.myPid(), android.os.Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) == PackageManager.PERMISSION_GRANTED);
            try (Cursor cursor = getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) record.put("name", cursor.getString(0));
            }
            byte[] bytes;
            try (java.io.InputStream stream = getContentResolver().openInputStream(uri)) {
                if (stream == null) throw new java.io.FileNotFoundException("Missing stream");
                bytes = stream.readAllBytes();
            }
            Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (bitmap == null) throw new IllegalArgumentException("Stream is not a decodable image");
            try {
                int[] pixels = new int[bitmap.getWidth() * bitmap.getHeight()];
                bitmap.getPixels(pixels, 0, bitmap.getWidth(), 0, 0, bitmap.getWidth(), bitmap.getHeight());
                ByteBuffer packed = ByteBuffer.allocate(pixels.length * 4);
                for (int pixel : pixels) packed.putInt(pixel);
                record.put("width", bitmap.getWidth()).put("height", bitmap.getHeight());
                record.put("pixelsSha256", hash(packed.array()));
            } finally { bitmap.recycle(); }
            record.put("bytes", bytes.length).put("sha256", hash(bytes)).put("ok", true);
        } catch (Exception error) {
            try { record.put("ok", false).put("error", error.toString()); } catch (Exception ignored) { }
        } finally {
            try { Files.write(new File(getFilesDir(), "b2-share.json").toPath(), record.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
            catch (Exception error) { android.util.Log.e("B2ShareReceiver", "Cannot record result", error); }
            finishAndRemoveTask();
        }
    }
}
