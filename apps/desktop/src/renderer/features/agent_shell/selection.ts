export function resolveDefaultAgent(
  ids: readonly string[],
  selected: string | null,
  user: string | null,
  remembered: string | null,
): string | null {
  if (user || ids.length === 0 || (selected && ids.includes(selected))) {
    return null;
  }

  return remembered && ids.includes(remembered) ? remembered : ids[0]!;
}
