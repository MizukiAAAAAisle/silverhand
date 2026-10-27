// Independent B3 units on disposable fixtures; S1 remains the normal path.
import assert from 'node:assert/strict';
import { runT2 } from './acceptance-t2.mjs';
import { nativeTlsMatch } from './t1-tls-evidence.mjs';
import { writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { leftControlTarget } from './acceptance-b2.mjs';

export const searchInput = 'input[placeholder="Search people, agents, messages, channels"]';
const live = '[data-page]:not([inert]):not([aria-hidden="true"])';
export const searchSelector = `${live} ${searchInput}`;

// Bounded, existing DOM fields only. Kept pages must not count as current results.
export function searchPageState(document) {
  const view = document.defaultView;
  const pages = [...document.querySelectorAll('[data-page]')].filter(e => !e.hasAttribute('inert') && e.getAttribute('aria-hidden') !== 'true');
  const page = pages.length === 1 ? pages[0] : null;
  const inputs = page ? [...page.querySelectorAll('input[placeholder="Search people, agents, messages, channels"]')] : [];
  const list = page?.querySelector('.search-list');
  const rows = list ? [...list.querySelectorAll('section ul > li > button')] : [];
  const clear = page?.querySelector('button[aria-label="Clear search"]');
  const active = document.activeElement;
  return {
    sampledAt: Date.now(), route: view.location.hash, origin: view.location.origin,
    timeOrigin: view.performance.timeOrigin, layout: document.documentElement.dataset.layout,
    viewport: { width: view.innerWidth, height: view.innerHeight, visualHeight: view.visualViewport?.height ?? null },
    pageCount: pages.length, searchInputCount: inputs.length, query: inputs[0]?.value ?? null,
    inputFocused: inputs.length === 1 && active === inputs[0],
    activeElement: active ? { tag: active.tagName, id: active.id, placeholder: active.getAttribute('placeholder') } : null,
    sidebarStyle: view.localStorage.getItem('silverhand:layout.sidebar-style') ?? 'tree(default)',
    rowCount: rows.length, rows: rows.slice(0, 12).map(e => ({ text: e.textContent.trim().slice(0, 1000), disabled: e.disabled })),
    rowsTruncated: rows.length > 12, listText: list?.textContent.slice(0, 2000) ?? null,
    clearDisabled: clear?.disabled ?? null,
    dialogs: document.querySelectorAll('[role=dialog]').length,
    toolbars: document.querySelectorAll('[role=toolbar][aria-label="Message selection"]').length,
  };
}

export function assertSearchAnswer(answer, target = null) {
  assert(Array.isArray(answer.results), 'Search response has no result array');
  assert(answer.identities?.humans && answer.identities?.agents, 'Search identity response missing');
  assert.equal(answer.identities.humans.results.length, 0, 'Unexpected human match');
  assert.equal(answer.identities.agents.results.length, 0, 'Unexpected agent match');
  if (!target) {
    assert.equal(answer.results.length, 0, 'No-match fixture query has results');
    assert.equal(answer.total, 0, 'No-match query total is not zero');
    return;
  }
  assert.equal(answer.results.length, 1, 'Fixture query is not unique');
  const result = answer.results[0];
  assert.equal(result.type, 'message');
  assert.equal(result.message.id, target.id, 'Search returned a different message');
  assert.equal(result.message.content, target.content);
  assert.equal(result.conversation.channel_id, target.channel);
  assert.equal(result.conversation.workspace?.id, target.workspace);
  assert.equal(answer.total, 1);
}

export function resultMatches(state, target, absent) {
  return state.route === '#/chat/search' && state.pageCount === 1 && state.searchInputCount === 1 &&
    state.query === target.query && state.rowCount === 1 && !state.rowsTruncated &&
    state.rows[0].text.includes(target.content) && state.rows[0].text.includes(target.channelTitle) &&
    state.rows[0].text.includes(target.workspaceName) && !state.rows[0].text.includes(absent.content);
}

export function imeShown(text) {
  return /mInputShown=true|isInputViewShown=true/.test(text);
}

// Radix Select gives ItemText a generated ID; the option refers to it.
// Resolve the existing relation uniquely; never add an ID or pick a first span.
export function searchOptionTarget(document, label) {
  const options = [...document.querySelectorAll('[role="option"]')];
  const escape = document.defaultView.CSS.escape;
  const candidates = [];
  for (const option of options) {
    const labelledby = option.getAttribute('aria-labelledby');
    const ids = labelledby?.trim().split(/\s+/).filter(Boolean) ?? [];
    if (ids.length !== 1) return { count: 0, selector: null, reason: 'label_relation_missing_or_multiple' };
    const nodes = [...document.querySelectorAll('#' + escape(ids[0]))];
    if (nodes.length !== 1) return { count: 0, selector: null, reason: 'label_id_not_unique' };
    const text = nodes[0];
    if (text.tagName !== 'SPAN' || !option.contains(text) || text.closest('[role="option"]') !== option)
      return { count: 0, selector: null, reason: 'label_not_owned_item_text' };
    if (text.textContent.includes(label)) candidates.push({ option, labelledby, text });
  }
  if (candidates.length !== 1) return { count: candidates.length, selector: null, reason: 'option_not_unique' };
  const { option, labelledby, text } = candidates[0];
  const selector = '[role="option"][aria-labelledby="' + escape(labelledby) + '"]';
  if (document.querySelectorAll(selector).length !== 1)
    return { count: candidates.length, selector: null, reason: 'option_relation_not_unique' };
  option.scrollIntoView({ block: 'center' });
  return { count: 1, selector, labelledby, text: text.textContent.slice(0, 200) };
}

export async function clickSearchOption(c, observe, click, label, name) {
  const target = await c.evaluate(`(${searchOptionTarget.toString()})(document,${JSON.stringify(label)})`);
  observe(name + '-option', target);
  assert(target.count === 1 && target.selector, 'S2 option identity unavailable');
  await click(target.selector, undefined, name);
}

// Auth mode belongs to one actual auth form, not the preceding brand heading.
export function searchAuthMode(document) {
  const forms = [...document.querySelectorAll('[data-auth-form]')];
  const state = { formCount: forms.length, ready: false, mode: null };
  if (forms.length !== 1) return { ...state, reason: 'auth_form_not_unique' };
  const form = forms[0], titles = [...form.querySelectorAll('h1')];
  state.titleCount = titles.length;
  if (titles.length !== 1) return { ...state, reason: 'auth_title_not_unique' };
  state.title = titles[0].textContent.trim().slice(0, 80);
  const mode = state.title === 'Log in' ? 'login' : state.title === 'Sign up' ? 'signup' : null;
  if (!mode) return { ...state, reason: 'auth_title_unrecognized' };
  const count = selector => form.querySelectorAll(selector).length;
  const exact = (selector, text) => [...form.querySelectorAll(selector)].filter(e => e.textContent.trim() === text).length;
  state.emailCount = count('#auth-email'); state.passwordCount = count('#auth-password');
  state.submitCount = exact('button[type=submit]', mode === 'login' ? 'Log in' : 'Create account');
  state.loginToggleCount = exact('button[type=button]', 'Log in');
  state.signupToggleCount = exact('button[type=button]', 'Sign up');
  if (state.emailCount !== 1 || state.passwordCount !== 1 || state.submitCount !== 1 ||
      document.querySelectorAll('#auth-email').length !== 1 || document.querySelectorAll('#auth-password').length !== 1 ||
      (mode === 'signup' ? state.loginToggleCount !== 1 || state.signupToggleCount !== 0 : state.loginToggleCount !== 0 || state.signupToggleCount > 1))
    return { ...state, reason: 'auth_controls_not_unique' };
  return { ...state, ready: true, mode, reason: null };
}

// Build the exact S2 CDP expression in one place; host executes this string too.
export function searchIsolationStateExpression({ waitForRoot = false } = {}) {
  // Only the signed-out wait may observe a document with no root yet.
  // Keep it distinct from a normal empty page; all other reads stay strict.
  const rootGuard = waitForRoot ? "if(!document.documentElement)return{readiness:'not_ready',reason:'document_root_missing'};" : '';
  return `(()=>{${rootGuard}const base=(${searchPageState.toString()})(document);const page=[...document.querySelectorAll('[data-page]')].find(e=>!e.hasAttribute('inert')&&e.getAttribute('aria-hidden')!=='true');const lists=[...document.querySelectorAll('.search-list')];return{...base,loading:!!page?.querySelector('[role=status][aria-label="Loading search results"]'),alert:page?.querySelector('[role=alert]')?.textContent?.slice(0,500)??null,allSearchLists:lists.length,hiddenSearchLists:lists.filter(e=>!!e.closest('[inert]')||!!e.closest('[aria-hidden="true"]')).length,filterExpanded:page?.querySelector('[data-filter-toggle]')?.getAttribute('aria-expanded')??null,filterLabels:['Project filter','Sender filter','Time filter'].map(label=>({label,text:page?.querySelector('[aria-label="'+label+'"]')?.textContent?.trim().slice(0,160)??null})),authForm:!!document.querySelector('[data-auth-form]'),authEmailCount:document.querySelectorAll('#auth-email').length}})()`;
}

// Same final assertions/read order as S1; the completion marker follows them all.
export async function completeSearchRestoration({ chats, finalIME, readIdentity, capture, expectedUserId, observe }) {
  assert(!finalIME.shown, 'IME remained after return');
  const identity = await readIdentity();
  assert.equal(identity.me?.status, 200, 'Native session missing after return');
  const actualUserId = JSON.parse(identity.me.bodyText).id;
  assert.equal(actualUserId, expectedUserId, 'Native fixture identity changed');
  observe('s1-native-session', { userId: expectedUserId, status: identity.me.status });
  await capture();
  observe('s1-restoration-complete', {
    status: 'passed', chats, finalIME,
    native: { status: identity.me.status, expectedUserId, observedUserId: actualUserId },
  });
}

export async function searchClick(c, observe, selector, text, name) {
  const state = () => c.evaluate(`(${searchPageState.toString()})(document)`);
  let primary;
  const before = await state();
  try {
    await c.evaluate('delete window.__b2LeftClickTarget');
    // Existing checked-click helper: same-target reference, route and real hit.
    const args = `${JSON.stringify(selector)},${JSON.stringify(text)},${JSON.stringify({ route: before.route })}`;
    const target = await c.evaluate(`(${leftControlTarget.toString()})(document,${args})`);
    observe(name + '-target', target);
    assert(target.ready && !target.fatal, 'B3 click rejected: ' + target.reason);
    const check = await c.evaluate(`(${leftControlTarget.toString()})(document,${args})`);
    observe(name + '-check', check);
    const current = await state();
    assert(current.origin === before.origin && current.timeOrigin === before.timeOrigin && current.route === before.route, 'B3 click document changed');
    assert(check.ready && !check.fatal, 'B3 click identity/hit rejected: ' + check.reason);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...check.point });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...check.point });
    observe(name + '-dispatch-returned', { point: check.point, consumption: 'asserted by following UI observation' });
  } catch (error) { primary = error; throw error; }
  finally {
    try { await c.evaluate('delete window.__b2LeftClickTarget'); }
    catch (error) { observe(name + '-release-error', String(error)); if (!primary) throw error; }
  }
}

