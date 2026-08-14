/**
 * Scope override / fault injection for UnitOfWork transaction scopes
 * (#task:1981 design contract v3.1 §9).
 *
 * The persistence composition owns its repos, so spying on a test-local repo
 * instance no longer reaches the service — which is the point of the boundary.
 * The scope handed to an `atomically` callback is the only persistence seam the
 * application still has, and that makes it the right injection point:
 *  - replacing a slice with a DIFFERENT value proves the application read
 *    THROUGH the scope rather than through a captured outside port (R1);
 *  - replacing a method with a throw proves the enclosing transaction's
 *    rollback boundary, with no production-only test hook.
 *
 * `overrideScope` uses a Proxy rather than `{...scope, x}` because concrete
 * scope slices are class instances: spreading one drops its prototype methods.
 * Non-overridden methods are bound to the real target so `this` stays the real
 * repo.
 */

export function overrideScope<T extends object>(target: T, overrides: Partial<T>): T {
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in overrides) return overrides[prop as keyof T];
      const value = Reflect.get(obj, prop) as unknown;
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });
}

interface UnitOfWorkLike<S> {
  atomically<T>(fn: (tx: S) => T): T;
}

/** A UnitOfWork with a second, workspace-keyed axis (`ChannelUnitOfWork`,
 *  #task:1987). Both entry points are KEYED and the two axes carry DIFFERENT
 *  scope types — that is the whole point of the split — so each gets its own
 *  wrapper slot. */
interface ChannelAxesUnitOfWorkLike<S, W> {
  atomicallyForChannel<T>(channelId: string, fn: (tx: S) => T): T;
  atomicallyInWorkspace<T>(workspaceId: string, fn: (tx: W) => T): T;
}

/**
 * A UnitOfWork that hands the callback a wrapped scope. `wrap` is read on every
 * transaction, so a test can arm the fault AFTER its setup writes committed
 * through the real scope.
 *
 * `seam` is a DIFFERENT instrument, and the two are not interchangeable: it runs
 * BEFORE the entry point delegates — in the gap between the caller's pre-lock
 * reads (a route's authorization answer, say) and BEGIN — so whatever it writes is
 * COMMITTED by the time the transaction starts. Wrapping the scope cannot express
 * that: a write issued from inside the callback belongs to the transaction under
 * test and rolls back with it. This is the only honest way to state "a rival
 * committed in the gap", which is what a route-pass → fact-revoked → zero-write
 * falsifier needs (#task:2021 P4-4, @Cindy B7). Same shape as
 * {@link twoAxisUowWithScopeWrap}'s slot of the same name.
 */
export function uowWithScopeWrap<S extends object>(
  uow: UnitOfWorkLike<S>,
  wrap: () => ((tx: S) => S) | null,
  seam?: () => (() => void) | null,
): UnitOfWorkLike<S> {
  return {
    atomically: fn => {
      seam?.()?.();
      return uow.atomically(tx => {
        const wrapper = wrap();
        return fn(wrapper ? wrapper(tx) : tx);
      });
    },
  };
}

/**
 * {@link uowWithScopeWrap} for the two-axis channel UnitOfWork: one wrapper slot
 * per axis, both read per transaction. Keys are passed straight through, so a
 * test cannot accidentally widen the axis it is injecting into.
 *
 * `seam` is a different instrument: it runs BEFORE the entry point delegates,
 * i.e. in the gap between the caller's pre-lock reads and BEGIN, and whatever it
 * writes is COMMITTED by the time the transaction starts. Wrapping the scope
 * cannot express that — a write issued from inside the callback belongs to the
 * very transaction under test and rolls back with it — so this is the only way to
 * state "a rival committed in the seam" without lying to the callback.
 */
export function twoAxisUowWithScopeWrap<S extends object, W extends object>(
  uow: ChannelAxesUnitOfWorkLike<S, W>,
  slots: {
    wrapForChannel: () => ((tx: S) => S) | null;
    wrapInWorkspace: () => ((tx: W) => W) | null;
    seam?: () => (() => void) | null;
  },
): ChannelAxesUnitOfWorkLike<S, W> {
  const runSeam = (): void => {
    slots.seam?.()?.();
  };
  return {
    atomicallyForChannel: (channelId, fn) => {
      runSeam();
      return uow.atomicallyForChannel(channelId, tx => {
        const wrapper = slots.wrapForChannel();
        return fn(wrapper ? wrapper(tx) : tx);
      });
    },
    atomicallyInWorkspace: (workspaceId, fn) => {
      runSeam();
      return uow.atomicallyInWorkspace(workspaceId, tx => {
        const wrapper = slots.wrapInWorkspace();
        return fn(wrapper ? wrapper(tx) : tx);
      });
    },
  };
}
