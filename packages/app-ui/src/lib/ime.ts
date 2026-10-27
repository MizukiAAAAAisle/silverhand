/** Candidate-confirming keys belong to the IME, including legacy 229 events. */
export function isImeKey(event: { isComposing?: boolean; keyCode?: number }, tracked = false): boolean {
  return tracked || Boolean(event.isComposing) || event.keyCode === 229;
}
