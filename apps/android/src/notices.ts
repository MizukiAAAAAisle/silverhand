import type {
  BannerCapability,
  BannerNotice,
  ToastCapability,
  ToastNotice,
} from '@silverhand/client';

type Notice = BannerNotice | ToastNotice;
type Kind = 'banner' | 'toast';

/** Android-local presentation of the existing mobile contracts. No native bridge
 * or shared notification policy: the caller decides when and what to show. */
export function createAndroidNotices(doc: Document = document) {
  const host = doc.createElement('aside');
  host.className = 'android-notices';
  const listeners = {
    banner: new Set<Parameters<BannerCapability['subscribe']>[0]>(),
    toast: new Set<Parameters<ToastCapability['subscribe']>[0]>(),
  };
  let disposed = false;

  function slot(kind: Kind) {
    const card = doc.createElement('div');
    card.className = `android-notice android-notice-${kind}`;
    card.hidden = true;
    const content = doc.createElement(kind === 'banner' ? 'button' : 'div');
    if (kind === 'banner') (content as HTMLButtonElement).type = 'button';
    content.className = 'android-notice-content';
    const icon = doc.createElement('span');
    icon.className = 'android-notice-icon';
    icon.setAttribute('aria-hidden', 'true');
    const text = doc.createElement('span');
    text.className = 'android-notice-text';
    const title = doc.createElement('strong');
    const subtitle = doc.createElement('span');
    subtitle.className = 'android-notice-subtitle';
    const body = doc.createElement('span');
    body.className = 'android-notice-body';
    text.append(title, subtitle, body);
    content.append(icon, text);
    const action = doc.createElement('button');
    action.type = 'button';
    action.className = 'android-notice-action';
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'android-notice-close';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.textContent = '×';
    // A separate live region keeps announcements distinct from focusable buttons.
    const live = doc.createElement('span');
    live.className = 'android-notice-announcement';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    card.append(content, action, close);
    host.append(card, live);
    let current: Notice | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lifetime = 0;
    let hover = false;
    let pointer: { id: number; x: number; y: number; moved: boolean } | undefined;
    let suppressClick = false;

    function cancelTimer() {
      clearTimeout(timer);
      timer = undefined;
    }
    function dismiss(id?: string) {
      if (!current || (id !== undefined && id !== current.id)) return;
      cancelTimer();
      current = undefined;
      pointer = undefined;
      card.hidden = true;
      card.style.transform = '';
      live.textContent = '';
    }
    function schedule() {
      cancelTimer();
      if (!current || !lifetime || pointer || hover || card.contains(doc.activeElement)) return;
      timer = setTimeout(() => dismiss(), lifetime);
    }
    close.onclick = () => dismiss();
    if (kind === 'banner')
      content.onclick = () => {
        if (!current) return;
        const id = current.id;
        dismiss();
        for (const handler of listeners.banner) handler({ kind: 'open', id });
      };
    action.onclick = () => {
      if (!current || !('action' in current) || !current.action) return;
      // Shared UI owns preventDefault/keep-open and dismiss(id) after this event.
      const id = current.id;
      for (const handler of listeners.toast) handler({ kind: 'action', id });
    };
    card.addEventListener(
      'click',
      (event) => {
        // A drag must never activate a button at its end or leak to the app below.
        if (suppressClick && event.detail > 0) {
          event.preventDefault();
          event.stopImmediatePropagation();
          suppressClick = false;
        }
      },
      true,
    );
    card.addEventListener('click', (event) => event.stopPropagation());
    card.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || event.button !== 0) return;
      suppressClick = false;
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
      cancelTimer();
      // Capture on the original button so a tap retains its normal click target.
      (event.target as Element).setPointerCapture?.(event.pointerId);
    });
    card.addEventListener('pointermove', (event) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const dy = event.clientY - pointer.y;
      pointer.moved ||= Math.abs(dy) > 8 || Math.abs(event.clientX - pointer.x) > 8;
      card.style.transform = `translateY(${Math.min(0, dy)}px)`;
    });
    const end = (event: PointerEvent) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const dismissing = event.type === 'pointerup' && event.clientY - pointer.y < -24;
      suppressClick = pointer.moved;
      pointer = undefined;
      card.style.transform = '';
      if (dismissing) dismiss();
      else schedule();
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
    card.addEventListener('focusin', cancelTimer);
    card.addEventListener('focusout', () => queueMicrotask(schedule));
    card.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'mouse') {
        hover = true;
        cancelTimer();
      }
    });
    card.addEventListener('pointerleave', (event) => {
      if (event.pointerType === 'mouse') {
        hover = false;
        schedule();
      }
    });
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        dismiss();
      }
    });

    function show(next: Notice) {
      if (disposed || doc.visibilityState === 'hidden') return;
      if (!host.isConnected) doc.body.append(host);
      const sameId = current?.id === next.id;
      current = next;
      // A pointer already down belongs to the previous notice, not this id.
      suppressClick = !!pointer;
      pointer = undefined;
      card.style.transform = '';
      card.dataset.noticeId = next.id;
      title.textContent = next.title;
      subtitle.textContent = 'subtitle' in next ? (next.subtitle ?? '') : '';
      body.textContent = 'tone' in next ? (next.description ?? '') : (next.body ?? '');
      subtitle.hidden = !subtitle.textContent;
      body.hidden = !body.textContent;
      icon.replaceChildren();
      icon.classList.remove('android-notice-ground');
      icon.dataset.tone = 'neutral';
      if ('tone' in next) {
        card.dataset.tone = next.tone;
        icon.dataset.tone = next.glyph === 'offline' ? 'neutral' : next.tone;
        icon.textContent = { success: '✓', error: '!', warning: '⚠', neutral: '' }[next.tone];
        if (next.glyph === 'offline') {
          icon.textContent = '';
          const glyph = doc.createElement('span');
          glyph.className = 'android-notice-mask';
          glyph.style.maskImage = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2"><path d="M2 2l20 20M2 8a16 16 0 0 1 2-1M8 5a16 16 0 0 1 14 3M5 12a11 11 0 0 1 3-2M14 10a11 11 0 0 1 5 2M8.5 15.5a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1"/></svg>')}")`;
          icon.append(glyph);
        }
        action.textContent = next.action?.label ?? '';
        action.hidden = !next.action;
        lifetime = next.sticky ? 0 : next.tone === 'error' ? 4500 : 3000;
      } else {
        action.hidden = true;
        lifetime = 6000;
        if (next.icon) {
          if ('image' in next.icon) {
            const image = doc.createElement('img');
            image.alt = '';
            image.src = next.icon.image;
            image.className = 'android-notice-avatar';
            image.onerror = () => image.remove();
            icon.append(image);
          } else {
            const glyph = doc.createElement('span');
            glyph.className = 'android-notice-mask';
            icon.classList.toggle('android-notice-ground', !!next.icon.ground);
            // Isolated SVG image, tinted by the application theme. Never innerHTML.
            glyph.style.maskImage = `url("data:image/svg+xml,${encodeURIComponent(next.icon.glyph)}")`;
            icon.append(glyph);
          }
        }
      }
      icon.hidden = !icon.hasChildNodes();
      card.hidden = false;
      // Updating the same progress toast keeps its DOM/focus; announce changed text only.
      const announcement = [next.title, subtitle.textContent, body.textContent]
        .filter(Boolean)
        .join(', ');
      if (!sameId || live.textContent !== announcement) live.textContent = announcement;
      schedule();
    }
    return { show, dismiss };
  }
  const bannerSlot = slot('banner');
  const toastSlot = slot('toast');
  const clear = () => {
    bannerSlot.dismiss();
    toastSlot.dismiss();
  };
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') clear();
  };
  doc.addEventListener('visibilitychange', onVisibility);
  const banner: BannerCapability = {
    show: async (notice) => bannerSlot.show(notice),
    subscribe: async (handler) => {
      if (!disposed) listeners.banner.add(handler);
      return () => {
        listeners.banner.delete(handler);
        if (!listeners.banner.size) bannerSlot.dismiss();
      };
    },
  };
  const toast: ToastCapability = {
    show: async (notice) => toastSlot.show(notice),
    dismiss: async (id) => toastSlot.dismiss(id),
    subscribe: async (handler) => {
      if (!disposed) listeners.toast.add(handler);
      return () => {
        listeners.toast.delete(handler);
      };
    },
  };
  return {
    banner,
    toast,
    clear,
    dispose() {
      disposed = true;
      clear();
      doc.removeEventListener('visibilitychange', onVisibility);
      listeners.banner.clear();
      listeners.toast.clear();
      host.remove();
    },
  };
}
