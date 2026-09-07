import { useEffect, useMemo, useRef } from 'react';
import { htmlPreviewSrcDoc, readPinchDelta } from '@/lib/html-preview-csp';

export function AttachmentHtmlPreview({
  html,
  title,
  zoom = 1,
  onPinch,
}: {
  html: string;
  /** Accessible name for the frame — the attachment filename. */
  title: string;
  /** Host-owned visual zoom. The iframe viewport grows inversely so fixed-size
   *  author documents can be scaled down without inspecting their opaque DOM. */
  zoom?: number;
  /** Called with a validated, clamped pinch `deltaY` (one merged value per
   *  animation frame). The host converts it to a scale factor and clamps. */
  onPinch?: (deltaY: number) => void;
}): JSX.Element {
  const srcDoc = useMemo(() => htmlPreviewSrcDoc(html), [html]);
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!onPinch) return undefined;
    let raf = 0;
    let pending = 0;
    const flush = (): void => {
      raf = 0;
      const delta = pending;
      pending = 0;
      if (delta !== 0) onPinch(delta);
    };
    const onMessage = (event: MessageEvent): void => {
      // Only our own frame, only the fixed pinch shape — an author script on the
      // opaque origin can still forge this, but it only zooms its own preview.
      if (event.source !== iframeRef.current?.contentWindow) return;
      const delta = readPinchDelta(event.data);
      if (delta === null) return;
      pending += delta;
      if (raf === 0) raf = requestAnimationFrame(flush);
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [onPinch]);

  return (
    <div className="h-full w-full overflow-hidden bg-white p-1">
      <iframe
        ref={iframeRef}
        title={title}
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="border-0 bg-white"
        style={{
          width: `${100 / safeZoom}%`,
          height: `${100 / safeZoom}%`,
          transform: safeZoom === 1 ? undefined : `scale(${safeZoom})`,
          transformOrigin: 'top left',
        }}
      />
    </div>
  );
}
