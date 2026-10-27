import type { ClientPlatform } from '@silverhand/client';

// MainActivity dispatches only on a committed system Back. No navigation is
// changed for predictive progress/cancellation, and no native chrome is exposed.
export function createSystemBack(target?: EventTarget): NonNullable<ClientPlatform['systemBack']> {
  return {
    subscribe(handler) {
      const events = target ?? window;
      const listener = (event: Event) => {
        if (!event.defaultPrevented && handler()) event.preventDefault();
      };
      events.addEventListener('silverhand:system-back', listener);
      return () => events.removeEventListener('silverhand:system-back', listener);
    },
  };
}
