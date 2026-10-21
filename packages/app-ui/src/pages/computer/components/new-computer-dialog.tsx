import { useEffect, useRef, useState } from "react";
import { SpinnerIcon } from "@/icons";
import type { HostCreateResponse } from "@silverhand/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  useBackendInfoSnapshot,
  useCancelPendingComputerMutation,
  useCreateComputerMutation,
  useHostByIdQuery,
  useUpdateHostMutation,
} from "../../../features/computers/hooks/hooks";
import { ConnectionCommandCard } from "./connection-command-card";
import { computerCopy } from "../../../features/computers/model/computer-copy";
import { rejectHostLabel } from "../../../features/computers/model/host-label";

interface NewComputerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired once the computer has connected and been named, with its
   *  host id so the caller can select it in the sidebar. */
  onCreated?: (hostId: string) => void;
}

type Phase = "creating" | "waiting" | "naming" | "error";

/**
 * #task:1348 — the "Add computer" flow.
 *
 * On open we mint a PENDING computer + a reveal-once connection command.
 * The user runs that command on the target machine; the sidebar shows a
 * pending card meanwhile. When the daemon first attaches (the row's
 * lifecycle `status` flips pending → active) we surface the reported
 * hostname and ask for a name — the ONLY naming moment (shiki: no name
 * input while pending).
 *
 * **Reveal-once** (#task:1428): the connect command is assembled locally by
 * `ConnectionCommandCard` from the recipe (`daemon_npm_spec`), this desktop's
 * connected server URL, and `connect_token` — the reveal-once credential that
 * lives in local state only, discarded on unmount, never written to the query
 * cache or logged. The server contributes no reach URL: the command's
 * `--server-url` is always this desktop's connected origin.
 *
 * **Draft lifecycle**: a pending computer is a modal-scoped DRAFT (shiki:
 * "这个连接只是一个临时的生命周期，而不是永久的"). Closing the dialog before the
 * daemon ever attaches cancels it — hard-deleting the row and invalidating
 * the reveal-once token — so no orphan pending card lingers. Only the first
 * successful connect (phase `naming` onward) promotes it to a real
 * computer, and closing from there keeps it.
 */
