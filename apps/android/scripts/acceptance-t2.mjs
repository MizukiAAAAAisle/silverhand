// Normal workspace UI writes only. No permission fixtures, product hooks or retry.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { readT2Events, assertT2ZeroWrites } from './t2-observer.mjs';
import { nativeTlsMatch } from './t1-tls-evidence.mjs';
export const T2_CASES = ['B3.T2.create','B3.T2.edit-cancel-save','B3.T2.status','B3.T2.restore'];
export async function t2Until(name, predicate, read, { now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), unitDeadline, observe = () => {} }) {
  const deadline = Math.min(now() + 10000, unitDeadline);
  for (let i = 0; i < 100 && now() < deadline; i++) {
    const value = await read();
    if (now() >= deadline) break;
    if (predicate(value)) { observe(name, value); return value; }
    await sleep(Math.min(100, deadline - now()));
  }
  throw Error('T2 bounded condition: ' + name);
}
export function t2IndependentTodoRead(rows, ack, { workspaceId, channelId, task }) {
  for (const request of rows.filter(x => x.event === 'request' && x.method === 'GET' && x.path === '/api/tasks/board/column' && x.seq > ack.seq && x.params?.container === 'workspace' && x.params.workspace_id === workspaceId && x.params.channel_id === channelId && x.params.status === 'todo')) {
    const responses = rows.filter(x => x.event === 'response' && x.request === request.request);
    const terminals = rows.filter(x => x.event === 'terminal' && x.request === request.request);
    if (responses.length !== 1 || terminals.length !== 1) continue;
    const response = responses[0], terminal = terminals[0], body = response.body;
    if (!(response.seq > request.seq && terminal.seq > response.seq && response.status === 200 && body?.status === 'todo' && Array.isArray(body.items))) continue;
    const matching = body.items.filter(x => x.id === task.id);
    if (matching.length === 1 && matching[0].task_number === task.task_number) return { request, response, terminal };
  }
  return null;
}
export async function runT2({ c, api, call, adb, input, out, token, fixture, step, observe, newOrigin }, h) {
  const file = out + '/t2-observer-private.json', events = out + '/t2-events.jsonl';
  assert.deepEqual(JSON.parse(readFileSync(file)), { version: 1, unit: 'task-write', active: false });
  const clock = h.clock ?? { now: Date.now, sleep: ms => new Promise(r => setTimeout(r, ms)) };
  const start = clock.now(); let operations = 0, spec, f, task, primary;
  const rows = () => readT2Events(readFileSync(events, 'utf8'));
  const state = () => c.evaluate(h.taskStateExpression());
  const until = (name, predicate, read = state) => t2Until(name, predicate, read, { ...clock, unitDeadline: start + 240000, observe });
  function save() { writeFileSync(file + '.next', JSON.stringify(spec), { mode: 0o600 }); renameSync(file + '.next', file); }
  const click = async (selector, text, name) => { assert(++operations <= 80); return h.searchClick(c, observe, selector, text, name, { waitUntilReady: read => until(name + '-ready', target => target.ready, read) }); };
  const text = async (selector, value) => { assert(++operations <= 80); await input(selector, value); };
  async function key(key, code, windowsVirtualKeyCode) {
    assert(++operations <= 80); await c.send('Input.dispatchKeyEvent', { type:'keyDown', key, code, windowsVirtualKeyCode });
    await c.send('Input.dispatchKeyEvent', { type:'keyUp', key, code, windowsVirtualKeyCode });
  }
  const detail = async () => {
    const answer = await api('/api/tasks/' + task.id, 'GET', undefined, token); const t = answer.task;
    assert(t?.id === task.id && t.task_number === task.task_number && t.place.workspace_id === f.w.id && t.place.conversation_id === f.ch.id);
    assert.equal(t.assignee, null); return t;
  };
  async function marker(label) {
    await until(label + '-drained', rs => rs.filter(x => x.event === 'request').every(x => rs.some(t => t.event === 'terminal' && t.request === x.request)), rows);
    spec.phase++; spec.marker = label; save(); const t = await detail();
    await until(label + '-observed', rs => { const m = rs.find(x => x.event === 'marker' && x.marker === label); return m && rs.some(x => x.event === 'request' && x.method === 'GET' && x.path === '/api/tasks/' + task.id && x.seq > m.seq && rs.some(end => end.event === 'terminal' && end.request === x.request)); }, rows); return t;
  }
  async function filter(label, name) {
    await h.clickTaskFilterControl(c, observe, label, 't2-' + label + '-open');
    const target = await c.evaluate(`(${h.taskOptionTarget.toString()})(document,${JSON.stringify(label)},${JSON.stringify(name)})`);
    assert(target.ready, 'T2 exact filter unavailable'); await click(target.selector, undefined, 't2-' + label + '-select');
  }
  const cardCount = (v, status) => { const cols = v.columns.filter(x => x.status === status); assert.equal(cols.length, 1); assert(!cols[0].truncated); return cols[0].rows.filter(x => x.id === task.id).length; };
  async function edit(label, value, field) {
    await click(`[data-page]:not([inert]) button[aria-label="${label}"]`, undefined, 't2-' + field + '-edit');
    await text(`textarea[aria-label="${field === 'title' ? 'Task title' : 'Task description'}"]`, value);
    await key('Enter','Enter',13);
    await until(field + '-saved-ui', v => v.detailText?.includes(value));
    const t = await detail(); assert.equal(t[field === 'title' ? 'title' : 'content'], value); return t;
  }
  try {
    await step('PRE.T2.fixture-login', async () => {
      const auth = await call('authState'); assert.equal(auth.me?.status,200); assert.equal(JSON.parse(auth.me.bodyText).id,fixture.userId);
      const stamp = String(Date.now()); f = { w: null, ch: null, title: 'T2 create ' + stamp, body: 'T2 body ' + stamp, stamp }; const wr = await api('/api/workspaces','POST',{name:'T2 '+stamp,member_user_ids:[fixture.userId],member_agent_ids:[]},token); const w = wr.workspace ?? wr; f.w = w; assert(w.id, 'T2 workspace identity missing');
      const cr = await api(`/api/workspaces/${w.id}/channels`,'POST',{title:'T2 channel '+stamp,member_user_ids:[fixture.userId],member_agent_ids:[],visibility:'private'},token); const ch = cr.channel ?? cr; f.ch = ch; assert(ch.id, 'T2 channel identity missing');
      const wm = await api(`/api/workspaces/${w.id}/members`,'GET',undefined,token), cm = await api(`/api/conversations/${ch.id}/members`,'GET',undefined,token), cf = await api(`/api/channels/${ch.id}`,'GET',undefined,token);
      assert.equal(wm.human_members.filter(x=>x.user_id===fixture.userId).length,1); assert.equal(cm.members.filter(x=>x.kind==='human'&&x.user_id===fixture.userId).length,1);
      const channel = cf.channel ?? cf; assert.equal(channel.status,'idle'); assert.equal(channel.closed_at,null); assert.equal(channel.archived_at,null);
      spec = { version:1,unit:'task-write',active:true,userId:fixture.userId,workspaceId:w.id,channelId:ch.id,apiToken:token,taskId:null,phase:0,marker:'prepared' }; save();
      const native = await call('authState');
      assert.equal(native.me?.status, 200); assert.equal(JSON.parse(native.me.bodyText).id, fixture.userId);
      if (newOrigin) {
        const tls = await until('t2-new-origin-native-tls', Boolean, () => {
          rows(); // Sticky observer failures cannot be bypassed by an old TLS row.
          return nativeTlsMatch(native, { userId: fixture.userId, serverCertificateSha256: newOrigin.server_certificate_der_sha256, attempt: out }, out + '/t2-tls-events.jsonl');
        });
        observe('t2-new-origin-native-tls-complete', tls);
      }
      await click('nav[aria-label="Main navigation"] button','Tasks','t2-tasks');
      await filter('Board scope',w.name); await filter('Channel',ch.title);
      await until('t2-empty-board',v=>v.route==='#/tasks'&&v.boardCount===1&&v.columns.every(x=>!x.loading&&!x.truncated));
      return {userId:fixture.userId,workspaceId:w.id,channelId:ch.id};
    });
    await step(T2_CASES[0], async () => {
      await click('button[aria-label="New task"]',undefined,'t2-new');
      await text('#create-task-title',f.title); await text('#create-task-body',f.body);
      await click('[role="dialog"] button[type="submit"]', 'Create task','t2-create-once');
      const rs = await until('t2-create-ack',rs=>rs.some(x=>x.event==='response'&&x.status===201&&x.body.task?.id),rows);
      const requests=rs.filter(x=>x.event==='request'&&x.method==='POST'&&x.path==='/api/tasks'); assert.equal(requests.length,1);
      const ack=rs.find(x=>x.event==='response'&&x.request===requests[0].request); assert.equal(ack.status,201); task=ack.body.task; spec.taskId=task.id; save();
      const board=await until('t2-created-board',v=>v.route==='#/tasks'&&v.dialogs===0&&cardCount(v,'todo')===1);
      assert.equal(board.columns.find(x=>x.status==='todo').rows.find(x=>x.id===task.id).number,String(task.task_number));
      const t=await detail(); assert.equal(t.title,f.title); assert.equal(t.content,f.body); assert.equal(t.status,'todo');
      const reads=rows().filter(x=>x.event==='request'&&x.method==='GET'&&x.path==='/api/tasks/board/column'&&x.seq>ack.seq);
      const independentRead = t2IndependentTodoRead(rows(), ack, { workspaceId:f.w.id, channelId:f.ch.id, task });
      observe('t2-board-read-layer',{requests:reads,independentReadObtained:independentRead !== null,independentRead,ui:board,ack});
      await h.clickTaskCard(c,observe,{id:task.id,number:task.task_number,title:t.title,status:'todo'},'t2-open-task');
      await until('t2-compact-detail',v=>v.taskId===task.id&&v.detailCount===1&&v.detailText?.includes(t.title)); return {ack,detail:t};
    });
    await step(T2_CASES[1], async () => {
      const before=await marker('cancel-start');
      await click('button[aria-label="Edit title"]',undefined,'t2-cancel-edit'); await text('textarea[aria-label="Task title"]','Cancelled '+f.stamp);
      await key('Escape','Escape',27); await click('[aria-label="Task detail"] h1',undefined,'t2-cancel-blur');
      await click('button[aria-label="Edit title"]',undefined,'t2-cancel-reenter');
      assert.equal(await c.evaluate('document.querySelector(\'textarea[aria-label="Task title"]\')?.value'),before.title);
      await key('Escape','Escape',27); const after=await marker('cancel-end'); assert.equal(after.title,before.title);
      const zero=assertT2ZeroWrites(rows(),'cancel-start','cancel-end',task.id); observe('t2-cancel-window',zero);
      const title=await edit('Edit title','T2 edited '+f.stamp,'title'); const body=await edit('Edit description','T2 edited body '+f.stamp,'content');
      const writes=rows().filter(x=>x.event==='request'&&x.path==='/api/tasks/'+task.id+'/edit'); assert.equal(writes.length,2);
      for (const x of writes) assert(rows().some(t=>t.event==='response'&&t.request===x.request&&t.status===200));
      return {zero,title,body};
    });
    await step(T2_CASES[2], async () => {
      await click('[aria-label="Task detail"] button[data-task-status="todo"]',undefined,'t2-status-open');
      await click('[data-popover-frame="info"] button:has([data-task-status="in_progress"])',undefined,'t2-status-select');
      await until('t2-status-ui',v=>v.detailMeta.status==='in_progress'); const t=await detail(); assert.equal(t.status,'in_progress');
      const writes=rows().filter(x=>x.event==='request'&&x.path==='/api/tasks/'+task.id+'/status'); assert.equal(writes.length,1); assert(rows().some(x=>x.event==='response'&&x.request===writes[0].request&&x.status===200));
      await click('button.mobile-back[aria-label="Back"]',undefined,'t2-back-board');
      const board=await until('t2-status-board',v=>v.route==='#/tasks'&&v.boardCount===1&&cardCount(v,'in_progress')===1&&cardCount(v,'todo')===0); return {detail:t,board};
    });
    await step(T2_CASES[3], async () => {
      await marker('normal-end'); await click('nav[aria-label="Main navigation"] button','Chats','t2-chats');
      const end=await until('t2-restored',v=>v.route==='#/chat'&&v.layout==='compact'&&v.pageCount===1&&v.dialogs===0&&v.toolbars===0);
      const ime=adb('shell','dumpsys','input_method');writeFileSync(out+'/t2-final-ime.txt',ime); assert(/mInputShown=|isInputViewShown=/.test(ime)&&!h.imeShown(ime));
      const auth=await call('authState');assert.equal(JSON.parse(auth.me.bodyText).id,fixture.userId);return {end,nativeUserId:fixture.userId,imeHidden:true};
    });
  } catch (error) { primary=error; throw error; }
  finally {
    // Preserve raw evidence/fixture identities on both success and first failure.
    try { observe('t2-residue',{workspaceId:f?.w?.id??null,channelId:f?.ch?.id??null,taskId:task?.id??null,runEvidence:out,dataDeleted:false,servicePidState:'outer-owned-cleanup-required',inputOperations:operations}); }
    catch (error) { if (!primary) throw error; }
  }
}
