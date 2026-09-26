import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSIONS } from '../src/index.js';

describe('protocol version authority', () => {
  it('every authority value is a positive integer', () => {
    for (const [axis, value] of Object.entries(PROTOCOL_VERSIONS)) {
      expect(Number.isInteger(value), axis).toBe(true);
      expect(value, axis).toBeGreaterThan(0);
    }
  });
});
