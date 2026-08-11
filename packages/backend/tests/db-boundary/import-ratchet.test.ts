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

  it('every debt-zone import entry states its deletion direction', () => {
    const empty = BETTER_SQLITE3_IMPORT_INVENTORY.filter(
      e => e.zone === 'debt' && !e.reason.trim(),
    );
    expect(empty.map(e => e.file)).toEqual([]);
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
