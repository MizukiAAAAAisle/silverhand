import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  apiPaths,
  ENTITY_NAME_MAX_LENGTH,
  ParticipantNameSchema,
  WorkspaceNameSchema,
  type NameAvailabilityDto,
} from "@silverhand/shared";
import { api } from "@/lib/api";
import { SpinnerIcon } from "@/icons";
import { t } from "@/lib/i18n";

export type NameCheckKind = "agent" | "workspace";

export type NameCheckStatus =
  | "idle" // untouched, or field empty → say nothing
  | "checking" // format ok, uniqueness probe in flight
  | "available"
  | "invalid" // fails the selected shared schema (charset / length)
  | "taken" // uniqueness collision
  | "error"; // probe network failure — advisory only, never blocks

type FormatIssue = "charset" | "length";

const nameRule = () =>
  ({
    agent: {
      schema: ParticipantNameSchema,
      message: {
        charset: t("identity.mustStartWithA"),
        length: t("identity.nameTooLong", { max: ENTITY_NAME_MAX_LENGTH }),
      },
    },
    workspace: {
      schema: WorkspaceNameSchema,
      message: {
        // A workspace name is a label, so almost everything is legal and the
        // only reachable non-length rejection is a code point the field cannot
        // render — pasted zero-width joiners, BOM, bidi overrides. Naming the
        // invisible cause is the whole value of this line; "invalid name" would
        // leave the user staring at text that looks correct.
        charset: t("identity.controlAndInvisibleCharacters"),
        length: t("identity.nameTooLong", { max: ENTITY_NAME_MAX_LENGTH }),
      },
    },
  }) satisfies Record<
    NameCheckKind,
    {
      schema: typeof ParticipantNameSchema | typeof WorkspaceNameSchema;
      message: Record<FormatIssue, string>;
    }
  >;

const takenMessage = () => t("identity.thisNameIsAlready");

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
export function nameFormatIssue(kind: NameCheckKind, name: string): FormatIssue | null {
  if (name.length === 0) return null;
  const parsed = nameRule()[kind].schema.safeParse(name);
  if (parsed.success) return null;
  return parsed.error.issues.some((issue) => issue.code === "too_big") ? "length" : "charset";
}

export function nameFormatMessage(kind: NameCheckKind, name: string): string | null {
  const issue = nameFormatIssue(kind, name);
  return issue ? nameRule()[kind].message[issue] : null;
}

/** Pure presentation core — no React, no fetching. Maps the resolved facts to
 *  the visible verdict so the decision table is unit-testable in isolation. */
export function nameAvailabilityView(input: {
  kind: NameCheckKind;
  touched: boolean;
  name: string; // trimmed
  formatIssue: FormatIssue | null;
  inSync: boolean;
  data: NameAvailabilityDto | null;
  isError: boolean;
  isFetching: boolean;
}): NameCheckView {
  const { kind, touched, name, formatIssue, inSync, data, isError, isFetching } = input;

  if (!touched || name.length === 0) {
    return { status: "idle", message: null, blocking: false };
  }
  if (formatIssue) {
    return {
      status: "invalid",
      message: nameRule()[kind].message[formatIssue],
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
      ? { status: "available", message: null, blocking: false }
      : { status: "taken", message: takenMessage(), blocking: true };
  }
  // No settled verdict yet: debounce still catching up, or the initial probe is
  // in flight. Non-blocking — create backstops a fast submit.
  if (!inSync || isFetching) {
    return { status: "checking", message: null, blocking: false };
  }
  if (isError) {
    // Probe couldn't reach the backend — stay silent and let create decide.
    return { status: "error", message: null, blocking: false };
  }
  return { status: "checking", message: null, blocking: false };
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
    kind === "agent" ? apiPaths.agentNameAvailability : apiPaths.workspaceNameAvailability;

  // Keyed by the concrete name → responses cache per-name and a slow reply for
  // an old name can never overwrite the verdict for the current one
  // (stale-guard by construction). Enabled only once armed, format-ok, and the
  // debounce has settled.
  const query = useQuery({
    queryKey: ["name-availability", kind, name],
    queryFn: () => api<NameAvailabilityDto>(`${path}?name=${encodeURIComponent(name)}`),
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

/** How long a probe must stay in flight before the field shows it. A local
 *  probe settles well inside this window, so the common path shows nothing. */
const CHECKING_DELAY_MS = 400;

/** True once `active` has held for `ms`; false again the moment it drops. */
function useSettledTrue(active: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!active) {
      setHeld(false);
      return;
    }
    const t = setTimeout(() => setHeld(true), ms);
    return () => clearTimeout(t);
  }, [active, ms]);

  return held;
}

/**
 * The definitive verdict line under the field. A slow probe is shown by
 * `NameCheckingIcon` inside the field instead: a line that comes and goes per
 * keystroke changes the dialog height, and the keyboard-anchored mobile sheet
 * jumps with it.
 */
export function NameAvailabilityHint({ check }: { check: NameCheckView }): JSX.Element | null {
  const problem = check.status === "invalid" || check.status === "taken";

  if (!problem) {
    return null;
  }

  return <p className="text-xs leading-4 text-error">{check.message}</p>;
}

/** Trailing spinner for a slow probe; the field wrapper must be `relative`. */
export function NameCheckingIcon({ check }: { check: NameCheckView }): JSX.Element | null {
  const slowProbe = useSettledTrue(check.status === "checking", CHECKING_DELAY_MS);

  if (!slowProbe) {
    return null;
  }

  return (
    <SpinnerIcon
      role="status"
      aria-label={t("identity.checkingAvailability")}
      className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-text-muted"
    />
  );
}
