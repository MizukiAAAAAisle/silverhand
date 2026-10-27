import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const fileAmbiguity = Symbol('native file target ambiguity');

export function nativeFileTarget(nodes, filename) {
  const preview = (n) => n['content-desc']?.startsWith('Preview the file ') || n['resource-id']?.endsWith('/preview_icon');
  const prefix = filename + ', ';
  const matches = nodes.filter((n) => !preview(n) && (n.text === filename ||
    (n['content-desc']?.startsWith(prefix) && n['content-desc'].slice(prefix.length).trim().length > 0)));
  if (!matches.length) return null;
  try { assert.equal(matches.length, 1, 'Ambiguous native file target'); }
  catch (error) { error[fileAmbiguity] = true; throw error; }
  const node = matches[0];
  assert.equal(node.enabled, 'true', 'Native file target disabled');
  const rect = (n) => {
    const values = n?.bounds?.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/)?.slice(1).map(Number);
    return values?.every(Number.isSafeInteger) && values[2] > values[0] && values[3] > values[1] ? values : null;
  };
  const screen = rect(nodes[0]), bounds = rect(node);
  assert(screen && screen[0] >= 0 && screen[1] >= 0 && bounds && bounds[0] >= screen[0] && bounds[1] >= screen[1] && bounds[2] <= screen[2] && bounds[3] <= screen[3], 'Native file target has invalid or offscreen bounds');
  const point = { x: Math.floor((bounds[0] + bounds[2]) / 2), y: Math.floor((bounds[1] + bounds[3]) / 2) };
  for (const other of nodes.filter(preview)) {
    const area = rect(other);
    assert(area, 'Native file preview has invalid bounds');
    assert(!(point.x >= area[0] && point.x < area[2] && point.y >= area[1] && point.y < area[3]), 'Native file target center overlaps Preview');
  }
  // DocumentsUI's observed file tile is enabled/focusable but clickable=false.
  // Tap its checked center; do not substitute its separately clickable Preview.
  return { filename, matchedBy: node.text === filename ? 'text' : 'content-desc', node, bounds, screen, point };
}

