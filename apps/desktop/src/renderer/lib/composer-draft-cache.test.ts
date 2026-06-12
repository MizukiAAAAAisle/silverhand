import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentDto } from '@silverhand/shared';

vi.mock('./api', () => ({
  apiUpload: vi.fn(),
  deleteAttachmentBestEffort: vi.fn().mockResolvedValue(true),
}));

vi.mock('./attachment-blob-cache', () => ({
  releaseAttachmentPreview: vi.fn(),
  setAttachmentBlobUrl: vi.fn(),
}));

import { apiUpload, deleteAttachmentBestEffort } from './api';
import {
  releaseAttachmentPreview,
  setAttachmentBlobUrl,
} from './attachment-blob-cache';
import {
  __resetComposerDraftCacheForTests,
  cleanupAllComposerDrafts,
  clearComposerDraft,
  dropSentAttachmentsFromDraft,
  hasComposerDraftInFlightUpload,
  MAX_DRAFTS,
  readComposerDraft,
  startComposerDraftAttachmentUpload,
  writeComposerDraft,
} from './composer-draft-cache';

const revokeObjectURL = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(),
    revokeObjectURL,
  });
});

afterEach(() => {
  __resetComposerDraftCacheForTests();
  vi.unstubAllGlobals();
});

describe('composer draft cache', () => {
  it('stores and restores text, caret, and pending attachments', () => {
    const file = testFile('x', 'x.png', 'image/png');
    writeComposerDraft({
      conversationId: 'c1',
      text: 'hello',
      caret: 3,
      pending: [
        {
          key: 'a1',
          filename: 'x.png',
          size: 1,
          contentType: 'image/png',
          state: 'uploading',
          file,
          previewUrl: 'blob:x',
        },
      ],
      updatedAt: 1,
    });

    const restored = readComposerDraft('c1');

    expect(restored?.text).toBe('hello');
    expect(restored?.caret).toBe(3);
    expect(restored?.pending[0]?.file).toBe(file);
    expect(restored?.pending[0]?.previewUrl).toBe('blob:x');
  });

  it('does not store empty snapshots', () => {
    writeComposerDraft({
      conversationId: 'empty',
      text: '   ',
      caret: 0,
      pending: [],
      updatedAt: 1,
    });

    expect(readComposerDraft('empty')).toBeNull();
  });

  it('evicts oldest entries over MAX_DRAFTS and cleans orphan attachments', () => {
    writeComposerDraft({
      conversationId: 'oldest',
      text: 'old',
      caret: 0,
      pending: [
        {
          key: 'old-att',
          filename: 'old.png',
          size: 1,
          contentType: 'image/png',
          state: 'done',
          previewUrl: 'blob:old',
          attachment: attachment('old-att-id'),
        },
      ],
      updatedAt: 0,
    });
    for (let i = 0; i < MAX_DRAFTS; i += 1) {
      writeComposerDraft({
        conversationId: `c${i}`,
        text: `draft ${i}`,
        caret: 0,
        pending: [],
        updatedAt: i,
      });
    }

    expect(readComposerDraft('oldest')).toBeNull();
    expect(releaseAttachmentPreview).toHaveBeenCalledWith('old-att-id');
    expect(deleteAttachmentBestEffort).toHaveBeenCalledWith('old-att-id');
  });

  it('upload success patches cache and transfers preview ownership', async () => {
    vi.mocked(apiUpload).mockResolvedValueOnce(attachment('att-1'));
    const file = testFile('image', 'image.png', 'image/png');

    await startComposerDraftAttachmentUpload({
      conversationId: 'c1',
      attachmentKey: 'a1',
      file,
      previewUrl: 'blob:image',
    });

    const item = readComposerDraft('c1')?.pending[0];
    expect(item?.state).toBe('done');
    expect(item?.attachment?.id).toBe('att-1');
    expect(setAttachmentBlobUrl).toHaveBeenCalledWith('att-1', 'blob:image');
  });

  it('upload error preserves file and preview for retry', async () => {
    vi.mocked(apiUpload).mockRejectedValueOnce(new Error('network down'));
    const file = testFile('image', 'image.png', 'image/png');

    await startComposerDraftAttachmentUpload({
      conversationId: 'c1',
      attachmentKey: 'a1',
      file,
      previewUrl: 'blob:image',
    });

    const item = readComposerDraft('c1')?.pending[0];
    expect(item?.state).toBe('error');
    expect(item?.file).toBe(file);
    expect(item?.previewUrl).toBe('blob:image');
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('clear skips sent attachment ids but cleans unsent ids', () => {
    writeComposerDraft({
      conversationId: 'c1',
      text: 'send',
      caret: 0,
      pending: [
        donePending('sent-key', 'sent-id'),
        donePending('orphan-key', 'orphan-id'),
      ],
      updatedAt: 1,
    });

    clearComposerDraft('c1', { sentAttachmentIds: ['sent-id'] });

    expect(readComposerDraft('c1')).toBeNull();
    expect(releaseAttachmentPreview).not.toHaveBeenCalledWith('sent-id');
    expect(deleteAttachmentBestEffort).not.toHaveBeenCalledWith('sent-id');
    expect(releaseAttachmentPreview).toHaveBeenCalledWith('orphan-id');
    expect(deleteAttachmentBestEffort).toHaveBeenCalledWith('orphan-id');
  });

  it('preserves sent attachment ids when a submit snapshot is flushed on unmount', () => {
    const pending = [donePending('sent-key', 'sent-id')];
    writeComposerDraft({
      conversationId: 'c1',
      text: 'send',
      caret: 4,
      pending,
      updatedAt: 1,
    });

    writeComposerDraft({
      conversationId: 'c1',
      text: 'send',
      caret: 4,
      pending,
      updatedAt: 2,
    });

    expect(readComposerDraft('c1')?.pending[0]?.attachment?.id).toBe('sent-id');
    expect(releaseAttachmentPreview).not.toHaveBeenCalledWith('sent-id');
    expect(deleteAttachmentBestEffort).not.toHaveBeenCalledWith('sent-id');
  });

  it('drops submitted rows without cleaning later user attachments', async () => {
    let resolveUpload!: (value: AttachmentDto) => void;
    vi.mocked(apiUpload).mockReturnValueOnce(
      new Promise(resolve => {
        resolveUpload = resolve;
      }),
    );
    const file = testFile('new', 'new.png', 'image/png');
    writeComposerDraft({
      conversationId: 'c1',
      text: 'submitted',
      caret: 9,
      pending: [donePending('sent-key', 'sent-id')],
      updatedAt: 1,
    });
    const upload = startComposerDraftAttachmentUpload({
      conversationId: 'c1',
      attachmentKey: 'new-key',
      file,
      previewUrl: 'blob:new',
    });

    dropSentAttachmentsFromDraft('c1', ['sent-key']);

    const pending = readComposerDraft('c1')?.pending;
    expect(pending).toHaveLength(1);
    expect(pending?.[0]?.key).toBe('new-key');
    expect(hasComposerDraftInFlightUpload('c1', 'new-key')).toBe(true);
    expect(releaseAttachmentPreview).not.toHaveBeenCalledWith('sent-id');
    expect(deleteAttachmentBestEffort).not.toHaveBeenCalledWith('sent-id');
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:new');

    resolveUpload(attachment('new-id'));
    await upload;

    expect(readComposerDraft('c1')?.pending[0]?.attachment?.id).toBe('new-id');
    expect(deleteAttachmentBestEffort).not.toHaveBeenCalledWith('new-id');
  });

  it('abandoned upload deletes the late server attachment', async () => {
    let resolveUpload!: (value: AttachmentDto) => void;
    vi.mocked(apiUpload).mockReturnValueOnce(
      new Promise(resolve => {
        resolveUpload = resolve;
      }),
    );
    const file = testFile('image', 'image.png', 'image/png');
    const promise = startComposerDraftAttachmentUpload({
      conversationId: 'c1',
      attachmentKey: 'a1',
      file,
      previewUrl: 'blob:image',
    });

    expect(hasComposerDraftInFlightUpload('c1', 'a1')).toBe(true);
    cleanupAllComposerDrafts();
    resolveUpload(attachment('late-id'));
    await promise;

    expect(deleteAttachmentBestEffort).toHaveBeenCalledWith('late-id');
    expect(readComposerDraft('c1')).toBeNull();
  });
});

function attachment(id: string): AttachmentDto {
  return {
    id,
    filename: `${id}.png`,
    size: 1,
    content_type: 'image/png',
    created_at: 1,
    channel_id: 'c1',
    source_conversation_id: 'c1',
    storage: 'local',
    created_by_kind: 'user',
    created_by_id: 'local',
  };
}

function donePending(key: string, id: string) {
  return {
    key,
    filename: `${id}.png`,
    size: 1,
    contentType: 'image/png',
    state: 'done' as const,
    previewUrl: `blob:${id}`,
    attachment: attachment(id),
  };
}

function testFile(contents: string, name: string, type: string): File {
  const blob = new Blob([contents], { type }) as File;
  Object.defineProperty(blob, 'name', { value: name });
  Object.defineProperty(blob, 'lastModified', { value: 1 });
  return blob;
}
