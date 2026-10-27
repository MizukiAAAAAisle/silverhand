/** Match the Android-only CSS budget, in CSS pixels (never native pixels). */
export const SHORT_VIEWPORT_QUERY = '(max-height: 320px)';

export function bindShortViewport(host: Window = window, doc: Document = document): () => void {
  const media = host.matchMedia(SHORT_VIEWPORT_QUERY);
  let alive = true;
  let active: HTMLElement | null = null;
  let frame = 0;
  let lastSize = '';
  let manual = false;
  const cancel = () => { host.cancelAnimationFrame(frame); frame = 0; };
  const userScroll = () => { manual = true; cancel(); };
  const reveal = () => {
    if (!active) return;
    if (!active.isConnected || doc.activeElement?.closest('[data-composer]') !== active) { detach(); return; }
    if (!media.matches) { cancel(); lastSize = ''; manual = false; return; }
    if (manual) return;
    const size = `${host.innerWidth}:${host.innerHeight}:${host.visualViewport?.height}`;
    if (size === lastSize) return;
    lastSize = size;
    cancel();
    const composer = active;
    frame = host.requestAnimationFrame(() => {
      frame = 0;
      if (!alive || manual || active !== composer || !media.matches) return;
      if (!composer.isConnected || doc.activeElement?.closest('[data-composer]') !== composer) { detach(); return; }
      const bounds = composer.getBoundingClientRect();
      const height = host.visualViewport?.height ?? host.innerHeight;
      if (bounds.top < 0 || bounds.bottom > height) {
        composer.scrollIntoView({ block: 'end', inline: 'nearest' });
      }
    });
  };
  const detach = () => {
    cancel();
    host.removeEventListener('resize', reveal);
    host.visualViewport?.removeEventListener('resize', reveal);
    media.removeEventListener('change', reveal);
    doc.removeEventListener('touchmove', userScroll);
    doc.removeEventListener('wheel', userScroll);
    active = null;
    lastSize = '';
    manual = false;
  };
  const focus = () => {
    const composer = doc.activeElement?.closest<HTMLElement>('[data-composer]') ?? null;
    if (composer === active) return;
    detach();
    if (!alive || !composer) return;
    active = composer;
    host.addEventListener('resize', reveal);
    host.visualViewport?.addEventListener('resize', reveal);
    media.addEventListener('change', reveal);
    doc.addEventListener('touchmove', userScroll, { passive: true });
    doc.addEventListener('wheel', userScroll, { passive: true });
    reveal();
  };
  doc.addEventListener('focusin', focus);
  doc.addEventListener('focusout', detach);
  focus();
  return () => {
    alive = false;
    detach();
    doc.removeEventListener('focusin', focus);
    doc.removeEventListener('focusout', detach);
  };
}
