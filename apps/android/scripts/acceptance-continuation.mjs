import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// The CLI's post-restart continuation. No main execution or network at import time.
export async function reconnectWebView(client, adb, connect) {
  client.close();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const pid = adb('shell', 'pidof', 'com.silverhand.android.stage1');
      adb('forward', 'tcp:19322', 'localabstract:webview_devtools_remote_' + pid);
      return await connect();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw Error('WebView reconnect timeout');
}

export async function continueAfterRestart({
  suite, diagnostic, runB2, logout, report, record, runB1,
  b1Context, selectedB1, releaseParent,
}) {
  if (suite === 'b2' && diagnostic !== 'coverage-b1') await runB2();
  if (suite !== 'b3' && (!diagnostic || diagnostic === 'coverage-b1')) {
    if (diagnostic === 'coverage-b1') await report.step('DIAG.logout-before-b1', logout);
    else record('logout', await logout());
    if (suite === 'b2') {
      await runB1({
        ...b1Context,
        reconnect: async () => {
          try { return await b1Context.reconnect(); }
          finally { releaseParent(); } // runB1 owns any returned client.
        },
      }, selectedB1);
    }
  }
}

export function coverageMetadata(table, diagnostic) {
  if (!['coverage-short','coverage-bars','coverage-b1'].includes(diagnostic)) return null;
  const full=[...table.original12,...table.B2.filter(row=>row.scope==='device').map(row=>'B2.'+row.id),...table.B1_affected.map(i=>'B1.'+table.B1[i-1])], selected=table.diagnostics[diagnostic];
  return {kind:'grouped',selector:diagnostic,planned:selected.length,selected_ids:selected,ordinary33_count:full.length,ordinary33_selected:full.filter(id=>selected.includes(id)),ordinary33_not_selected:full.filter(id=>!selected.includes(id)),partial_of:table.coverage_partial?.[diagnostic]??null,group_counts_not_aggregated:true};
}
export function groupedB1Observation(report, root, table) {
  let prepared=false;
  return (name,value)=>{
    report.observe(name,value);
    if(name!=='continuation-preconditions.json')return;
    assert(!prepared,'Repeated B1 initialization observation');
    const current=JSON.parse(readFileSync(root+'b1-fixture.json'));
    assert(typeof current.workspace==='string'&&current.workspace&&typeof current.channel==='string'&&current.channel,'B1 fixture identity missing');
    assert.equal(value.route,'#/chat/w/'+current.workspace+'/c/'+current.channel,'B1 initialization route does not match current fixture');
    assert.deepEqual(value.selectedCases,table.B1_affected,'B1 initialization case set changed');
    assert(value.freshFixture===true&&value.historicalPassesUsed===false,'B1 initialization fixture provenance changed');
    assert(Number.isSafeInteger(value.identity?.activity)&&value.identity.activity>=0&&Number.isSafeInteger(value.identity?.webViewIdentity)&&value.identity.webViewIdentity>=0,'B1 initialization identity missing');
    prepared=true;
    report.pass('DIAG.b1-preconditions',{route:value.route,selectedCases:value.selectedCases,identity:value.identity,credit:'readiness only; no B1 functional case credited',source:'existing runB1 instrumentation/fixture/reconnect/React login and textarea checks before this observation'});
  };
}
