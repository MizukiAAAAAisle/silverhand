import { Fragment, type ReactNode } from "react";

/** Renders `<b>…</b>` spans of a translated string as `<strong>`, so word order stays in the catalog. */
export function withStrong(text: string): ReactNode {
  return text
    .split(/<b>(.*?)<\/b>/g)
    .map((part, index) =>
      index % 2 === 1 ? (
        <strong key={index}>{part}</strong>
      ) : (
        <Fragment key={index}>{part}</Fragment>
      ),
    );
}

/** Substitutes `{name}` placeholders in `text` with React nodes. */
export function interpolateNodes(text: string, nodes: Record<string, ReactNode>): ReactNode {
  return text
    .split(/\{(\w+)\}/g)
    .map((part, index) =>
      index % 2 === 1 ? (
        <Fragment key={index}>{part in nodes ? nodes[part] : `{${part}}`}</Fragment>
      ) : (
        part
      ),
    );
}
