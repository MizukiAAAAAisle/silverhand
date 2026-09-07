import { join } from 'node:path';

export type RendererEntry =
  | { kind: 'dev-server'; url: string }
  | { kind: 'packaged-file'; filePath: string };

export function resolveRendererEntry(input: {
  /** `process.env['ELECTRON_RENDERER_URL']` — present only under dev. */
  devServerUrl: string | undefined;
  /** The main bundle's `__dirname`; the renderer sits next to it. */
  mainDirname: string;
}): RendererEntry {
  const dev = input.devServerUrl?.trim();
  if (dev) {
    // The dev arm's whole contract is "same origin as the dev server", so the
    // URL must have a real (non-opaque) origin. `data:` and custom schemes
    // produce origin `null`, which would make every other null-origin page
    // compare equal — fail loud at resolve time instead.
    let parsed: URL;
    try {
      parsed = new URL(dev);
    } catch {
      throw new Error(`renderer dev-server URL is not a valid URL: ${dev}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(
        `renderer dev-server URL must be http(s), got ${parsed.protocol}`,
      );
    }
    return { kind: 'dev-server', url: dev };
  }
  return {
    kind: 'packaged-file',
    filePath: join(input.mainDirname, '../renderer/index.html'),
  };
}
