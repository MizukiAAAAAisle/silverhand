const REFERENCE_RE = /<silverhand:\/\/(?:human|agent)\/([^>\s]+)>/g;
const LOCATOR_RE = /<silverhand:\/\/(workspace|dm)\/([^>\s]+)>/g;
const EMPHASIS_RE = /\*\*|__|`/g;

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** A Markdown source excerpt as one line of plain text, for previews that cannot
 *  draw chips or emphasis: references read as the names the message shows
 *  (`@shiki`, `#ui polish`) and emphasis marks drop away. */
export function plainTextFromMarkdown(source: string): string {
  return source
    .replace(REFERENCE_RE, (_, handle: string) => `@${handle}`)
    .replace(LOCATOR_RE, (_, root: string, path: string) => {
      const segments = path.split("/").map(decodeSegment);
      if (root === "dm") {
        return segments
          .slice(0, 2)
          .map((handle) => `@${handle}`)
          .join(", ");
      }

      return segments.length >= 2 ? `#${segments[1]}` : segments[0]!;
    })
    .replace(EMPHASIS_RE, "");
}
