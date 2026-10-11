import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateInputs({ version, event, ref, remoteUrl }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Desktop version must be X.Y.Z');
  if (event !== 'push' && event !== 'workflow_dispatch') throw new Error('Unsupported event');
  if (event === 'push' && ref !== `refs/tags/desktop-v${version}`) {
    throw new Error('Desktop tag must exactly match apps/desktop/package.json version');
  }
  const url = new URL(remoteUrl);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    ['localhost', '[::1]'].includes(url.hostname) ||
    url.hostname.startsWith('127.')
  )
    throw new Error('SILVERHAND_REMOTE_SERVER_URL must be a non-loopback HTTPS origin');
}

export async function collectDmg(root, variant, version) {
  if (!['embedded', 'remote-only'].includes(variant)) throw new Error('Unknown build variant');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid version');
  const source = resolve(root, 'apps/desktop', `release-ci-${variant}`);
  const files = (await readdir(source)).filter((name) => name.endsWith('.dmg'));
  if (files.length !== 1)
    throw new Error(`Expected exactly one ${variant} DMG, got ${files.length}`);
  const input = resolve(source, files[0]);
  const info = await stat(input);
  if (!info.isFile() || info.size === 0) throw new Error('Empty or invalid DMG');
  const output = resolve(root, '.cache/desktop-dmg', variant);
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error('Artifact output must be empty');
  const name = `Silverhand-${version}-${variant}-arm64.dmg`;
  await copyFile(input, resolve(output, name));
  const digest = createHash('sha256')
    .update(await readFile(resolve(output, name)))
    .digest('hex');
  await writeFile(resolve(output, `${name}.sha256`), `${digest}  ${name}\n`);
  await collectUpdateFeed(source, output, variant, version);
  return output;
}

/** Copies the electron-updater feed unchanged: its manifest names the zip by its built filename. */
export async function collectUpdateFeed(source, output, variant, version) {
  const feed = `${variant}-mac.yml`;
  const manifest = await readFile(resolve(source, feed), 'utf8').catch(() => {
    throw new Error(`Missing ${feed}; signed builds must publish an update feed`);
  });
  if (!new RegExp(`^version: ${version.replaceAll('.', '\\.')}$`, 'm').test(manifest))
    throw new Error(`${feed} does not describe version ${version}`);
  const zip = /^path: (\S+\.zip)$/m.exec(manifest)?.[1];
  if (!zip || zip.includes('/')) throw new Error(`${feed} must reference one local zip`);
  for (const name of [feed, zip, `${zip}.blockmap`]) {
    await copyFile(resolve(source, name), resolve(output, name));
  }
}

async function main() {
  const root = process.cwd();
  const { version } = JSON.parse(
    await readFile(resolve(root, 'apps/desktop/package.json'), 'utf8'),
  );
  if (process.argv[2] === 'preflight') {
    if (process.platform !== 'darwin' || process.arch !== 'arm64')
      throw new Error('Requires macOS arm64');
    validateInputs({
      version,
      event: process.env.GITHUB_EVENT_NAME,
      ref: process.env.GITHUB_REF,
      remoteUrl: process.env.REMOTE_SERVER_URL,
    });
    console.log(`Validated Desktop ${version}`);
  } else if (process.argv[2] === 'collect') {
    console.log(await collectDmg(root, process.argv[3], version));
  } else throw new Error('Usage: desktop-dmg.mjs preflight | collect <embedded|remote-only>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
