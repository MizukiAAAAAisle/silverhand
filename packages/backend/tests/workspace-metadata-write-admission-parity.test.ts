import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ArchiveWorkspaceInputSchema,
  UpdateWorkspaceInputSchema,
} from '@silverhand/shared';

/**
 * TS-first half of the cross-language admission (400) parity gate for the
 * workspace metadata-write surface (#task:2193): PATCH /api/workspaces/{id} and
 * PATCH /api/workspaces/{id}/archive.
 *
 * The SAME checked-in fixture the Rust unit test replays
 * (rust/crates/backend-server/src/workspace_metadata_write.rs `mod admission_parity`)
 * -- one `admission-cases.json` of (body → 400 envelope) pairs -- is replayed
 * here against the REAL Zod authority. For each case this reproduces the route's
 * malformed-body branch VERBATIM: `Schema.safeParse(body)` and, on failure,
 * `{ error: 'invalid input', issues: parsed.error.issues }`. That envelope is the
 * exact bytes the Hono route returns, so the fixture pins the refusal PRECEDENCE
 * (the issue `code`) and the per-code key order the Rust `wire` projection must
 * match byte-for-byte.
 *
 * This test is the ORACLE: the expected envelopes are hand-authored but the real
 * Zod schemas run here first, so a wrong expectation goes red against reality
 * before the Rust side is ever asked to match it. Only the 400 admission bytes
 * live here -- the boundary that would silently drift between two hand-written
 * validators. The full-route refusal ORDERING (404/403 gate the body before this
 * 400, then 409/200) and the rename message atomicity are structural, not
 * byte-drift-prone, and are guarded Rust-side in
 * backend-server/tests/workspace_metadata_write_e2e.rs.
 */
const here = dirname(fileURLToPath(import.meta.url));
const FX = join(here, 'fixtures', 'workspace-metadata-write');
const CASES = JSON.parse(readFileSync(join(FX, 'admission-cases.json'), 'utf8')) as {
  readonly status: number;
  readonly update: ReadonlyArray<Case>;
  readonly archive: ReadonlyArray<Case>;
  readonly admitted_update: ReadonlyArray<AdmittedCase>;
  readonly admitted_archive: ReadonlyArray<AdmittedCase>;
};
type Case = {
  readonly name: string;
  readonly input: unknown;
  readonly expected: { readonly error: string; readonly issues: readonly unknown[] };
};
type AdmittedCase = {
  readonly name: string;
  readonly input: unknown;
  readonly expected: unknown;
};

/** The route's malformed-body branch, verbatim: parse, then the 400 envelope. */
function admit(schema: { safeParse: (b: unknown) => any }, body: unknown) {
  const parsed = schema.safeParse(body);
  expect(parsed.success, 'every admission case is a refusal').toBe(false);
  return { error: 'invalid input', issues: parsed.error.issues };
}

/**
 * The impl-neutral projection of an ACCEPTED update body onto the edit it means.
 * `name` is null or the transform's `{name, key}` display+fold pair; the
 * description is the tri-state the route acts on: an absent key is `"untouched"`,
 * an explicit `null` is `"clear"`, a string is `{ set }`. This is what the Rust
 * `parse_update_body` result must project to identically.
 */
function projectUpdate(schema: { safeParse: (b: unknown) => any }, body: unknown) {
  const parsed = schema.safeParse(body);
  expect(parsed.success, 'every admitted case parses').toBe(true);
  const data = parsed.data as { name?: { name: string; key: string }; description?: string | null };
  const name = 'name' in data && data.name ? { name: data.name.name, key: data.name.key } : null;
  const description = !('description' in data)
    ? 'untouched'
    : data.description === null
      ? 'clear'
      : { set: data.description };
  return { name, description };
}

describe('workspace metadata-write admission parity (#task:2193)', () => {
  it('the real Zod authority produces the shared 400 update envelopes', () => {
    for (const testCase of CASES.update) {
      expect(admit(UpdateWorkspaceInputSchema, testCase.input), testCase.name).toEqual(
        testCase.expected,
      );
    }
  });

  it('the real Zod authority produces the shared 400 archive envelopes', () => {
    for (const testCase of CASES.archive) {
      expect(admit(ArchiveWorkspaceInputSchema, testCase.input), testCase.name).toEqual(
        testCase.expected,
      );
    }
  });

  it('the real Zod authority yields the shared admitted update projections', () => {
    for (const testCase of CASES.admitted_update) {
      expect(projectUpdate(UpdateWorkspaceInputSchema, testCase.input), testCase.name).toEqual(
        testCase.expected,
      );
    }
  });

  it('the real Zod authority yields the shared admitted archive flags', () => {
    for (const testCase of CASES.admitted_archive) {
      const parsed = ArchiveWorkspaceInputSchema.safeParse(testCase.input);
      expect(parsed.success, testCase.name).toBe(true);
      expect(parsed.data.archived, testCase.name).toEqual(testCase.expected);
    }
  });
});
