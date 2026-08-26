import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { ListTasksQuerySchema } from '@silverhand/shared';

/**
 * TS oracle for the Rust list-query grammar (task #2196, delta #3).
 *
 * The production `ListTasksQuerySchema` is the ONE authority for how a
 * `GET /internal/agents/{aid}/tasks` query's numeric and status fields are
 * validated. The Rust `parse_list_query` re-implements it, and shiki approved a
 * single deliberate refinement over it: numeric fields (`task_number`, `limit`)
 * parse as a STRICT base-10 integer in Rust, whereas the schema's
 * `z.coerce.number()` runs JavaScript `Number()` — so the quirk forms `Number()`
 * silently coerces (`"190.0"`, `"0x10"`, `" 190 "`, `"1e2"`) are accepted by TS
 * but refused by Rust.
 *
 * This file signs a fixture from the REAL schema so the divergence is pinned in
 * one place instead of asserted twice with hand-authored expectations:
 *
 *   * `ts_accepts` / `ts_value` are produced by running `ListTasksQuerySchema`,
 *     never authored — TS drift goes red here, Rust drift goes red on its side
 *     against the same bytes.
 *   * `rust_refinement` marks the cases where TS accepts but Rust intentionally
 *     refuses. The author declares the intent; this oracle ASSERTS a refinement
 *     input is one TS actually accepts (else it is a shared rejection, not a
 *     refinement), so the label can never drift into a lie.
 *
 * Regenerate with `UPDATE_LIST_QUERY_FIXTURE=1`; by default the checked-in
 * fixture is asserted against the live schema.
 *
 * NOT in scope: the route's pre-schema massaging (dropping the `all` alias,
 * `c.req.query(k) || undefined` for empties, collecting repeatable keys). That
 * is Hono plumbing both sides re-implement and the query unit tests plus the
 * mounted e2e already cover; this oracle pins the SCHEMA-level grammar, which is
 * where the refinement lives.
 */

const FIXTURE_URL = new URL(
  '../../../../rust/crates/backend-server/src/messaging/task/fixtures/list_query_parity.json',
  import.meta.url,
);

interface NumericInput {
  name: string;
  raw: string;
  /** The author's intent: TS coerces this, Rust's strict grammar refuses it. */
  refinement: boolean;
}

interface NumericCase extends NumericInput {
  ts_accepts: boolean;
  ts_value: number | null;
  rust_refinement: boolean;
}

interface StatusCase {
  name: string;
  raw: string;
  ts_accepts: boolean;
}

/** Canonical + shared-rejection + refinement inputs for a numeric field. */
const NUMERIC_INPUTS: NumericInput[] = [
  { name: 'canonical', raw: '190', refinement: false },
  { name: 'canonical_large', raw: '500', refinement: false },
  // Shared rejections: TS and Rust both refuse these for the same reason.
  { name: 'zero_is_not_positive', raw: '0', refinement: false },
  { name: 'negative_is_not_positive', raw: '-3', refinement: false },
  { name: 'fraction_is_not_an_integer', raw: '1.5', refinement: false },
  { name: 'letters_are_not_a_number', raw: 'x', refinement: false },
  { name: 'empty_is_not_a_number', raw: '', refinement: false },
  // The named refinement: `Number()` coerces each of these; Rust refuses them.
  { name: 'trailing_point_zero', raw: '190.0', refinement: true },
  { name: 'hexadecimal', raw: '0x10', refinement: true },
  { name: 'surrounding_space', raw: ' 190 ', refinement: true },
  { name: 'scientific_notation', raw: '1e2', refinement: true },
];

/** Limit adds its own upper bound to the shared numeric grammar. */
const LIMIT_ONLY_INPUTS: NumericInput[] = [
  { name: 'at_the_cap', raw: '500', refinement: false },
  { name: 'one_past_the_cap', raw: '501', refinement: false },
];

/**
 * `task_number` has NO upper bound in the schema (`z.coerce.number().int().positive()`),
 * so the value domain — not just the lexical form — diverges. At/below
 * `Number.MAX_SAFE_INTEGER` a decimal string denotes the SAME integer on both sides; above
 * it the JSON number rounds, so TS "accepts" a value that names a DIFFERENT task than the
 * digits. Rust caps the wire domain at the safe integer, so every value past it is a
 * refinement (TS accepts — rounding when it must — Rust refuses). The boundary itself is a
 * shared acceptance that must still round-trip exactly. `limit`'s `.max(500)` bound keeps it
 * far below this ceiling, so these belong to `task_number` alone.
 */