export function nativeUI(serial) {
  function adb(...args) {
    return execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8' }).trim();
  }
  function nodes() {
    const file = '/sdcard/silverhand-stage1-ui.xml'; // Only this helper's dedicated dump artifact.
    let stage = 'cleanup';
    try {
      adb('shell', 'rm', '-f', file);
      adb('shell', 'test', '!', '-e', file);
      stage = 'dump';
      adb('shell', 'uiautomator', 'dump', file);
      stage = 'read';
      const xml = adb('shell', 'cat', file);
      assert(xml.length > 0, 'Native UI dump returned empty XML');
      const result = [...xml.matchAll(/<node\b([^>]+)>/g)].map((m) =>
        Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])),
      );
      assert(result.length > 0, 'Native UI dump contains no nodes');
      return result;
    } catch (error) {
      throw new Error('Native UI tree ' + stage + ' failed: ' + error.message, { cause: error });
    }
  }
  function tapNode(node) {
    if (!node) throw Error('Native UI node missing');
    const values = node.bounds.match(/\d+/g).map(Number);
    adb(
      'shell',
      'input',
      'tap',
      String(Math.floor((values[0] + values[2]) / 2)),
      String(Math.floor((values[1] + values[3]) / 2)),
    );
  }
  async function tap(match) {
    for (let i = 0; i < 12; i++) {
      const node = nodes().find((n) => n.enabled === 'true' && match(n));
      if (node) {
        tapNode(node);
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw Error('Native UI control not found');
  }
  async function chooseFile(filename, onFile = () => {}) {
    const record = (phase, value) => {
      try { onFile(phase, { at: new Date().toISOString(), ...value }); }
      catch (error) { console.error('File selection observation failed:', String(error)); }
    };
    let stage = 'initial', readIndex = 0, expectedMode = null;
    const downloadsState = (tree) => {
      const prefix = 'com.google.android.documentsui:id/';
      const crumbs = tree.filter((n) => n['resource-id'] === prefix + 'breadcrumb_text');
      if (expectedMode === null && !crumbs.some((n) => n.text === 'Downloads')) return null;
      assert(tree.every((n) => n.package === 'com.google.android.documentsui'), 'Downloads picker identity changed');
      assert(crumbs.length === 1 && crumbs[0].text === 'Downloads' && crumbs[0].enabled === 'true', 'Downloads directory missing or ambiguous');
      const containers = tree.filter((n) => n['resource-id'] === prefix + 'dir_list');
      assert(containers.length === 1 && containers[0].enabled === 'true', 'Downloads file container missing or ambiguous');
      const controls = tree.filter((n) => [prefix + 'sub_menu_list', prefix + 'sub_menu_grid'].includes(n['resource-id']));
      assert.equal(controls.length, 1, 'Downloads view control missing or ambiguous');
      const control = controls[0];
      const mode = control['resource-id'] === prefix + 'sub_menu_list' ? 'grid' : 'list';
      assert.equal(control['content-desc'], mode === 'grid' ? 'List view' : 'Grid view', 'Downloads view control identity changed');
      assert(control.enabled === 'true' && control.clickable === 'true', 'Downloads view control unavailable');
      const rect = (n) => {
        const values = n?.bounds?.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/)?.slice(1).map(Number);
        return values?.every(Number.isSafeInteger) && values[2] > values[0] && values[3] > values[1] ? values : null;
      };
      const screen = rect(tree[0]), bounds = rect(control);
      assert(screen && screen[0] >= 0 && screen[1] >= 0 && bounds && bounds[0] >= screen[0] && bounds[1] >= screen[1] && bounds[2] <= screen[2] && bounds[3] <= screen[3], 'Downloads view control has invalid or offscreen bounds');
      return { mode, breadcrumb: crumbs[0], container: containers[0], control,
        point: { x: Math.floor((bounds[0] + bounds[2]) / 2), y: Math.floor((bounds[1] + bounds[3]) / 2) } };
    };
    const lookup = () => {
      let tree;
      try { tree = nodes(); }
      catch (error) {
        record('read-error', { filename, stage, readIndex, status: 'unknown', error: { type: error.name, message: error.message } });
        throw error;
      }
      let directory;
      try {
        directory = downloadsState(tree);
        if (expectedMode !== null) assert.equal(directory.mode, expectedMode, 'Downloads view mode changed or not established');
        return { tree, target: nativeFileTarget(tree, filename), directory };
      }
      catch (error) {
        // Only this exact cardinality refusal may consume remaining lookup reads.
        // The directory and positive mode were checked on this same tree first.
        if (directory && error[fileAmbiguity] === true && (stage === 'initial' || (stage === 'lookup' && expectedMode !== null)))
          return { tree, target: null, directory, ambiguity: error };
        record('target-rejected', { filename, stage, readIndex, nodes: tree, decision: 'rejected', error: { type: error.name, message: error.message } });
        throw error;
      }
    };
    try {
      const initial = lookup();
      record('initial', { filename, nodes: initial.tree, target: initial.target, directory: initial.directory, alreadyPresent: initial.target !== null, decision: initial.ambiguity ? 'ambiguous' : initial.target ? 'matched' : 'not_found',
        ...(initial.ambiguity ? { candidateCount: initial.ambiguity.actual, error: { type: initial.ambiguity.name, message: initial.ambiguity.message } } : {}) });
      if (initial.directory) {
        expectedMode = initial.directory.mode;
        if (!initial.target && !initial.ambiguity && expectedMode === 'grid') {
          stage = 'list-view';
          record('view-target', initial.directory);
          adb('shell', 'input', 'tap', String(initial.directory.point.x), String(initial.directory.point.y));
          record('view-dispatch-returned', { mode: 'list', point: initial.directory.point, eventConsumption: 'not_observed' });
          expectedMode = 'list';
        }
      } else if (!initial.target) {
        stage = 'show-roots';
        await tap((n) => n['content-desc'] === 'Show roots');
        stage = 'downloads';
        await tap((n) => n.text === 'Downloads');
      }
      stage = 'lookup';
      let lastAmbiguity = null;
      for (let i = 0; i < 12; i++) {
        readIndex = i + 1;
        const { tree, target, directory, ambiguity } = lookup();
        lastAmbiguity = ambiguity ?? null;
        if (target) {
          record('target', { ...target, nodes: tree, directory, readIndex, limit: 12, decision: 'matched' });
          adb('shell', 'input', 'tap', String(target.point.x), String(target.point.y));
          record('dispatch-returned', { filename, point: target.point, eventConsumption: 'not_observed' });
          return;
        }
        if (i === 0 || i === 11)
          record(i === 0 ? 'lookup-first-miss' : 'lookup-last', { filename, nodes: tree, directory, target: null, readIndex, limit: 12,
            decision: ambiguity ? 'ambiguous' : 'not_found',
            ...(ambiguity ? { candidateCount: ambiguity.actual, error: { type: ambiguity.name, message: ambiguity.message } } : {}) });
        await new Promise((r) => setTimeout(r, 200));
      }
      throw lastAmbiguity ?? Error('Native UI control not found');
    } catch (error) {
      record('failure', { filename, stage, readIndex, limit: 12, error: { type: error.name, message: error.message } });
      throw error;
    }
  }

  async function waitFor(match) {
    for (let i = 0; i < 12; i++) {
      const node = nodes().find(match);
      if (node) return node;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw Error('Native UI state not found');
  }
  return { adb, nodes, tap, chooseFile, waitFor };
}
