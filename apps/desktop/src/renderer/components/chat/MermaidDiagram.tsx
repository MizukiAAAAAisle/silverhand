import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Code, Copy, Maximize2, Minus, Plus, Workflow } from 'lucide-react';
import { MermaidLightbox } from './MermaidLightbox';

/**
 * Renders a ```mermaid fenced block as an actual diagram (#task:1322), inside its
 * own operable block (#task:2114).
 *
 * Product contract (shiki): a mermaid block AUTO-renders to a diagram by
 * default; only if rendering fails does it fall back to showing the source.
 * The fallback is per-diagram and non-blocking — one broken diagram never
 * takes down the rest of the message.
 *
 * The block's chrome is the CODE BLOCK's chrome (`.code-block` + its header
 * strip), not a second vocabulary: a diagram and a snippet are the same kind of
 * thing in prose — an island with a language tag — and one of this block's two
 * views IS a code block. Reusing it also means every theme already paints this
 * surface (the `island` token family), with no per-theme work.
 *
 * Why lazy `import('mermaid')`: the library is large (~500KB) and most
 * messages have no diagram, so we keep it out of the main renderer chunk and
 * only pay the cost the first time a mermaid block actually mounts.
 *
 * Security (Cindy review boundary): agent-authored markdown is untrusted, so
 * we render with `securityLevel: 'strict'` (mermaid runs the produced SVG
 * through DOMPurify, strips script/click handlers) and `htmlLabels: false`
 * (label text is rendered as SVG <text>, never as injected HTML). Combined
 * with the fact that the surrounding `Markdown` component never enables
 * `rehype-raw`, there is no HTML-injection path through a diagram.
 *
 * Theme: the diagram follows the active app theme — dark themes get mermaid's
 * dark palette, light themes the default. Re-renders when the app theme
 * switches (observes `documentElement[data-theme]`).
 *
 * Export / screenshot: this component is only mounted on the interactive
 * (live) path. The export tree (`interactive={false}` in `Markdown`) can't
 * mount it because the screenshot is captured synchronously and mermaid's
 * async render wouldn't finish in time. Instead the export pipeline
 * (`ImagePreviewModal`) pre-renders each diagram to SVG *before* capture via
 * {@link renderMermaidSvg} — the SAME render entry and theme this component
 * uses — and injects the finished SVG into the static tree; a diagram that
 * fails (or times out) pre-render still falls back to source. That tree keeps
 * the chrome-less `.mermaid-diagram` shell: zoom and a view toggle are
 * interactions, and a captured image has none.
 */

// Monotonic id source: mermaid.render needs a DOM-id-safe unique id per call.
// React's useId yields colons (invalid in a mermaid id), so we use a counter.
let diagramSeq = 0;

/**
 * Render a mermaid source string to a sanitized SVG string. This is the single
 * render entry shared by the live component and the export pre-render pass
 * (#task:1322), so a shared image never drifts in color/style from what's on
 * screen. `dark` selects mermaid's palette; callers pass {@link isDarkTheme}()
 * so both paths follow the active theme. Throws on empty/invalid source — the
 * caller decides the fallback (live: source code block; export: same).
 */
export async function renderMermaidSvg(
  code: string,
  dark: boolean,
): Promise<string> {
  const source = code.trim();
  if (!source) throw new Error('empty diagram');
  const mermaid = (await import('mermaid')).default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    theme: dark ? 'dark' : 'default',
    fontFamily: 'inherit',
  });
  // A parse pass first gives a clean diagnostic without leaving a
  // half-injected error SVG in the DOM (mermaid.render on a syntax
  // error otherwise throws AND appends a visible error node to <body>).
  await mermaid.parse(source);
  const id = `mermaid-${diagramSeq++}`;
  const { svg } = await mermaid.render(id, source);
  return svg;
}

/** Extract the trimmed source of every ```mermaid fence in a markdown string,
 *  for the export pre-render pass (#task:1322). Case-insensitive on the info
 *  string (agents write ```Mermaid too). Keyed identically to the `pre`
 *  override's `extractText(children).trim()`, so a pre-rendered SVG looked up
 *  there matches. A fence this misses simply falls back to source — safe. */
export function extractMermaidSources(markdown: string): string[] {
  const re = /```[ \t]*mermaid[^\n]*\r?\n([\s\S]*?)```/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const src = m[1]!.trim();
    if (src) out.push(src);
  }
  return out;
}

type RenderState =
  | { status: 'pending' }
  | { status: 'ok'; svg: string }
  | { status: 'error'; message: string };

/**
 * Zoom steps, not a continuous factor: a diagram is read at a few useful sizes
 * (fit, a bit closer, twice), and discrete steps make the control's two ends
 * reachable and its state announceable. `1` is "fit the message column" — the
 * SVG's own `max-width: 100%` — so the ladder is relative to what the reader
 * already sees, never to the diagram's intrinsic pixel size, which no reader
 * can see anyway.
 */
const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3] as const;
const ZOOM_BASE_INDEX = ZOOM_STEPS.indexOf(1);

