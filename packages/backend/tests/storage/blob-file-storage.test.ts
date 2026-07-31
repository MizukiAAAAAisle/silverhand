import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BlobFileStorageError,
  createLocalBlobFileStorage,
  LocalBlobFileStorage,
} from '../../src/storage/blob-file-storage.js';
import { makeTempSilverhandDir } from '../utils/db.js';

describe('LocalBlobFileStorage', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  function makeStorage(): {
    silverhandDir: string;
    storage: LocalBlobFileStorage;
  } {
    const tmp = makeTempSilverhandDir();
    cleanup = tmp.cleanup;
    return {
      silverhandDir: tmp.silverhandDir,
      storage: createLocalBlobFileStorage({ rootDir: join(tmp.silverhandDir, 'blobs') }),
    };
  }

  it('puts files under the blob root with a namespaced storage key and extension', async () => {
    const { silverhandDir, storage } = makeStorage();
    const ref = await storage.put({
      namespace: 'attachments',
      id: 'att-1',
      filename: 'screenshot.PNG',
      contentType: 'image/png',
      buffer: Buffer.from('png-bytes'),
    });

    expect(ref).toEqual({
      storage: 'local',
      storageKey: 'attachments/att-1.png',
    });
    const located = await storage.locate(ref);
    expect(located?.localPath).toBe(join(
      silverhandDir,
      'blobs',
      'attachments',
      'att-1.png',
    ));
    expect(readFileSync(located!.localPath, 'utf8')).toBe('png-bytes');
  });

  it('serves bytes with attachment metadata headers', async () => {
    const { storage } = makeStorage();
    const ref = await storage.put({
      namespace: 'attachments',
      id: 'doc',
      filename: 'report',
      contentType: 'application/pdf',
      buffer: Buffer.from('%PDF'),
    });

    expect(ref.storageKey).toBe('attachments/doc.pdf');
    const response = await storage.serve(ref, {
      filename: 'report.pdf',
      contentType: 'application/pdf; charset=utf-8',
    });

    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-length')).toBe('4');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-disposition')).toContain('report.pdf');
    expect(Buffer.from(await response.arrayBuffer()).toString('utf8')).toBe('%PDF');
  });

  it('deletes local files and locate returns null after deletion', async () => {
    const { storage } = makeStorage();
    const ref = await storage.put({
      namespace: 'avatars',
      id: 'agent-a',
      filename: 'avatar.webp',
      contentType: 'image/webp',
      buffer: Buffer.from('avatar'),
    });
    const located = await storage.locate(ref);
    expect(located).not.toBeNull();

    await storage.delete(ref);

    expect(existsSync(located!.localPath)).toBe(false);
    expect(await storage.locate(ref)).toBeNull();
  });

  it('rejects refs for another storage kind and unsafe storage keys', async () => {
    const { storage } = makeStorage();

    await expect(storage.locate({
      storage: 's3',
      storageKey: 'attachments/a.png',
    })).rejects.toMatchObject({ code: 'storage_kind_mismatch' });

    await expect(storage.locate({
      storage: 'local',
      storageKey: '../outside.png',
    })).rejects.toMatchObject({ code: 'invalid_storage_key' });
  });

  it('rejects unsafe namespaces before writing', async () => {
    const { storage } = makeStorage();

    await expect(storage.put({
      namespace: '../attachments',
      id: 'a',
      filename: 'x.png',
      contentType: 'image/png',
      buffer: Buffer.from('x'),
    })).rejects.toBeInstanceOf(BlobFileStorageError);
  });
});
