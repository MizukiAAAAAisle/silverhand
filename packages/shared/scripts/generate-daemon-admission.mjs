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
  if (!hostWebSocketPath.startsWith('/')) {
    fail('hostWebSocketPath must be absolute');
  }
  return `// Generated from daemon-admission.json. Do not edit by hand.\nexport const DAEMON_ADMISSION = {\n  hostProtocolVersion: ${hostProtocolVersion},\n  outboundProtocolVersion: ${outboundProtocolVersion},\n  hostWebSocketPath: ${JSON.stringify(hostWebSocketPath)},\n  updateRequiredCloseReason: ${JSON.stringify(updateRequiredCloseReason)},\n} as const;\n`;
}

const expected = render(JSON.parse(readFileSync(source, 'utf8')));
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== expected) {
    fail('generated TypeScript artifact has drifted');
  }
} else {
  writeFileSync(output, expected);
}
