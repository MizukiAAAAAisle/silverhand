import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseBearerTokenHeader } from '../../src/auth/bearer.js';

interface BearerCase {
  name: string;
  header: string | null;
  ts_extracted_token: string | null;
  rust_extracted_token: string | null;
}

const cases = JSON.parse(readFileSync(new URL(
  '../../../../rust/crates/backend-server/src/auth/fixtures/public_bearer_grammar.json',
  import.meta.url,
), 'utf8')) as BearerCase[];

describe('public bearer TS oracle for Rust migration', () => {
  it.each(cases)('$name', ({ header, ts_extracted_token }) => {
    expect(parseBearerTokenHeader(header ?? undefined)).toBe(ts_extracted_token);
  });
});
