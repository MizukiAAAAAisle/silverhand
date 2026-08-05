import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  apiPaths,
  ENTITY_NAME_MAX_LENGTH,
  EntityNameSchema,
  ParticipantNameSchema,
  type NameAvailabilityDto,
} from '@silverhand/shared';
import { api } from '@/lib/api';

/**
 * Shared onBlur name-validation for the create-agent / create-workspace
 * dialogs (#task:1387). One hook, two consumers, with the entity kind selecting
 * its shared schema: participant addressing rules must not constrain workspace
 * labels, while each create path and availability probe must still agree.
 *
 * Two axes, kept separate on purpose (mirrors the backend split):
 *   - FORMAT is client-side and synchronous, via the SHARED
 *     {@link ParticipantNameSchema} or {@link EntityNameSchema} (never a
 *     second regex).
 *   - UNIQUENESS is server-only, via the matching name-availability probe
 *     endpoint, which shares ONE predicate with the create path — so the form
 *     can never report `available` for a name create would reject.
 *
 * Advisory, not authoritative: create is the real backstop (it returns
 * `nameTaken` / a zod 400). So this gates the button on the DEFINITIVE bad
 * states only (`invalid` / `taken`); `checking` and a network `error` don't
 * block — a fast submit falls through to create, which enforces.
 */
export type NameCheckKind = 'agent' | 'workspace';

export type NameCheckStatus =
  | 'idle' // untouched, or field empty → say nothing
  | 'checking' // format ok, uniqueness probe in flight
  | 'available'
  | 'invalid' // fails the selected shared schema (charset / length)
  | 'taken' // uniqueness collision
  | 'error'; // probe network failure — advisory only, never blocks

type FormatIssue = 'charset' | 'length';

const NAME_RULE = {
  agent: {
    schema: ParticipantNameSchema,
    message: {
      charset: 'Start with a letter; then use letters, numbers, - and _ only',
      length: `Up to ${ENTITY_NAME_MAX_LENGTH} characters`,
    },
  },
  workspace: {
    schema: EntityNameSchema,
    message: {
      charset: 'Letters, numbers, - and _ only',
      length: `Up to ${ENTITY_NAME_MAX_LENGTH} characters`,
    },
  },
} satisfies Record<
  NameCheckKind,
  {
    schema: typeof ParticipantNameSchema | typeof EntityNameSchema;
    message: Record<FormatIssue, string>;
  }
>;

const TAKEN_MESSAGE = 'Name already taken';

export interface NameCheckView {
  status: NameCheckStatus;
  /** Inline message for the definitive bad states; null otherwise. */
  message: string | null;
  /** Disable submit? True only for the definitive bad states. */
  blocking: boolean;
}

/** FORMAT verdict for a trimmed name. `null` = ok (or empty → nothing to say).
 *  The schema owns both character and length semantics. Reading its issues
 *  avoids recreating a kind-blind `string.length` rule in this advisory layer;
 *  if both fail, length remains the more actionable verdict. */
export function nameFormatIssue(
  kind: NameCheckKind,
  name: string,
): FormatIssue | null {
  if (name.length === 0) return null;
  const parsed = NAME_RULE[kind].schema.safeParse(name);
  if (parsed.success) return null;
  return parsed.error.issues.some(issue => issue.code === 'too_big')
    ? 'length'
    : 'charset';
}

/** Pure presentation core — no React, no fetching. Maps the resolved facts to
 *  the visible verdict so the decision table is unit-testable in isolation. */