async function runS1({ c, api, call, adb, input, serial, out, token, fixture, step, observe }) {
  let primary, imeRead = 0;
  const state = () => c.evaluate(`(${searchPageState.toString()})(document)`);
  async function until(name, predicate, read = state) {
    const deadline = Date.now() + 30000;
    let last;
    for (let reads = 1; reads <= 150; reads++) {
      last = await read();
      if (reads === 1) observe(name + '-first', last);
      const expired = Date.now() >= deadline;
      if (!expired && predicate(last)) { observe(name, { reads, value: last }); return last; }
      if (expired || reads === 150) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(200, Math.max(0, deadline - Date.now()))));
    }
    observe(name + '-last', last);
    throw Error('B3 S1 condition deadline: ' + name);
  }
  async function capture(name) {
    const startedAt = new Date().toISOString();
    const bytes = execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 15000 });
    writeFileSync(out + '/' + name + '.png', bytes);
    observe(name + '-capture', { startedAt, returnedAt: new Date().toISOString(), file: name + '.png', frameTime: 'not_measured' });
  }
  const click = (selector, text, name) => searchClick(c, observe, selector, text, name);
  function ime(name) {
    const dump = adb('shell', 'dumpsys', 'input_method');
    const file = name + '-' + (++imeRead) + '.txt';
    writeFileSync(out + '/' + file, dump);
    const value = { shown: imeShown(dump), evidence: file, matched: dump.split('\n').filter(s => /mInputShown=|isInputViewShown=/.test(s)).slice(0, 8) };
    assert(value.matched.length > 0, 'IME visibility fields unavailable');
    observe(name, value);
    return value;
  }
  async function hideIME(name, required = false) {
    if (!ime(name + '-before').shown) { assert(!required, 'IME disappeared before the specified Back'); return; }
    const before = await state();
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await until(name + '-hidden', value => !value.shown, () => ime(name + '-poll'));
    const after = await state();
    observe(name + '-route-query', { before, after });
    assert.equal(after.route, before.route, 'IME Back navigated the page');
    assert.equal(after.query, before.query, 'IME Back cleared query');
  }
  async function query(target, absent, name) {
    await input(searchSelector, target.query);
    return until(name, value => resultMatches(value, target, absent));
  }
  try {
    let preparedFixture;
    await step('PRE.S1.fixture-login', async () => {
      // Two real channels/messages, exact POST identities; no response replacement.
      const identity = await call('authState');
      assert.equal(identity.me?.status, 200, 'Shared login did not establish native session');
      assert.equal(JSON.parse(identity.me.bodyText).id, fixture.userId, 'Shared login identity differs from signup');
      const stamp = String(Date.now());
      const workspaceName = 'B3 Search ' + stamp;
      const workspaceResponse = await api('/api/workspaces', 'POST', { name: workspaceName }, token);
      const workspace = workspaceResponse.workspace ?? workspaceResponse;
      assert(typeof workspace.id === 'string' && workspace.id);
      const targets = [];
      for (const letter of ['A', 'B']) {
        const channelTitle = 'S1 channel ' + letter + ' ' + stamp;
        const cb = await api(`/api/workspaces/${workspace.id}/channels`, 'POST', { title: channelTitle }, token);
        const channel = cb.channel ?? cb;
        const query = `b3s1${letter.toLowerCase()}${stamp}`;
        const content = query + ' unique message ' + letter;
        const mb = await api(`/api/channels/${channel.id}/messages`, 'POST', { content }, token);
        const message = mb.message ?? mb;
        assert(typeof message.id === 'string' && message.id, 'POST did not return message identity');
        targets.push({ id: message.id, channel: channel.id, workspace: workspace.id, channelTitle, workspaceName, query, content });
      }
      const [a, b] = targets, missing = 'b3s1missing' + stamp;
      for (const target of targets) {
        const answer = await api('/api/search?' + new URLSearchParams({ q: target.query, include_identities: 'true', limit: '100' }), 'GET', undefined, token);
        assertSearchAnswer(answer, target);
        observe('s1-server-' + target.query, { query: target.query, target, answer });
      }
      const noMatch = await api('/api/search?' + new URLSearchParams({ q: missing, include_identities: 'true', limit: '100' }), 'GET', undefined, token);
      assertSearchAnswer(noMatch);
      observe('s1-fixture', { accountEmail: fixture.email, targets, missing, noMatch });
      await until('s1-chats-ready', v => v.layout === 'compact' && v.pageCount === 1 && v.route === '#/chat');
      preparedFixture = { a, b, missing, noMatch, stamp, targets };
      return preparedFixture;
    });
    const { a, b, missing, noMatch, stamp, targets } = preparedFixture;
    await step('B3.S1.mobile-entry', async () => {
      await click(`${live} aside[data-sidebar="workspaces"] button`, 'Search', 's1-mobile-search');
      const entered = await until('s1-search-entered', v => v.route === '#/chat/search' && v.searchInputCount === 1 && v.query === '' && v.clearDisabled === true && v.listText?.includes('Type to search'));
      await capture('s1-mobile-entry');
      return { entry: 'compact Chats sidebar Search', state: entered };
    });
    await step('B3.S1.query-results', async () => {
      const first = await query(a, b, 's1-query-a'), second = await query(b, a, 's1-query-b');
      await capture('s1-query-results');
      return { first, second, input: 'React value/input event via CDP; real IME separately in back-and-ime', serverIds: targets.map(t => t.id) };
    });
    await step('B3.S1.empty-clear', async () => {
      await click(`${live} button[aria-label="Clear search"]`, undefined, 's1-clear');
      const cleared = await until('s1-cleared', v => v.query === '' && v.clearDisabled === true && v.rowCount === 0 && v.listText?.includes('Type to search'));
      await input(searchSelector, missing);
      const empty = await until('s1-no-match', v => v.query === missing && v.rowCount === 0 && v.listText?.includes('No matches') && !v.listText.includes('Search failed'));
      await capture('s1-empty-clear');
      return { cleared, empty, serverNoMatch: noMatch };
    });
    await step('B3.S1.message-navigation', async () => {
      await query(b, a, 's1-result-before-jump');
      await hideIME('s1-before-result-back');
      // Exact unique content and existing place context are checked above, not a synthetic result id.
      await click(`${live} .search-list section ul > li > button`, undefined, 's1-result-open');
      const expectedRoute = '#/chat/w/' + b.workspace + '/c/' + b.channel;
      const target = await until('s1-message-target', v => v.route === expectedRoute && v.matches === 1 && v.text.includes(b.content) && v.visible, async () => c.evaluate(`(()=>{const nodes=[...document.querySelectorAll(${JSON.stringify(live + ' [data-message-row]')})].filter(e=>e.id===${JSON.stringify('msg-' + b.id)});const e=nodes[0],r=e?.getBoundingClientRect();return{route:location.hash,matches:nodes.length,id:e?.id,text:e?.textContent??'',visible:!!r&&r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight}})()`));
      await capture('s1-message-navigation');
      const returnBefore = await state();
      assert(!ime('s1-result-back-before').shown, 'Result page unexpectedly opened IME before navigation Back');
      adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
      const returned = await until('s1-return-search', v => v.route === '#/chat/search' && v.searchInputCount === 1);
      const returnIME = ime('s1-result-back-after');
      assert(!returnIME.shown, 'Navigation Back raised IME');
      observe('s1-result-back-consumption', { before: returnBefore, after: returned, ime: returnIME, expectedLayer: 'result page to Search' });
      return { target, returned, expectedMessageId: b.id, queryPersistenceRequired: false };
    });
    await step('B3.S1.back-and-ime', async () => {
      // Clear through UI before an OS-key input probe. Do not treat CDP filling as IME coverage.
      if ((await state()).clearDisabled === false) await click(`${live} button[aria-label="Clear search"]`, undefined, 's1-ime-clear');
      await until('s1-ime-empty', v => v.query === '' && v.clearDisabled === true);
      await click(searchSelector, undefined, 's1-ime-focus');
      await until('s1-input-focused', v => v.inputFocused);
      await until('s1-ime-shown', v => v.shown, () => ime('s1-ime-visible'));
      const probe = 'b3ime' + stamp;
      adb('shell', 'input', 'text', probe);
      const typed = await until('s1-os-key-input', v => v.query === probe && v.inputFocused);
      await capture('s1-ime');
      await hideIME('s1-back-ime', true);
      adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
      const queryCleared = await until('s1-back-query', v => v.route === '#/chat/search' && v.query === '' && v.clearDisabled === true);
      assert(!ime('s1-query-back-after').shown, 'Query-clearing Back raised IME');
      observe('s1-query-back-consumption', { queryCleared, expectedLayer: 'Search Escape query reset' });
      adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
      const chats = await until('s1-back-chats', v => v.route === '#/chat' && v.layout === 'compact' && v.pageCount === 1 && v.dialogs === 0 && v.toolbars === 0);
      await completeSearchRestoration({ chats, finalIME: ime('s1-final-ime'),
        readIdentity: () => call('authState'), capture: () => capture('s1-restored'),
        expectedUserId: fixture.userId, observe });
      return { typed, queryCleared, chats, coverage: 'Android IME visible + ADB ASCII input + Back consumption; no soft-keyboard keypress, composition or InputConnection protocol claim' };
    });
  } catch (error) {
    primary = error;
    try { observe('s1-failure-state', await state()); await capture('s1-failure'); }
    catch (captureError) { observe('s1-failure-observation-error', String(captureError)); }
    throw error;
  } finally {
    try {
      await c.evaluate('delete window.__b2LeftClickTarget');
      observe('s1-reference-release', { status: 'released', finalState: await state(), productOrWindowChanged: false });
    } catch (error) {
      observe('s1-reference-release', { status: 'failed', error: String(error) });
      if (!primary) throw error;
    }
  }
}

