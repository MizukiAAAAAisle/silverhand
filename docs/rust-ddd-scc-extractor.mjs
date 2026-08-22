#!/usr/bin/env node
// Reproducible import-graph / SCC extractor for the Rust-backend DDD analysis (#task:2167).
//
// Builds a MODULE dependency graph over packages/backend/src, computes strongly
// connected components (Tarjan), and reports:
//   - the largest SCC and its members
//   - in/out degree of a set of "suspect" nodes (service locator, logger, etc.)
//   - the same on a VALUE-ONLY graph (type-only imports dropped) to separate
//     genuine runtime coupling from type coupling.
//
// Method is deliberately simple + auditable: a regex scan of static `import`
// statements (no TS type-resolver). It resolves relative specifiers to files,
// then folds files to a chosen granularity (default: first-level dir under src).
// It is APPROXIMATE (ignores dynamic import(), re-exports through barrels count
// as edges to the barrel). Numbers are reproducible from this script alone.
//
// Usage:
//   node docs/rust-ddd-scc-extractor.mjs [--granularity=dir|file] [--root=packages/backend/src]
//                                        [--suspect=context.ts,logger.ts]

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  }),
);
const ROOT = resolve(args.root || 'packages/backend/src');
const GRAN = args.granularity || 'dir';
const SUSPECTS = (args.suspect || 'context.ts,logger.ts').split(',');

const TS = /\.(ts|tsx)$/;
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (name === 'node_modules' || name === '__tests__' || name.endsWith('.test.ts')) continue;
      walk(p, acc);
    } else if (TS.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) {
      acc.push(p);
    }
  }
  return acc;
}

// Resolve a relative import specifier from `fromFile` to an actual file on disk.
function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // external / package import — ignore
  // NodeNext: TS source imports carry a `.js`/`.jsx` extension that maps to `.ts`/`.tsx` on disk.
  const noExt = spec.replace(/\.(js|jsx)$/, '');
  const base = resolve(dirname(fromFile), noExt);
  const candidates = [
    base + '.ts',
    base + '.tsx',
    base,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

// Fold a file path to a graph node id at the chosen granularity.
function nodeId(file) {
  const rel = relative(ROOT, file);
  if (GRAN === 'file') return rel;
  const first = rel.split('/')[0];
  // Top-level files (e.g. context.ts, routes.ts) are their own node; dirs fold.
  return rel.includes('/') ? first + '/' : rel;
}

const files = walk(ROOT);
// import regex: captures `import type`? and the specifier. [\s\S] spans multi-line
// braced import clauses (`import {\n a,\n b\n} from '...'`).
const IMPORT_RE = /\bimport\s+(type\s+)?[\s\S]*?from\s*['"]([^'"]+)['"]/g;
const IMPORT_BARE = /\bimport\s+['"]([^'"]+)['"]/g;

const edgesAll = new Set(); // "a\tb"
const edgesValue = new Set();
const nodes = new Set();

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const from = nodeId(file);
  nodes.add(from);
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src))) {
    const isType = !!m[1];
    const target = resolveSpecifier(file, m[2]);
    if (!target) continue;
    const to = nodeId(target);
    if (to === from) continue;
    nodes.add(to);
    edgesAll.add(from + '\t' + to);
    if (!isType) edgesValue.add(from + '\t' + to);
  }
  IMPORT_BARE.lastIndex = 0;
  while ((m = IMPORT_BARE.exec(src))) {
    const target = resolveSpecifier(file, m[1]);
    if (!target) continue;
    const to = nodeId(target);
    if (to === from) continue;
    nodes.add(to);
    edgesAll.add(from + '\t' + to);
    edgesValue.add(from + '\t' + to);
  }
}

function tarjan(nodeSet, edgeSet) {
  const adj = new Map();
  for (const n of nodeSet) adj.set(n, []);
  for (const e of edgeSet) {
    const [a, b] = e.split('\t');
    if (adj.has(a)) adj.get(a).push(b);
  }
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  const stronglyConnect = (v) => {
    // iterative Tarjan to avoid stack overflow
    const work = [[v, 0]];
    idx.set(v, index); low.set(v, index); index++; stack.push(v); onStack.add(v);
    while (work.length) {
      const [node, pi] = work[work.length - 1];
      const succ = adj.get(node) || [];
      if (pi < succ.length) {
        work[work.length - 1][1]++;
        const w = succ[pi];
        if (!idx.has(w)) {
          idx.set(w, index); low.set(w, index); index++; stack.push(w); onStack.add(w);
          work.push([w, 0]);
        } else if (onStack.has(w)) {
          low.set(node, Math.min(low.get(node), idx.get(w)));
        }
      } else {
        if (low.get(node) === idx.get(node)) {
          const comp = [];
          let w;
          do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== node);
          sccs.push(comp);
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1][0];
          low.set(parent, Math.min(low.get(parent), low.get(node)));
        }
      }
    }
  };
  for (const v of nodeSet) if (!idx.has(v)) stronglyConnect(v);
  return sccs;
}

function report(label, edgeSet) {
  const sccs = tarjan(nodes, edgeSet).filter((c) => c.length > 1);
  sccs.sort((a, b) => b.length - a.length);
  const largest = sccs[0] || [];
  console.log(`\n=== ${label} ===`);
  console.log(`nodes=${nodes.size} edges=${edgeSet.size} nontrivial-SCCs=${sccs.length}`);
  console.log(`largest-SCC size=${largest.length}`);
  console.log(`largest-SCC members:\n  ${largest.sort().join('\n  ')}`);
  for (const s of SUSPECTS) {
    const suspectNode = [...nodes].find((n) => n === s || n === s.replace(/\.ts$/, '/'));
    if (!suspectNode) { console.log(`suspect ${s}: NOT A NODE`); continue; }
    let inDeg = 0, outDeg = 0;
    for (const e of edgeSet) {
      const [a, b] = e.split('\t');
      if (b === suspectNode) inDeg++;
      if (a === suspectNode) outDeg++;
    }
    console.log(`suspect ${suspectNode}: in=${inDeg} out=${outDeg}`);
  }
}

report('ALL imports (value + type)', edgesAll);
report('VALUE-only imports (type-only dropped)', edgesValue);
