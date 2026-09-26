import { describe, expect, it } from 'vitest';

import { ClaudeDriver } from '../src/drivers/claude.js';
import { CodexDriver } from '../src/drivers/codex.js';
import { CursorDriver } from '../src/drivers/cursor.js';
import type { Driver } from '../src/drivers/index.js';
import {
  DRIVER_PARSE_ORACLES,
  type DriverParseOracle,
} from './_fixtures/driver-oracles.js';

function makeDriver(oracle: DriverParseOracle): Driver {
  switch (oracle.runtime) {
    case 'claude':
      return new ClaudeDriver();
    case 'codex':
      return new CodexDriver();
    case 'cursor':
      return new CursorDriver();
  }
}

describe('daemon oracle regression matrix — driver parser fixtures', () => {
  for (const oracle of DRIVER_PARSE_ORACLES) {
    it(`${oracle.id}: ${oracle.description}`, () => {
      const driver = makeDriver(oracle);
      for (const [index, step] of oracle.steps.entries()) {
        const actual = driver.parseLine(step.line);
        expect(actual, `${oracle.id} step ${index + 1}`).toEqual(step.expected);
        for (const forbidden of step.forbiddenSubstrings ?? []) {
          expect(JSON.stringify(actual)).not.toContain(forbidden);
        }
      }
    });
  }

  it('keeps every oracle tied to a concrete incident / state-machine risk', () => {
    for (const oracle of DRIVER_PARSE_ORACLES) {
      expect(oracle.incident.trim(), `${oracle.id} incident`).not.toBe('');
      expect(oracle.steps.length, `${oracle.id} steps`).toBeGreaterThan(0);
    }
  });

  it('oracle ids are unique', () => {
    const ids = DRIVER_PARSE_ORACLES.map(oracle => oracle.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

});
