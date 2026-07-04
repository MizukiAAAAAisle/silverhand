import {
  classifyServerUrl,
  type ServerUrlRejectionReason,
} from '@silverhand/shared';

export type ServerUrlDraftValidation =
  | { kind: 'empty' }
  | { kind: 'ok'; url: URL }
  | {
      kind: 'reject';
      reason: ServerUrlRejectionReason;
      message: string;
    };

export function validateServerUrlDraft(
  draft: string,
  options?: { allowInsecureRemote?: boolean },
): ServerUrlDraftValidation {
  const trimmed = draft.trim();
  if (trimmed === '') return { kind: 'empty' };
  const classified = classifyServerUrl(trimmed, {
    allowInsecureRemote: options?.allowInsecureRemote === true,
  });
  return classified.ok
    ? { kind: 'ok', url: classified.url }
    : {
        kind: 'reject',
        reason: classified.reason,
        message: classified.message,
      };
}
