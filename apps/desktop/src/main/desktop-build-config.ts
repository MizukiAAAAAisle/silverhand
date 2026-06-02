import {
  classifyServerUrl,
  type ServerConnectionProfileView,
} from '@silverhand/shared';

export type EffectiveBootProfileSource =
  | 'saved_profile'
  | 'packaged_default'
  | 'none';

export type EffectiveBootProfile =
  | {
      source: 'saved_profile' | 'packaged_default';
      profileView: ServerConnectionProfileView;
      warning: null;
    }
  | {
      source: 'none';
      profileView: null;
      warning:
        | null
        | {
            reason:
              | 'packaged_default_invalid'
              | 'packaged_default_loopback_remote_only';
            message: string;
          };
    };

export interface ResolveEffectiveBootProfileInput {
  savedProfileView: ServerConnectionProfileView | null;
  packagedDefaultServerUrl: string;
  allowInsecureRemote: boolean;
  remoteOnly: boolean;
  now?: () => number;
}

export function resolveEffectiveBootProfile(
  input: ResolveEffectiveBootProfileInput,
): EffectiveBootProfile {
  if (input.savedProfileView) {
    return {
      source: 'saved_profile',
      profileView: input.savedProfileView,
      warning: null,
    };
  }

  const rawDefault = input.packagedDefaultServerUrl.trim();
  if (rawDefault.length === 0) {
    return { source: 'none', profileView: null, warning: null };
  }

  const classification = classifyServerUrl(rawDefault, {
    allowInsecureRemote: input.allowInsecureRemote,
  });
  if (!classification.ok) {
    return {
      source: 'none',
      profileView: null,
      warning: {
        reason: 'packaged_default_invalid',
        message: classification.message,
      },
    };
  }
  if (input.remoteOnly && classification.kind === 'loopback') {
    return {
      source: 'none',
      profileView: null,
      warning: {
        reason: 'packaged_default_loopback_remote_only',
        message:
          'Remote-only desktop packages require a non-loopback remote server URL.',
      },
    };
  }

  return {
    source: 'packaged_default',
    profileView: {
      server_url: classification.url.origin,
      updated_at: (input.now ?? Date.now)(),
    },
    warning: null,
  };
}