/**
 * Ordinary reading has one vertical scroll owner: the document. A reader who
 * explicitly changes Mermaid zoom opts into a bounded pan viewport instead.
 * Named as a pure decision so the default can never silently regress to the
 * hidden nested scroller fixed by #task:2129.
 */
export function mermaidScrollOwnerForZoom(
  zoom: number,
): 'document' | 'viewport' {
  return zoom === 1 ? 'document' : 'viewport';
}

export function MermaidDiagram({ code }: { code: string }): JSX.Element {
  const [state, setState] = useState<RenderState>({ status: 'pending' });
  // Bumped whenever the app theme changes so the render effect re-fires.
  const [themeTick, setThemeTick] = useState(0);
  // View + zoom are per-block session state, deliberately NOT reset when `code`
  // changes: a streaming edit re-renders the same diagram, and yanking the
  // reader back to fit-width mid-read would read as the block fighting them.
  const [view, setView] = useState<'diagram' | 'code'>('diagram');
  const [zoomIndex, setZoomIndex] = useState(ZOOM_BASE_INDEX);
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // While the fullscreen modal is open the SAME sanitized SVG lives there, so the
  // inline copy is withdrawn: a Mermaid SVG carries internal ids and `url(#…)` /
  // marker / clipPath fragment references, and two live copies in one document
  // collide (duplicate ids → the modal's refs can resolve into the inline
  // `<defs>`). We do NOT re-render or rewrite ids; we simply hold the inline
  // slot's measured height with an id-free placeholder so the message doesn't
  // reflow underneath the modal, then restore the SVG on close (Cindy B1,
  // #task:2130).
  const [inlineHold, setInlineHold] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  const openFullscreen = useCallback(() => {
    setInlineHold(viewportRef.current?.offsetHeight ?? null);
    setFullscreen(true);
  }, []);

  // Re-render on app theme switch so diagram colors track the UI.
  useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(() => setThemeTick(t => t + 1));
    observer.observe(el, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const source = code.trim();
    if (!source) {
      setState({ status: 'error', message: 'empty diagram' });
      return;
    }
    setState({ status: 'pending' });

    void (async () => {
      try {
        const svg = await renderMermaidSvg(source, isDarkTheme());
        if (!cancelled) setState({ status: 'ok', svg });
      } catch (err) {
        // Dev-visible diagnostic (Cindy boundary: failures must stay
        // diagnosable), but the user just sees the source fall-back.
        const message = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error('[mermaid] render failed, showing source:', message);
        if (!cancelled) setState({ status: 'error', message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code, themeTick]);

  const onCopy = useCallback(async () => {
    const text = code.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied; ignore */
    }
  }, [code]);

  if (state.status === 'error') {
    // Fall back to the raw source so no information is lost. Same block chrome,
    // and NO view toggle: there is no diagram to switch to, so the source is
    // not a "view" here — it is all there is. The note says why.
    return (
      <div className="code-block mermaid-block mermaid-fallback">
        <div className="code-block__header">
          <span className="code-block__lang">mermaid</span>
          <span className="mermaid-fallback__note" title={state.message}>
            Unable to render · source shown
          </span>
        </div>
        <pre>
          <code className="language-mermaid">{code}</code>
        </pre>
      </div>
    );
  }

  const zoom = ZOOM_STEPS[zoomIndex] ?? 1;
  const diagramReady = state.status === 'ok';
  const scrollOwner = mermaidScrollOwnerForZoom(zoom);

  return (
    <div
      ref={containerRef}
      className="code-block mermaid-block"
      data-mermaid-state={state.status}
      data-mermaid-view={view}
    >
      <div className="code-block__header">
        {/* LEFT: the view switch IS the label (shiki #task:2130「header 上固定的
            mermaid label 去掉，变成 mermaid + source 固定常驻，点击切换」). Two
            persistent segments, not one flip-button: both destinations stay
            visible and directly clickable, and the active segment names the
            current view — so the switch subsumes the old static `mermaid` tag
            rather than sitting beside it. */}
        <div className="mermaid-block__switch" role="group" aria-label="View">
          <button
            type="button"
            className="mermaid-block__seg"
            data-active={view === 'diagram'}
            data-sticker
            data-sticker-size="sm"
            aria-pressed={view === 'diagram'}
            onClick={() => setView('diagram')}
          >
            <Workflow className="size-3" />
            Mermaid
          </button>
          <button
            type="button"
            className="mermaid-block__seg"
            data-active={view === 'code'}
            data-sticker
            data-sticker-size="sm"
            aria-pressed={view === 'code'}
            onClick={() => setView('code')}
          >
            <Code className="size-3" />
            Code
          </button>
        </div>
        {/* RIGHT: view-scoped actions. Zoom + fullscreen belong to the diagram
            view only — in the code view they would be present and inert, a worse
            answer than their absence. The code view answers with Copy in the same
            slot, matching `CodeBlock`'s header. */}
        <div className="mermaid-block__controls">
          {view === 'diagram' ? (
            <>
              {/* Order is `100% − +` (shiki #task:2130): the readout sits to the
                  LEFT so the two steppers are adjacent and read as one pair. The
                  zoom level is a READOUT, not a control — it is NOT aria-hidden
                  (a visually-hidden "Zoom " prefix gives screen readers "Zoom
                  150%"); reset is by stepping down with `−`. */}
              <span className="mermaid-block__zoom">
                <span className="sr-only">Zoom </span>
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                className="mermaid-block__icon"
                data-sticker
                data-sticker-size="sm"
                onClick={() => setZoomIndex(i => Math.max(0, i - 1))}
                disabled={!diagramReady || zoomIndex === 0}
                aria-label="Zoom out"
                title="Zoom out"
              >
                <Minus className="size-3" />
              </button>
              <button
                type="button"
                className="mermaid-block__icon"
                data-sticker
                data-sticker-size="sm"
                onClick={() =>
                  setZoomIndex(i => Math.min(ZOOM_STEPS.length - 1, i + 1))
                }
                disabled={!diagramReady || zoomIndex === ZOOM_STEPS.length - 1}
                aria-label="Zoom in"
                title="Zoom in"
              >
                <Plus className="size-3" />
              </button>
              {/* Fullscreen opens the read-only pan/zoom modal (#task:2130):
                  inline zoom is capped and bounded to the message column, the
                  modal is the room to inspect a large diagram. */}
              <button
                type="button"
                className="mermaid-block__icon"
                data-sticker
                data-sticker-size="sm"
                onClick={openFullscreen}
                disabled={!diagramReady}
                aria-label="Open fullscreen"
                title="Fullscreen"
              >
                <Maximize2 className="size-3" />
              </button>
            </>
          ) : (
            <button
              type="button"
              className="code-block__copy"
              data-sticker
              data-sticker-size="sm"
              onClick={onCopy}
              title={copied ? 'Copied' : 'Copy source'}
              aria-label="Copy source"
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            </button>
          )}
        </div>
      </div>
      {view === 'code' ? (
        <pre>
          <code className="language-mermaid">{code}</code>
        </pre>
      ) : (
        <div
          ref={viewportRef}
          className="mermaid-block__viewport"
          data-mermaid-scroll={scrollOwner}
        >
          {fullscreen ? (
            // Inline SVG withdrawn while the modal owns the only live copy
            // (Cindy B1). An id-free, aria-hidden spacer holds the measured
            // height so the message doesn't reflow behind the backdrop.
            <div aria-hidden style={{ height: inlineHold ?? undefined }} />
          ) : diagramReady ? (
            <div
              className="mermaid-block__canvas"
              // At 100% the SVG participates in ordinary document layout: no
              // transform/compositor layer and no nested vertical scroller.
              // That keeps the message stream the sole wheel-scroll owner.
              // Once the reader explicitly zooms, transform preserves
              // mermaid's laid-out geometry; the viewport then becomes the
              // deliberate pan surface (see `data-mermaid-scroll`).
              style={zoom === 1 ? undefined : { transform: `scale(${zoom})` }}
              // SVG is produced by mermaid with securityLevel:'strict'
              // (DOMPurify-sanitized).
              dangerouslySetInnerHTML={{ __html: state.svg }}
            />
          ) : (
            // Pending: the block's own shell is already on screen, so this only
            // has to say the inside is still coming.
            <span className="mermaid-diagram__pending">Rendering diagram…</span>
          )}
        </div>
      )}
      {/* Fullscreen viewer, mounted only with a rendered diagram to show — it
          replays the SAME sanitized SVG string, never a re-render. */}
      {diagramReady ? (
        <MermaidLightbox
          open={fullscreen}
          onOpenChange={setFullscreen}
          svg={state.svg}
        />
      ) : null}
    </div>
  );
}

/**
 * Decide dark vs light from the active theme's base background luminance,
 * so the mapping auto-follows any current or future theme rather than
 * hard-coding theme names. Reads `--bg-base` (every theme defines it); falls
 * back to the computed body background, then to light.
 */
export function isDarkTheme(): boolean {
  try {
    const root = document.documentElement;
    const raw = getComputedStyle(root).getPropertyValue('--bg-base').trim();
    const lum = raw ? luminance(raw) : null;
    if (lum != null) return lum < 0.5;
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    const bodyLum = luminance(bodyBg);
    if (bodyLum != null) return bodyLum < 0.5;
  } catch {
    /* getComputedStyle unavailable (e.g. tests) — default light */
  }
  return false;
}

/** Relative luminance (0..1) of a `#rgb`/`#rrggbb`/`rgb(...)` color, or null
 *  if unparseable. Simple perceptual weighting; precision isn't critical, we
 *  only need the dark/light side of 0.5. */
function luminance(color: string): number | null {
  const rgb = parseColor(color);
  if (!rgb) return null;
  const [r, g, b] = rgb;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function parseColor(color: string): [number, number, number] | null {
  const c = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = h.split('').map(ch => ch + ch).join('');
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(c);
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  return null;
}
