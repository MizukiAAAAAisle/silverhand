export function isMoreDestination(path: string) {
  return /^\/(members|computers|settings)(?:\/|$)/.test(path);
}

/** Workspace selection remains a Chats root; panel targets are detail pages. */
export function showsTabBar(path: string, search = ""): boolean {
  const root = ["/chat", "/activity", "/tasks"].includes(path) || /^\/chat\/w\/[^/]+$/.test(path);
  const query = new URLSearchParams(search);
  return (
    root &&
    !["side", "thread", "threads", "files", "settings", "task", "agent", "human"].some((key) =>
      query.has(key),
    )
  );
}
