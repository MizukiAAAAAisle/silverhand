export function isRefHoverDebugEnabled(): boolean {
  return true;
}

export function logRefHoverDebug(
  event: string,
  payload: Record<string, unknown>,
): void {
  const t = typeof performance !== 'undefined'
    ? Math.round(performance.now())
    : Date.now();
  // Temporary diagnostic instrumentation for the hover-card flicker
  // investigation. Keep the prefix stable so users can copy-filter
  // console logs; remove this file and call sites after the cause is
  // confirmed.
  console.debug('[silverhand:hover-popover]', event, {
    t,
    ...payload,
  });
}
