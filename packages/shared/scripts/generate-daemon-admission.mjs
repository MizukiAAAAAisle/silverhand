import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(
  new URL('../src/daemon-admission.json', import.meta.url),
);
const output = fileURLToPath(
  new URL('../src/daemon-admission.generated.ts', import.meta.url),
);

function fail(message) {
  throw new Error(`invalid daemon admission contract: ${message}`);
}

function positiveInteger(record, field) {
  const value = record[field];
  if (!Number.isInteger(value) || value <= 0) fail(`${field} must be positive`);
  return value;
}

function nonEmptyString(record, field) {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${field} must be non-empty`);
  }
  return value;
}

function eventKinds(record) {
  const value = record.daemonEventKinds;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('daemonEventKinds must be an object');
  }
  const entries = Object.entries(value);
  if (entries.length !== 18) fail('daemonEventKinds must contain 18 arms');
  const seen = new Set();
  for (const [field, kind] of entries) {
    if (field.length === 0 || typeof kind !== 'string' || kind.length === 0) {
      fail('daemonEventKinds keys and values must be non-empty strings');
    }
    if (seen.has(kind)) fail(`duplicate daemon event kind: ${kind}`);
    seen.add(kind);
  }
  return Object.fromEntries(entries);
}

function render(record) {
  const hostProtocolVersion = positiveInteger(record, 'hostProtocolVersion');
  const outboundProtocolVersion = positiveInteger(
    record,
    'outboundProtocolVersion',
  );
  const hostWebSocketPath = nonEmptyString(record, 'hostWebSocketPath');
  const updateRequiredCloseReason = nonEmptyString(
    record,
    'updateRequiredCloseReason',
  );
  const daemonEventKinds = eventKinds(record);
  if (!hostWebSocketPath.startsWith('/')) {
    fail('hostWebSocketPath must be absolute');
  }
  return `// Generated from daemon-admission.json. Do not edit by hand.\nexport const DAEMON_ADMISSION = {\n  hostProtocolVersion: ${hostProtocolVersion},\n  outboundProtocolVersion: ${outboundProtocolVersion},\n  hostWebSocketPath: ${JSON.stringify(hostWebSocketPath)},\n  updateRequiredCloseReason: ${JSON.stringify(updateRequiredCloseReason)},\n  daemonEventKinds: ${JSON.stringify(daemonEventKinds, null, 2).replaceAll('\n', '\n  ')},\n} as const;\n`;
}

const expected = render(JSON.parse(readFileSync(source, 'utf8')));
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== expected) {
    fail('generated TypeScript artifact has drifted');
  }
} else {
  writeFileSync(output, expected);
}
