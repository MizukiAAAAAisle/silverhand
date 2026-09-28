import type { ReactNode } from "react";

/** Excerpt windowed around the first match, ellipsized where clipped; falls back
 *  to a head-truncated snippet when the query is empty or absent. */
export function buildExcerpt(content: string, query: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const needle = query.trim().toLowerCase();
  if (!needle) return flat.length > 260 ? `${flat.slice(0, 260)}…` : flat;
  const index = flat.toLowerCase().indexOf(needle);
  if (index < 0) return flat.length > 260 ? `${flat.slice(0, 260)}…` : flat;
  const start = Math.max(0, index - 80);
  const end = Math.min(flat.length, index + needle.length + 180);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/** Wrap the first case-insensitive `query` match in a `<mark>`; returns raw text
 *  when the query is empty or absent. */
export function highlightText(text: string, query: string): ReactNode {
  const needle = query.trim();
  if (!needle) return text;
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded bg-(--search-hit-bg-active) px-0.5 text-(--search-hit-text)">
        {text.slice(index, index + needle.length)}
      </mark>
      {text.slice(index + needle.length)}
    </>
  );
}
