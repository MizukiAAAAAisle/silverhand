import { describe, expect, it } from 'vitest';
import { NameAvailabilityDtoSchema } from '../src/api/name.js';

// #task:1388 — the DTO is a wire contract, so its `available ⇔ reason ===
// 'available'` invariant must be enforced in the shared schema itself, not left
// to route discipline. A contradictory pair (available:true + reason:'taken',
// or available:false + reason:'available') must be structurally rejected.
describe('NameAvailabilityDtoSchema — available ⇔ reason invariant', () => {
  it('accepts the consistent available pair', () => {
    expect(
      NameAvailabilityDtoSchema.safeParse({
        available: true,
        reason: 'available',
      }).success,
    ).toBe(true);
  });

  it('accepts consistent unavailable pairs (taken / invalid)', () => {
    expect(
      NameAvailabilityDtoSchema.safeParse({ available: false, reason: 'taken' })
        .success,
    ).toBe(true);
    expect(
      NameAvailabilityDtoSchema.safeParse({
        available: false,
        reason: 'invalid',
      }).success,
    ).toBe(true);
  });

  it('rejects available:true with a non-available reason', () => {
    expect(
      NameAvailabilityDtoSchema.safeParse({ available: true, reason: 'taken' })
        .success,
    ).toBe(false);
  });

  it('rejects available:false paired with reason:available', () => {
    expect(
      NameAvailabilityDtoSchema.safeParse({
        available: false,
        reason: 'available',
      }).success,
    ).toBe(false);
  });
});
