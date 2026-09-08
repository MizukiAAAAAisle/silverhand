import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// #task:1267 §6 — the renderer-consumption fences for brand-typed seq (S2).
//
// The brand types (docs/brand-typed-seq-v1.md) turn "several distinct quantities
// all called seq and typed number" into compile errors. But a brand is only as
// strong as the discipline that no code launders a raw number into a brand
// off-boundary. These source-scans lock the four renderer consumption
// invariants so a future edit can't quietly re-open the #1265-class trap:
//
//   1. §3.1 — the ONE genuine MessageSeq → ReadSeq conversion is minted at
//      streamSourceAtSeq alone (single testable bridge). `asReadSeq(` must not
//      appear anywhere else in the renderer.
//   2. §5/§6 — no scattered `as <SeqBrand>` escape hatch. The only legal
//      number → brand routes are the shared mint (asReadSeq) and the shared
//      validated decoders; a bare cast is the hole the fence forbids.
//   3. §3.6 — the wire is a TYPED TRUST boundary, not a renderer runtime decode
//      boundary: branded DTOs arrive trusted through api<T>() (minted
//      server-side). So no renderer file re-parses a wire seq via a *SeqSchema
//      .parse(). (This bans the SCATTERED per-hook parse — a future centralized
//      apiParse(schema) boundary would be a deliberate, different change.)
//   4. Contract Blocker 4 — MessageSeq is conversation-global, so a cursor↔seq
//      compare is only meaningful same-stream. The shared package deliberately
//      exports NO generic isUnread/isBeyond comparator; the renderer must not
//      import one (it would erase the stream identity from the type).
//
// Plus a positive-space fence: the two legal renderer `number → MessageSeq`
// construction points (§3.3 pending role-defined-zero head, §3.4 localStorage
// hydrate) are the ONLY places decodeMessageSeq is called in production.
//
// The desktop test env is `node` (no jsdom/RTL), so — like
// `realtime-ingestion-read-inert` / `notification-toast-purity` — we statically
// fence the source instead of rendering.

const RENDERER_ROOT = fileURLToPath(new URL(".", import.meta.url));

/** Collect every renderer production `.ts`/`.tsx` (no tests, no decls). */
function rendererSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (entry.name.endsWith(".d.ts")) continue;
      if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
      out.push(full);
    }
  };
  walk(RENDERER_ROOT.replace(/\/$/, ""));
  return out;
}

/** Strip line + block comments so prose (which legitimately says things like
 *  "held as MessageSeq up the chain") never trips a token scan. Crude but
 *  sufficient for a source fence: a string-embedded `//` at worst truncates the
 *  rest of that line, which can only ever HIDE a real hit (a theoretical
 *  false-PASS in a pathological same-line case — none exist in the scanned tree),
 *  never INVENT one, so it cannot manufacture a false failure. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Path relative to the renderer root, for readable failure messages. */
function rel(file: string): string {
  return file.slice(RENDERER_ROOT.length);
}

const FILES = rendererSourceFiles().map((file) => ({
  path: file,
  rel: rel(file),
  code: stripComments(readFileSync(file, "utf8")),
}));

describe("seq-brand renderer consumption fences (#task:1267 §6)", () => {
  it("collected a non-trivial renderer source tree", () => {
    // Guards the walker itself — an empty list would make every fence vacuously
    // pass.
    expect(FILES.length).toBeGreaterThan(50);
  });

  it("mints ReadSeq ONLY at streamSourceAtSeq (§3.1 single bridge)", () => {
    const offenders = FILES.filter(
      (f) => f.code.includes("asReadSeq(") && f.rel !== "features/attention/observe.ts",
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("has NO scattered `as <SeqBrand>` escape-hatch cast (§5/§6)", () => {
    const CAST = /\bas\s+(MessageSeq|ReadSeq|TransportSeq|TransportEpoch|ObservedSeq)\b/;
    const offenders = FILES.filter((f) => CAST.test(f.code)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("never re-parses a wire seq via a *SeqSchema.parse() (§3.6 wire-trust)", () => {
    // Branded wire DTOs are minted server-side and trusted through api<T>(); a
    // per-hook `MessageSeqSchema.parse(...)` is the scattered escape hatch the
    // fence forbids. A future centralized apiParse boundary is a different,
    // deliberate change (and would update this fence). TransportEpochSchema is
    // included: the TransportSeq cut brought TransportEpoch into the renderer
    // consumption face, so a scattered `.parse()` of it is the same hole.
    const SCHEMA_PARSE =
      /(MessageSeq|ReadSeq|TransportSeq|TransportEpoch|ObservedSeq)Schema\s*\.\s*parse/;
    const offenders = FILES.filter((f) => SCHEMA_PARSE.test(f.code)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("imports NO stream-erasing generic cursor comparator (Blocker 4)", () => {
    // The shared package deletes isUnread / isBeyond outright; guard against a
    // renderer reintroducing a stream-key-erasing comparator.
    const offenders = FILES.filter(
      (f) => /\bisUnread\b/.test(f.code) || /\bisBeyond\b/.test(f.code),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("constructs a MessageSeq via decodeMessageSeq ONLY at the two legal points", () => {
    // §3.3 pending provisional head (role-defined zero) + §3.4 localStorage
    // hydrate decode. Everything else arriving as a brand is trusted from the
    // wire (§3.6), so a new decodeMessageSeq call is a new boundary that must be
    // justified here.
    const ALLOWED = new Set([
      "features/channels/hooks.ts",
      // #task:1292: appendPendingMessage's §3.3 provisional-head decode moved
      // here with the append trio.
      "features/channels/message-cache-core.ts",
      "lib/place-memory.ts",
    ]);
    const offenders = FILES.filter(
      (f) => f.code.includes("decodeMessageSeq(") && !ALLOWED.has(f.rel),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("advances a TransportSeq floor ONLY through advanceTransportSeq — no raw `+ 1` (Cindy cond#3)", () => {
    // A TransportSeq `+ 1` decays to a bare number; the sole legal successor is
    // the shared `advanceTransportSeq` boundary (docs/brand-typed-seq-v1.md §4).
    // Lock the resume-floor arithmetic in ws-client so a future edit can't
    // re-introduce a scattered `received.lastSeq + 1` / `floor.lastSeq + 1` that
    // silently drops the brand.
    const RAW_ADVANCE = /\.lastSeq\s*[+-]\s*1\b/;
    const offenders = FILES.filter((f) => RAW_ADVANCE.test(f.code)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("routes every transport-floor advance through advanceTransportSeq alone", () => {
    // Positive-space companion to the ban above: the only renderer consumer of
    // the shared advance boundary is the transport client. If a second file
    // starts advancing a transport floor, it must be reviewed here (and prove it
    // holds the same (scope, epoch) context the helper does not check).
    const ALLOWED = new Set(["lib/ws-client.ts"]);
    const offenders = FILES.filter(
      (f) => f.code.includes("advanceTransportSeq(") && !ALLOWED.has(f.rel),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