export function nameAvailabilityView(input: {
  kind: NameCheckKind;
  touched: boolean;
  name: string; // trimmed
  formatIssue: FormatIssue | null;
  /** Does the probe result reflect the CURRENT input? (debounce settled) */
  inSync: boolean;
  data: NameAvailabilityDto | null;
  isError: boolean;
  isFetching: boolean;
}): NameCheckView {
  const { kind, touched, name, formatIssue, inSync, data, isError, isFetching } =
    input;

  if (!touched || name.length === 0) {
    return { status: 'idle', message: null, blocking: false };
  }
  if (formatIssue) {
    return {
      status: 'invalid',
      message: NAME_RULE[kind].message[formatIssue],
      blocking: true,
    };
  }
  // Settled fact for the CURRENT name wins over freshness. `data` is keyed by
  // the concrete name, so its presence means it's the verdict for this input —
  // show it even while a background refetch is in flight, so a window-focus /
  // staleTime refetch can't blink a settled available/taken back to "checking"
  // (freshness ≠ fact — the #1376 rule).
  if (data) {
    return data.available
      ? { status: 'available', message: null, blocking: false }
      : { status: 'taken', message: TAKEN_MESSAGE, blocking: true };
  }
  // No settled verdict yet: debounce still catching up, or the initial probe is
  // in flight. Non-blocking — create backstops a fast submit.
  if (!inSync || isFetching) {
    return { status: 'checking', message: null, blocking: false };
  }
  if (isError) {
    // Probe couldn't reach the backend — stay silent and let create decide.
    return { status: 'error', message: null, blocking: false };
  }
  return { status: 'checking', message: null, blocking: false };
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export interface NameCheck extends NameCheckView {
  /** Format is well-formed AND non-empty — used by the submit handler to run a
   *  final format pass even on a field the user never blurred. */
  formatValid: boolean;
  /** Arm validation (call onBlur, and from the submit handler). */
  markTouched: () => void;
}

/**
 * onBlur name validation for a create dialog. Returns the visible verdict plus
 * `markTouched` (arm on blur) and `formatValid` (for the submit gate). Live
 * re-validation kicks in once armed, so an error clears the moment the user
 * fixes it — no second blur required.
 */
export function useNameAvailability(kind: NameCheckKind, rawName: string): NameCheck {
  const name = rawName.trim();
  const [touched, setTouched] = useState(false);

  // Reset when the field is cleared (incl. the dialog's post-create reset) so a
  // reopened dialog starts calm instead of inheriting the last session's armed
  // state.
  useEffect(() => {
    if (name.length === 0) setTouched(false);
  }, [name]);

  const formatIssue = useMemo(() => nameFormatIssue(kind, name), [kind, name]);

  const debounced = useDebounced(name, 300);
  const inSync = debounced === name;
  const path =
    kind === 'agent'
      ? apiPaths.agentNameAvailability
      : apiPaths.workspaceNameAvailability;

  // Keyed by the concrete name → responses cache per-name and a slow reply for
  // an old name can never overwrite the verdict for the current one
  // (stale-guard by construction). Enabled only once armed, format-ok, and the
  // debounce has settled.
  const query = useQuery({
    queryKey: ['name-availability', kind, name],
    queryFn: () =>
      api<NameAvailabilityDto>(`${path}?name=${encodeURIComponent(name)}`),
    enabled: touched && name.length > 0 && formatIssue === null && inSync,
    staleTime: 30_000,
    retry: false,
  });

  const view = nameAvailabilityView({
    kind,
    touched,
    name,
    formatIssue,
    inSync,
    data: query.data ?? null,
    isError: query.isError,
    isFetching: query.isFetching,
  });

  return {
    ...view,
    formatValid: name.length > 0 && formatIssue === null,
    markTouched: () => setTouched(true),
  };
}

/** Inline field note under a Name input. Renders the red message for the
 *  definitive bad states, a muted "Checking…" while probing, and nothing
 *  otherwise (a calm resting field — no positive-confirmation clutter). */
export function NameAvailabilityHint({ check }: { check: NameCheckView }): JSX.Element | null {
  if (check.status === 'invalid' || check.status === 'taken') {
    return <p className="text-xs text-error">{check.message}</p>;
  }
  if (check.status === 'checking') {
    return <p className="text-xs text-text-muted">Checking…</p>;
  }
  return null;
}