// T1 is an independent read/navigation unit; all product state still comes from UI/API.
// Called only after the original mobile-board route/rows predicate qualifies.
// Unknown counts include cold errors: the DOM does not expose that distinction.
export function taskInitialCountsReady(board, expected, observe) {
  let unknown = false, rejection;
  try {
    for (const status of ['todo', 'in_progress']) {
      const columns = board.columns.filter(column => column.status === status);
      rejection = { reason: 'column_identity', status, expected: String(expected[status]), value: null };
      assert.equal(columns.length, 1, 'T1 column identity');
      const value = columns[0].count;
      if (value === '–') { unknown = true; continue; }
      rejection = { reason: 'invalid_count', status, expected: String(expected[status]), value };
      assert(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), 'Invalid T1 board count');
      rejection.reason = 'count_differs';
      assert.equal(value, String(expected[status]));
    }
    return !unknown;
  } catch (error) {
    try { observe('t1-board-count-rejected', { ...rejection, snapshot: board }); }
    catch (recordError) { error.t1CountRecordError = String(recordError); error.t1CountRejectedSnapshot = { ...rejection, snapshot: board }; }
    throw error;
  }
}

export function taskPageState(document) {
  const base = searchPageState(document), view = document.defaultView;
  const pages = [...document.querySelectorAll('[data-page]')].filter(e => !e.hasAttribute('inert') && e.getAttribute('aria-hidden') !== 'true');
  const page = pages.length === 1 ? pages[0] : null, boards = page ? [...page.querySelectorAll('[data-tasks-board]')] : [];
  const details = page ? [...page.querySelectorAll('[aria-label="Task detail"]')] : [], detail = details.length === 1 ? details[0] : null;
  const headings = detail ? [...detail.querySelectorAll('h1')] : [];
  const columns = boards.length === 1 ? [...boards[0].querySelectorAll('[data-tasks-column]')].map(col => {
    const rows = [...col.querySelectorAll('[data-task-id]')];
    return { status: col.getAttribute('data-status'), expanded: col.querySelector('[data-tasks-column-header]')?.getAttribute('aria-expanded'),
      count: col.querySelector('[data-tasks-column-header]')?.lastElementChild?.textContent.trim() ?? null,
      loading: !!col.querySelector('[role=status][aria-label="Loading tasks"]'),
      text: col.querySelector('[data-tasks-column-body]')?.textContent.trim().slice(0,3000) ?? null,
      rows: rows.slice(0,20).map(e => { const titles=[...e.querySelectorAll(':scope > div.pointer-events-none > span')]; return { id:e.getAttribute('data-task-id'), number:e.getAttribute('data-task-number'), titleCount:titles.length, title:titles.length===1?titles[0].textContent.trim():null, text:e.textContent.trim().slice(0,600) }; }), truncated:rows.length>20 };
  }) : [];
  // PaneBody renders flat label/value pairs, not a table or hidden API state.
  const metadata=detail?[...detail.querySelectorAll('.task-pane-meta')]:[];
  const metaValue=label=>{const labels=metadata.length===1?[...metadata[0].children].filter(e=>e.tagName==='SPAN'&&e.textContent.trim()===label):[];const value=labels.length===1&&labels[0].nextElementSibling?.tagName==='DIV'?labels[0].nextElementSibling:null;return{count:labels.length,value}};
  const statusRow=metaValue('Status'),channelRow=metaValue('Channel');
  const badges=statusRow.value?[...statusRow.value.querySelectorAll('[data-task-status]')]:[];
  const channelNames=channelRow.value?[...channelRow.value.querySelectorAll('span[title]')]:[];
  const detailMeta={containerCount:metadata.length,statusRowCount:statusRow.count,statusBadgeCount:badges.length,status:badges.length===1?badges[0].getAttribute('data-task-status'):null,statusText:badges.length===1?badges[0].textContent.trim():null,channelRowCount:channelRow.count,channelNameCount:channelNames.length,channelName:channelNames.length===1?channelNames[0].textContent.trim():null,channelTitle:channelNames.length===1?channelNames[0].getAttribute('title'):null};
  const params = new view.URLSearchParams(view.location.hash.split('?')[1] ?? '');
  return { ...base, detailMeta, boardCount:boards.length, columns, boardScrollLeft:boards[0]?.scrollLeft ?? null,
    detailCount:details.length, taskId:params.get('task'), titleCount:headings.length, title:headings.length===1?headings[0].textContent.trim():null,
    detailText:detail?.textContent.slice(0,6000)??null, detailLoading:!!detail?.querySelector('[role=status][aria-label="Loading task"]'),
    detailRetryCount:detail?[...detail.querySelectorAll('button')].filter(e=>e.textContent.trim()==='Retry').length:0,
    filterLabels:page?[...page.querySelectorAll('[data-task-filter-bar] button[aria-label]')].map(e=>({label:e.getAttribute('aria-label'),text:e.textContent.trim()})):[],
    taskPanelsAll:document.querySelectorAll('[aria-label="Task detail"]').length };
}
export function taskStateExpression() {
  return `(()=>{const searchPageState=(${searchPageState.toString()});return (${taskPageState.toString()})(document)})()`;
}

export function taskAlignCard(document, target) {
  const view=document.defaultView, esc=view.CSS.escape, live='[data-page]:not([inert]):not([aria-hidden="true"])';
  const pages=[...document.querySelectorAll(live)], boards=pages.length===1?[...pages[0].querySelectorAll('[data-tasks-board]')]:[];
  const columns=boards.length===1?[...boards[0].querySelectorAll('[data-tasks-column]')].filter(e=>e.getAttribute('data-status')===target.status):[];
  const cards=columns.length===1?[...columns[0].querySelectorAll('[data-task-id]')].filter(e=>e.getAttribute('data-task-id')===target.id&&e.getAttribute('data-task-number')===String(target.number)):[];
  const counts={pages:pages.length,boards:boards.length,columns:columns.length,cards:cards.length};
  if(pages.length!==1||boards.length!==1||columns.length!==1||cards.length!==1||boards[0].querySelectorAll('[data-task-id="'+esc(target.id)+'"]').length!==1) return {ready:false,reason:'task_card_not_unique',counts};
  const card=cards[0], buttons=[...card.querySelectorAll('button[aria-label="Open task detail"]')];
  if(buttons.length!==1)return{ready:false,reason:'task_button_not_unique',counts:{...counts,buttons:buttons.length}};
  const button=buttons[0], before=boards[0].scrollLeft;
  card.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
  const box=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,bottom:r.bottom,left:r.left,right:r.right}};
  const rect=box(button), point={x:rect.x+rect.width/2,y:rect.y+rect.height/2};
  let clip={left:0,top:0,right:view.innerWidth,bottom:view.innerHeight};const ancestors=[];
  for(let e=button.parentElement;e;e=e.parentElement){const s=view.getComputedStyle(e),r=box(e);const x=/(auto|scroll|hidden|clip)/.test(s.overflowX),y=/(auto|scroll|hidden|clip)/.test(s.overflowY);if(x||y){ancestors.push({tag:e.tagName,rect:r,overflowX:s.overflowX,overflowY:s.overflowY});if(x){clip.left=Math.max(clip.left,r.left);clip.right=Math.min(clip.right,r.right)}if(y){clip.top=Math.max(clip.top,r.top);clip.bottom=Math.min(clip.bottom,r.bottom)}}}
  const hit=document.elementFromPoint(point.x,point.y), inside=rect.width>0&&rect.height>0&&point.x>=clip.left&&point.x<clip.right&&point.y>=clip.top&&point.y<clip.bottom;
  const ready=inside&&!button.disabled&&!!hit&&(hit===button||button.contains(hit));
  const selector=live+' [data-tasks-board] [data-tasks-column][data-status="'+esc(target.status)+'"] [data-task-id="'+esc(target.id)+'"][data-task-number="'+esc(String(target.number))+'"] button[aria-label="Open task detail"]';
  if(ready)view.__b3TaskCardTarget={button,card,document,href:view.location.href,origin:view.location.origin,timeOrigin:view.performance.timeOrigin,selector};
  return {ready,reason:ready?null:'task_card_clipped_disabled_or_occluded',counts,selector,rect,cardRect:box(card),clip,ancestors,point,hit:!!hit&&(hit===button||button.contains(hit)),scrollLeftBefore:before,scrollLeftAfter:boards[0].scrollLeft};
}
export async function clickTaskCard(c,observe,target,name,{dispatch=true}={}) {
  let primary;
  try {
    const aligned=await c.evaluate(`(${taskAlignCard.toString()})(document,${JSON.stringify(target)})`);
    observe(name+'-alignment',aligned);assert(aligned.ready,'T1 task card alignment rejected: '+aligned.reason);
    if(!dispatch)return aligned;
    const tracked={send:(...args)=>c.send(...args),evaluate:expression=>c.evaluate(expression.includes('function leftControlTarget')?`(()=>{const t=window.__b3TaskCardTarget;if(!t||t.document!==document||t.href!==location.href||t.origin!==location.origin||t.timeOrigin!==performance.timeOrigin||!t.card.isConnected||!t.button.isConnected||document.querySelector(${JSON.stringify(aligned.selector)})!==t.button)throw Error('T1 aligned card replaced');return ${expression}})()`:expression)};
    await searchClick(tracked,observe,aligned.selector,undefined,name);
    return aligned;
  } catch(error) { primary=error; throw error; }
  finally {
    try { await c.evaluate('delete window.__b3TaskCardTarget'); }
    catch(error) { observe(name+'-release-error',String(error)); if(!primary)throw error; }
  }
}
// Exact persisted system event, scoped to the active page. Text is only an
// additional task-number assertion after identity/locate/flash are established.
export function taskEventStateExpression(messageId, conversationId) {
  return `(()=>{
    const id=${JSON.stringify(messageId)},conversation=${JSON.stringify(conversationId)};
    const nodes=[...document.querySelectorAll('[data-page]:not([inert]):not([aria-hidden="true"]) [data-system-message-id]')].filter(e=>e.dataset.systemMessageId===id&&e.dataset.messageConversationId===conversation);
    const e=nodes.length===1?nodes[0]:null,r=e?.getBoundingClientRect(),list=e?.closest('[data-message-list]');
    let owner=null;try{owner=JSON.parse(list?.dataset.systemJumpOwner??'null')}catch{}
    return{messageCount:nodes.length,messageText:e?.textContent.slice(0,1500)??null,eventId:e?.dataset.systemMessageId??null,eventConversation:e?.dataset.messageConversationId??null,
      eventVisible:!!r&&r.width>0&&r.height>0&&r.right>0&&r.left<innerWidth&&r.bottom>0&&r.top<innerHeight&&getComputedStyle(e).visibility!=='hidden',
      eventFlashed:!!e?.classList.contains('msg-jump-flash'),eventLocateState:list?.dataset.systemJumpState??null,
      eventOwner:owner,eventLocated:list?.dataset.systemJumpState==='located'&&list.dataset.systemJumpMessageId===id&&Array.isArray(owner)&&owner.length===3&&owner[0]===conversation&&owner[1]===id&&Number.isSafeInteger(owner[2])&&owner[2]>0,
      eventRect:r?{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}:null};
  })()`;
}

