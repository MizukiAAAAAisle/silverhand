import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rustRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cargo = spawnSync('cargo', ['metadata', '--locked', '--format-version', '1'], {
  cwd: rustRoot,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
if (cargo.error) {
  throw cargo.error;
}
if (cargo.status !== 0) {
  process.stderr.write(cargo.stderr);
  process.exit(cargo.status ?? 1);
}

const metadata = JSON.parse(cargo.stdout);
const names = [
  'silverhand-backend-app',
  'silverhand-backend-core',
  'silverhand-backend-filesystem',
  'silverhand-backend-observability',
  'silverhand-backend-server',
  'silverhand-backend-sqlite',
];
const packages = new Map(metadata.packages.map((entry) => [entry.name, entry]));
const workspaceNames = metadata.workspace_members
  .map((id) => metadata.packages.find((entry) => entry.id === id)?.name)
  .sort();

assertEqual(workspaceNames, names, 'workspace members');
assertInternalDependencies('silverhand-backend-app', null, [
  'silverhand-backend-core',
  'silverhand-backend-filesystem',
  'silverhand-backend-observability',
  'silverhand-backend-server',
  'silverhand-backend-sqlite',
]);
assertInternalDependencies('silverhand-backend-core', null, []);
assertInternalDependencies('silverhand-backend-filesystem', null, ['silverhand-backend-core']);
assertInternalDependencies('silverhand-backend-observability', null, []);
assertInternalDependencies('silverhand-backend-server', null, [
  'silverhand-backend-core',
  'silverhand-backend-filesystem',
  'silverhand-backend-observability',
]);
assertInternalDependencies('silverhand-backend-server', 'dev', ['silverhand-backend-sqlite']);
assertInternalDependencies('silverhand-backend-sqlite', null, [
  'silverhand-backend-core',
  'silverhand-backend-observability',
]);
assertNormalDependenciesExclude('silverhand-backend-server', [
  'sqlx',
  'thiserror',
  'tracing-subscriber',
]);
assertNormalDependenciesExclude('silverhand-backend-sqlite', [
  'silverhand-backend-server',
  'ts-rs',
]);

const core = packages.get('silverhand-backend-core');
for (const forbidden of ['axum', 'sqlx', 'tower-http', 'ts-rs']) {
  if (core.dependencies.some((dependency) => dependency.name === forbidden)) {
    throw new Error(`backend-core must not depend on ${forbidden}`);
  }
}
assertNormalDependencyClosureExcludes('silverhand-backend-core', [
  'axum',
  'libsqlite3-sys',
  'sqlx',
  'ts-rs',
]);
assertNormalDependencyClosureExcludes('silverhand-backend-server', [
  'silverhand-backend-app',
  'libsqlite3-sys',
  'sqlx',
]);
assertNormalDependencyClosureExcludes('silverhand-backend-core', ['silverhand-backend-app']);
assertNormalDependencyClosureExcludes('silverhand-backend-sqlite', ['silverhand-backend-app']);
for (const adapter of ['silverhand-backend-filesystem', 'silverhand-backend-observability']) {
  assertNormalDependencyClosureExcludes(adapter, [
    'silverhand-backend-app',
    'silverhand-backend-server',
    'silverhand-backend-sqlite',
    'axum',
    'libsqlite3-sys',
    'sqlx',
  ]);
}

process.stdout.write('Rust scaffold dependency direction verified\n');

function assertInternalDependencies(packageName, kind, expected) {
  const entry = packages.get(packageName);
  if (!entry) {
    throw new Error(`missing workspace package: ${packageName}`);
  }
  const actual = entry.dependencies
    .filter((dependency) => dependency.kind === kind)
    .map((dependency) => dependency.name)
    .filter((name) => names.includes(name))
    .sort();
  const kindLabel = kind ?? 'normal';
  assertEqual(actual, expected, `${packageName} ${kindLabel} internal dependencies`);
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertNormalDependenciesExclude(packageName, forbiddenNames) {
  const entry = packages.get(packageName);
  const normalNames = entry.dependencies
    .filter((dependency) => dependency.kind === null)
    .map((dependency) => dependency.name);
  for (const forbidden of forbiddenNames) {
    if (normalNames.includes(forbidden)) {
      throw new Error(`${packageName} normal dependencies contain ${forbidden}`);
    }
  }
}

function assertNormalDependencyClosureExcludes(packageName, forbiddenNames) {
  const root = packages.get(packageName);
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const namesById = new Map(metadata.packages.map((entry) => [entry.id, entry.name]));
  const pending = [root.id];
  const visited = new Set();
  while (pending.length > 0) {
    const id = pending.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    const name = namesById.get(id);
    if (forbiddenNames.includes(name)) {
      throw new Error(`${packageName} dependency closure contains ${name}`);
    }
    for (const dependency of nodes.get(id)?.deps ?? []) {
      if (dependency.dep_kinds.some((entry) => entry.kind === null)) {
        pending.push(dependency.pkg);
      }
    }
  }
}
