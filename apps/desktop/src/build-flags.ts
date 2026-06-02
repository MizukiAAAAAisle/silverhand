declare const __SILVERHAND_DESKTOP_REMOTE_ONLY__: boolean | undefined;
declare const __SILVERHAND_DESKTOP_DEFAULT_SERVER_URL__: string | undefined;

export const DESKTOP_REMOTE_ONLY =
  typeof __SILVERHAND_DESKTOP_REMOTE_ONLY__ !== 'undefined'
    && __SILVERHAND_DESKTOP_REMOTE_ONLY__ === true;

export const PACKAGED_DEFAULT_SERVER_URL =
  typeof __SILVERHAND_DESKTOP_DEFAULT_SERVER_URL__ === 'string'
    ? __SILVERHAND_DESKTOP_DEFAULT_SERVER_URL__.trim()
    : '';

export interface DesktopBuildConfig {
  remote_only: boolean;
  default_server_url: string;
}

export function desktopBuildConfig(): DesktopBuildConfig {
  return {
    remote_only: DESKTOP_REMOTE_ONLY,
    default_server_url: PACKAGED_DEFAULT_SERVER_URL,
  };
}