// T1 selected filter controls only. Alignment is a new acceptance operation;
// it does not stand in for a touch gesture or relax the existing click guards.
export function taskAlignFilterControl(document,label) {
  const view=document.defaultView,live='[data-page]:not([inert]):not([aria-hidden="true"])';
  if(!['Board scope','Channel','Reset filters'].includes(label))return{ready:false,reason:'task_filter_label_unselected',label};
  const locate=()=>{const pages=[...document.querySelectorAll(live)],bars=pages.length===1?[...pages[0].querySelectorAll('[data-task-filter-bar]')]:[],buttons=bars.length===1?[...bars[0].querySelectorAll('button')].filter(e=>e.getAttribute('aria-label')===label):[];return{pages,bars,buttons}};
  const found=locate(),counts={pages:found.pages.length,bars:found.bars.length,controls:found.buttons.length};
  if(counts.pages!==1||counts.bars!==1||counts.controls!==1)return{ready:false,reason:'task_filter_control_not_unique',label,counts};
  const page=found.pages[0],bar=found.bars[0],button=found.buttons[0];
  const identity=()=>({href:view.location.href,origin:view.location.origin,route:view.location.hash,timeOrigin:view.performance.timeOrigin});
  const initial=identity(),box=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,left:r.left,right:r.right,top:r.top,bottom:r.bottom}};
  const sample=()=>{const rect=box(button),point={x:rect.x+rect.width/2,y:rect.y+rect.height/2},ancestors=[];let clip={left:0,top:0,right:view.innerWidth,bottom:view.innerHeight};for(let e=button.parentElement;e;e=e.parentElement){const style=view.getComputedStyle(e),rect=box(e),x=/(auto|scroll|hidden|clip)/.test(style.overflowX),y=/(auto|scroll|hidden|clip)/.test(style.overflowY);if(x||y){ancestors.push({tag:e.tagName,rect,overflowX:style.overflowX,overflowY:style.overflowY,scrollLeft:e.scrollLeft,scrollTop:e.scrollTop,clientWidth:e.clientWidth,clientHeight:e.clientHeight});if(x){clip.left=Math.max(clip.left,rect.left);clip.right=Math.min(clip.right,rect.right)}if(y){clip.top=Math.max(clip.top,rect.top);clip.bottom=Math.min(clip.bottom,rect.bottom)}}}const hit=document.elementFromPoint(point.x,point.y);return{rect,point,strip:{rect:box(bar),scrollLeft:bar.scrollLeft,clientWidth:bar.clientWidth,scrollWidth:bar.scrollWidth},ancestors,clip,hit:{tag:hit?.tagName??null,id:hit?.id??null,insideTarget:!!hit&&(hit===button||button.contains(hit))}}};
  const before=sample();
  button.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
  const after=sample(),current=locate(),sameDocument=button.ownerDocument===document&&bar.ownerDocument===document&&page.ownerDocument===document,sameRoute=JSON.stringify(identity())===JSON.stringify(initial),sameNodes=current.pages.length===1&&current.pages[0]===page&&current.bars.length===1&&current.bars[0]===bar&&current.buttons.length===1&&current.buttons[0]===button&&page.isConnected&&bar.isConnected&&button.isConnected;
  const result={label,counts,before,after,document:initial,identity:{sameDocument,sameRoute,sameNodes},scrollOperation:{block:'nearest',inline:'nearest',behavior:'instant'}};
  if(!sameDocument||!sameRoute||!sameNodes)return{...result,ready:false,reason:'task_filter_identity_changed'};
  if(button.disabled||button.hasAttribute('data-disabled')||button.getAttribute('aria-disabled')==='true')return{...result,ready:false,reason:'task_filter_disabled'};
  const {rect,point,clip}=after;
  if(!(rect.width>0&&rect.height>0&&point.x>0&&point.x<view.innerWidth&&point.y>0&&point.y<view.innerHeight&&point.x>=clip.left&&point.x<clip.right&&point.y>=clip.top&&point.y<clip.bottom))return{...result,ready:false,reason:'task_filter_outside_clip'};
  if(!after.hit.insideTarget)return{...result,ready:false,reason:'task_filter_occluded'};
  const selector=live+' [data-task-filter-bar] button[aria-label="'+label+'"]';
  view.__b3TaskFilterTarget={page,bar,button,document,...initial,selector};
  return{...result,selector,ready:true,reason:null};
}
export async function clickTaskFilterControl(c,observe,label,name) {
  let primary;
  try {
    const aligned=await c.evaluate(`(${taskAlignFilterControl.toString()})(document,${JSON.stringify(label)})`);
    observe(name+'-alignment',aligned);assert(aligned.ready,'T1 filter alignment rejected: '+aligned.reason);
    const tracked={send:(...args)=>c.send(...args),evaluate:expression=>c.evaluate(expression.includes('function leftControlTarget')?`(()=>{const t=window.__b3TaskFilterTarget,live='[data-page]:not([inert]):not([aria-hidden="true"])',pages=[...document.querySelectorAll(live)],bars=pages.length===1?[...pages[0].querySelectorAll('[data-task-filter-bar]')]:[],buttons=[...document.querySelectorAll(${JSON.stringify(aligned.selector)})];if(!t||t.document!==document||t.href!==location.href||t.origin!==location.origin||t.route!==location.hash||t.timeOrigin!==performance.timeOrigin||!t.page.isConnected||!t.bar.isConnected||!t.button.isConnected||pages.length!==1||pages[0]!==t.page||bars.length!==1||bars[0]!==t.bar||buttons.length!==1||buttons[0]!==t.button)throw Error('T1 aligned filter control replaced');return ${expression}})()`:expression)};
    await searchClick(tracked,observe,aligned.selector,undefined,name);
    return aligned;
  } catch(error) { primary=error;throw error; }
  finally {
    try { await c.evaluate('delete window.__b3TaskFilterTarget'); }
    catch(error) { observe(name+'-release-error',String(error));if(!primary)throw error; }
  }
}

export function taskOptionTarget(document,triggerLabel,label) {
  const live='[data-page]:not([inert]):not([aria-hidden="true"])', pages=[...document.querySelectorAll(live)];
  const triggers=pages.length===1?[...pages[0].querySelectorAll('[data-task-filter-bar] button')].filter(e=>e.getAttribute('aria-label')===triggerLabel):[];
  if(triggers.length!==1||triggers[0].getAttribute('aria-expanded')!=='true')return{ready:false,reason:'task_filter_trigger_unavailable'};
  const esc=document.defaultView.CSS.escape;
  const open=[...document.querySelectorAll('[data-task-filter-panel][data-state="open"]')];
  if(open.length!==1)return{ready:false,reason:'task_filter_panel_not_unique'};
  const panel=open[0],lists=panel.matches('[role=listbox]')?[panel]:[...panel.querySelectorAll('[role=listbox]')];
  if(lists.length!==1)return{ready:false,reason:'task_filter_list_not_unique'};
  const rows=[...lists[0].querySelectorAll('button[role=option][data-option-row]')].filter(e=>[...e.querySelectorAll('span')].some(s=>!s.children.length&&s.textContent.trim()===label));
  if(rows.length!==1||!rows[0].id||document.querySelectorAll('#'+esc(rows[0].id)).length!==1)return{ready:false,reason:'task_filter_option_not_unique',count:rows.length};
  const row=rows[0];row.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
  return{ready:true,count:1,id:row.id,selector:'#'+esc(row.id),text:row.textContent.trim(),triggerLabel,panelId:panel.id,triggerControls:triggers[0].getAttribute('aria-controls')};
}

