package com.silverhand.android;

import android.database.Cursor;
import android.database.MatrixCursor;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract.Document;
import android.provider.DocumentsContract.Root;
import android.provider.DocumentsProvider;
import java.io.FileNotFoundException;

/** Test APK only. DocumentsUI returns the URI; product openOutputStream fails. */
public final class B2DocumentsProvider extends DocumentsProvider {
    private static final String[] ROOTS = { Root.COLUMN_ROOT_ID, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_TITLE, Root.COLUMN_FLAGS, Root.COLUMN_MIME_TYPES };
    private static final String[] DOCS = { Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_FLAGS };
    @Override public boolean onCreate() { return true; }
    private void row(MatrixCursor cursor, String id) throws FileNotFoundException {
        if (!id.equals("root") && !id.equals("denied") && !id.equals("missing")) throw new FileNotFoundException(id);
        MatrixCursor.RowBuilder row = cursor.newRow();
        for (String column : cursor.getColumnNames()) {
            if (column.equals(Document.COLUMN_DOCUMENT_ID)) row.add(column, id);
            else if (column.equals(Document.COLUMN_DISPLAY_NAME)) row.add(column, id.equals("root") ? "B2 Save Errors" : id);
            else if (column.equals(Document.COLUMN_MIME_TYPE)) row.add(column, id.equals("root") ? Document.MIME_TYPE_DIR : "application/octet-stream");
            else if (column.equals(Document.COLUMN_FLAGS)) row.add(column, id.equals("root") ? Document.FLAG_DIR_SUPPORTS_CREATE : Document.FLAG_SUPPORTS_WRITE);
            else row.add(column, null);
        }
    }
    @Override public Cursor queryRoots(String[] projection) {
        MatrixCursor cursor = new MatrixCursor(projection == null ? ROOTS : projection);
        MatrixCursor.RowBuilder row = cursor.newRow();
        for (String column : cursor.getColumnNames()) {
            if (column.equals(Root.COLUMN_ROOT_ID) || column.equals(Root.COLUMN_DOCUMENT_ID)) row.add(column, "root");
            else if (column.equals(Root.COLUMN_TITLE)) row.add(column, "B2 Save Errors");
            else if (column.equals(Root.COLUMN_FLAGS)) row.add(column, Root.FLAG_SUPPORTS_CREATE | Root.FLAG_LOCAL_ONLY);
            else if (column.equals(Root.COLUMN_MIME_TYPES)) row.add(column, "*/*");
            else row.add(column, null);
        }
        return cursor;
    }
    @Override public Cursor queryDocument(String id, String[] projection) throws FileNotFoundException {
        MatrixCursor cursor = new MatrixCursor(projection == null ? DOCS : projection);
        row(cursor, id);
        return cursor;
    }
    @Override public Cursor queryChildDocuments(String id, String[] projection, String sortOrder) throws FileNotFoundException {
        if (!id.equals("root")) throw new FileNotFoundException(id);
        return new MatrixCursor(projection == null ? DOCS : projection);
    }
    @Override public String createDocument(String parent, String mimeType, String name) throws FileNotFoundException {
        if (!parent.equals("root")) throw new FileNotFoundException(parent);
        // Fixed names choose two fixed IDs; no storage/configuration framework.
        return name.startsWith("missing") ? "missing" : "denied";
    }
    @Override public ParcelFileDescriptor openDocument(String id, String mode, CancellationSignal signal) throws FileNotFoundException {
        if (id.equals("denied")) throw new SecurityException("B2 destination denied");
        throw new FileNotFoundException("B2 destination missing: " + id);
    }
}
