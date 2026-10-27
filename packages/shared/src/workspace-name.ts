// A regular workspace's display name is its address root (#task:2027).
//
// The Unicode verdict and case fold are deliberately delegated to the channel
// title authority from #task:2016. Workspace names add only their historical
// 64-code-point cap and a distinct brand, so there is one shipped character
// table, one normalizer and one fold in the product.
import {
  canonicalizeStoredConversationTitle,
  parseConversationTitle,
  type ConversationTitleIssue,
} from './conversation-title.js';
import { TARGET_SEGMENT_CODEC, URI_SEGMENT_CODEC, type SegmentCodec } from './address-segment.js';

export const WORKSPACE_NAME_MAX_CODE_POINTS = 64;

declare const CANONICAL_WORKSPACE_NAME: unique symbol;

/** The terminal write value for a regular workspace. `name` and `key` cannot
 * be supplied independently outside this module. Agent-home workspaces do not
 * carry this value and have `name_key = NULL`. */
export interface CanonicalWorkspaceName {
  readonly name: string;
  readonly key: string;
  readonly [CANONICAL_WORKSPACE_NAME]: true;
}

export type WorkspaceNameIssue =
  | ConversationTitleIssue
  | { readonly kind: 'too_long'; readonly codePoints: number };

export type WorkspaceNameResult =
  | { readonly ok: true; readonly value: CanonicalWorkspaceName }
  | { readonly ok: false; readonly issue: WorkspaceNameIssue };

/** Total keying function for rows that predate the validator. The migration and
 * boot audit must be able to diagnose every stored string, including one that a
 * new write would reject. */
export function canonicalizeStoredWorkspaceName(raw: string): CanonicalWorkspaceName {
  const canonical = canonicalizeStoredConversationTitle(raw);
  return {
    name: canonical.title,
    key: canonical.key,
  } as CanonicalWorkspaceName;
}

/** Product input parser: the #2016 validator first, then only the workspace's
 * narrower length cap. NFC, trim, forbidden characters and case folding are not
 * reimplemented here. */
export function parseWorkspaceName(raw: string): WorkspaceNameResult {
  const parsed = parseConversationTitle(raw);
  if (!parsed.ok) return parsed;
  const codePoints = Array.from(parsed.value.title).length;
  if (codePoints > WORKSPACE_NAME_MAX_CODE_POINTS) {
    return { ok: false, issue: { kind: 'too_long', codePoints } };
  }
  return {
    ok: true,
    value: {
      name: parsed.value.title,
      key: parsed.value.key,
    } as CanonicalWorkspaceName,
  };
}

/** For code-owned fixtures/constants only. User input uses
 * {@link parseWorkspaceName} so a refusal can be rendered rather than thrown. */
export function fixedWorkspaceName(literal: string): CanonicalWorkspaceName {
  const parsed = parseWorkspaceName(literal);
  if (!parsed.ok) {
    throw new Error(
      `workspace name literal ${JSON.stringify(literal)} is not storable: ${describeWorkspaceNameIssue(parsed.issue)}`,
    );
  }
  return parsed.value;
}

/** Canonical readable-address segment for a regular workspace. */
export function formatWorkspaceAddressSegment(name: CanonicalWorkspaceName): string {
  return TARGET_SEGMENT_CODEC.encode(name.name);
}

/** Strict inverse of {@link formatWorkspaceAddressSegment}. Besides the
 * percent codec's own canonicality, the decoded display bytes must already be
 * NFC+trim canonical — aliases such as an encoded leading space are refused. */
export function parseWorkspaceAddressSegment(segment: string): CanonicalWorkspaceName | null {
  return parseNameSegment(segment, TARGET_SEGMENT_CODEC);
}

/** The same name in the prose-URI carrier — the root segment of
 *  `silverhand://workspace/<name>` (#task:2119). Separate from the `target=`
 *  carrier by function name, not by an argument, so no call site can pick the wrong
 *  escape set by omission. */
export function formatWorkspaceUriSegment(name: CanonicalWorkspaceName): string {
  return URI_SEGMENT_CODEC.encode(name.name);
}

/** Strict inverse of {@link formatWorkspaceUriSegment}. */
export function parseWorkspaceUriSegment(segment: string): CanonicalWorkspaceName | null {
  return parseNameSegment(segment, URI_SEGMENT_CODEC);
}

/** One implementation for both carriers; only the escape set differs. */
function parseNameSegment(segment: string, codec: SegmentCodec): CanonicalWorkspaceName | null {
  const decoded = codec.decode(segment);
  if (decoded === null) return null;
  const parsed = parseWorkspaceName(decoded);
  if (!parsed.ok || parsed.value.name !== decoded) return null;
  return codec.encode(parsed.value.name) === segment ? parsed.value : null;
}

export function describeWorkspaceNameIssue(issue: WorkspaceNameIssue): string {
  switch (issue.kind) {
    case 'empty':
      return 'workspace name must not be empty';
    case 'too_long':
      return `workspace name must be at most ${WORKSPACE_NAME_MAX_CODE_POINTS} characters (got ${issue.codePoints})`;
    case 'forbidden_code_point':
      return `workspace name must not contain U+${issue.codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
  }
}
