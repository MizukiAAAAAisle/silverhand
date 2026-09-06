import { describe, expect, it } from 'vitest';
import { getDriver } from '@silverhand/host/drivers';
import { sanitizeParsedEventForBroadcast } from '../src/runtime/event-sanitize.js';

describe('Pi input reaches the common activity sanitizer structurally intact', () => {
  for (const shape of ['object', 'array'] as const) {
    it(`preserves large ${shape} semantics and the common truncation markers`, () => {
      const value = 'x'.repeat(1000);
      const input = shape === 'object'
        ? Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`key${i}`, value]))
        : Array.from({ length: 60 }, () => ({ value }));
      expect(JSON.stringify(input).length).toBeGreaterThan(16384);
      const driver = getDriver('pi');
      const event = driver.parseLine(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'id', toolName: 'tool', args: input }))[0]!;
      expect(event).toMatchObject({ input });
      const sanitized = sanitizeParsedEventForBroadcast(event);
      if (sanitized.kind !== 'tool_call') throw new Error('missing tool input');
      const truncated = value.slice(0, 500) + '...<truncated 500 chars>';
      if (shape === 'object') {
        expect(sanitized.input).toEqual({
          ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`key${i}`, truncated])),
          __truncatedKeys: 20,
        });
      } else {
        expect(sanitized.input).toEqual([
          ...Array.from({ length: 20 }, () => ({ value: truncated })),
          { __truncatedItems: 40 },
        ]);
      }
    });
  }
});
