/**
 * D4.a Commit 4 — bind_address_scope classifier tests.
 *
 * Covers every bucket assignment for every commonly-bound shape
 * an operator might pass via `SILVERHAND_LISTEN`.
 */
import { describe, expect, it } from 'vitest';
import { classifyBindAddressScope } from '@silverhand/shared';

describe('classifyBindAddressScope — loopback bucket', () => {
  it.each([
    'localhost',
    'LocalHost',
    '127.0.0.1',
    '127.0.0.2',
    '127.255.255.254',
    '::1',
    '[::1]',
  ])('%s → loopback', input => {
    expect(classifyBindAddressScope(input)).toBe('loopback');
  });
});

describe('classifyBindAddressScope — lan bucket', () => {
  it.each([
    // RFC1918
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '192.168.255.255',
    // Link-local IPv4 (169.254/16)
    '169.254.1.2',
    '169.254.255.254',
    // IPv6 link-local fe80::/10
    'fe80::1',
    '[fe80::dead:beef]',
    // IPv6 unique-local fc00::/7
    'fc00::1',
    'fd12:3456:789a::1',
    // mDNS
    'mybox.local',
    'CamelCase.Local',
  ])('%s → lan', input => {
    expect(classifyBindAddressScope(input)).toBe('lan');
  });

  it('excludes 172.32.0.1 from RFC1918 lan bucket (172.16/12 only goes through 172.31.x.x)', () => {
    // Pin: dotted-decimal /12 means second octet 16..31. 172.32.x.x
    // is NOT private space — must classify as 'public'.
    expect(classifyBindAddressScope('172.32.0.1')).toBe('public');
    expect(classifyBindAddressScope('172.15.0.1')).toBe('public');
  });
});

describe('classifyBindAddressScope — public bucket (conservative)', () => {
  it.each([
    // Public IPv4
    '1.1.1.1',
    '8.8.8.8',
    '203.0.113.42',
    // Public DNS
    'backend.example.com',
    'silverhand.tail-scale.ts.net',
    // Wildcard binds — most exposure-risky, conservatively public
    '0.0.0.0',
    '::',
    '[::]',
    // Empty / mis-set env
    '',
    '   ',
  ])('%s → public', input => {
    expect(classifyBindAddressScope(input)).toBe('public');
  });
});

describe('classifyBindAddressScope — invariants', () => {
  it('returns one of the three literal buckets for every input (never throws)', () => {
    const buckets = new Set<string>(['loopback', 'lan', 'public']);
    const samples = [
      'localhost',
      '127.0.0.1',
      '10.0.0.1',
      '1.1.1.1',
      '0.0.0.0',
      '',
      'garbage',
      '999.999.999.999',
      'not.an.ip.address.at.all',
    ];
    for (const s of samples) {
      const out = classifyBindAddressScope(s);
      expect(buckets.has(out)).toBe(true);
    }
  });

  it('is case-insensitive on hostname literals', () => {
    expect(classifyBindAddressScope('LOCALHOST')).toBe('loopback');
    expect(classifyBindAddressScope('MyBox.LOCAL')).toBe('lan');
  });

  it('trims whitespace before classifying', () => {
    expect(classifyBindAddressScope('  127.0.0.1  ')).toBe('loopback');
    expect(classifyBindAddressScope('\tlocalhost\n')).toBe('loopback');
  });
});