export function NewComputerDialog({
  open,
  onOpenChange,
  onCreated,
}: NewComputerDialogProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>("creating");
  const [created, setCreated] = useState<HostCreateResponse | null>(null);
  const [name, setName] = useState("");
  const [finalizeError, setFinalizeError] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const startedRef = useRef(false);
  // Set true when the dialog is closed before the daemon attaches. The
  // in-flight create reads it on resolve so a computer minted AFTER the
  // close (the create→close race) is cancelled immediately rather than
  // stranded as an orphan pending row.
  const cancelOnResolveRef = useRef(false);
  // Set true the moment finalize (the Done button) starts committing the
  // draft into a real computer, and kept true through success. Once we're
  // committing, a close is NOT an abandon — we must not delete the row.
  //
  // This guard became load-bearing after #task:1355: `DELETE /api/hosts/:id`
  // now hard-deletes a *finalized* empty user-managed computer (the old
  // `finalized_at` 409 guard is gone). Without this ref, a close that races
  // the finalize PATCH (Esc / overlay click while it's in flight, or right
  // after it lands) would destroy the computer the user just created.
  const committingRef = useRef(false);

  const createComputer = useCreateComputerMutation();
  const cancelComputer = useCancelPendingComputerMutation();
  const rename = useUpdateHostMutation(created?.host_id ?? "");
  // #task:1428 — the connect command is assembled locally from THIS desktop's
  // own connected server URL (a proven-reachable origin), never from the
  // server-echoed `server_url` (which carried a bind-address fallback bug).
  const backendInfo = useBackendInfoSnapshot();

  // Poll the freshly-minted draft BY ID (not the rail list, which the
  // backend filters down to finalized computers). We watch its lifecycle
  // `status` flip pending → attached; `attached` means the daemon
  // connected but the user hasn't confirmed the setup yet — our cue to
  // ask for a name.
  const draftQuery = useHostByIdQuery(created?.host_id, {
    enabled: created !== null,
    refetchInterval: phase === "waiting" ? 2000 : false,
  });
  const draft = draftQuery.data ?? null;

  // Mint exactly once per open. `startedRef` guards against the effect
  // re-firing (a second create would leave an orphan pending computer).
  useEffect(() => {
    if (!open) {
      startedRef.current = false;
      committingRef.current = false;
      setPhase("creating");
      setCreated(null);
      setName("");
      setFinalizeError(false);
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;
    cancelOnResolveRef.current = false;
    void (async () => {
      try {
        const res = await createComputer.mutateAsync();
        // If the dialog was closed while this create was in flight, the
        // freshly-minted computer is an orphan draft — cancel it instead
        // of committing it to state.
        if (cancelOnResolveRef.current) {
          void cancelComputer.mutateAsync(res.host_id);
          return;
        }
        setCreated(res);
        setPhase("waiting");
      } catch {
        setPhase("error");
      }
    })();
    // Intentionally keyed on `open` only — the ref guard makes this a
    // once-per-open effect; `createComputer.mutateAsync` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Transition to naming the moment the daemon first attaches. `attached`
  // (or `active`, if a poll races past it) both mean the connection is
  // live, which is the only prerequisite for the finalize/name step.
  useEffect(() => {
    if (phase === "waiting" && (draft?.status === "attached" || draft?.status === "active")) {
      setPhase("naming");
    }
  }, [phase, draft?.status]);

  const handleFinish = async (): Promise<void> => {
    if (!created) return;
    const label = name.trim();
    // Naming is REQUIRED: the PATCH both names the computer and finalizes
    // the setup (the backend rejects an empty label on a draft with
    // `display_label_required`). Finalize IS the commit point — until it
    // succeeds the computer is still a throwaway draft — so a failure must
    // keep the user in the dialog to retry, not close (which would cancel
    // the draft).
    if (!label) return;
    // Validate the draft against the shared schema BEFORE committing
    // (#task:1849). This field carries no DOM length cap on purpose — one
    // would silently cut a pasted name — so an over-long name has to come
    // back as a reason the user can act on, not as the generic
    // "couldn't finish setting up" line (which is for real failures).
    const rejection = rejectHostLabel(label);
    if (rejection) {
      setNameError(rejection);
      return;
    }
    setNameError(null);
    setFinalizeError(false);
    // Categorical: from the moment we start committing, the draft is being
    // promoted to a real computer — a close must never delete it (see
    // `committingRef`). Set BEFORE the await so a close racing the in-flight
    // PATCH is already covered.
    committingRef.current = true;
    try {
      await rename.mutateAsync({ display_label: label });
    } catch {
      // Finalize failed → this is still an un-finalized draft, so closing
      // may legitimately abandon (and delete) it again.
      committingRef.current = false;
      setFinalizeError(true);
      return;
    }
    onCreated?.(created.host_id);
    onOpenChange(false);
  };

  // Intercept close requests (Esc / overlay click / X). Closing an
  // un-finalized draft discards it: we cancel it — deleting the row and
  // invalidating its reveal-once token — so no orphan pending/attached
  // computer lingers (it never appears in the rail until finalized anyway).
  //
  // CATEGORICAL RULE (Alice, post-#task:1355): once the setup has been (or is
  // being) finalized, it is a real computer and a modal close NEVER deletes
  // it. This is load-bearing because `DELETE /api/hosts/:id` no longer 409s
  // on a finalized empty computer — the backend `finalized_at` guard that
  // used to make this cancel a benign no-op is GONE. So the renderer itself
  // must decide "is this an abandon of a draft?" and only then delete:
  //   - `committingRef` true  → finalizing / finalized → close is IGNORED
  //     entirely (not merely delete-skipped): letting the modal close
  //     mid-commit would, if the finalize PATCH then FAILS, leave a row that
  //     is neither deleted nor finalized — an attached draft that never
  //     enters the rail and the user can't recover (Cindy). Success closes
  //     via handleFinish's raw `onOpenChange`; a failure resets
  //     `committingRef` so the user can retry, or close to abandon (which
  //     then deletes the draft).
  //   - create still in flight → `cancelOnResolveRef` cancels the orphan on
  //     resolve (a pre-attach draft, always safe to delete).
  // The Done path closes via the raw `onOpenChange` prop, bypassing this
  // handler entirely, so the happy path never routes through a delete.
  const handleOpenChange = (next: boolean): void => {
    if (!next && committingRef.current) return;
    if (!next) {
      cancelOnResolveRef.current = true;
      if (created) void cancelComputer.mutateAsync(created.host_id);
    }
    onOpenChange(next);
  };

  // "Connected to <hostname>" shows the daemon-reported machine name.
  // `connected_host_name` is the availability-axis diagnostic (who's
  // live-attached right now), orthogonal to the identity fields — we never
  // read `name`/`display_label` AS the hostname. Fall back to the display
  // name only if the diagnostic isn't populated yet (Alice doc §7.1).
  const connectedHostname = draft?.connected_host_name ?? draft?.display_label ?? draft?.name ?? "";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{computerCopy().dialogTitle}</DialogTitle>
          {phase !== "naming" ? (
            <DialogDescription>{computerCopy().dialogIntro}</DialogDescription>
          ) : null}
        </DialogHeader>

        {phase === "error" ? (
          <p className="text-sm text-error">{computerCopy().createFailed}</p>
        ) : phase === "creating" || !created ? (
          <div className="flex items-center gap-2 py-6 text-sm text-text-muted">
            <SpinnerIcon className="size-4 animate-spin" />
            {computerCopy().addComputer}…
          </div>
        ) : phase === "naming" ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void handleFinish();
            }}
          >
            <div className="flex items-center gap-2 border-l-[3px] border-success bg-success/10 px-3 py-2 text-sm">
              <span className="size-2 shrink-0 rounded-full bg-success" />
              <span>{computerCopy().connectedTo(connectedHostname)}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="computer-name">{computerCopy().nameLabel}</Label>
              <Input
                id="computer-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameError(null);
                }}
                placeholder={computerCopy().namePlaceholder}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? "computer-name-error" : undefined}
                autoFocus
              />
              {nameError ? (
                <p id="computer-name-error" role="alert" className="text-sm text-error">
                  {nameError}
                </p>
              ) : null}
            </div>
            {finalizeError ? (
              <p className="text-sm text-error">{computerCopy().finalizeFailed}</p>
            ) : null}
            <div className="mt-1 flex justify-end gap-2">
              {/* Name is required — it's the finalize gate. */}
              <Button
                type="submit"
                variant="primary"
                disabled={rename.isPending || name.trim() === ""}
              >
                {computerCopy().finish}
              </Button>
            </div>
          </form>
        ) : (
          // phase === 'waiting'
          <div className="flex flex-col gap-3">
            <ConnectionCommandCard
              daemonNpmSpec={created.daemon_npm_spec}
              connectToken={created.connect_token}
              connectedServerUrl={backendInfo.data?.url ?? ""}
            />

            <div className="mt-1 flex items-center gap-2 border border-dashed border-border px-3 py-2.5 text-sm text-text-secondary">
              <SpinnerIcon className="size-4 animate-spin text-text-secondary" />
              {computerCopy().waitingForConnection}…
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
