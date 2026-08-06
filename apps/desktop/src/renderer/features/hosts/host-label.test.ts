import { describe, expect, it } from 'vitest';
import { HOST_DISPLAY_LABEL_MAX_LENGTH } from '@silverhand/shared';
import { rejectHostLabel } from './host-label';

/**
 * Behaviour of the computer-name gate (#task:1849). The point of the
 * helper is that the renderer's answer is the schema's answer: the
 * boundary is `HOST_DISPLAY_LABEL_MAX_LENGTH`, it is measured AFTER
 * trimming (which is why the field carries no DOM length cap), and the
 * clear-the-label path stays open.
 */

const atMax = 'a'.repeat(HOST_DISPLAY_LABEL_MAX_LENGTH);
const overMax = 'a'.repeat(HOST_DISPLAY_LABEL_MAX_LENGTH + 1);

describe('rejectHostLabel', () => {
  it('accepts a name at the shared bound', () => {
    expect(rejectHostLabel(atMax)).toBeNull();
  });

  it('refuses one code unit past the bound, naming the limit', () => {
    expect(rejectHostLabel(overMax)).toBe(
      `Computer name is limited to ${HOST_DISPLAY_LABEL_MAX_LENGTH} characters.`,
    );
  });

  it('measures the trimmed name, so padding around a max-length name is fine', () => {
    // The case a DOM `maxLength` would silently truncate: raw length is
    // over the bound, trimmed length is exactly the bound.
    expect(rejectHostLabel(`  ${atMax}  `)).toBeNull();
  });

  it('allows clearing the custom label', () => {
    expect(rejectHostLabel(null)).toBeNull();
    expect(rejectHostLabel('')).toBeNull();
  });
});