export async function runT1({c,api,call,adb,serial,out,token,fixture,step,observe,selection,newOrigin}) {
  const faultsOnly=selection==='faults';
  const live='[data-page]:not([inert]):not([aria-hidden="true"])', controlFile=out+'/t1-control.json', eventsFile=out+'/t1-proxy-events.jsonl';
  const control=JSON.parse(readFileSync(controlFile));assert(control.unit==='task-read'&&control.active===false,'T1 control precondition');
  const start=Date.now();let operations=0,primary,prepared,restoration;
  const state=()=>c.evaluate(taskStateExpression());
  const controlError=message=>Object.assign(Error('T1 acceptance control: '+message),{source:'acceptance-control'});
  const save=update=>{Object.assign(control,update);writeFileSync(controlFile+'.tmp',JSON.stringify(control),{mode:0o600});renameSync(controlFile+'.tmp',controlFile)};
  function events(ignore=false){if(!existsSync(eventsFile))return[];const text=readFileSync(eventsFile,'utf8');assert(Buffer.byteLength(text)<3*1024*1024,'T1 event bytes');const lines=text.split('\n');lines.pop();assert(lines.length<=2000,'T1 event count');const rows=lines.filter(Boolean).map(JSON.parse);const failed=rows.filter(r=>['control_failure','manifest_refused','session_binding_budget'].includes(r.event));if(!ignore&&failed.length)throw controlError(JSON.stringify(failed));return rows}
  async function until(name,predicate,read=state,ignore=false){const deadline=Math.min(start+240000,Date.now()+10000);let last;for(let i=1;i<=100;i++){assert(Date.now()-start<240000,'T1 unit budget');events(ignore);last=await read();if(i===1)observe(name+'-first',last);if(Date.now()<deadline&&predicate(last)){observe(name,{reads:i,value:last});return last}if(Date.now()>=deadline||i===100)break;await new Promise(r=>setTimeout(r,Math.min(100,deadline-Date.now())))}observe(name+'-last',last);throw Error('T1 condition deadline: '+name)}
  const tracked={evaluate:x=>c.evaluate(x),send:async(method,value)=>{assert(++operations<=100,'T1 input budget');return c.send(method,value)}};
  const click=(selector,text,name)=>searchClick(tracked,observe,selector,text,name);
  const card=(target,name,dispatch=true)=>clickTaskCard(tracked,observe,target,name,{dispatch});
  const path=(url,params={})=>url+(Object.keys(params).length?'?'+new URLSearchParams(params):'');
  const scoped=(w,channel)=>({container:'workspace',workspace_id:w,...(channel?{channel_id:channel}:{})});
  function column(v,status){const cs=v.columns.filter(c=>c.status===status);assert.equal(cs.length,1,'T1 column identity');return cs[0]}
  function rowsEqual(v,status,expected){if(v.boardCount!==1)return false;const col=column(v,status);return!col.loading&&!col.truncated&&!col.text?.includes('Couldn’t load tasks')&&JSON.stringify(col.rows.map(r=>r.id).sort())===JSON.stringify(expected.map(t=>t.id).sort())&&expected.every(t=>col.rows.some(r=>r.id===t.id&&r.titleCount===1&&r.title===t.title))}
  function detail(v,t){return v.taskId===t.id&&v.detailCount===1&&v.titleCount===1&&v.title===t.title&&v.detailText?.includes(t.content)&&v.detailText?.includes('#'+t.number)&&!v.detailLoading&&v.detailMeta.containerCount===1&&v.detailMeta.statusRowCount===1&&v.detailMeta.statusBadgeCount===1&&v.detailMeta.status===t.status&&v.detailMeta.statusText===t.status.replaceAll('_',' ')&&v.detailMeta.channelRowCount===1&&v.detailMeta.channelNameCount===1&&v.detailMeta.channelName===t.channelName&&v.detailMeta.channelTitle===t.channelName}
  const received=id=>events().filter(r=>r.event==='received'&&r.rule===id);
  const terminal=r=>events().find(e=>e.request_id===r.request_id&&['downstream_finish','client_disconnect','control_failure'].includes(e.event));
  async function release(id,r){save({release:[...new Set([...control.release,id])]});const end=await until('t1-'+id+'-terminal',Boolean,()=>terminal(r));if(end.event!=='downstream_finish'||end.status!==503)throw controlError('fault response did not finish as503');return end}
  async function capture(name){const startedAt=Date.now();writeFileSync(out+'/'+name+'.png',execFileSync('adb',['-s',serial,'exec-out','screencap','-p'],{timeout:15000}));observe(name+'-capture',{startedAt,returnedAt:Date.now(),frameTime:'not_measured'})}
  function ime(name){const dump=adb('shell','dumpsys','input_method');writeFileSync(out+'/'+name+'.txt',dump);const matched=dump.split('\n').filter(s=>/mInputShown=|isInputViewShown=/.test(s));assert(matched.length,'T1 IME fields missing');const result={shown:imeShown(dump),evidence:name+'.txt'};observe(name,result);return result}
  async function filter(label,text,name){await clickTaskFilterControl(tracked,observe,label,name+'-trigger');const target=await c.evaluate(`(${taskOptionTarget.toString()})(document,${JSON.stringify(label)},${JSON.stringify(text)})`);observe(name+'-option',target);assert(target.ready,'T1 option identity unavailable: '+target.reason);await click(target.selector,undefined,name+'-select');if(ime(name+'-ime').shown){const before=await state();adb('shell','input','keyevent','KEYCODE_BACK');await until(name+'-ime-hidden',v=>!v.shown,()=>ime(name+'-ime-poll'));assert.equal((await state()).route,before.route,'IME Back navigated T1')}}
  async function reset(name){await clickTaskFilterControl(tracked,observe,'Reset filters',name);}
  async function coldTarget(id,target) {
    const board=await state();
    const spec=JSON.parse(readFileSync(controlFile)), rows=events(), f=prepared;
    const same=(a,b)=>JSON.stringify(Object.entries(a).sort())===JSON.stringify(Object.entries(b).sort());
    const matching=spec.routes.filter(r=>r.path===target.path&&same(r.params,target.params));
    const bindings=rows.filter(r=>r.event==='me_bound'&&r.userId===fixture.userId);
    const unbound=rows.filter(r=>r.event==='session_unbound'&&r.pathname===target.path);
    const previous=rows.filter(r=>r.event==='received'&&r.pathname===target.path&&same(r.params,target.params));
    const projection={id,active:spec.active,releaseAll:spec.releaseAll,stage:spec.stage,unit:spec.unit,users:spec.users,workspaceId:spec.workspaceId,channelIds:spec.channelIds,taskIds:spec.taskIds,target,matchingRoutes:matching,bindings,unbound,previous,board};
    observe('t1-'+id+'-cold-observation',projection);
    assert(spec.unit==='task-read'&&spec.active===true&&spec.releaseAll===false,'T1 cold observation inactive');
    assert.deepEqual(spec.users,[fixture.userId],'T1 cold observation user changed');
    assert.equal(spec.workspaceId,f.w.id,'T1 cold observation workspace changed');
    assert.deepEqual([...spec.channelIds].sort(),Object.values(f.channels).map(c=>c.id).sort(),'T1 cold observation channels changed');
    assert.deepEqual([...spec.taskIds].sort(),Object.values(f.tasks).map(t=>t.id).sort(),'T1 cold observation tasks changed');
    assert.equal(matching.length,1,'T1 cold target outside observed manifest');
    assert(bindings.length>0&&bindings.every(r=>typeof r.sessionDigest==='string'&&r.sessionDigest.length===64)&&unbound.length===0,'T1 cold observation session unbound');
    assert.equal(previous.length,0,'T1 cold target already received');
    assert(!spec.rules.some(r=>r.id===id)&&!spec.release.includes(id)&&!spec.disarmed.includes(id),'T1 cold target already armed');
    assert(board.route==='#/tasks'&&board.boardCount===1&&board.detailCount===0&&!board.filterLabels.some(b=>b.label==='Reset filters')&&rowsEqual(board,'todo',f.answers.baseline.todo)&&rowsEqual(board,'in_progress',f.answers.baseline.in_progress),'T1 cold target baseline board unavailable');
  }
  try {
    await step('PRE.T1.fixture-login',async()=>{
      const auth=await call('authState');assert.equal(auth.me?.status,200);assert.equal(JSON.parse(auth.me.bodyText).id,fixture.userId);
      const stamp=String(Date.now()),userId=fixture.userId;
      const wr=await api('/api/workspaces','POST',{name:'T1 workspace '+stamp,member_user_ids:[userId]},token),w=wr.workspace??wr;assert(w.id);
      const members=await api(`/api/workspaces/${w.id}/members`,'GET',undefined,token);assert.equal(members.human_members.filter(m=>m.user_id===userId).length,1,'T1 workspace member missing');
      const channels={};for(const key of ['main','empty','error']){const res=await api(`/api/workspaces/${w.id}/channels`,'POST',{title:'T1 '+key+' '+stamp,member_user_ids:[userId],visibility:'private'},token),ch=res.channel??res;assert(ch.id);const roster=await api(`/api/conversations/${ch.id}/members`,'GET',undefined,token);assert.equal(roster.members.filter(m=>m.kind==='human'&&m.user_id===userId).length,1,'T1 channel member missing');const cr=await api(`/api/channels/${ch.id}`,'GET',undefined,token),fact=cr.channel??cr;assert.equal(fact.id,ch.id);assert.equal(fact.status,'idle');assert.equal(fact.closed_at,null);assert.equal(fact.archived_at,null);channels[key]={id:ch.id,title:ch.title};}
      const tasks={};for(const [key,place,status] of [['todo','main','todo'],['progress','main','in_progress'],['detailError','main','todo'],['boardError','error','todo']]){const title='T1 '+key+' '+stamp,content='T1 plain description '+key+' '+stamp;const created=await api('/api/tasks','POST',{conversation_id:channels[place].id,title,body:content},token);assert(created.success&&created.task?.id);if(status!=='todo')await api(`/api/tasks/${created.task.id}/status`,'POST',{status},token);const answer=await api(`/api/tasks/${created.task.id}`,'GET',undefined,token),t=answer.task;assert(t&&t.id===created.task.id&&t.task_number===created.task.task_number&&t.title===title&&t.content===content&&t.status===status&&t.place?.kind==='workspace'&&t.place.workspace_id===w.id&&t.place.conversation_id===channels[place].id&&t.place.channel_name===channels[place].title,'T1 task detail fixture mismatch');assert(t.source_message_id===null&&t.nav?.kind==='created_event'&&t.nav.ref.conversation_id===channels[place].id&&t.nav.ref.thread_root_id===null&&t.nav.ref.message_id,'T1 created event unavailable');tasks[key]={id:t.id,number:t.task_number,title,content,status,channel:channels[place].id,channelName:t.place.channel_name,nav:t.nav};}
      const scopeSets={baseline:{},workspace:scoped(w.id),main:scoped(w.id,channels.main.id),empty:scoped(w.id,channels.empty.id),error:scoped(w.id,channels.error.id)},answers={};const routes=[];
      for(const [key,params]of Object.entries(scopeSets)){answers[key]={};for(const status of ['todo','in_progress','in_review','done','closed']){const ps={...params,status,limit:'20'},answer=await api(path('/api/tasks/board/column',ps),'GET',undefined,token);assert(answer.status===status&&Array.isArray(answer.items)&&answer.next_cursor===null,'T1 board fixture not bounded');answers[key][status]=answer.items;routes.push({path:'/api/tasks/board/column',params:ps})}const counts=await api(path('/api/tasks/board/counts',params),'GET',undefined,token);for(const status of Object.keys(answers[key]))assert.equal(counts.counts[status],answers[key][status].length,'T1 count/column mismatch');answers[key].counts=counts.counts;routes.push({path:'/api/tasks/board/counts',params})}
      assert.deepEqual(answers.main.todo.map(t=>t.id).sort(),[tasks.todo.id,tasks.detailError.id].sort());assert.deepEqual(answers.main.in_progress.map(t=>t.id),[tasks.progress.id]);assert(Object.values(answers.empty.counts).every(n=>n===0));assert.deepEqual(answers.error.todo.map(t=>t.id),[tasks.boardError.id]);
      routes.push({path:'/api/tasks/board/facets',params:{}},{path:'/api/tasks/board/facets',params:{container:'workspace'}},...Object.values(tasks).map(t=>({path:'/api/tasks/'+t.id,params:{}})));
      save({users:[userId],workspaceId:w.id,channelIds:Object.values(channels).map(c=>c.id),taskIds:Object.values(tasks).map(t=>t.id),routes,faultTargets:{columnChannelId:channels.error.id,detailTaskId:tasks.detailError.id},active:true,stage:'normal'});
      const native=await call('authState');assert.equal(native.me?.status,200);assert.equal(JSON.parse(native.me.bodyText).id,userId);if(newOrigin){const tls=await until('t1-new-origin-native-tls',Boolean,()=>nativeTlsMatch(native,{userId,serverCertificateSha256:newOrigin.server_certificate_der_sha256},out+'/t1-tls-events.jsonl'));observe('t1-new-origin-native-tls-complete',tls);}await until('t1-me-bound',rows=>rows.some(r=>r.event==='me_bound'&&r.userId===userId),()=>events());
      await until('t1-chats-ready',v=>v.route==='#/chat'&&v.layout==='compact'&&v.pageCount===1);prepared={stamp,w,channels,tasks,answers};return prepared;
    });
    const f=prepared;
    await step('B3.T1.mobile-board',async()=>{await click('nav[aria-label="Main navigation"] button','Tasks','t1-entry');const board=await until('t1-board',v=>v.route==='#/tasks'&&v.layout==='compact'&&rowsEqual(v,'todo',f.answers.baseline.todo)&&rowsEqual(v,'in_progress',f.answers.baseline.in_progress)&&taskInitialCountsReady(v,f.answers.baseline.counts,observe));for(const status of ['todo','in_progress'])assert.equal(column(board,status).count,String(f.answers.baseline.counts[status]));const alignments=[];for(const key of ['todo','progress'])alignments.push(await card(f.tasks[key],'t1-'+key+'-reachable',false));await capture('t1-board');return{board,alignments,coverage:'selected Todo/In progress only; no all-column/touch/paging claim'}});
    if(!faultsOnly) {
    await step('B3.T1.filters-empty',async()=>{await filter('Board scope',f.w.name,'t1-scope');await filter('Channel',f.channels.main.title,'t1-channel-main');const main=await until('t1-main-set',v=>rowsEqual(v,'todo',f.answers.main.todo)&&rowsEqual(v,'in_progress',f.answers.main.in_progress));await filter('Channel',f.channels.empty.title,'t1-channel-empty');const empty=await until('t1-empty-set',v=>rowsEqual(v,'todo',[])&&rowsEqual(v,'in_progress',[])&&column(v,'todo').text==='No todo tasks'&&column(v,'in_progress').text==='No in progress tasks');for(const status of ['todo','in_progress'])assert.equal(column(empty,status).count,'0');for(const ch of ['main','empty'])assert(events().some(r=>r.event==='received'&&r.pathname==='/api/tasks/board/column'&&r.params.workspace_id===f.w.id&&r.params.channel_id===f.channels[ch].id),'T1 actual filter request missing');await reset('t1-reset');const baseline=await until('t1-reset-set',v=>rowsEqual(v,'todo',f.answers.baseline.todo)&&!v.filterLabels.some(b=>b.label==='Reset filters'));return{main,empty,baseline,facets:'container-key only; no new facets request required by channel'}});
    await step('B3.T1.detail-back',async()=>{await card(f.tasks.todo,'t1-detail');const first=await until('t1-detail-result',v=>detail(v,f.tasks.todo));const before=events().filter(r=>r.event==='received'&&r.pathname==='/api/tasks/'+f.tasks.todo.id);assert(before.length,'T1 first actual detail GET absent');await click(`${live} button.mobile-back[aria-label="Back"]`,undefined,'t1-detail-back');await until('t1-detail-back-board',v=>v.route==='#/tasks'&&v.boardCount===1&&v.detailCount===0);await card(f.tasks.todo,'t1-detail-reentry');const reopened=await until('t1-detail-reopened',v=>detail(v,f.tasks.todo));const after=events().filter(r=>r.event==='received'&&r.pathname==='/api/tasks/'+f.tasks.todo.id);observe('t1-reentry-network',{before,after,kind:after.length>before.length?'new_get':'cached_reappearance'});return{first,reopened,before,after}});
    await step('B3.T1.conversation-anchor',async()=>{const t=f.tasks.todo;await click(`${live} [aria-label="Task detail"] button[aria-label="View in conversation"]`,undefined,'t1-view-conversation');const target=await until('t1-event-target',v=>v.route===`#/chat/w/${f.w.id}/c/${t.channel}`&&v.messageCount===1&&v.eventVisible&&v.eventFlashed&&v.eventLocated,async()=>{const base=await state();return{...base,...await c.evaluate(taskEventStateExpression(t.nav.ref.message_id,t.channel))}});assert(target.messageText?.includes('#'+t.number),'T1 event task number mismatch');await click(`${live} button.mobile-back[aria-label="Back"]`,undefined,'t1-event-back-detail');await until('t1-event-detail-return',v=>detail(v,t));await click(`${live} button.mobile-back[aria-label="Back"]`,undefined,'t1-event-back-board');const board=await until('t1-event-board-return',v=>v.route==='#/tasks'&&v.boardCount===1);return{nav:t.nav,target,board}});
    }
    await step('B3.T1.board-column-error',async()=>{const params={...scoped(f.w.id,f.channels.error.id),status:'todo',limit:'20'};if(faultsOnly)await coldTarget('column-error',{path:'/api/tasks/board/column',params});control.rules.push({id:'column-error',kind:'error',userId:fixture.userId,path:'/api/tasks/board/column',params});save({rules:control.rules,stage:'column-error'});await filter('Board scope',f.w.name,'t1-error-scope');await filter('Channel',f.channels.error.title,'t1-error-channel');const request=await until('t1-column-request',rows=>rows[0],()=>received('column-error'));const loading=await until('t1-column-loading',v=>column(v,'todo').loading);await release('column-error',request[0]);const failed=await until('t1-column-error',v=>column(v,'todo').text==='Couldn’t load tasks'&&!column(v,'todo').loading);assert.equal(received('column-error').length,2);assert.equal(column(failed,'todo').count,'1');await capture('t1-column-error');save({disarmed:[...control.disarmed,'column-error'],stage:'column-exit'});await reset('t1-column-error-reset');const board=await until('t1-column-error-exit',v=>rowsEqual(v,'todo',f.answers.baseline.todo));return{loading,failed,board,requests:received('column-error'),coverage:'one cold Todo column only; counts/facets transparent'}});
    await step('B3.T1.detail-error-retry',async()=>{const t=f.tasks.detailError;if(faultsOnly)await coldTarget('detail-error',{path:'/api/tasks/'+t.id,params:{}});assert(!events().some(r=>r.event==='received'&&r.pathname==='/api/tasks/'+t.id),'T1 detail not cold');control.rules.push({id:'detail-error',kind:'error',userId:fixture.userId,path:'/api/tasks/'+t.id,params:{}});save({rules:control.rules,stage:'detail-error'});await card(t,'t1-cold-detail');const request=await until('t1-detail-error-request',rows=>rows[0],()=>received('detail-error'));const loading=await until('t1-detail-loading',v=>v.taskId===t.id&&v.detailLoading);await release('detail-error',request[0]);const failed=await until('t1-detail-error',v=>v.taskId===t.id&&!v.detailLoading&&v.detailText?.includes('Couldn’t load this task')&&v.detailRetryCount===1);assert.equal(received('detail-error').length,2);await capture('t1-detail-error');save({disarmed:[...control.disarmed,'detail-error'],stage:'ui-retry'});let pressedAt=null;const dispatchClient={evaluate:x=>c.evaluate(x),send:async(m,v)=>{if(v.type==='mousePressed')pressedAt=Date.now();return tracked.send(m,v)}};await searchClick(dispatchClient,observe,`${live} [aria-label="Task detail"] button`,'Retry','t1-ui-retry');const result=await until('t1-retry-result',v=>detail(v,t)&&v.detailRetryCount===0);const requests=received('detail-error');assert.equal(requests.length,3);assert(pressedAt!==null&&requests[2].at>=pressedAt,'T1 third GET preceded Retry input');const end=await until('t1-retry-terminal',Boolean,()=>terminal(requests[2]));assert(end.event==='downstream_finish'&&end.status===200,'T1 Retry did not forward original200');await click(`${live} button.mobile-back[aria-label="Back"]`,undefined,'t1-final-board');await until('t1-final-board-ready',v=>v.route==='#/tasks'&&v.boardCount===1);await click('nav[aria-label="Main navigation"] button','Chats','t1-final-chats-tab');const chats=await until('t1-final-chats',v=>v.route==='#/chat'&&v.layout==='compact'&&v.pageCount===1&&v.dialogs===0&&v.toolbars===0);const finalIME=ime('t1-final-ime');assert(!finalIME.shown);const native=await call('authState');assert.equal(native.me?.status,200);assert.equal(JSON.parse(native.me.bodyText).id,fixture.userId);await capture('t1-restored');restoration={status:'passed',chats,finalIME,native:{status:200,expectedUserId:fixture.userId,observedUserId:fixture.userId}};return{loading,failed,result,requests,end,coverage:'cold transient Retry reread only; no reload/warm/404/offline'}});
  } catch(error){primary=error;observe('t1-failure-classification',{source:error.source??'assertion_or_driver',error:String(error),productCause:'not_assumed',...(error.t1CountRecordError?{countRecordError:error.t1CountRecordError,countRejectedSnapshot:error.t1CountRejectedSnapshot}:{})});try{observe('t1-failure-state',await state());await capture('t1-failure')}catch(other){observe('t1-failure-observation-error',String(other))}throw error}
  finally {
    try{save({active:false,releaseAll:true,rules:[]});const rows=await until('t1-control-release-complete',rows=>rows.filter(r=>r.event==='received').every(r=>rows.some(end=>end.request_id===r.request_id&&['downstream_finish','client_disconnect','control_failure'].includes(end.event))),()=>events(true),true);const failures=rows.filter(r=>['control_failure','manifest_refused','session_binding_budget'].includes(r.event));observe('t1-control-summary',{controlFailures:failures,received:rows.filter(r=>r.event==='received'),terminals:rows.filter(r=>['downstream_finish','client_disconnect','control_failure'].includes(r.event)),inputOperations:operations,unitElapsedMs:Date.now()-start,clientConsumption:'not_measured'});await c.evaluate('delete window.__b2LeftClickTarget;delete window.__b3TaskCardTarget');const finalState=await state();observe('t1-reference-release',{status:'released',finalState});if(failures.length)throw controlError(JSON.stringify(failures));if(!primary&&restoration){assert(finalState.route==='#/chat'&&finalState.layout==='compact'&&finalState.pageCount===1&&finalState.dialogs===0&&finalState.toolbars===0&&finalState.timeOrigin===restoration.chats.timeOrigin,'T1 final scene changed before control release');observe('t1-restoration-complete',restoration)}}catch(error){observe('t1-reference-release-error',String(error));if(!primary)throw error}
  }
}

