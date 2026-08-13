/**
 * Gate 1 — better-sqlite3 import ratchet.
 *
 * The runtime driver import is locked to the single adapter file; every other
 * production import (type or value, any binding form) must appear in the
 * named ledger. New debt entries are refused by review contract: the ledger
 * header declares shrink-only for the debt zone.
 */
import { describe, expect, it } from 'vitest';
import { scanBetterSqliteImports, type ImportKind } from './scan.js';
import { BETTER_SQLITE3_IMPORT_INVENTORY } from './inventory.js';
import { zoneSurfaceViolations } from './zones.js';
import { allProductionSources, asInventoryLines } from './sources.js';

const ADAPTER_VALUE_IMPORT_FILES = new Set(['packages/backend/src/db.ts']);

describe('db-boundary: better-sqlite3 import ratchet', () => {
  const findings = allProductionSources().flatMap(scanBetterSqliteImports);

  it('the runtime (value) driver import stays locked to the adapter file', () => {
    const valueImports = findings.filter(f => f.kind === 'value');
    const offenders = valueImports.filter(f => !ADAPTER_VALUE_IMPORT_FILES.has(f.file));
    expect(
      offenders.map(o => `${o.file}: ${o.form}`),
      'a new RUNTIME better-sqlite3 import outside the adapter breaks the single-driver boundary',
    ).toEqual([]);
    expect(valueImports.length).toBeGreaterThan(0);
  });

  it('every production file naming better-sqlite3 matches the named ledger exactly', () => {
    const actualByFile = new Map<string, Set<ImportKind>>();
    for (const f of findings) {
      const kinds = actualByFile.get(f.file) ?? new Set<ImportKind>();
      kinds.add(f.kind);
      actualByFile.set(f.file, kinds);
    }
    const actual = [...actualByFile.entries()]
      .map(([file, kinds]) => ({ file, kinds: [...kinds].sort() }))
      .sort((a, b) => (a.file < b.file ? -1 : 1));
    const expected = BETTER_SQLITE3_IMPORT_INVENTORY.map(e => ({
      file: e.file,
      kinds: [...e.kinds].sort(),
    })).sort((a, b) => (a.file < b.file ? -1 : 1));
    expect(
      actual,
      'better-sqlite3 import set drifted from the ledger. If you removed one: delete its ledger row (celebrated). ' +
        'If you added one: importing better-sqlite3 outside adapter/repository zones is refused — inject the DB ' +
        'handle or extend a repository instead. Current tree state:\n' +
        asInventoryLines(actual),
    ).toEqual(expected);
  });

  it('every ledger row is on the owner surface its zone names (#task:1983 W8)', () => {
    // The half the exact match cannot do. Above, a NEW business file that names
    // the driver type passes the moment someone adds a row for it — and the
    // `adapter | repository` arms take no reason, so the row is a one-word
    // claim. Here the claim is checked: `repository` means `src/repos/` or
    // `src/read-model/`, not "a file that says so".
    expect(
      zoneSurfaceViolations(BETTER_SQLITE3_IMPORT_INVENTORY, 'driver-import'),
      'a ledger row claims a zone it is not on. Naming the driver type is a persistence privilege; a business ' +
        'file gets the capability by asking a repository or a port for it, not by classifying itself',
    ).toEqual([]);
  });

  it('every singleton-zone entry states what it owns the handle for', () => {
    // `adapter` / `repository` are self-explaining by zone; `composition` and
    // `lifecycle` are single-file roles, so each must say WHICH role it holds and
    // what deleting the row would mean. (The `debt` zone this used to police is
    // gone — see the type.)
    const missing = BETTER_SQLITE3_IMPORT_INVENTORY.filter(
      e => (e.zone === 'composition' || e.zone === 'lifecycle') && !e.reason.trim(),
    );
    expect(missing.map(e => e.file)).toEqual([]);
  });

  it('the composition zone holds exactly one file (#task:1983 W1)', () => {
    // What this proves, exactly: among files that IMPORT the driver, only one
    // is a composition site. That is worth pinning — a second driver-importing
    // composition would be two authorities over the same handle — but it is a
    // claim about IMPORTS, and the inventory is an import inventory. Receiving a
    // handle as a parameter is invisible here: boot named the driver type only
    // from W5 onward (for the test seam), and it never appeared at all while it
    // was taking `openDatabase()`'s inferred return type. So this gate on its
    // own cannot say "only one file spends the handle".
    //
    // The complement lives in `port-contract.test.ts`: boot is fenced from
    // `repos/*` and `adapters/*`, and off the concrete-import allowlist. The two
    // together are what make the singleton claim real. Neither is a directory
    // waiver — the file is named here, so moving the spend is a reviewed diff.
    expect(
      BETTER_SQLITE3_IMPORT_INVENTORY.filter(e => e.zone === 'composition').map(
        e => e.file,
      ),
      'the persistence composition root is a singleton: fold the new wiring into it, ' +
        'or argue in review why a second handle-spending file is not two authorities',
    ).toEqual(['packages/backend/src/persistence/root.ts']);
  });

  it('the lifecycle zone holds exactly one file (#task:1983 W5)', () => {
    // One process, one handle lifetime. A second lifecycle file would mean a
    // second open/close authority over the same database file — the failure mode
    // the app has already been bitten by (a stray connection into a live WAL).
    // Same import-based caveat as the composition gate above: this pins who may
    // NAME the driver for lifetime purposes, and `port-contract.test.ts` is what
    // keeps that file from also composing persistence out of the handle it owns.
    expect(
      BETTER_SQLITE3_IMPORT_INVENTORY.filter(e => e.zone === 'lifecycle').map(
        e => e.file,
      ),
      'the handle lifetime is boot-owned and singular: open/migrate/close belongs to ' +
        'src/index.ts, and a test that needs the running server SQL takes it through ' +
        'testHooks.onDatabaseOpened rather than opening its own connection',
    ).toEqual(['packages/backend/src/index.ts']);
  });

  it('fence self-test: every binding form is detected (and unrelated imports are not)', () => {
    const probes: Array<[string, ImportKind]> = [
      ["import Database from 'better-sqlite3';", 'value'],
      ["import * as sqlite from 'better-sqlite3';", 'value'],
      ["import { Database as Raw } from 'better-sqlite3';", 'value'],
      ["import type Database from 'better-sqlite3';", 'type'],
      ["import type { Database as Db } from 'better-sqlite3';", 'type'],
      ["import { type Database } from 'better-sqlite3';", 'type'],
      ["const D = require('better-sqlite3');", 'value'],
      ["const D = await import('better-sqlite3');", 'value'],
      ["let db: import('better-sqlite3').Database;", 'type'],
    ];
    for (const [src, kind] of probes) {
      const got = scanBetterSqliteImports({ path: 'probe.ts', src });
      const first = got[0];
      expect(first, `not detected: ${src}`).toBeDefined();
      expect(first?.kind, `wrong kind for: ${src}`).toBe(kind);
    }
    expect(
      scanBetterSqliteImports({ path: 'probe.ts', src: "import Database from 'not-sqlite';" }),
    ).toEqual([]);
  });
});