const TASK_NUMBER_ONLY_INPUTS: NumericInput[] = [
  { name: 'max_safe_integer', raw: '9007199254740991', refinement: false },
  { name: 'max_safe_plus_one', raw: '9007199254740992', refinement: true },
  { name: 'precision_loss_rounds_down', raw: '9007199254740993', refinement: true },
  { name: 'i64_max', raw: '9223372036854775807', refinement: true },
  { name: 'i64_max_plus_one', raw: '9223372036854775808', refinement: true },
];

const STATUS_INPUTS: { name: string; raw: string }[] = [
  { name: 'todo', raw: 'todo' },
  { name: 'in_progress', raw: 'in_progress' },
  { name: 'in_review', raw: 'in_review' },
  { name: 'done', raw: 'done' },
  { name: 'closed', raw: 'closed' },
  { name: 'unknown_token', raw: 'frozen' },
  { name: 'wrong_case', raw: 'In_Progress' },
  { name: 'cancelled_is_not_a_member', raw: 'cancelled' },
];

/** Run the production schema over one `task_number` token (a single-element array). */
function signTaskNumber({ name, raw, refinement }: NumericInput): NumericCase {
  const parsed = ListTasksQuerySchema.safeParse({ task_number: [raw] });
  const ts_accepts = parsed.success;
  const ts_value = parsed.success ? (parsed.data.task_number?.[0] ?? null) : null;
  return { name, raw, refinement, ts_accepts, ts_value, rust_refinement: refinement };
}

/** Run the production schema over one `limit` token (a scalar). */
function signLimit({ name, raw, refinement }: NumericInput): NumericCase {
  const parsed = ListTasksQuerySchema.safeParse({ limit: raw });
  const ts_accepts = parsed.success;
  const ts_value = parsed.success ? (parsed.data.limit ?? null) : null;
  return { name, raw, refinement, ts_accepts, ts_value, rust_refinement: refinement };
}

function signStatus({ name, raw }: { name: string; raw: string }): StatusCase {
  const parsed = ListTasksQuerySchema.safeParse({ status: [raw] });
  return { name, raw, ts_accepts: parsed.success };
}

const live = {
  task_number: [...NUMERIC_INPUTS, ...TASK_NUMBER_ONLY_INPUTS].map(signTaskNumber),
  // `limit` drops the empty-string case: an empty `?limit=` is turned into
  // `undefined` by the route's `|| undefined` BEFORE the schema sees it (a
  // no-bound, not a rejection), so it is a massaging concern, not the schema
  // grammar this oracle pins. `task_number` keeps it, because the route passes
  // an empty element straight through to the schema, which rejects it.
  limit: [...NUMERIC_INPUTS.filter((k) => k.raw !== ''), ...LIMIT_ONLY_INPUTS].map(signLimit),
  status: STATUS_INPUTS.map(signStatus),
};

if (process.env.UPDATE_LIST_QUERY_FIXTURE === '1') {
  writeFileSync(FIXTURE_URL, `${JSON.stringify(live, null, 2)}\n`, 'utf8');
}

const checkedIn = JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as typeof live;

describe('list-query TS oracle for the Rust grammar', () => {
  it('signs the numeric and status contract with the production schema', () => {
    // Guards against BOTH TS-side drift and a hand-edited fixture: the
    // checked-in signature must be exactly what the live schema produces.
    expect(checkedIn).toEqual(live);
  });

  it('every declared refinement is a case TS actually accepts', () => {
    // A refinement is "TS coerces it, Rust refuses it" — so it MUST be accepted
    // by TS. A refinement TS rejects would be a shared rejection mislabelled.
    for (const kase of [...live.task_number, ...live.limit]) {
      if (kase.rust_refinement) {
        expect(kase.ts_accepts, `${kase.name} is a refinement, so TS must accept it`).toBe(true);
      }
    }
    // The named refinement forms present on task_number: four lexical `Number()` quirks
    // plus the value-domain family past MAX_SAFE_INTEGER that TS rounds and Rust refuses.
    expect(live.task_number.filter((k) => k.rust_refinement).map((k) => k.raw)).toEqual([
      '190.0',
      '0x10',
      ' 190 ',
      '1e2',
      '9007199254740992',
      '9007199254740993',
      '9223372036854775807',
      '9223372036854775808',
    ]);
  });

  it.each(live.task_number)('task_number $name', ({ raw, ts_accepts, ts_value }) => {
    const parsed = ListTasksQuerySchema.safeParse({ task_number: [raw] });
    expect(parsed.success).toBe(ts_accepts);
    if (parsed.success) expect(parsed.data.task_number?.[0]).toBe(ts_value);
  });

  it.each(live.limit)('limit $name', ({ raw, ts_accepts, ts_value }) => {
    const parsed = ListTasksQuerySchema.safeParse({ limit: raw });
    expect(parsed.success).toBe(ts_accepts);
    if (parsed.success) expect(parsed.data.limit).toBe(ts_value);
  });
});
