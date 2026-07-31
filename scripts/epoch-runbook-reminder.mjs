#!/usr/bin/env node
// #task:1761 — desktop↔server API epoch release reminder, shared by every
// build entry point (scripts/package.sh for the desktop artifact, the
// standalone server bundle build in packages/server/package.json).
//
// Fail-loud contract: if the runbook file is missing (renamed/deleted), the
// BUILD FAILS — a dangling doc reference would otherwise silently kill the
// reminder exactly when it matters (audit #8 lesson). Correctness is still
// owned by the admission gates and tests, never by this message.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNBOOK = 'docs/desktop-server-api-epoch.md';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

if (!existsSync(join(repoRoot, RUNBOOK))) {
  console.error(
    `[epoch] ERROR: runbook missing at ${RUNBOOK} — update scripts/epoch-runbook-reminder.mjs if it moved`,
  );
  process.exit(1);
}
console.log(
  `[epoch] REMINDER: breaking desktop<->server DTO/behavior changes require an epoch bump — see ${RUNBOOK}`,
);
