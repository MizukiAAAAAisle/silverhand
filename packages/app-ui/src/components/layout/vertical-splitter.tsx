import { SplitterTrack } from "./splitter-track";

interface VerticalSplitterProps {
  onPointerDown: (e: React.PointerEvent) => void;
  active?: boolean;
}

/**
 * Declarative wrapper over {@link SplitterTrack} for the resize seams whose
 * parents re-render on drag (sidebar↔conversation, activity-list↔channel): the
 * `active` boolean flows straight through to the track's active paint. The
 * imperative sibling — `SplitPane` — instead drives the same track by ref +
 * `data-active` so its rAF drag never triggers a re-render. Paint, geometry and
 * a11y all live in `SplitterTrack`; this stays a 3-call-site convenience so those
 * sites don't repeat the prop-to-`active` plumbing.
 */
export function VerticalSplitter({
  onPointerDown,
  active = false,
}: VerticalSplitterProps): JSX.Element {
  return <SplitterTrack onPointerDown={onPointerDown} active={active} />;
}
