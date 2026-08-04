import {
  DESKTOP_API_EPOCH_HEADER,
  DESKTOP_SERVER_API_EPOCH,
} from '@silverhand/shared';

/**
 * The admission header a CURRENT desktop client always stamps
 * (`apps/desktop/src/main/index.ts`). relocation-v1 §6 raised
 * `MINIMUM_CLIENT_API_EPOCH` to the current epoch, so a `/api/*` request
 * without it is the pre-epoch generation and is refused with 426.
 *
 * `http()` in `./app.js` injects it automatically; spread this at HAND-BUILT
 * request sites (raw `app.fetch(new Request(...))`, multipart bodies, WS
 * upgrades, real-HTTP e2e rigs) that bypass that helper. It lives in its own
 * module so the network-level rigs can speak for a current client without
 * importing the in-process app builder.
 */
export const CURRENT_DESKTOP_EPOCH_HEADERS: Record<string, string> = {
  [DESKTOP_API_EPOCH_HEADER]: String(DESKTOP_SERVER_API_EPOCH),
};
