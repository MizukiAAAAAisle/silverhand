import { describe, expect, it, vi } from 'vitest';
import { prepareEmbeddedStartup } from '../embedded-startup-preparation.js';

describe('pre-child token ownership', () => {
  for (const fault of ['missing-manifest', 'missing-binary', 'verify', 'migration', 'spawn-throw', 'spawn-error'] as const) {
    it(`${fault} cleans final and tmp tokens and never publishes`, async () => {
      const artifacts = new Set(['final', 'tmp']);
      const order: string[] = [];
      const published = vi.fn();
      const result = prepareEmbeddedStartup({
        cleanupTokens: async () => { order.push('cleanup'); artifacts.clear(); },
        verify: async () => {
          expect(artifacts.size).toBe(0);
          order.push('verify');
          if (['missing-manifest', 'missing-binary', 'verify'].includes(fault)) throw new Error(fault);
          return 'verified';
        },
        launch: () => {
          order.push('launch'); artifacts.add('final'); artifacts.add('tmp');
          if (fault === 'spawn-throw') throw new Error(fault);
          return Promise.reject(new Error(fault));
        },
      }).then(published);
      await expect(result).rejects.toThrow(fault);
      expect(artifacts.size).toBe(0);
      expect(order[0]).toBe('cleanup');
      expect(order.at(-1)).toBe('cleanup');
      expect(published).not.toHaveBeenCalled();
    });
  }
});
