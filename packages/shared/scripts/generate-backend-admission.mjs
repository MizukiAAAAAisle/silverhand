import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(
  new URL('../src/backend-admission.json', import.meta.url),
);
const output = fileURLToPath(
  new URL('../src/backend-admission.generated.ts', import.meta.url),
);

function fail(message) {
  throw new Error(`invalid backend admission contract: ${message}`);
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
  const desktopApi = positiveInteger(record, 'desktopApi');
  const desktopMinClient = positiveInteger(record, 'desktopMinClient');
  const desktopMinServer = positiveInteger(record, 'desktopMinServer');
  const eventWebSocketPath = nonEmptyString(record, 'eventWebSocketPath');
  const eventWebSocketSessionCookie = nonEmptyString(
    record,
    'eventWebSocketSessionCookie',
  );
  const desktopApiEpochHeader = nonEmptyString(
    record,
    'desktopApiEpochHeader',
  );
  if (!eventWebSocketPath.startsWith('/')) {
    fail('eventWebSocketPath must be absolute');
  }
  return `// Generated from backend-admission.json. Do not edit by hand.\nexport const BACKEND_ADMISSION = {\n  desktopApi: ${desktopApi},\n  desktopMinClient: ${desktopMinClient},\n  desktopMinServer: ${desktopMinServer},\n  eventWebSocketPath: ${JSON.stringify(eventWebSocketPath)},\n  eventWebSocketSessionCookie: ${JSON.stringify(eventWebSocketSessionCookie)},\n  desktopApiEpochHeader: ${JSON.stringify(desktopApiEpochHeader)},\n} as const;\n`;
}

const expected = render(JSON.parse(readFileSync(source, 'utf8')));
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== expected) {
    fail('generated TypeScript artifact has drifted');
  }
} else {
  writeFileSync(output, expected);
}
