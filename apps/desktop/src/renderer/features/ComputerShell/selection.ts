export function resolveComputerSelection(
  ids: readonly string[],
  selected: string | null,
  local: string | null,
): string | null {
  if (ids.length === 0) {
    return selected;
  }

  if (selected && ids.includes(selected)) {
    return selected;
  }

  return local && ids.includes(local) ? local : ids[0]!;
}
