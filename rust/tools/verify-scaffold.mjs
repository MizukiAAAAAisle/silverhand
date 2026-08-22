import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rustRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cargo = spawnSync(
  'cargo',
  ['metadata', '--locked', '--format-version', '1'],
  { cwd: rustRoot, encoding: 'utf8' },
);
if (cargo.status !== 0) {
  process.stderr.write(cargo.stderr);
  process.exit(cargo.status ?? 1);
}

const metadata = JSON.parse(cargo.stdout);
const names = [
  'silverhand-backend-core',
  'silverhand-backend-server',
  'silverhand-backend-sqlite',
];
const packages = new Map(metadata.packages.map((entry) => [entry.name, entry]));
const workspaceNames = metadata.workspace_members
  .map((id) => metadata.packages.find((entry) => entry.id === id)?.name)
  .sort();

assertEqual(workspaceNames, names, 'workspace members');
assertInternalDependencies('silverhand-backend-core', []);
assertInternalDependencies('silverhand-backend-server', [
  'silverhand-backend-core',
]);
assertInternalDependencies('silverhand-backend-sqlite', [
  'silverhand-backend-core',
]);

const core = packages.get('silverhand-backend-core');
for (const forbidden of ['axum', 'sqlx', 'tower-http', 'ts-rs']) {
  if (core.dependencies.some((dependency) => dependency.name === forbidden)) {
    throw new Error(`backend-core must not depend on ${forbidden}`);
  }
}

process.stdout.write('Rust scaffold dependency direction verified\n');

function assertInternalDependencies(packageName, expected) {
  const entry = packages.get(packageName);
  if (!entry) {
    throw new Error(`missing workspace package: ${packageName}`);
  }
  const actual = entry.dependencies
    .map((dependency) => dependency.name)
    .filter((name) => names.includes(name))
    .sort();
  assertEqual(actual, expected, `${packageName} internal dependencies`);
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