export function b3ScenarioKey(unit,selection) {
  assert(['search-normal','search-isolation','task-read','task-write'].includes(unit),'Unknown B3 unit');
  assert(selection===undefined||(unit==='task-read'&&selection==='faults'),'Unknown B3 fixed selection');
  return selection==='faults'?'task-read-faults':unit;
}

export async function runB3(context) {
  const unit = context.unit ?? 'search-normal';
  b3ScenarioKey(unit,context.selection);
  return unit === 'task-write' ? runT2(context, { taskStateExpression, searchClick, clickTaskFilterControl, taskOptionTarget, clickTaskCard, imeShown }) : unit === 'task-read' ? runT1(context) : unit === 'search-normal' ? runS1(context) : runS2(context);
}

// S2 has a finite fixture manifest and its own budget, not a general probe/runner.
export async function runS2({ c, api, call, adb, input, serial, out, token, fixture, step, observe }) {
  const controlFile = out + '/s2-control.json', eventsFile = out + '/s2-proxy-events.jsonl';
  const control = JSON.parse(readFileSync(controlFile));
  assert(control.version === 1 && control.unit === 'search-isolation' && control.active === false, 'S2 control precondition changed');
  const start = Date.now(); let operations = 0, primary, currentUserId = fixture.userId, prepared;
  const budget = () => { assert(Date.now() - start < 240000, 'S2 unit budget exhausted'); };
  const controlError = message => Object.assign(Error('S2 acceptance control: ' + message), { source: 'acceptance-control' });
  const save = update => {
    Object.assign(control, update); writeFileSync(controlFile + '.tmp', JSON.stringify(control), { mode: 0o600 });
    renameSync(controlFile + '.tmp', controlFile);
  };
  function events(ignoreFailure = false) {
    if (!existsSync(eventsFile)) return [];
    const text = readFileSync(eventsFile, 'utf8');
    assert(Buffer.byteLength(text) < 3 * 1024 * 1024, 'S2 event evidence bound exceeded');
    const lines = text.split('\n'); lines.pop(); // A concurrent final partial line is not a complete event.
    assert(lines.length <= 2000, 'S2 event count exceeded');
    const rows = lines.filter(Boolean).map(line => JSON.parse(line));
    const failures = rows.filter(row => ['control_failure', 'manifest_refused', 'session_binding_budget'].includes(row.event));
    if (!ignoreFailure && failures.length) throw controlError(JSON.stringify(failures.slice(-3)));
    return rows;
  }
  const state = () => c.evaluate(searchIsolationStateExpression());
  async function until(name, predicate, read = state, ignoreControlFailure = false) {
    const deadline = Math.min(start + 240000, Date.now() + 10000); let last;
    for (let i = 1; i <= 100; i++) {
      budget(); events(ignoreControlFailure); last = await read();
      if (i === 1) observe(name + '-first', last);
      if (Date.now() < deadline && predicate(last)) { observe(name, { reads: i, value: last }); return last; }
      if (Date.now() >= deadline || i === 100) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    }
    observe(name + '-last', last); throw Error('S2 condition deadline: ' + name);
  }
  const inputValue = async (selector, value) => { budget(); assert(++operations <= 100, 'S2 input budget'); await input(selector, value); };
  const click = async (selector, text, name, reload = false) => {
    budget(); let dispatched = false, pressedAt = null;
    const tracked = { evaluate: expression => c.evaluate(expression), send: async (method, value) => {
      assert(++operations <= 100, 'S2 input budget');
      if (value.type === 'mousePressed') pressedAt = Date.now();
      observe(name + '-input-call', { at: Date.now(), method, type: value.type, point: { x: value.x, y: value.y } });
      return c.send(method, value);
    } };
    try { await searchClick(tracked, (key, value) => { if (key === name + '-dispatch-returned') dispatched = true; observe(key, value); }, selector, text, name); }
    catch (error) {
      if (!(reload && dispatched && /context.*(destroyed|not found)|Cannot find context/i.test(String(error)))) throw error;
      observe(name + '-release-await-new-document', { error: String(error), dispatched: true });
    }
    return { pressedAt, dispatched };
  };
  async function capture(name) {
    const startedAt = Date.now();
    const bytes = execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 15000 });
    writeFileSync(out + '/' + name + '.png', bytes);
    observe(name + '-capture', { startedAt, returnedAt: Date.now(), frameTime: 'not_measured' });
  }
  async function openSearch(name) {
    await click(`${live} aside[data-sidebar="workspaces"] button`, 'Search', name + '-entry');
    return until(name, v => v.route === '#/chat/search' && v.query === '' && v.pageCount === 1);
  }
  async function clear(name) {
    if (!(await state()).clearDisabled) await click(`${live} button[aria-label="Clear search"]`, undefined, name + '-click');
    return until(name, v => v.query === '' && v.clearDisabled);
  }
  function matches(v, query, targets) {
    return v.route === '#/chat/search' && v.query === query && !v.rowsTruncated && v.rowCount === targets.length &&
      targets.every(t => v.rows.some(row => row.text.includes(t.content) && row.text.includes(t.channelTitle) && row.text.includes(t.workspaceName)));
  }
  async function enter(query, targets, name) { await inputValue(searchSelector, query); return until(name, v => matches(v, query, targets)); }
  function received(rule) { return events().find(row => row.event === 'received' && row.rule === rule); }
  function terminal(request) { return events().find(row => row.request_id === request.request_id && ['downstream_finish','client_disconnect','control_failure'].includes(row.event)); }
  function rule(id, query, kind) {
    control.rules.push({ id, kind, userId: fixture.userId, params: { q: query, include_identities: 'true', limit: '100' } });
    save({ active: true, stage: id });
  }
  async function release(id, request) {
    control.release.push(id); save({ release: control.release });
    const result = await until('s2-' + id + '-terminal', Boolean, () => terminal(request));
    observe('s2-' + id + '-delivery-boundary', { request, terminal: result, clientConsumed: 'not_measured' });
    return result;
  }
  const option = (label, name) => clickSearchOption(c, observe, click, label, name);
  const setFilter = async (label, value, name) => {
    await click(`${live} [aria-label="${label} filter"]`, undefined, name + '-trigger'); await option(value, name + '-option-click');
  };
  async function serverSet(query, targets, params = {}, auth = token) {
    save({ active: false });
    const answer = await api('/api/search?' + new URLSearchParams({ q: query, include_identities: 'true', limit: '100', ...params }), 'GET', undefined, auth);
    assert.equal(answer.results.length, targets.length, 'S2 fixture search size');
    assert.deepEqual(answer.results.map(r => r.message?.id).sort(), targets.map(t => t.id).sort(), 'S2 fixture search identities');
    save({ active: true });
    return answer;
  }
  async function realIdentity(expected, name) {
    const value = await call('authState'); assert.equal(value.me?.status, 200);
    assert.equal(JSON.parse(value.me.bodyText).id, expected, 'S2 native identity mismatch');
    observe(name, { userId: expected, status: value.me.status });
    await until(name + '-proxy-session', rows => rows.some(r => r.event === 'me_bound' && r.userId === expected), () => events());
  }
  try {
    await step('PRE.S2.fixture-login', async () => {
      const stamp = String(Date.now()), q = Object.fromEntries(['error','slow','fast','pop','filter','timea','timeb','account'].map(k => [k, 'b3s2' + k + stamp]));
      const identity = await call('authState'); assert.equal(JSON.parse(identity.me.bodyText).id, fixture.userId);
      const bCredentials = { email: 'b3s2b' + stamp + '@example.test', password: 'Stage1-Isolated-Only!', name: 'b3s2b' + stamp };
      const b = await api('/auth/signup', 'POST', bCredentials); assert(b.user?.id && b.user_token);
      writeFileSync(out + '/fixture-private-s2.json', JSON.stringify({ ...bCredentials, userId: b.user.id }), { mode: 0o600 });
      async function workspace(label, auth = token, users = []) {
        const response = await api('/api/workspaces', 'POST', { name: 'S2 ' + label + ' ' + stamp, member_user_ids: users }, auth);
        const w = response.workspace ?? response;
        const answer = await api(`/api/workspaces/${w.id}/channels`, 'POST', { title: 'S2 channel ' + label + ' ' + stamp, member_user_ids: users }, auth);
        const channel = answer.channel ?? answer; assert(w.id && channel.id);
        return { workspace: w.id, workspaceName: w.name, channel: channel.id, channelTitle: channel.title };
      }
      const shared = await workspace('shared', token, [b.user.id]), second = await workspace('second'), privateA = await workspace('privateA'), privateB = await workspace('privateB', b.user_token);
      async function message(place, content, auth = token) {
        const answer = await api(`/api/channels/${place.channel}/messages`, 'POST', { content }, auth);
        const m = answer.message ?? answer; assert(typeof m.id === 'string' && m.id);
        return { ...place, content, id: m.id, created_at: m.created_at };
      }
      const unary = {};
      for (const key of ['error','slow','fast','pop']) unary[key] = await message(shared, q[key] + ' unique ' + key);
      const filterA = await message(shared, q.filter + ' shared author A');
      const filterB = await message(shared, q.filter + ' shared author B', b.user_token);
      const filterOther = await message(second, q.filter + ' second project');
      const timeBefore = await message(shared, q.timea + ' ' + q.timeb + ' before selection');
      assert(Number.isInteger(timeBefore.created_at) && timeBefore.created_at > 1000000000000, 'S2 message timestamp is not epoch milliseconds');
      const accountA = await message(privateA, q.account + ' private A only'), accountB = await message(privateB, q.account + ' private B only', b.user_token);
      save({ users: [fixture.userId, b.user.id], queries: Object.values(q), active: false });
      for (const key of Object.keys(unary)) await serverSet(q[key], [unary[key]]);
      await serverSet(q.filter, [filterA, filterB, filterOther]);
      await serverSet(q.account, [accountA]); await serverSet(q.account, [accountB], {}, b.user_token);
      await realIdentity(fixture.userId, 's2-pre-native');
      await until('s2-chats-ready', v => v.route === '#/chat' && v.layout === 'compact');
      prepared = { stamp, q, bUserId: b.user.id, bCredentials, shared, second, unary, filterA, filterB, filterOther, timeBefore, accountA, accountB };
      // Credentials remain private; the actual local fixture still feeds the business.
      const { bCredentials: _, ...detail } = prepared; return detail;
    });
    const f = prepared;
    await step('B3.S2.loading-error-retry', async () => {
      await openSearch('s2-search'); rule('http-error', f.q.error, 'error');
      await inputValue(searchSelector, f.q.error);
      const request = await until('s2-error-request', Boolean, () => received('http-error'));
      const loading = await until('s2-loading', v => v.query === f.q.error && v.loading);
      await release('http-error', request);
      const error = await until('s2-error-alert', v => v.alert?.includes('Search failed.') && !v.listText?.includes('No matches'));
      assert.equal(events().filter(r => r.event === 'received' && r.rule === 'http-error').length, 2, 'S2 error did not consume initial + retry1 exactly');
      await capture('s2-error'); control.retry.push('http-error'); save({ retry: control.retry, stage: 'ui-retry' });
      const before = events().filter(r => r.event === 'received' && r.rule === 'http-error').length;
      const retryDispatch = await click(`${live} [role=alert] button`, 'Retry', 's2-ui-retry');
      const result = await until('s2-retry-result', v => matches(v, f.q.error, [f.unary.error]) && !v.alert);
      const requests = events().filter(r => r.event === 'received' && r.rule === 'http-error');
      assert.equal(before, 2); assert.equal(requests.length, 3);
      assert(retryDispatch.dispatched && requests[2].at >= retryDispatch.pressedAt, 'Third request preceded actual Retry dispatch');
      const retryInput = events().filter(r => r.event === 'upstream_end' && r.request_id === requests[2].request_id);
      assert.equal(retryInput.length, 1); assert.equal(retryInput[0].status, 200);
      return { loading, error, result, requests, retryDispatch, retryGate: 'explicitly released before checked UI Retry; third request independently recorded' };
    });
    await step('B3.S2.query-switch', async () => {
      rule('old-query', f.q.slow, 'hold'); await inputValue(searchSelector, f.q.slow);
      const old = await until('s2-old-upstream', rows => rows.some(r => r.event === 'upstream_end' && r.request_id === received('old-query')?.request_id), () => events());
      const request = received('old-query');
      const current = await enter(f.q.fast, [f.unary.fast], 's2-current-query');
      const fast = events().filter(r => r.event === 'received' && r.params.q === f.q.fast);
      assert.equal(fast.length, 1, 'S2 new query must issue its own actual request');
      const ending = await release('old-query', request);
      if (ending.event !== 'downstream_finish' || ending.status !== 200) throw controlError('old-query response did not finish sending: ' + JSON.stringify(ending));
      const after = await until('s2-current-after-release', v => matches(v, f.q.fast, [f.unary.fast]) && !v.listText.includes(f.unary.slow.content));
      return { current, oldUpstream: old.filter(r => r.request_id === request.request_id), fastRequest: fast[0], ending, after, clientConsumption: 'not_measured', cancellation: 'not_measured' };
    });
    await step('B3.S2.page-lifecycles', async () => {
      // Search is a detail page: the actual product has no Tab bar here.
      const keptTab = { status: 'not_executed', reason: 'showsTabBar excludes /chat/search; no equivalent explicit UI control' };
      observe('s2-kept-tab-uncovered', keptTab);
      rule('popped-page', f.q.pop, 'hold'); await inputValue(searchSelector, f.q.pop);
      const popped = await until('s2-pop-request', Boolean, () => received('popped-page'));
      await click('button.mobile-back[aria-label="Back"]', undefined, 's2-pop-header-back');
      const chats = await until('s2-page-unmounted', v => v.route === '#/chat' && v.allSearchLists === 0);
      const popEnd = await release('popped-page', popped);
      const reopened = await openSearch('s2-new-search'); assert.equal(reopened.query, '');
      return { keptTab, chats, popEnd, reopened, limits: 'actual popped DOM removal only; kept-tab/transport-cancel/client-consumption not covered' };
    });
    await step('B3.S2.filters', async () => {
      save({ stage: 'filters' });
      await click(`${live} [data-filter-toggle]`, undefined, 's2-show-filters');
      await until('s2-filters-open', v => v.filterExpanded === 'true');
      await enter(f.q.filter, [f.filterA, f.filterB, f.filterOther], 's2-filter-all');
      await setFilter('Project', f.shared.workspaceName, 's2-project-shared');
      const shared = await until('s2-project-result', v => matches(v, f.q.filter, [f.filterA, f.filterB]));
      await setFilter('Project', f.second.workspaceName, 's2-project-second');
      const second = await until('s2-second-result', v => matches(v, f.q.filter, [f.filterOther]));
      await setFilter('Project', f.shared.workspaceName, 's2-project-back');
      const aIdentity = await api('/api/me', 'GET', undefined, token), aLabel = aIdentity.display_name || aIdentity.name;
      await setFilter('Sender', aLabel, 's2-sender-a');
      const senderA = await until('s2-sender-a-result', v => matches(v, f.q.filter, [f.filterA]));
      await setFilter('Sender', f.bCredentials.name, 's2-sender-b');
      const senderB = await until('s2-sender-b-result', v => matches(v, f.q.filter, [f.filterB]));
      await setFilter('Sender', 'All senders', 's2-sender-all'); await setFilter('Project', 'All projects', 's2-project-all');
      await enter(f.q.timea, [f.timeBefore], 's2-time-before');
      await setFilter('Time', 'Today', 's2-time-today');
      const wire = await until('s2-time-wire', Boolean, () => events().find(r => r.event === 'received' && r.params.q === f.q.timea && r.params.from && r.params.to));
      const to = Number(wire.params.to), from = Number(wire.params.from);
      assert(Number.isInteger(to) && Number.isInteger(from) && from > 1000000000000 && to >= from);
      const response = await api(`/api/channels/${f.shared.channel}/messages`, 'POST', { content: f.q.timea + ' ' + f.q.timeb + ' after selection' }, token);
      const message = response.message ?? response, afterMessage = { ...f.shared, id: message.id, content: message.content, created_at: message.created_at };
      assert(f.timeBefore.created_at <= to && to < afterMessage.created_at, 'S2 fixture time order not established; no time rewrite');
      await serverSet(f.q.timeb, [f.timeBefore], { from: String(from), to: String(to) });
      const bounded = await enter(f.q.timeb, [f.timeBefore], 's2-time-upper-bound');
      await setFilter('Time', 'All time', 's2-time-all');
      const allTime = await until('s2-time-all-result', v => matches(v, f.q.timeb, [f.timeBefore, afterMessage]));
      const requests = events().filter(r => r.event === 'received' && [f.q.filter,f.q.timea,f.q.timeb].includes(r.params.q));
      for (const params of [{ workspace_id: f.shared.workspace },{ workspace_id: f.second.workspace },{ user_id: fixture.userId },{ user_id: f.bUserId }]) assert(requests.some(r => Object.entries(params).every(([k,v]) => r.params[k] === v)), 'Filter must issue corresponding real query');
      assert(requests.some(r => r.params.q === f.q.timeb && r.params.to === String(to)));
      await clear('s2-filter-clear');
      return { shared, second, senderA, senderB, wire, afterMessage, bounded, allTime, requests, uncovered: ['time lower-bound exclusion','all ranges/time zones','agent sender'] };
    });
    await step('B3.S2.logout-login-isolation', async () => {
      rule('old-account', f.q.account, 'hold'); await inputValue(searchSelector, f.q.account);
      await until('s2-account-old-upstream', rows => rows.some(r => r.event === 'upstream_end' && r.request_id === received('old-account')?.request_id), () => events());
      const old = received('old-account'), before = await state();
      await click('button.mobile-back[aria-label="Back"]', undefined, 's2-account-back-root');
      await until('s2-account-root', v => v.route === '#/chat' && v.allSearchLists === 0);
      await click('nav[aria-label="Main navigation"] button', 'Me', 's2-account-me');
      await click(`${live} button[aria-label="Edit profile"]`, undefined, 's2-account-settings');
      await until('s2-account-pane', v => v.route.includes('settingsSection=account'));
      await click(`${live} button`, 'Log out', 's2-logout', true);
      const signedOut = await until('s2-signed-out-new-document', v => v.readiness !== 'not_ready' && v.authForm && v.authEmailCount === 1 && v.timeOrigin !== before.timeOrigin, () => c.evaluate(searchIsolationStateExpression({ waitForRoot: true })));
      const authMode = await c.evaluate(`(${searchAuthMode.toString()})(document)`);
      observe('s2-auth-mode', authMode);
      assert(authMode.ready, 'S2 auth mode unavailable: ' + authMode.reason);
      if (authMode.mode === 'signup') await click('[data-auth-form] button[type=button]', 'Log in', 's2-login-mode');
      await inputValue('#auth-email', f.bCredentials.email); await inputValue('#auth-password', f.bCredentials.password);
      await click('[data-auth-form] button[type=submit]', 'Log in', 's2-login-b');
      await until('s2-b-chats', v => v.route === '#/chat' && !v.authForm);
      await realIdentity(f.bUserId, 's2-b-native'); currentUserId = f.bUserId;
      await openSearch('s2-b-search'); const b = await enter(f.q.account, [f.accountB], 's2-b-private-result');
      const ending = await release('old-account', old);
      const after = await until('s2-b-after-old-release', v => matches(v, f.q.account, [f.accountB]) && !v.listText.includes(f.accountA.content));
      await realIdentity(f.bUserId, 's2-b-native-after');
      return { old, signedOut, b, ending, after, path: 'real logout/reload/login only', oldClientConsumption: 'not_measured' };
    });
    await clear('s2-final-clear');
    await click('button.mobile-back[aria-label="Back"]', undefined, 's2-final-back');
    const chats = await until('s2-final-chats', v => v.route === '#/chat' && v.pageCount === 1 && v.dialogs === 0 && v.toolbars === 0);
    const dump = adb('shell', 'dumpsys', 'input_method'); writeFileSync(out + '/s2-final-ime.txt', dump);
    const matched = dump.split('\n').filter(s => /mInputShown=|isInputViewShown=/.test(s)).slice(0,8);
    assert(matched.length && !imeShown(dump), 'S2 final IME not confirmed hidden');
    await realIdentity(currentUserId, 's2-final-native');
    await capture('s2-restored');
    observe('s2-restoration-complete', { status: 'passed', chats, finalIME: { shown: false, evidence: 's2-final-ime.txt' }, native: { status: 200, expectedUserId: currentUserId, observedUserId: currentUserId } });
  } catch (error) {
    primary = error; observe('s2-failure-classification', { source: error.source ?? 'assertion_or_driver', error: String(error), productCause: 'not_assumed' });
    try { observe('s2-failure-state', await state()); await capture('s2-failure'); } catch (other) { observe('s2-failure-observation-error', String(other)); }
    throw error;
  } finally {
    try {
      save({ releaseAll: true, active: false });
      const outcome = await until('s2-control-release-complete', rows => {
        const held = rows.filter(r => r.event === 'received' && r.rule && (r.use === 1));
        return held.every(r => rows.some(end => end.request_id === r.request_id && ['downstream_finish','client_disconnect','control_failure'].includes(end.event)));
      }, () => events(true), true);
      const controlFailures = outcome.filter(r => ['control_failure','manifest_refused','session_binding_budget'].includes(r.event));
      observe('s2-control-summary', { controlFailures, received: outcome.filter(r => r.event === 'received'), terminals: outcome.filter(r => ['downstream_finish','client_disconnect','control_failure'].includes(r.event)), inputOperations: operations, unitElapsedMs: Date.now() - start, deviceClientConsumption: 'not_measured' });
      await c.evaluate('delete window.__b2LeftClickTarget');
      observe('s2-reference-release', { status: 'released', finalState: await state() });
      if (controlFailures.length) throw controlError(JSON.stringify(controlFailures));
    } catch (error) { observe('s2-reference-release-error', String(error)); if (!primary) throw error; }
  }
}
