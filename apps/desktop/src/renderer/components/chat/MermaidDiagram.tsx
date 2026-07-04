import { useEffect, useRef, useState } from 'react';

/**
 * Renders a ```mermaid fenced block as an actual diagram (#task:1322).
 *
 * Product contract (shiki): a mermaid block AUTO-renders to a diagram by
 * default; only if rendering fails does it fall back to showing the source.
 * The fallback is per-diagram and non-blocking — one broken diagram never
 * takes down the rest of the message.
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
 * fails (or times out) pre-render still falls back to source. See
 * `Markdown.tsx` `pre` and `ImagePreviewModal`.
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

export function MermaidDiagram({ code }: { code: string }): JSX.Element {
  const [state, setState] = useState<RenderState>({ status: 'pending' });
  // Bumped whenever the app theme changes so the render effect re-fires.
  const [themeTick, setThemeTick] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

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

  if (state.status === 'error') {
    // Fall back to the raw source so no information is lost. Styled as a code
    // block (reuses existing `.code-block` CSS) with a mermaid tag so it reads
    // as "this was meant to be a diagram" rather than a plain snippet.
    return (
      <div className="code-block mermaid-fallback">
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

  return (
    <div
      ref={containerRef}
      className="mermaid-diagram"
      data-mermaid-state={state.status}
      // SVG is produced by mermaid with securityLevel:'strict' (DOMPurify-
      // sanitized). While pending we render nothing (no layout jump: the
      // diagram simply appears once ready — diagrams are block-level and
      // typically the last thing to settle in a message).
      dangerouslySetInnerHTML={
        state.status === 'ok' ? { __html: state.svg } : undefined
      }
    >
      {state.status === 'pending' ? (
        <span className="mermaid-diagram__pending">Rendering diagram…</span>
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
