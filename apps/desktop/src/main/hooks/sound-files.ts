import { open, mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { NotificationSoundFile } from '@silverhand/client';

const TYPES: Record<string, string> = {
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
};
const MAX_BYTES = 8 * 1024 * 1024;
async function readAudio(path: string): Promise<Buffer> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size === 0 || info.size > MAX_BYTES)
      throw new Error('Choose an audio file smaller than 8 MB.');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) throw new Error('Choose an audio file smaller than 8 MB.');
    return bytes.subarray(0, size);
  } finally {
    await file.close();
  }
}
export async function importSoundFile(
  directory: string,
  path: string,
): Promise<NotificationSoundFile> {
  const extension = extname(path).toLowerCase();
  if (!TYPES[extension]) throw new Error('Choose an MP3, WAV, OGG, M4A, AAC or FLAC file.');
  const bytes = await readAudio(path);
  const id = createHash('sha256').update(bytes).digest('hex') + extension;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(join(directory, id), bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return { id, name: basename(path) };
}
export async function readSoundFile(
  directory: string,
  sound: NotificationSoundFile,
): Promise<string> {
  if (
    !sound ||
    typeof sound.id !== 'string' ||
    !/^[a-f0-9]{64}\.(ogg|mp3|wav|m4a|aac|flac)$/.test(sound.id) ||
    typeof sound.name !== 'string' ||
    !sound.name ||
    sound.name.length > 255
  )
    throw new Error('Invalid notification sound. Choose the file again.');
  const bytes = await readAudio(join(directory, sound.id));
  return `data:${TYPES[extname(sound.id)]};base64,${bytes.toString('base64')}`;
}
