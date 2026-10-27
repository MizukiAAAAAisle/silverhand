import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { nativeUI, nativeFileTarget } from './native-ui.mjs';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pkg = 'com.silverhand.android.stage1',
  testPkg = pkg + '.test';

export function assertSavedAvatarDesign(response) {
  const design = response?.design;
  assert(design && typeof design === 'object' && !Array.isArray(design), 'Saved avatar design is missing');
  assert(
    Number.isInteger(design.parts_version) && design.parts_version > 0 && design.parts_version <= 0xffffffff,
    'Saved avatar design parts_version must be a positive u32',
  );
  assert(
    design.config && typeof design.config === 'object' && !Array.isArray(design.config),
    'Saved avatar design config must be an object',
  );
}

// Bounded metadata in the existing reads. The total includes hidden/unknown dialogs.
export function previewDialogState(document) {
  const view = document.defaultView, all = [...document.querySelectorAll('[role="dialog"]')];
  const controlLinks = all.length ? [...document.querySelectorAll('[aria-controls]')] : [];
  const rect = e => { const r = e.getBoundingClientRect(); return { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height }; };
  const shown = e => { const s=view.getComputedStyle(e), r=rect(e); return e.isConnected && !e.closest('[inert]') && !e.hidden && s.display!=='none' && s.visibility!=='hidden' && s.visibility!=='collapse' && Number(s.opacity)!==0 && r.width>0 && r.height>0; };
  const describe = e => {
    const s=view.getComputedStyle(e), r=rect(e), text=(e.textContent??'').trim(), buttons=[...e.querySelectorAll('button')];
    const triggers=e.id?controlLinks.filter(t=>(t.getAttribute('aria-controls')??'').split(/\s+/).includes(e.id)):[];
    const rawLabelledby=e.getAttribute('aria-labelledby'), labelledby=rawLabelledby?.slice(0,160)??null, title=(labelledby??'').split(/\s+/).filter(Boolean).slice(0,4).map(id=>document.getElementById(id)?.textContent?.slice(0,160)??'').join(' ').trim();
    const attr=n=>e.getAttribute(n)?.slice(0,160)??null;
    return { id:e.id?.slice(0,160)||null, role:attr('role'), ariaLabel:attr('aria-label'), labelledby, labelledbyTruncated:!!rawLabelledby&&rawLabelledby.length>160, title:title.slice(0,160), text:text.slice(0,160), textTruncated:text.length>160||title.length>160,
      className:(e.getAttribute('class')??'').slice(0,240), classTruncated:(e.getAttribute('class')??'').length>240, state:e.getAttribute('data-state'), modal:e.hasAttribute('data-modal-shell'), imagePreview:e.hasAttribute('data-image-export-preview'),
      popoverFrame:attr('data-popover-frame'), popoverFrameTruncated:(e.getAttribute('data-popover-frame')??'').length>160,
      triggerCount:triggers.length, triggersTruncated:triggers.length>4, triggers:triggers.slice(0,4).map(t=>{
        const names=['id','role','aria-label','aria-controls','aria-expanded','aria-haspopup','data-message-author','data-author-kind','data-member-chip','data-member-id','data-mention-kind','data-mention-id'];
        const attributes=Object.fromEntries(names.map(n=>[n,t.getAttribute(n)?.slice(0,160)??null]));
        const content=(t.textContent??'').trim();
        return {tag:t.tagName,attributes,attributesTruncated:names.some(n=>(t.getAttribute(n)??'').length>160),text:content.slice(0,160),textTruncated:content.length>160,connected:t.isConnected,visible:shown(t),rect:rect(t)};
      }),
      connected:e.isConnected, hidden:!!e.hidden, inert:!!e.closest('[inert]'), visible:shown(e), display:s.display, visibility:s.visibility, opacity:s.opacity, pointerEvents:s.pointerEvents, rect:r,
      viewportIntersection:{width:Math.max(0,Math.min(view.innerWidth,r.right)-Math.max(0,r.left)),height:Math.max(0,Math.min(view.innerHeight,r.bottom)-Math.max(0,r.top))},
      previewScroll:!!e.querySelector('[data-image-export-scroll]'), previewActions:!!e.querySelector('[data-image-export-actions]'), buttonCount:buttons.length, buttonsTruncated:buttons.length>4,
      buttons:buttons.slice(0,4).map(b=>({label:b.getAttribute('aria-label')?.slice(0,160)??null,title:b.getAttribute('title')?.slice(0,160)??null,text:(b.textContent??'').trim().slice(0,160),disabled:!!b.disabled,visible:shown(b)})) };
  };
  const previews=all.filter(e=>e.hasAttribute('data-modal-shell')&&e.hasAttribute('data-image-export-preview')&&shown(e));
  const close=previews.length===1?[...previews[0].querySelectorAll('button[aria-label="Close"]')].filter(shown):[];
  const previewReady=previews.length===1&&!!previews[0].querySelector('[data-image-export-scroll]')&&!!previews[0].querySelector('[data-image-export-actions]')&&close.length===1&&!close[0].disabled;
  return { dialogs:all.length, dialogDetails:all.slice(0,4).map(describe), dialogsTruncated:all.length>4, visiblePreviewCount:previews.length, previewCloseCount:close.length, previewReady,
    previewIdentity:previewReady?{origin:view.location.origin,href:view.location.href,hash:view.location.hash,timeOrigin:view.performance.timeOrigin}:null };
}

// Device-page geometry only; a configured WM size is never itself a pass.
export function shortSelectionLayout(document, messageId, scrollGuard = null) {
  const view = document.defaultView, style = (e) => view.getComputedStyle(e);
  const box = (e) => { const r = e?.getBoundingClientRect(); return r && { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const panelSelector='[data-panel="chat"]:has(> [data-pane-chrome="scroller"])';
  const panels=scrollGuard?[...document.querySelectorAll(panelSelector)]:null;
  const panel = scrollGuard?(panels.length===1?panels[0]:null):document.querySelector(panelSelector);
  const ownedScrollers=()=>panel?[...panel.querySelectorAll('[data-virtuoso-scroller]')].filter(e=>e.closest('[data-panel]')===panel):[];
  const scrollers=scrollGuard?ownedScrollers():null;
  const scroller = scrollGuard?(scrollers.length===1?scrollers[0]:null):panel?.querySelector('[data-virtuoso-scroller]');
  const intersect = (e) => {
    const rect = box(e); if (!rect) return null;
    const own = style(e);
    if (own.visibility === 'hidden' || own.visibility === 'collapse' || own.display === 'none' || Number(own.opacity) === 0) return { ...rect, area: 0 };
    const visual = view.visualViewport;
    let left = Math.max(visual?.offsetLeft ?? 0, rect.left), top = Math.max(visual?.offsetTop ?? 0, rect.top), right = Math.min((visual?.offsetLeft ?? 0) + (visual?.width ?? view.innerWidth), rect.right), bottom = Math.min((visual?.offsetTop ?? 0) + (visual?.height ?? view.innerHeight), rect.bottom);
    for (let n = e.parentElement; n; n = n.parentElement) {
      const s = style(n), b = box(n);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return { left, top, right: left, bottom: top, area: 0 };
      if (/auto|scroll|hidden|clip/.test(s.overflowX)) { left = Math.max(left, b.left); right = Math.min(right, b.right); }
      if (/auto|scroll|hidden|clip/.test(s.overflowY)) { top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom); }
    }
    return { left, top, right, bottom, area: Math.max(0, right - left) * Math.max(0, bottom - top) };
  };
  const clipped = intersect(scroller);let point = clipped?.area > 0 ? { x: (clipped.left + clipped.right) / 2, y: (clipped.top + clipped.bottom) / 2 } : null;
  const row = document.getElementById('msg-' + messageId), spacer = panel?.querySelector('[data-pane-chrome-spacer]');
  let scrollTarget=null,hit=null;
  if(scrollGuard){
    const describe=e=>e?{tag:e.tagName,id:(e.id??'').slice(0,160),className:(e.getAttribute('class')??'').slice(0,240),label:e.getAttribute('aria-label')?.slice(0,160)??null,title:e.getAttribute('title')?.slice(0,160)??null,scrollBottom:e.hasAttribute('data-scroll-bottom'),panel:e.getAttribute('data-panel')?.slice(0,80)??null,nearestPanel:e.closest('[data-panel]')?.getAttribute('data-panel')?.slice(0,80)??null,rect:box(e),pointerEvents:style(e).pointerEvents}:null;
    const identity=()=>({origin:view.location.origin,hash:view.location.hash,timeOrigin:view.performance.timeOrigin});
    const sameIdentity=()=>!!scrollGuard.expectedIdentity&&['origin','hash','timeOrigin'].every(k=>identity()[k]===scrollGuard.expectedIdentity[k]);
    scrollTarget={ready:false,reason:null,identity:identity(),expectedIdentity:scrollGuard.expectedIdentity,paneCount:panels.length,scrollerCount:scrollers.length,pane:describe(panel),scroller:describe(scroller),row:describe(row),intersection:clipped,originalPoint:point,point:null,hit:null,hitAncestors:[],hitChecks:0,avoidance:{count:0,button:null,overlap:null,candidates:[],selected:null,rule:'area descending; exact tie right,left,down,up'}};
    const ownedButtons=()=>[...panel.querySelectorAll('button[data-scroll-bottom]')].filter(e=>e.closest('[data-panel]')===panel);
    try{
      const require=(ok,reason)=>{if(!ok)throw Error(reason);};
      require(sameIdentity(),'Short scroll document identity changed');
      require(panel?.isConnected&&panels.length===1&&!panel.closest('[inert]'),'Short scroll pane missing or ambiguous');
      require(scroller?.isConnected&&scrollers.length===1&&panel.contains(scroller),'Short scroll scroller missing or ambiguous');
      require(row?.isConnected&&row.id==='msg-'+messageId&&panel.contains(row)&&scroller.contains(row)&&row.closest('[data-virtuoso-scroller]')===scroller&&row.closest('[data-panel]')===panel&&row.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')==='true','Short scroll selected message relationship changed');
      require(clipped?.area>0&&[clipped.left,clipped.top,clipped.right,clipped.bottom].every(Number.isFinite),'Short scroll visible intersection unavailable');
      const buttons=ownedButtons();scrollTarget.avoidance.count=buttons.length;
      require(buttons.length<=1,'Short scroll bottom button ambiguous');
      const button=buttons[0];
      if(button){
        const b=box(button),s=style(button);scrollTarget.avoidance.button=describe(button);
        require(button.isConnected&&!button.closest('[inert]')&&s.position==='absolute'&&s.display!=='none'&&s.visibility!=='hidden'&&s.visibility!=='collapse'&&Number(s.opacity)!==0&&b.width>0&&b.height>0&&[b.left,b.top,b.right,b.bottom,b.width,b.height].every(Number.isFinite),'Short scroll bottom button geometry unavailable');
        const l=Math.max(clipped.left,b.left),t=Math.max(clipped.top,b.top),r=Math.min(clipped.right,b.right),d=Math.min(clipped.bottom,b.bottom);
        if(r>l&&d>t){
          scrollTarget.avoidance.overlap={left:l,top:t,right:r,bottom:d};
          scrollTarget.avoidance.candidates=[['right',r,clipped.top,clipped.right,clipped.bottom],['left',clipped.left,clipped.top,l,clipped.bottom],['down',clipped.left,d,clipped.right,clipped.bottom],['up',clipped.left,clipped.top,clipped.right,t]].map(([side,left,top,right,bottom],order)=>({side,order,left,top,right,bottom,width:Math.max(0,right-left),height:Math.max(0,bottom-top),area:Math.max(0,right-left)*Math.max(0,bottom-top)}));
          const ranked=scrollTarget.avoidance.candidates.filter(e=>e.area>0).sort((a,b)=>b.area-a.area||a.order-b.order);
          require(ranked.length>0,'Short scroll bottom button leaves no remaining rectangle');scrollTarget.avoidance.selected=ranked[0];point={x:(ranked[0].left+ranked[0].right)/2,y:(ranked[0].top+ranked[0].bottom)/2};
        }
      }
      scrollTarget.point=point;
      const currentPanels=[...document.querySelectorAll(panelSelector)],currentScrollers=ownedScrollers(),currentButtons=ownedButtons();
      require(sameIdentity()&&currentPanels.length===1&&currentPanels[0]===panel&&currentScrollers.length===1&&currentScrollers[0]===scroller&&document.getElementById('msg-'+messageId)===row&&row.isConnected&&scroller.isConnected&&row.closest('[data-virtuoso-scroller]')===scroller&&row.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')==='true'&&currentButtons.length===buttons.length&&currentButtons[0]===button,'Short scroll node identity changed');
      hit=document.elementFromPoint(point.x,point.y);scrollTarget.hitChecks=1;scrollTarget.hit=describe(hit);
      for(let n=hit?.parentElement;n&&scrollTarget.hitAncestors.length<6;n=n.parentElement)scrollTarget.hitAncestors.push(describe(n));
      require(!!hit&&scroller.contains(hit),'Short scroll point does not hit current scroller');scrollTarget.ready=true;
    }catch(error){scrollTarget.reason=String(error.message??error).slice(0,240);}
  }else if(point)hit=document.elementFromPoint(point.x,point.y);
  return { origin: view.location.origin, hash: view.location.hash, timeOrigin: view.performance.timeOrigin,
    viewport: { width: view.innerWidth, height: view.innerHeight, media: view.matchMedia('(max-height: 320px)').matches,
      visualViewport: view.visualViewport ? { width: view.visualViewport.width, height: view.visualViewport.height, offsetTop: view.visualViewport.offsetTop, offsetLeft: view.visualViewport.offsetLeft, scale: view.visualViewport.scale } : null },
    toolbarCount: panel?.querySelectorAll('[role="toolbar"][aria-label="Message selection"]').length ?? 0,
    dialogs: document.querySelectorAll('[role="dialog"]').length,
    selected: row?.querySelector('[role="checkbox"]')?.getAttribute('aria-checked') === 'true',
    message: { connected: !!row?.isConnected, text: (row?.innerText ?? '').slice(0, 240), rect: box(row), intersection: intersect(row) },
    scroller: scroller ? { rect: box(scroller), intersection: clipped, point,
      hit: !!hit&&scroller.contains(hit),
      top: scroller.scrollTop, max: scroller.scrollHeight - scroller.clientHeight,
      visibleMessages: [...scroller.querySelectorAll('[id^="msg-"]')].filter((e) => intersect(e)?.area > 0).length,
      visibleSample: [...scroller.querySelectorAll('[id^="msg-"]')].filter((e) => intersect(e)?.area > 0).slice(0, 3).map((e) => ({ id: e.id, text: (e.innerText ?? '').slice(0, 160) })) } : null,
    spacerHeight: spacer ? parseFloat(style(spacer).height) : null,
    expectedSpacerHeight: panel ? parseFloat(style(panel).getPropertyValue('--pane-chrome-height')) + 12 : null,
    ...(scrollGuard?{scrollTarget}: {}) };
}

export async function shortSelectionWindow(adb, observe, run, restorePage, verifyWindow) {
  const record = (name, value) => { try { observe(name, value); } catch (error) { console.error('Short selection observation failed:', String(error)); } };
  const original = adb('shell', 'wm', 'size');
  const lines = original.trim().split('\n').map((line) => line.trim());
  assert(lines.length >= 1 && lines.length <= 2 && /^Physical size: \d+x\d+$/.test(lines[0]), 'Unknown WM size state');
  assert(lines.length === 1 || /^Override size: \d+x\d+$/.test(lines[1]), 'Unknown WM override');
  const restore = lines[1]?.slice('Override size: '.length) ?? 'reset';
  let primary, value;
  try {
    record('short-selection-window-before', { original, restore });
    adb('shell', 'wm', 'size', '1080x900');
    value = await run();
  } catch (error) { primary = error; }
  finally {
    try { await restorePage(); }
    catch (error) { record('short-selection-page-restore-error', { error: String(error) }); primary ??= error; }
    try { adb('shell', 'wm', 'size', restore); record('short-selection-window-restored', { restore }); }
    catch (error) { record('short-selection-window-restore-error', { error: String(error) }); primary ??= error; }
    try { await verifyWindow(); }
    catch (error) { record('short-selection-window-verification-error', { error: String(error) }); primary ??= error; }
  }
  if (primary) throw primary;
  return value;
}

export function messageMenuTarget(document, messageId, align = true, short = false, finalCheck) {
  const view = document.defaultView;
  const rect = (e) => { const r = e.getBoundingClientRect(); return { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height }; };
  const describe = (e) => {
    if (!e) return null;
    const style=view.getComputedStyle(e);
    return { tag:e.tagName, id:e.id?.slice(0,160) || null, role:e.getAttribute('role')?.slice(0,160) ?? null, label:e.getAttribute('aria-label')?.slice(0,160) ?? null,
      className:(e.getAttribute('class')??'').slice(0,240), data:{paneChrome:e.getAttribute('data-pane-chrome')?.slice(0,80)??null,panel:e.getAttribute('data-panel')?.slice(0,80)??null,messageRow:e.hasAttribute('data-message-row'),messageBody:e.hasAttribute('data-message-body')},
      rect:rect(e), pointerEvents:style.pointerEvents, position:style.position, zIndex:style.zIndex };
  };
  const visual = view.visualViewport;
  const viewport = { width:view.innerWidth, height:view.innerHeight,
    visual: visual ? { left:visual.offsetLeft, top:visual.offsetTop, width:visual.width, height:visual.height, scale:visual.scale } : null };
  const state = { ready:false, reason:null, rowId:'msg-' + messageId, viewport, body:null, scrollViewport:null, clips:[], clipCount:0, intersection:null, point:null, hit:null, hitAncestors:[] };
  const reject = (message) => { state.reason = message; const error = Error(message); error.targetState = state; throw error; };
  const row = document.getElementById(state.rowId);
  if (!row || !row.isConnected || row.closest('[inert]')) reject('Committed preview target unavailable');
  if(finalCheck)state.row=describe(row);
  if (align) row.scrollIntoView({ block:'center', inline:'nearest', behavior:'instant' });
  if (!row.isConnected || document.getElementById(state.rowId) !== row) reject('Preview target row replaced after scroll');
  const body = row.querySelector('[data-message-body]');
  if (!body || !body.isConnected || !row.contains(body)) reject('Preview target has no current message body');
  const scroller = body.closest('[data-virtuoso-scroller]');
  if (!scroller || !scroller.isConnected) reject('Preview target has no current message scroll viewport');
  state.body = rect(body);
  const clientBox = (e) => { const r=rect(e), left=r.left+e.clientLeft, top=r.top+e.clientTop; return { left, top, right:left+e.clientWidth, bottom:top+e.clientHeight }; };
  state.scrollViewport = clientBox(scroller);
  let left=Math.max(state.body.left,0,visual?.offsetLeft??0), top=Math.max(state.body.top,0,visual?.offsetTop??0);
  let right=Math.min(state.body.right,view.innerWidth,visual?(visual.offsetLeft+visual.width):view.innerWidth), bottom=Math.min(state.body.bottom,view.innerHeight,visual?(visual.offsetTop+visual.height):view.innerHeight);
  for (let node=body;node;node=node.parentElement) {
    const style=view.getComputedStyle(node);
    if (style.display==='none' || style.visibility==='hidden' || style.visibility==='collapse' || Number(style.opacity)===0) reject('Preview target is not visually rendered');
    if (node===body) continue;
    const x=node===scroller || /^(auto|scroll|hidden|clip)$/.test(style.overflowX), y=node===scroller || /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
    if (x || y) {
      const box=clientBox(node); state.clipCount++;
      if (state.clips.length<8) state.clips.push({ ...describe(node), box, x, y });
      if (x) { left=Math.max(left,box.left); right=Math.min(right,box.right); }
      if (y) { top=Math.max(top,box.top); bottom=Math.min(bottom,box.bottom); }
    }
  }
  let pane=null, chrome=null;
  if (short) {
    pane=row.closest('[data-panel="chat"]');
    if (!pane?.isConnected || !pane.contains(scroller) || !pane.contains(row)) reject('Short preview current pane unavailable');
    state.pane=describe(pane);
    const candidates=[...pane.querySelectorAll(':scope > [data-pane-chrome]')];
    state.chromeCount=candidates.length;
    if (candidates.length!==1) reject('Short preview chrome missing or ambiguous');
    chrome=candidates[0];state.chrome=describe(chrome);
    const style=view.getComputedStyle(chrome), paneStyle=view.getComputedStyle(pane), box=state.chrome.rect, paneBox=clientBox(pane);
    state.chromeRelation={paneBox,originalIntersection:{left,top,right,bottom}};
    if (!chrome.isConnected || chrome.parentElement!==pane || chrome.getAttribute('data-pane-chrome')!=='scroller' ||
        style.display==='none' || style.visibility==='hidden' || style.visibility==='collapse' || Number(style.opacity)===0 ||
        style.position!=='absolute' || paneStyle.position!=='relative' || !(box.width>0 && box.height>0) ||
        ![box.left,box.top,box.right,box.bottom,...Object.values(paneBox)].every(Number.isFinite) ||
        Math.abs(box.top-paneBox.top)>1 || box.top>top || box.left>left || box.right<right)
      reject('Short preview chrome top relationship unknown');
    // All values are getBoundingClientRect/client-box viewport coordinates.
    // A content spacer/CSS variable is not an obstruction boundary.
    top=Math.max(top,box.bottom);
    state.chromeRelation.boundary=box.bottom;
  }
  state.intersection={left,top,right,bottom,width:Math.max(0,right-left),height:Math.max(0,bottom-top)};
  if (!(right>left && bottom>top)) reject('Preview target has no visible body intersection');
  let point={x:(left+right)/2,y:(top+bottom)/2};
  let bottomButton=null;
  const samePaneButtons=()=>[...pane.querySelectorAll('button[data-scroll-bottom]')].filter(e=>e.closest('[data-panel]')===pane);
  if(finalCheck){
    if(!short)reject('Bottom-button avoidance requires the current short pane');
    point=finalCheck.originalPoint;state.originalPoint=point;
    const buttons=samePaneButtons(),avoidance={count:buttons.length,button:null,overlap:null,candidates:[],selected:null,rule:'area descending; exact tie right,left,down,up'};state.bottomButtonAvoidance=avoidance;
    if(buttons.length>1)reject('Short preview bottom button ambiguous');
    if(buttons.length===1){
      bottomButton=buttons[0];avoidance.button=describe(bottomButton);avoidance.ownedByCurrentPane=bottomButton.closest('[data-panel]')===pane;
      const style=view.getComputedStyle(bottomButton),b=avoidance.button.rect;
      if(!bottomButton.isConnected||bottomButton.tagName!=='BUTTON'||bottomButton.closest('[inert]')||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0||style.position!=='absolute'||![b.left,b.top,b.right,b.bottom,b.width,b.height].every(Number.isFinite)||b.width<=0||b.height<=0)
        reject('Short preview bottom button geometry unavailable');
      const l=Math.max(left,b.left),t=Math.max(top,b.top),r=Math.min(right,b.right),d=Math.min(bottom,b.bottom);
      if(r>l&&d>t){
        avoidance.overlap={left:l,top:t,right:r,bottom:d};
        avoidance.candidates=[['right',r,top,right,bottom],['left',left,top,l,bottom],['down',left,d,right,bottom],['up',left,top,right,t]]
          .map(([side,left,top,right,bottom],order)=>({side,order,left,top,right,bottom,width:Math.max(0,right-left),height:Math.max(0,bottom-top),area:Math.max(0,right-left)*Math.max(0,bottom-top)}));
        const ranked=avoidance.candidates.filter(e=>e.area>0).sort((a,b)=>b.area-a.area||a.order-b.order);
        if(!ranked.length)reject('Short preview bottom button leaves no remaining rectangle');
        avoidance.selected=ranked[0];point={x:(ranked[0].left+ranked[0].right)/2,y:(ranked[0].top+ranked[0].bottom)/2};
      }
    }
    state.point=point;
    if(!Number.isFinite(point?.x)||!Number.isFinite(point?.y)||point.x<left||point.x>=right||point.y<top||point.y>=bottom)
      reject('Short context original point outside current geometry');
  }
  state.point=point;
  if (!(point.x>0 && point.x<view.innerWidth && point.y>0 && point.y<view.innerHeight)) reject('Preview target point outside viewport');
  if (!row.isConnected || !body.isConnected || document.getElementById(state.rowId)!==row || row.querySelector('[data-message-body]')!==body) reject('Preview target node identity changed');
  if (short && (!pane.isConnected || row.closest('[data-panel="chat"]')!==pane || !chrome.isConnected ||
      pane.querySelectorAll(':scope > [data-pane-chrome]').length!==1 || pane.querySelectorAll(':scope > [data-pane-chrome]')[0]!==chrome))
    reject('Short preview chrome node identity changed');
  if(finalCheck){const current=samePaneButtons();if(current.length!==state.bottomButtonAvoidance.count||(bottomButton&&current[0]!==bottomButton))reject('Short preview bottom button identity changed');}
  const hit=document.elementFromPoint(point.x,point.y); state.hit=describe(hit);
  state.rowContainsHit=!!hit&&row.contains(hit);state.bodyContainsHit=!!hit&&body.contains(hit);state.scrollerContainsHit=!!hit&&scroller.contains(hit);
  state.nearestRowId=hit?.closest('[data-message-row]')?.id??null;
  state.notificationHit=!!hit?.closest('[data-sonner-toaster]');
  for (let n=hit?.parentElement;n && state.hitAncestors.length<6;n=n.parentElement) state.hitAncestors.push(describe(n));
  if (!hit || !row.contains(hit) || hit.closest('[data-message-row]')!==row || (finalCheck&&(!state.bodyContainsHit||!state.scrollerContainsHit))) reject('Preview target point is occluded or belongs to another row');
  state.ready=true; state.hitTag=hit.tagName;
  return state;
}

export function fileComposer(document, name, text) {
  const forms = [...document.querySelectorAll('form[data-composer]')].filter((form) => {
    const r = form.getBoundingClientRect();
    return !form.closest('[inert]') && r.width > 0 && r.height > 0;
  });
  if (forms.length !== 1) throw Error('Expected one current file composer, found ' + forms.length);
  const form = forms[0];
  const textarea = form.querySelector('textarea[data-composer-input]');
  const send = form.querySelector('[data-composer-action="send"]');
  const file = form.querySelector('input[type=file]');
  if (!textarea || !send || !file) throw Error('File composer controls missing');
  const state = {
    route: document.defaultView.location.hash,
    value: textarea.value,
    textareaDisabled: textarea.disabled,
    sendDisabled: send.disabled,
    filenamePresent: form.innerText.includes(name),
    uploadingText: form.innerText.includes('Uploading…'),
    targetFocused: document.activeElement === textarea,
  };
  state.ready = !state.textareaDisabled && !state.sendDisabled && state.value === text && state.filenamePresent && !state.uploadingText;
  return { textarea, send, file, state };
}

export function leftControlTarget(document, selector, text, guard, bindClickTarget = true) {
  const view = document.defaultView;
  const rect = (element) => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const describe = (element) => {
    if (!element) return null;
    const style = view.getComputedStyle?.(element) ?? {};
    return { tag: element.tagName, id: element.id || null, className: (element.getAttribute('class') ?? '').slice(0, 240), ariaLabel: element.getAttribute('aria-label'), role: element.getAttribute('role'), rect: rect(element), overflowX: style.overflowX, overflowY: style.overflowY, position: style.position, zIndex: style.zIndex, pointerEvents: style.pointerEvents };
  };
  const shown = (element) => {
    const r = rect(element);
    return !element.closest('[inert]') && r.width > 0 && r.height > 0;
  };
  const candidates = [...document.querySelectorAll(selector)].filter((element) => shown(element) && (text === undefined || element.textContent.trim() === text));
  const state = { sampledAt: Date.now(), selector, text, route: view.location?.hash, candidateCount: candidates.length, viewport: { width: view.innerWidth, height: view.innerHeight }, ready: false, fatal: false };
  if (guard?.route === '#/settings?settingsSection=appearance') {
    try {
      const attributes = (element) => ({
        tag: element.tagName, rect: rect(element), hover: element.matches(':hover'),
        expanded: element.getAttribute('data-expanded'), swiping: element.getAttribute('data-swiping'),
        visible: element.getAttribute('data-visible'), removed: element.getAttribute('data-removed'),
      });
      const toasters = [...document.querySelectorAll('[data-sonner-toaster]')];
      const toasts = [...document.querySelectorAll('[data-sonner-toast]')];
      const activeAncestors = [];
      for (let node = document.activeElement; node && activeAncestors.length < 6; node = node.parentElement)
        activeAncestors.push({ tag: node.tagName, role: node.getAttribute('role'), ariaLabel: node.getAttribute('aria-label'), inNotification: !!node.closest('[data-sonner-toaster]') });
      state.notificationInteraction = {
        status: 'observed', sampledAt: Date.now(), visibility: document.visibilityState ?? null,
        hidden: typeof document.hidden === 'boolean' ? document.hidden : null,
        focused: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
        toasterCount: toasters.length, toasters: toasters.slice(0, 8).map(attributes),
        toastCount: toasts.length, toasts: toasts.slice(0, 8).map(attributes), activeAncestors,
        internal: { expanded: 'unknown', interacting: 'unknown', documentHidden: 'unknown', remainingTime: 'unknown' },
      };
    } catch (error) {
      state.notificationInteraction = { status: 'unknown', error: String(error) };
    }
  }
  if (candidates.length !== 1) return { ...state, fatal: true, reason: 'target_not_unique' };
  const target = candidates[0];
  state.target = describe(target);
  state.point = { x: state.target.rect.x + state.target.rect.width / 2, y: state.target.rect.y + state.target.rect.height / 2 };
  const hit = document.elementFromPoint(state.point.x, state.point.y);
  state.hit = describe(hit);
  state.hitAncestors = [];
  for (let node = hit?.parentElement; node && state.hitAncestors.length < 6; node = node.parentElement) state.hitAncestors.push(describe(node));
  state.clippingAncestors = [];
  for (let node = target.parentElement; node && state.clippingAncestors.length < 6; node = node.parentElement) {
    const info = describe(node);
    if (/(auto|scroll|hidden|clip)/.test((info.overflowX ?? '') + ' ' + (info.overflowY ?? '')))
      state.clippingAncestors.push({ ...info, scrollTop: node.scrollTop, scrollLeft: node.scrollLeft, clientWidth: node.clientWidth, clientHeight: node.clientHeight });
  }
  if (guard) {
    const bars = guard.messageId === undefined ? null : [...document.querySelectorAll('[role=toolbar][aria-label="Message selection"]')].filter(shown);
    if (bars) state.selection = { toolbarCount: bars.length, targetSelected: document.getElementById('msg-' + guard.messageId)?.querySelector('[role=checkbox]')?.getAttribute('aria-checked') === 'true' };
    if (state.route !== guard.route) return { ...state, fatal: true, reason: 'route_changed' };
    if (guard.previewIdentity) {
      const expected=guard.previewIdentity;
      if(view.location.origin!==expected.origin||view.location.href!==expected.href||view.location.hash!==expected.hash||view.performance.timeOrigin!==expected.timeOrigin)
        return {...state,fatal:true,reason:'preview_document_changed'};
      const previews=[...document.querySelectorAll('[role="dialog"][data-modal-shell][data-image-export-preview]')].filter(e=>{
        const s=view.getComputedStyle(e);return e.isConnected&&shown(e)&&!e.hidden&&s.display!=='none'&&s.visibility!=='hidden'&&s.visibility!=='collapse'&&Number(s.opacity)!==0;
      });
      if(previews.length!==1||!previews[0].contains(target)||!previews[0].querySelector('[data-image-export-scroll]')||!previews[0].querySelector('[data-image-export-actions]'))
        return {...state,fatal:true,reason:'preview_identity_unavailable'};
      const closes=[...previews[0].querySelectorAll('button[aria-label="Close"]')].filter(shown);
      if(closes.length!==1||closes[0]!==target)return {...state,fatal:true,reason:'preview_close_not_unique'};
    }
    if (bars && (state.selection.targetSelected !== guard.selected || bars.length !== (guard.selected ? 1 : 0)))
      return { ...state, fatal: true, reason: 'selection_changed' };
  }
  // Batch reachability does not own a click; actual clicks retain their same-target guard.
  if (bindClickTarget) {
    if (view.__b2LeftClickTarget && view.__b2LeftClickTarget !== target) return { ...state, fatal: true, reason: 'target_replaced' };
    view.__b2LeftClickTarget = target; // Released by click() on success or failure; no DOM mutation.
  }
  if (target.disabled || target.hasAttribute('data-disabled') || target.getAttribute('aria-disabled') === 'true')
    return { ...state, reason: 'disabled' };
  if (!(state.point.x > 0 && state.point.x < view.innerWidth && state.point.y > 0 && state.point.y < view.innerHeight))
    return { ...state, reason: 'outside_viewport' };
  if (!hit || (hit !== target && !target.contains(hit))) return { ...state, reason: 'occluded' };
  return { ...state, ready: true, reason: null };
}

export async function waitLeftControl(read, record, deadline) {
  let rejected = false;
  while (true) {
    const state = await read();
    if (state.fatal || Date.now() >= deadline) {
      record('last', state);
      throw Error('Left-click precondition stopped: ' + (state.fatal ? state.reason : 'shared_budget_expired'));
    }
    if (state.ready) return state;
    if (!rejected) { record('rejected', state); rejected = true; }
    await delay(Math.min(200, Math.max(0, deadline - Date.now())));
  }
}

// Diagnostics are independent observations; a failed read never replaces the action error.
export async function sampleShare(observe, name, read) {
  const startedAt = new Date().toISOString();
  let result;
  try {
    result = { status: 'observed', value: await read() };
  } catch (error) {
    result = { status: 'unknown', error: { type: error?.name ?? typeof error, message: String(error) } };
  }
  result.sampleStartedAt = startedAt;
  result.sampleFinishedAt = new Date().toISOString();
  try { observe(name, result); }
  catch (error) { console.error('Share diagnostic recording failed:', name, String(error)); }
  return result;
}

export function shareBridgeState() {
  return {
    probeInstalled: window.__b2Probe === true,
    calls: (Array.isArray(window.__b2Calls) ? window.__b2Calls : [])
      .filter((row) => row.method === 'sharePng')
      .map(({ method, settled, completed, rejected, error, code, value }) =>
        ({ method, settled, completed, rejected, error, code, value })),
  };
}

export function appearanceState() {
  return { route: location.hash, theme: document.documentElement.dataset.theme, confirmation: document.documentElement.dataset.themePersistence, appearance: localStorage.getItem('silverhand:appearance') };
}

export function barPageState(document) {
  const view=document.defaultView;
  const describe=(e)=>{const r=e.getBoundingClientRect();return{text:(e.textContent??'').trim().slice(0,160),rect:{left:r.left,top:r.top,width:r.width,height:r.height},inert:!!e.closest('[inert]')};};
  const checks=[...document.querySelectorAll('[data-appearance-pane] [aria-label="Current theme"]')];
  const statuses=[...document.querySelectorAll('[data-appearance-pane] [role="status"]')];
  return {sampledAt:Date.now(),origin:view.location.origin,href:view.location.href,hash:view.location.hash,timeOrigin:view.performance.timeOrigin,
    theme:document.documentElement.dataset.theme,confirmation:document.documentElement.dataset.themePersistence,
    checkedCount:checks.length,checkedCards:checks.slice(0,8).map(e=>e.closest('button')).filter(Boolean).map(describe),
    statusCount:statuses.length,statuses:statuses.slice(0,8).map(describe),background:view.getComputedStyle(document.body).backgroundColor};
}

// Two fresh DOM observations bracket the original single screenshot, not a frame acknowledgement.
export async function observeBarScreenshot(c, observe, name, capture) {
  const before=await sampleShare(observe,name+'-dom-before',()=>c.evaluate(`(${barPageState.toString()})(document)`));
  let primary,value,command,after;
  try {value=capture(state=>{command=state;try{observe(name+'-screencap-command',state);}catch(error){console.error('Screencap observation failed:',String(error));}});}
  catch(error){primary=error;}
  finally {after=await sampleShare(observe,name+'-dom-after',()=>c.evaluate(`(${barPageState.toString()})(document)`));}
  const a=before.value,b=after.value;
  const identityCurrent=!!(before.status==='observed'&&after.status==='observed'&&a&&b&&typeof a.origin==='string'&&typeof a.href==='string'&&Number.isFinite(a.timeOrigin)&&a.hash==='#/settings?settingsSection=appearance'&&['origin','href','hash','timeOrigin'].every(k=>a[k]===b[k]));
  const result={before,after,command:command??null,file:value?.file??null,sha256:value?.sha256??null,identityCurrent,diagnosticOnly:true,screenPresentation:'not_observed'};
  try{observe(name+'-screenshot-observation',result);}catch(error){console.error('Screenshot observation failed:',String(error));}
  if(primary)throw primary;
  assert(before.status==='observed'&&after.status==='observed','Bar screenshot DOM observation unavailable');
  assert(identityCurrent,'Bar screenshot document identity changed or unavailable');
  return result;
}

// Cold-start navigation is published after native theme confirmation, at React mount.
export function themeRestartPage(id) {
  const shells = [...document.querySelectorAll('.app-shell')].filter((e) => e.isConnected);
  const frames = shells.length === 1 ? [...shells[0].querySelectorAll('[data-app-frame]')].filter((e) => e.isConnected) : [];
  const pages = frames.length === 1 ? [...frames[0].querySelectorAll('[data-page-stack] > [data-page]')]
    .filter((e) => e.isConnected && !e.hasAttribute('inert') && e.getAttribute('aria-hidden') !== 'true') : [];
  const theme = document.documentElement?.dataset.theme ?? null;
  const confirmation = document.documentElement?.dataset.themePersistence ?? null;
  const themeHeld = theme === id && confirmation === 'confirmed';
  const navigationReady = shells.length === 1 && frames.length === 1 && pages.length === 1 && location.hash === '#/chat';
  return { sampledAt: Date.now(), origin: location.origin, href: location.href, timeOrigin: performance.timeOrigin,
    route: location.hash, readyState: document.readyState, theme, confirmation, themeHeld,
    shellCount: shells.length, frameCount: frames.length, currentPageCount: pages.length, navigationReady,
    ready: themeHeld && navigationReady };
}

export async function sampleThemeRestart(c, adb, observe, name, packageName, documentIdentity = false) {
  const page = await sampleShare(observe, name + '-page', () => c.evaluate(`({...(${appearanceState.toString()})(),origin:location.origin,href:location.href${documentIdentity ? ',timeOrigin:performance.timeOrigin' : ''}})`));
  await sampleShare(observe, name + '-pid', () => {
    const value = adb('shell', 'pidof', packageName).trim();
    assert(/^\d+(?:\s+\d+)*$/.test(value), 'Package PID unavailable');
    return { packageName, pids: value.split(/\s+/).map(Number) };
  });
  await sampleShare(observe, name + '-target', async () => {
    const { targetInfo } = await c.send('Target.getTargetInfo');
    assert(targetInfo?.targetId, 'Connected CDP target identity unavailable');
    const { targetId, type, url, browserContextId } = targetInfo;
    return { targetId, type, url, browserContextId: browserContextId ?? null };
  });
  return page;
}

export async function moveThemePointer(c, observe, name, deadline) {
  const expression = `(()=>{const state=(${leftControlTarget.toString()})(document,'header[data-pane-header] > [data-pane-header-title]','Appearance',{route:'#/settings?settingsSection=appearance'});const hit=state.point&&document.elementFromPoint(state.point.x,state.point.y);return {...state,notificationHit:!!hit?.closest('[data-sonner-toaster]')}})()`;
  try {
    await c.evaluate('delete window.__b2LeftClickTarget');
    const anchor = await c.evaluate(expression);
    observe(name + '-pointer-before', anchor);
    assert(!anchor.fatal && anchor.ready && !anchor.notificationHit, 'Theme pointer anchor rejected: ' + anchor.reason);
    assert(Date.now() < deadline, 'Theme pointer budget exhausted before movement');
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'none', buttons: 0, ...anchor.point });
    const after = await sampleShare(observe, name + '-pointer-after', () => c.evaluate(expression));
    if (after.status === 'observed') assert(!after.value.fatal, 'Theme pointer context changed: ' + after.value.reason);
    assert(Date.now() < deadline, 'Theme pointer budget exhausted after movement');
  } finally {
    try { await c.evaluate('delete window.__b2LeftClickTarget'); }
    catch (error) { console.error('Theme pointer anchor release failed:', String(error)); }
  }
}

// Short preview only. Metadata is sampled at document capture time, before later handlers.
export function shortMenuCapture(document, messageId, route, action = 'sample') {
  const view = document.defaultView, key = '__b2ShortMenuCapture';
  const identity = () => ({ origin:view.location.origin, hash:view.location.hash, timeOrigin:view.performance.timeOrigin });
  const describe = (e) => {
    if (!e?.getAttribute) return null;
    const r=e.getBoundingClientRect(), style=view.getComputedStyle?.(e);
    return { tag:e.tagName, id:(e.id??'').slice(0,160), role:e.getAttribute('role')?.slice(0,80)??null,
      className:(e.getAttribute('class')??'').slice(0,240), messageRow:e.hasAttribute('data-message-row'), messageBody:e.hasAttribute('data-message-body'),
      scrollBottom:e.hasAttribute('data-scroll-bottom'), label:e.getAttribute('aria-label')?.slice(0,160)??null,title:e.getAttribute('title')?.slice(0,160)??null,
      pane:e.getAttribute('data-pane')?.slice(0,80)??null,panel:e.getAttribute('data-panel')?.slice(0,80)??null,
      nearestPane:e.closest('[data-pane]')?.getAttribute('data-pane')?.slice(0,80)??null,nearestPanel:e.closest('[data-panel]')?.getAttribute('data-panel')?.slice(0,80)??null,
      rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height},pointerEvents:style?.pointerEvents??null };
  };
  const types = ['pointerdown','pointerup','mousedown','mouseup','contextmenu','click','auxclick'];
  if (action === 'install') {
    if (view[key]) return { status:'refused', reason:'capture_already_installed' };
    const row=document.getElementById('msg-'+messageId), body=row?.querySelector('[data-message-body]'), scroller=body?.closest('[data-virtuoso-scroller]');
    if (view.location.hash!==route || !row?.isConnected || !body?.isConnected || !scroller?.isConnected || !row.contains(body)) return {status:'refused',reason:'capture_target_unavailable',identity:identity()};
    const saved={document,row,body,scroller,identity:identity(),installedAt:Date.now(),events:[],total:0,dropped:0,errors:[],types:[]};
    saved.handler=(event)=>{try {
      saved.total++;
      if(saved.events.length>=16){saved.dropped++;return;}
      const target=event.target;
      saved.events.push({ type:event.type, sampledAt:Date.now(), eventTimeStamp:event.timeStamp, samplingPhase:'document_capture', eventPhase:event.eventPhase,
        isTrusted:event.isTrusted, defaultPreventedAtCapture:event.defaultPrevented, button:event.button, buttons:event.buttons,
        pointerType:typeof event.pointerType==='string'?event.pointerType.slice(0,20):null, clientX:event.clientX, clientY:event.clientY,
        target:describe(target), path:event.composedPath().slice(0,8).map(describe), rowContainsTarget:saved.row.contains(target), bodyContainsTarget:saved.body.contains(target), scrollerContainsTarget:saved.scroller.contains(target),
        identity:identity(), originalRowConnected:saved.row.isConnected, currentRowMatches:document.getElementById('msg-'+messageId)===saved.row });
    } catch(error){if(saved.errors.length<2)saved.errors.push(String(error).slice(0,240));}};
    try { for(const type of types){document.addEventListener(type,saved.handler,true);saved.types.push(type);} view[key]=saved; }
    catch(error){for(const type of saved.types)document.removeEventListener(type,saved.handler,true);return{status:'unknown',reason:'capture_install_failed',error:String(error).slice(0,240)};}
  }
  const saved=view[key];
  if(!saved) return {status:'not_installed',identity:identity(),release:action==='release'?'not_installed':null};
  let result;
  try {
    const current=identity(), identityCurrent=saved.document===document && current.origin===saved.identity.origin && current.hash===route && current.hash===saved.identity.hash && current.timeOrigin===saved.identity.timeOrigin && saved.row.isConnected && saved.body.isConnected && saved.scroller.isConnected && document.getElementById('msg-'+messageId)===saved.row && saved.row.querySelector('[data-message-body]')===saved.body;
    result={status:action==='install'?'installed':'observed',sampledAt:Date.now(),installedAt:saved.installedAt,identity:saved.identity,currentIdentity:current,identityCurrent,
      listenerTypes:saved.types,events:saved.events.slice(),total:saved.total,dropped:saved.dropped,errors:saved.errors.slice(),limit:16,release:null};
    return result;
  } finally {
    if(action==='release'){
      const errors=[];
      for(const type of saved.types)try{document.removeEventListener(type,saved.handler,true);}catch(error){errors.push(String(error).slice(0,240));}
      delete view[key];
      if(result){result.release=errors.length?'unknown':'released';result.releasedAt=Date.now();result.releaseErrors=errors;}
    }
  }
}

export async function shortContextMenu(c, observe, name, point, messageId, route, deadline) {
  const record=(suffix,value)=>{try{observe(name+suffix,value);}catch(error){console.error('Short context observation failed:',String(error));}};
  const started=Date.now();let reads=0,last=null,primary;
  try {
    assert(Date.now()<deadline,'Short preview budget exhausted before menu');
    let check;
    try {check=await c.evaluate(`(()=>{const capture=(${shortMenuCapture.toString()})(document,${JSON.stringify(messageId)},${JSON.stringify(route)});
      if(capture.status!=='observed'||!capture.identityCurrent)return {...capture,pointCheck:{ready:false,reason:'Short context point identity changed or unavailable',geometry:'not_evaluated_identity_rejected'}};
      try{return {...capture,pointCheck:(${messageMenuTarget.toString()})(document,${JSON.stringify(messageId)},false,true,{originalPoint:${JSON.stringify(point)}})};}
      catch(error){return {...capture,pointCheck:error.targetState??{ready:false,reason:String(error)},pointError:{type:error.name,message:error.message}};}})()`);}
    catch(error){record('-point-check',{status:'unknown',error:String(error)});throw error;}
    record('-point-check',check);
    assert(check?.status==='observed'&&check.identityCurrent,'Short context point identity changed or unavailable');
    assert(check.pointCheck?.ready,check.pointCheck?.reason??'Short context original point check unavailable');
    assert(Date.now()<deadline,'Short preview budget exhausted after point check');
    const checkedPoint=check.pointCheck.point;
    for(const type of ['mousePressed','mouseReleased']){
      const start=Date.now();record('-'+type+'-start',{at:start});
      try {await c.send('Input.dispatchMouseEvent',{type,button:'right',clickCount:1,...checkedPoint});record('-'+type+'-end',{at:Date.now(),status:'returned'});}
      catch(error){record('-'+type+'-end',{at:Date.now(),status:'failed',error:String(error)});throw error;}
    }
    record('-wait-start',{at:Date.now(),deadline});
    while(reads<150 && Date.now()<deadline){
      last=await c.evaluate(`(()=>{const capture=(${shortMenuCapture.toString()})(document,${JSON.stringify(messageId)},${JSON.stringify(route)});
        const row=document.getElementById(${JSON.stringify('msg-'+messageId)}),items=[...document.querySelectorAll('[role=menuitem]')],menus=[...document.querySelectorAll('[role=menu]')];
        const shares=items.filter(e=>e.textContent.trim()==='Share…');return {sampledAt:Date.now(),capture,trigger:row?{id:row.id,state:row.getAttribute('data-state'),disabled:row.getAttribute('data-disabled'),ariaDisabled:row.getAttribute('aria-disabled'),ariaHaspopup:row.getAttribute('aria-haspopup')}:null,
          menuCount:menus.length,itemCount:items.length,shareCount:shares.length,items:items.slice(0,8).map(e=>({text:e.textContent.trim().slice(0,120),state:e.getAttribute('data-state'),disabled:e.getAttribute('data-disabled')})),ready:shares.length>0};})()`);
      reads++;if(reads===1)record('-wait-first',{read:reads,...last});
      assert(last.capture?.status==='observed'&&last.capture.identityCurrent,'Short context capture document/row identity changed or unavailable');
      if(last.ready){assert(Date.now()<deadline,'Short preview budget exhausted after menu read');return last;}
      if(reads<150&&Date.now()<deadline)await delay(Math.min(200,Math.max(0,deadline-Date.now())));
    }
    throw Error(Date.now()>=deadline?'Short context menu deadline exhausted':'Short context menu read limit exhausted');
  } catch(error){primary=error;throw error;}
  finally {record('-wait-last',{startedAt:started,endedAt:Date.now(),deadline,reads,elapsedMs:Date.now()-started,value:last,error:primary?String(primary):null});}
}

// Short preview only: one real pointer leave, then fresh hit checks in its original deadline.
export async function shortMenuTarget(c, observe, name, messageId, route, deadline) {
  const record = (suffix, value) => { try { observe(name + suffix, value); } catch (error) { console.error('Short menu observation failed:', String(error)); } };
  const notificationProjection = `(document)=>{try{return {status:'observed',toasters:[...document.querySelectorAll('[data-sonner-toaster]')].slice(0,8).map(e=>({hover:e.matches(':hover'),expanded:e.getAttribute('data-expanded')})),toasts:[...document.querySelectorAll('[data-sonner-toast]')].slice(0,8).map(e=>({hover:e.matches(':hover'),expanded:e.getAttribute('data-expanded')}))}}catch(error){return {status:'unknown',error:String(error)}}}`;
  const started = Date.now();
  let reads = 0, last = null, primary;
  try {
    assert(Date.now() < deadline, 'Short preview budget exhausted before pointer anchor');
    const anchor = await c.evaluate(`(()=>{delete window.__b2LeftClickTarget;
      const state=(${leftControlTarget.toString()})(document,'form[data-composer] textarea[data-composer-input]',undefined,{route:${JSON.stringify(route)}});
      const row=document.getElementById(${JSON.stringify('msg-' + messageId)}),body=row?.querySelector('[data-message-body]');
      const identity={origin:location.origin,href:location.href,hash:location.hash,timeOrigin:performance.timeOrigin};
      const hit=state.point&&document.elementFromPoint(state.point.x,state.point.y);
      state.notificationHit=!!hit?.closest('[data-sonner-toaster]');state.identity=identity;state.notificationInteraction=(${notificationProjection})(document);
      if(!row?.isConnected||!body?.isConnected||!row.contains(body)){state.ready=false;state.fatal=true;state.reason='message_identity_unavailable';}
      if(state.ready&&!state.fatal&&!state.notificationHit)window.__b2ShortMenuPointer={row,body,anchor:window.__b2LeftClickTarget,...identity};
      return state;})()`);
    record('-pointer-before', anchor);
    assert(anchor.ready && !anchor.fatal && !anchor.notificationHit, 'Short menu pointer anchor rejected: ' + anchor.reason);
    assert(Date.now() < deadline, 'Short preview budget exhausted before pointer movement');
    await c.send('Input.dispatchMouseEvent', { type:'mouseMoved', button:'none', buttons:0, ...anchor.point });
    // 150 includes the original target read. Each poll uses one new DOM projection;
    // only notification occlusion is retryable. No second scroll or alternate point.
    for (; reads < 150;) {
      assert(Date.now() < deadline, 'Short preview budget exhausted waiting for message hit');
      last = await c.evaluate(`(()=>{let target=null;const notificationInteraction=(${notificationProjection})(document);try{
        const saved=window.__b2ShortMenuPointer;
        if(!saved||location.origin!==saved.origin||location.href!==saved.href||location.hash!==${JSON.stringify(route)}||performance.timeOrigin!==saved.timeOrigin)throw Error('Short menu document/route changed');
        if(!saved.row.isConnected||!saved.body.isConnected||!saved.anchor.isConnected||document.getElementById(${JSON.stringify('msg-' + messageId)})!==saved.row||saved.row.querySelector('[data-message-body]')!==saved.body||window.__b2LeftClickTarget!==saved.anchor)throw Error('Short menu node identity changed');
        target=(${messageMenuTarget.toString()})(document,${JSON.stringify(messageId)},${reads === 0},true);
        if(target.ready){target.captureInstall=(${shortMenuCapture.toString()})(document,${JSON.stringify(messageId)},${JSON.stringify(route)},'install');if(target.captureInstall.status!=='installed'||!target.captureInstall.identityCurrent)throw Error('Short context capture installation failed');}
        return {target,error:null,retryable:false,notificationInteraction};
      }catch(error){target=error.targetState??target;return {target,error:{type:error.name,message:error.message},retryable:target?.reason==='Preview target point is occluded or belongs to another row'&&target.notificationHit===true,notificationInteraction};}})()`);
      reads++;
      // Hover/expanded are observations only, never an instantaneous pass/fail gate.
      if (reads === 1) record('-menu-first', { read:reads, ...last });
      if (last.error && !last.retryable) throw Error(last.error.message);
      if (!last.error && last.target?.ready) {
        assert(Date.now() < deadline, 'Short preview budget exhausted after message hit');
        record('-menu-target', { ...last.target, reads, elapsedMs:Date.now()-started });
        return last.target;
      }
      assert(last.retryable, 'Short menu target refused without a notification hit');
      if (reads < 150 && Date.now() < deadline) await delay(Math.min(200, Math.max(0, deadline-Date.now())));
    }
    throw Error('Short menu message-hit read limit exhausted');
  } catch (error) { primary = error; throw error; }
  finally {
    record('-menu-last', { reads, elapsedMs:Date.now()-started, deadline, value:last, error:primary ? String(primary) : null });
    try {
      await c.evaluate('delete window.__b2ShortMenuPointer; delete window.__b2LeftClickTarget');
      record('-pointer-release', { status:'released' });
    } catch (error) {
      record('-pointer-release', { status:'unknown', error:String(error) });
      if (!primary) throw error;
    }
  }
}

export async function clickNativeShareOnce(c, observe, route) {
  try {
    await c.evaluate('delete window.__b2LeftClickTarget');
    const target = await c.evaluate(`(${leftControlTarget.toString()})(document,'[role=dialog] button[aria-label="Share"]','Share')`);
    observe('native-share-click-target', { sampledAt: new Date().toISOString(), ...target });
    assert.equal(target.route, route, 'Unexpected route before native Share');
    assert.equal(target.ready, true, 'Native Share target rejected: ' + target.reason);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...target.point });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...target.point });
    observe('native-share-dispatch-returned', { at: new Date().toISOString(), eventConsumption: 'not_observed' });
  } finally {
    await sampleShare(observe, 'native-share-target-release', () => c.evaluate('delete window.__b2LeftClickTarget'));
  }
}

export function nativeShareTarget(nodes) {
  const resolver = 'com.android.intentresolver';
  const rect = (node) => {
    const values = node?.bounds?.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/)?.slice(1).map(Number);
    return values && values[2] > values[0] && values[3] > values[1] ? values : null;
  };
  const inside = (outer, inner) => outer && inner && inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
  const screen = rect(nodes[0]);
  assert(nodes[0]?.package === resolver && screen && nodes.some((n) => n.package === resolver && n.text === 'Sharing image'), 'Left image chooser');
  const own = nodes.filter((n) => n.package === resolver);
  const matches = own.filter((n) => n.text === 'B2 Share Check' || n['content-desc']?.includes('B2 Share Check'));
  assert(matches.length <= 1, 'Chooser target is ambiguous');
  const target = matches[0];
  if (target) assert.equal(target.enabled, 'true', 'Chooser target disabled');
  const bounds = rect(target);
  const lists = own.filter((n) => n['resource-id'] === 'android:id/resolver_list' && inside(screen, rect(n)));
  assert(lists.length <= 1, 'Chooser target viewport ambiguous');
  if (bounds && lists.length && inside(rect(lists[0]), bounds)) {
    // UIAutomator labels need not be clickable; require their actual resolver item.
    const items = target.clickable === 'true' ? [target] : own.filter((n) => n['resource-id'] === resolver + ':id/item' && n.clickable === 'true' && n.enabled === 'true' && inside(rect(n), bounds));
    assert.equal(items.length, 1, 'Chooser target has no unique clickable item');
    return { target, item: items[0], point: { x: Math.floor((bounds[0] + bounds[2]) / 2), y: Math.floor((bounds[1] + bounds[3]) / 2) } };
  }
  const containers = own.filter((n) => n['resource-id'] === resolver + ':id/chooser_scrollable_container' && n.scrollable === 'true' && inside(screen, rect(n)));
  const handles = own.filter((n) => n['resource-id'] === 'android:id/drag' && inside(screen, rect(n)));
  assert(containers.length <= 1 && handles.length <= 1, 'Chooser navigation geometry ambiguous');
  return { screen, container: containers[0], handle: handles[0], rect };
}

export async function selectNativeShareTarget(ui, observe, capture) {
  let previous = null, navigations = 0, expanded = false, scrolls = 0, last = null;
  const record = (name, value) => observe('native-share-navigation-' + name, { sampledAt: new Date().toISOString(), ...value });
  try {
    // Same twelve UI reads as nativeUI.tap. A 200ms swipe replaces that poll's
    // 200ms pause; there is no second lookup loop after navigation.
    for (let read = 0; read < 12; read++) {
      const nodes = await ui.nodes();
      last = { read: read + 1, nodes };
      const state = nativeShareTarget(nodes);
      if (state.target) {
        record('visible-target', { target: state.target, item: state.item, point: state.point, navigations });
        if (navigations) {
          record('after', last);
          await sampleShare(observe, 'native-share-navigation-screenshot', capture);
        }
        await ui.adb('shell', 'input', 'tap', String(state.point.x), String(state.point.y));
        return;
      }
      const signature = JSON.stringify(nodes.map((n) => [n['resource-id'], n.text, n['content-desc'], n.bounds, n.scrollable, n.enabled, n.clickable]));
      assert(signature !== previous, 'Chooser navigation made no visible change / reached end');
      assert(read < 11 && navigations < 3, 'Chooser lookup/navigation budget exhausted');
      if (!navigations) record('before', last);
      let from, to, kind;
      if (!expanded && state.handle) {
        const [left, top, right, bottom] = state.rect(state.handle);
        const [, sy, , ey] = state.screen;
        from = { x: Math.floor((left + right) / 2), y: Math.floor((top + bottom) / 2) };
        to = { x: from.x, y: Math.max(Math.ceil(sy + (ey - sy) * .1), Math.floor(from.y - (ey - sy) * .5)) };
        assert(to.y < from.y, 'Chooser handle cannot expand within screen');
        expanded = true; kind = 'expand';
      } else {
        assert(state.container && scrolls < 2, 'Chooser is not scrollable / scroll limit reached');
        const [left, top, right, bottom] = state.rect(state.container);
        from = { x: Math.floor((left + right) / 2), y: Math.floor(top + (bottom - top) * .8) };
        to = { x: from.x, y: Math.ceil(top + (bottom - top) * .2) };
        scrolls++; kind = 'scroll';
      }
      record('action', { read: read + 1, action: ++navigations, kind, from, to, durationMs: 200 });
      previous = signature;
      await ui.adb('shell', 'input', 'swipe', String(from.x), String(from.y), String(to.x), String(to.y), '200');
    }
    throw Error('Chooser lookup budget exhausted');
  } catch (error) {
    await sampleShare(observe, 'native-share-navigation-last', () => ({ ...last, navigations, scrolls, error: String(error) }));
    throw error;
  }
}

function nativeBounds(node) {
  const values = node?.bounds?.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/)?.slice(1).map(Number);
  return values?.every(Number.isSafeInteger) && values[2] > values[0] && values[3] > values[1] ? values : null;
}
function nativeBoundsContain(outer, inner) {
  return outer && inner && inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}
export function photoPickerMoreTarget(nodes) {
  const chooser = 'com.google.android.photopicker';
  const rect = nativeBounds, inside = nativeBoundsContain;
  const screen = rect(nodes?.[0]);
  assert(screen && screen[0] >= 0 && screen[1] >= 0 && nodes.every((n) => n.package === chooser), 'Not the observed Photo Picker');
  assert(['Photos', 'Albums'].every((text) => nodes.filter((n) => n.text === text).length === 1), 'Photo Picker main surface changed');
  const labels = nodes.filter((n) => n['content-desc'] === 'More');
  assert.equal(labels.length, 1, 'Photo Picker More label missing or ambiguous');
  assert.equal(labels[0].enabled, 'true', 'Photo Picker More label disabled');
  const labelRect = rect(labels[0]);
  assert(inside(screen, labelRect), 'Photo Picker More label outside screen');
  // UIAutomator was flattened: geometric containment is not a parent-chain claim.
  const items = nodes.filter((n) => n.clickable === 'true' && inside(rect(n), labelRect));
  assert.equal(items.length, 1, 'Photo Picker More clickable target missing or ambiguous');
  const item = items[0], bounds = rect(item);
  assert.equal(item.enabled, 'true', 'Photo Picker More target disabled');
  assert(inside(screen, bounds), 'Photo Picker More target outside screen');
  return { label: labels[0], item, screen, point: { x: Math.floor((bounds[0] + bounds[2]) / 2), y: Math.floor((bounds[1] + bounds[3]) / 2) } };
}

export async function inspectPhotoPickerMore(ui, observe, snapshot, before) {
  let stage = 'before-menu', tapAttempts = 0;
  try {
    assert.equal(before?.status, 'observed', 'Photo Picker before-menu UI unavailable');
    assert.equal(before.capture?.screenshot, 'observed', 'Photo Picker before-menu screenshot unavailable');
    assert.equal(before.capture?.window, 'observed', 'Photo Picker before-menu window unavailable');
    photoPickerMoreTarget(before.value);
    stage = 'fresh-target';
    const fresh = await ui.nodes();
    await sampleShare(observe, 'photo-picker-more-fresh-ui', () => fresh);
    const target = photoPickerMoreTarget(fresh);
    assert.equal(JSON.stringify(fresh), JSON.stringify(before.value), 'Photo Picker changed before More tap');
    await sampleShare(observe, 'photo-picker-more-target', () => ({ sampledAt: new Date().toISOString(), ...target }));
    stage = 'more-tap';
    tapAttempts++;
    await ui.adb('shell', 'input', 'tap', String(target.point.x), String(target.point.y));
    await sampleShare(observe, 'photo-picker-more-dispatch-returned', () => ({ at: new Date().toISOString(), tapAttempts, eventConsumption: 'not_observed' }));
    stage = 'after-menu';
    const after = await snapshot('after-menu');
    assert.equal(after?.status, 'observed', 'Photo Picker after-menu UI unavailable');
    assert.equal(after.capture?.screenshot, 'observed', 'Photo Picker after-menu screenshot unavailable');
    assert.equal(after.capture?.window, 'observed', 'Photo Picker after-menu window unavailable');
    assert(after.value.length && after.value.every((n) => n.package === 'com.google.android.photopicker'), 'Left Photo Picker after More tap');
    assert.notEqual(JSON.stringify(after.value), JSON.stringify(fresh), 'Photo Picker More made no visible change');
    return { diagnosticOnly: true, tapAttempts, dispatchReturned: true, eventConsumption: 'not_observed', postCapture: 'observed', changedUICollected: true, menuContents: 'retained for review; no item selected', errorRecoveryValidated: false };
  } catch (error) {
    await sampleShare(observe, 'photo-picker-more-first-error', () => ({ stage, tapAttempts, message: String(error) }));
    throw error;
  }
}

export function photoPickerBrowseTarget(nodes, screen) {
  assert(nodes.length && nodes.every((n) => n.package === 'com.google.android.photopicker'), 'Not the observed Photo Picker menu');
  const labels = nodes.filter((n) => n.text === 'Browse…');
  assert.equal(labels.length, 1, 'Photo Picker Browse label missing or ambiguous');
  assert.equal(labels[0].enabled, 'true', 'Photo Picker Browse label disabled');
  const labelRect = nativeBounds(labels[0]);
  assert(nativeBoundsContain(screen, labelRect), 'Photo Picker Browse label outside screen');
  const items = nodes.filter((n) => n.clickable === 'true' && nativeBoundsContain(nativeBounds(n), labelRect));
  assert.equal(items.length, 1, 'Photo Picker Browse clickable target missing or ambiguous');
  const item = items[0], bounds = nativeBounds(item);
  assert.equal(item.enabled, 'true', 'Photo Picker Browse target disabled');
  assert(nativeBoundsContain(screen, bounds), 'Photo Picker Browse target outside screen');
  return { label: labels[0], item, screen, point: { x: Math.floor((bounds[0] + bounds[2]) / 2), y: Math.floor((bounds[1] + bounds[3]) / 2) } };
}

function avatarFileBrowser(nodes, filename) {
  // B1-009 observed this package; native-ui.mjs already uses these file/root predicates.
  return nodes?.length > 0 && nodes.every((n) => n.package === 'com.google.android.documentsui') &&
    (nativeFileTarget(nodes, filename) !== null || nodes.some((n) => n.enabled === 'true' && n['content-desc'] === 'Show roots'));
}

export async function chooseAvatarPickerFile(ui, filename, observe, snapshot, before) {
  let stage = 'picker-identity', browseTapAttempts = 0;
  try {
    assert.equal(before?.status, 'observed', 'Avatar picker UI unavailable');
    if (!avatarFileBrowser(before.value, filename)) {
      const screen = photoPickerMoreTarget(before.value).screen;
      let menu;
      stage = 'more-menu';
      await inspectPhotoPickerMore(ui, observe, async (phase) => (menu = await snapshot(phase)), before);
      stage = 'browse-target';
      photoPickerBrowseTarget(menu.value, screen);
      const fresh = await ui.nodes();
      await sampleShare(observe, 'avatar-browse-fresh-ui', () => fresh);
      const target = photoPickerBrowseTarget(fresh, screen);
      assert.equal(JSON.stringify(fresh), JSON.stringify(menu.value), 'Photo Picker changed before Browse tap');
      await sampleShare(observe, 'avatar-browse-target', () => target);
      stage = 'browse-tap'; browseTapAttempts++;
      await ui.adb('shell', 'input', 'tap', String(target.point.x), String(target.point.y));
      await sampleShare(observe, 'avatar-browse-dispatch-returned', () => ({ at: new Date().toISOString(), browseTapAttempts, eventConsumption: 'not_observed' }));
      stage = 'after-browse';
      const browser = await snapshot('after-browse');
      assert.equal(browser?.status, 'observed', 'Avatar file-browser UI unavailable');
      assert.equal(browser.capture?.screenshot, 'observed', 'Avatar file-browser screenshot unavailable');
      assert.equal(browser.capture?.window, 'observed', 'Avatar file-browser window unavailable');
      assert(avatarFileBrowser(browser.value, filename), 'Browse did not reach the existing file-browser contract');
    }
    stage = 'choose-file';
    return await ui.chooseFile(filename, (phase, value) => observe('avatar-file-selection-' + phase, value));
  } catch (error) {
    await sampleShare(observe, 'avatar-file-navigation-first-error', () => ({ stage, browseTapAttempts, message: String(error) }));
    throw error;
  }
}

export function avatarFileCapture(action) {
  const key = '__b2AvatarFileCapture';
  const identity = () => ({ origin: location.origin, href: location.href, timeOrigin: performance.timeOrigin });
  const currentInput = () => {
    const buttons = [...document.querySelectorAll('button[aria-label="Change avatar"]')];
    if (buttons.length !== 1) return null;
    const input = buttons[0].previousElementSibling;
    return input?.tagName === 'INPUT' && input.type === 'file' ? input : null;
  };
  if (action === 'install') {
    if (window[key]) throw Error('Avatar file capture already installed');
    const target = currentInput();
    if (!target) throw Error('Unique avatar file input not identified');
    const state = { target, document, identity: identity(), installedAt: Date.now(), events: [], total: 0, listeners: [], installError: null };
    state.handler = (event) => {
      if (event.target !== state.target) return;
      state.total++;
      if (state.events.length >= 4) return;
      try {
        const file = event.target.files?.[0] ?? null; // Synchronous capture, before React clears value/FileList.
        state.events.push({ type: event.type, at: Date.now(), trusted: event.isTrusted === true,
          file: file ? { name: file.name, type: file.type, size: file.size } : null });
      } catch (error) { state.events.push({ type: event.type, at: Date.now(), error: String(error) }); }
    };
    window[key] = state;
    try {
      for (const type of ['change', 'cancel']) { document.addEventListener(type, state.handler, true); state.listeners.push(type); }
    } catch (error) { state.installError = String(error); }
  }
  const state = window[key];
  if (!state) return { status: 'unknown', reason: 'No capture in this document', currentDocument: identity() };
  const result = { status: 'observed', installed: state.listeners.length === 2, installError: state.installError,
    installedAt: state.installedAt, installedDocument: state.identity, currentDocument: identity(), sameDocument: state.document === document,
    target: { id: state.target.id || null, name: state.target.name || null, accept: state.target.accept,
      type: state.target.type, connected: state.target.isConnected, sameCurrentInput: currentInput() === state.target },
    events: state.events.slice(), observedEventCount: state.total, retainedLimit: 4,
    zeroEventMeaning: 'Only unobserved during this listener window; not proof of cancellation or no callback', release: null };
  if (action === 'release') {
    result.release = state.listeners.map((type) => {
      try { state.document.removeEventListener(type, state.handler, true); return { type, status: 'released' }; }
      catch (error) { return { type, status: 'unknown', error: String(error) }; }
    });
    delete window[key];
  }
  return result;
}

export function avatarAccountObservation() {
  const error = document.querySelector('[data-testid="human-avatar-error"]');
  return { origin: location.origin, href: location.href, timeOrigin: performance.timeOrigin,
    bodyText: (document.body?.innerText ?? '').slice(0, 4096),
    avatarError: error ? { text: error.textContent?.slice(0, 1000), connected: error.isConnected } : null,
    alerts: [...document.querySelectorAll('[role="alert"]')].slice(0, 8).map((e) => e.textContent?.slice(0, 1000)),
    avatarInputs: [...document.querySelectorAll('input[type="file"]')].slice(0, 4).map((e) => ({ id: e.id || null, name: e.name || null, accept: e.accept, connected: e.isConnected })),
    uploadTrace: { status: 'unknown', reason: 'No pre-existing avatar upload trace; share/save probe is not an upload record' } };
}

export function startupDocumentState() {
  return {
    snapshot: window.__b2AppearanceStartup ?? null,
    current: {
      origin: location.origin, href: location.href, timeOrigin: performance.timeOrigin,
      top: window === window.top,
      appearance: localStorage.getItem('silverhand:appearance'),
      theme: document.documentElement.dataset.theme ?? null,
    },
  };
}

export function classifyStartup(state, nonce, connected) {
  const { snapshot: boot, current } = state;
  assert(boot?.version === 1 && boot.phase === 'before-main' && boot.status === 'observed', 'Startup snapshot missing or unreadable');
  assert(boot.nonce === nonce && boot.top === true && current.top === true, 'Startup diagnostic/frame identity mismatch');
  assert(boot.readyState === 'loading' && boot.mainModuleSeen === false, 'Startup snapshot was not captured before main');
  assert(Number.isFinite(boot.timeOrigin) && boot.timeOrigin > 0 && boot.timeOrigin === current.timeOrigin, 'Startup document identity mismatch');
  const documentURL = (href) => { const url = new URL(href); url.hash = ''; return url.href; };
  assert(boot.origin === 'https://localhost' && boot.origin === current.origin && documentURL(boot.href) === documentURL(current.href), 'Startup origin/page identity mismatch');
  if (connected)
    assert(connected.current.timeOrigin === current.timeOrigin && JSON.stringify(connected.snapshot) === JSON.stringify(boot), 'Connected startup document was replaced');
  assert(boot.appearance === null || typeof boot.appearance === 'string');
  assert(current.appearance === null || typeof current.appearance === 'string');
  const isGlass = (value) => { try { return JSON.parse(value)?.theme === 'glass'; } catch { return false; } };
  let boundary = 'other-observed-values';
  if (boot.appearance === null) boundary = 'absent-before-main';
  else if (isGlass(boot.appearance) && current.appearance === null) boundary = 'lost-after-startup-snapshot';
  else if (isGlass(boot.appearance) && isGlass(current.appearance))
    boundary = current.theme === 'glass' ? 'glass-retained-and-applied' : 'glass-present-not-applied';
  return { boundary, state, commitAcknowledged: false, diagnosticOnly: true };
}

export function restoreGroupedNightMode(adb, observe, expected, primary) {
  const value={expected,status:'passed',commandError:null,actual:null,readError:null};let failure;
  try {adb('shell','cmd','uimode','night',expected);}catch(error){failure=error;value.commandError=String(error);}
  try {const raw=adb('shell','cmd','uimode','night'),match=raw.match(/Night mode:\s*(yes|no|auto)\b/i);value.actual=raw;assert(match&&match[1].toLowerCase()===expected,'Grouped bars OS mode was not restored');}
  catch(error){failure??=error;value.readError=String(error);}
  if(failure)value.status='failed';
  try {observe('grouped-bars-os-restore',value);}catch(error){failure??=error;console.error('Grouped bars cleanup observation failed:',String(error));}
  if(failure&&!primary)throw failure;
  return value;
}

export async function runB2(context) {
  let c = context.c;
  const {
    api,
    call,
    input,
    wait,
    adb,
    serial,
    root,
    out,
    token,
    fixture,
    path,
    channelUrl,
    step,
    observe,
  } = context;
  assert(context.diagnostic === undefined || ['appearance-startup','appearance-short','photo-picker-menu','coverage-short','coverage-bars'].includes(context.diagnostic),'Unknown B2 diagnostic');
  const ui = nativeUI(serial);
  const table = JSON.parse(readFileSync(new URL('./acceptance-scenarios.json', import.meta.url)));
  const images = table.images;
  const screenshot = (name, onCommand) => {
    const command={command:[process.env.ANDROID_HOME+'/platform-tools/adb','-s',serial,'exec-out','screencap','-p'],startedAt:new Date().toISOString(),rawReturncode:null,signal:null};
    let bytes;
    try {bytes=execFileSync(command.command[0],command.command.slice(1),{timeout:10000});command.rawReturncode=0;}
    catch(error){command.rawReturncode=Number.isInteger(error.status)?error.status:null;command.signal=error.signal??null;throw error;}
    finally {command.finishedAt=new Date().toISOString();if(onCommand)onCommand(command);}
    writeFileSync(out+'/'+name+'.png',bytes);
    if(onCommand)return{file:name+'.png',sha256:hash(bytes)};
  };
  const visible = `e=>!e.closest('[inert]')&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0`;
  async function click(selector, text, evidenceName, deadline, guard, scroll = false) {
    try {
      let point;
      const expression = `(()=>{const candidates=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(${visible}).filter(e=>${text === undefined ? 'true' : `e.textContent.trim()===${JSON.stringify(text)}`});if(candidates.length!==1)throw Error('Expected one visible control '+${JSON.stringify(selector)}+' found '+candidates.length);const e=candidates[0];if(e.disabled)throw Error('Control disabled');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`;
      if (evidenceName) {
        assert(deadline === null || Number.isFinite(deadline), 'Checked click requires an immediate check or existing shared deadline');
        await c.evaluate('delete window.__b2LeftClickTarget');
        const read = () => c.evaluate(`(${leftControlTarget.toString()})(document,${JSON.stringify(selector)},${JSON.stringify(text)},${JSON.stringify(guard)})`);
        if (deadline === null || scroll) await c.evaluate(expression); // Normal scroll, then read the actual hit afresh.
        if (scroll && Number.isFinite(deadline)) assert(Date.now() < deadline, 'Checked click budget exhausted after scroll');
        const target = deadline === null ? await read() : await waitLeftControl(read, (suffix, value) => observe(evidenceName + '-' + suffix, value), deadline);
        observe(evidenceName + '-target', target);
        assert(!target.fatal && target.ready, 'Checked click rejected: ' + target.reason);
        if (scroll && Number.isFinite(deadline)) assert(Date.now() < deadline, 'Checked click budget exhausted before dispatch');
        point = target.point;
      } else {
        point = await c.evaluate(expression);
      }
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    } finally {
      if (evidenceName) {
        try { await c.evaluate('delete window.__b2LeftClickTarget'); }
        catch (error) { console.error('Left-click target reference release failed:', String(error)); }
      }
    }
  }
  async function go(route) {
    await c.evaluate('location.hash=' + JSON.stringify(route));
    await wait('location.hash===' + JSON.stringify('#' + route));
    await delay(350);
  }
  async function selectTheme(id, label, scene, restart = false) {
    const name = 'theme-' + scene + '-' + id;
    const deadline = Date.now() + 30000;
    const state = () => c.evaluate(`(${appearanceState.toString()})()`);
    let restartConnected = false;
    try {
      await sampleShare(observe, name + '-before', state);
      await moveThemePointer(c, observe, name, deadline);
      await click('button', label, name, deadline, { route: '#/settings?settingsSection=appearance' }, true);
      let actual, changed = false;
      while (Date.now() < deadline) {
        actual = await state();
        if (Date.now() >= deadline) break;
        assert.equal(actual.route, '#/settings?settingsSection=appearance', 'Appearance route changed during theme switch');
        if (actual.theme === id && actual.confirmation === 'confirmed') { changed = true; break; }
        await delay(Math.min(200, Math.max(0, deadline - Date.now())));
      }
      if (!changed) observe(name + '-transition-last', { deadline, actual });
      assert(changed, 'Theme shared 30s switch budget exhausted');
      await sampleShare(observe, name + '-after', () => actual);
      if (restart) {
        const before = await sampleThemeRestart(c, adb, observe, name + '-restart-before', pkg, !!context.startupDiagnostic);
        if (context.startupDiagnostic)
          assert(before.status === 'observed' && Number.isFinite(before.value.timeOrigin), 'Pre-restart document identity unavailable');
        for (const args of [['shell', 'am', 'force-stop', pkg], ['shell', 'am', 'start', '-n', pkg + '/com.silverhand.android.MainActivity']]) {
          const command = { args, startedAt: new Date().toISOString(), rawReturncode: null, signal: null };
          try { adb(...args); command.rawReturncode = 0; }
          catch (error) { command.rawReturncode = Number.isInteger(error.status) ? error.status : null; command.signal = error.signal ?? null; throw error; }
          finally {
            command.finishedAt = new Date().toISOString();
            try { observe(name + '-restart-command', command); }
            catch (error) { console.error('Theme restart command recording failed:', String(error)); }
          }
        }
        c = await context.reconnect();
        restartConnected = true;
        await sampleThemeRestart(c, adb, observe, name + '-restart-connected', pkg);
        let startupConnected;
        if (context.startupDiagnostic) {
          startupConnected = await c.evaluate(`(${startupDocumentState.toString()})()`);
          observe(name + '-startup-connected-document', startupConnected);
          classifyStartup(startupConnected, context.startupDiagnostic.nonce); // Reject a missing/wrong document before waiting.
          assert.notEqual(startupConnected.current.timeOrigin, before.value.timeOrigin, 'Restart did not establish a new observed document');
        }
        let persistenceAssertion = 'passed';
        const needsNavigation = scene === 'named' && !context.startupDiagnostic;
        const navigationRead = () => c.evaluate(`(${themeRestartPage.toString()})(${JSON.stringify(id)})`);
        let navigationDocument;
        const restartPredicate = needsNavigation
          ? `(${themeRestartPage.toString()})(${JSON.stringify(id)}).ready`
          : 'document.documentElement.dataset.theme===' + JSON.stringify(id) + '&&document.documentElement.dataset.themePersistence==="confirmed"';
        try { await wait(restartPredicate); }
        catch (error) {
          if (needsNavigation) await sampleShare(observe, name + '-restart-navigation-last', navigationRead);
          if (context.diagnostic === 'appearance-short' && error.message?.startsWith('UI timed out: ' + restartPredicate))
            await sampleShare(observe, name + '-restart-persistence-assertion', () => ({ status: 'failed', diagnosticOnly: true }));
          if (!context.startupDiagnostic || !error.message?.startsWith('UI timed out: ' + restartPredicate)) throw error;
          persistenceAssertion = 'failed'; // Measured diagnostic outcome, never an acceptance pass.
        }
        if (needsNavigation) {
          const ready = await sampleShare(observe, name + '-restart-navigation-ready', navigationRead);
          assert(ready.status === 'observed' && ready.value.ready, 'Restart navigation readiness changed before return');
          navigationDocument = ready.value;
        }
        if (context.diagnostic === 'appearance-short')
          await sampleShare(observe, name + '-restart-persistence-assertion', () => ({ status: 'passed', diagnosticOnly: true }));
        if (context.startupDiagnostic) {
          observe(name + '-restart-persistence-assertion', { status: persistenceAssertion, diagnosticOnly: true });
          const state = await c.evaluate(`(${startupDocumentState.toString()})()`);
          observe(name + '-startup-document', state);
          const result = classifyStartup(state, context.startupDiagnostic.nonce, startupConnected);
          observe(name + '-startup-boundary', { ...result, persistenceAssertion });
          return { ...result, persistenceAssertion };
        }
        await sampleShare(observe, name + '-restarted', state);
        return navigationDocument;
      }
    } catch (error) {
      await sampleShare(observe, name + '-failure', state);
      if (restartConnected) await sampleThemeRestart(c, adb, observe, name + '-restart-failure', pkg);
      await sampleShare(observe, name + '-failure-screenshot', () => { screenshot(name + '-failure'); return { file: name + '-failure.png' }; });
      throw error;
    }
  }
  if (context.startupDiagnostic) {
    assert.equal(context.startupDiagnostic.kind, 'appearance-startup');
    await step('DIAG.theme-startup', async () => {
      await go('/settings?settingsSection=appearance');
      return selectTheme('glass', 'Glass', 'diagnostic', true);
    });
    return;
  }
  if (context.diagnostic === 'appearance-short') {
    await step('DIAG.theme-short-path', async () => {
      await go('/settings?settingsSection=appearance');
      await selectTheme('glass', 'Glass', 'short', true);
      return { diagnosticOnly: true, persistenceAssertion: 'passed' };
    });
    return;
  }
  if (context.diagnostic === 'photo-picker-menu') {
    await step('DIAG.photo-picker-menu', async () => {
      await go('/settings?settingsSection=account');
      return withAvatarPicker('menu', (before) => inspectPhotoPickerMore(ui, observe,
        (phase) => nativeSnapshot('photo-picker-' + phase), before), 'Add avatar', 'more-menu');
    });
    return;
  }
  async function probe() {
    await c.evaluate(
      `(()=>{if(window.__b2Probe)return;window.__b2Probe=true;window.__b2Calls=[];const native=window.Capacitor.nativePromise.bind(window.Capacitor);window.Capacitor.nativePromise=(plugin,method,args)=>{if(plugin!=='SilverhandClient'||!['sharePng','saveAttachment'].includes(method))return native(plugin,method,args);const row={method,args,completed:0,rejected:0};window.__b2Calls.push(row);return native(plugin,method,args).then(value=>{row.completed++;row.value=value;row.settled=true;return value},error=>{row.rejected++;row.error=String(error);row.code=error.code;row.settled=true;throw error});};})()`,
    );
  }
  async function outcome() {
    await wait(`window.__b2Calls.at(-1)?.settled===true`);
    const row = await c.evaluate(`window.__b2Calls.at(-1)`);
    assert.equal(row.completed + row.rejected, 1, 'Bridge result must settle once');
    return row;
  }
  const listing = async () => {
    const value = await api(
      `/api/channels/${fixture.channel}/attachments`,
      'GET',
      undefined,
      token,
    );
    return (value.attachments ?? value.items ?? value).map((row) => row.attachment ?? row);
  };
  const history = () => api(path, 'GET', undefined, token);
  async function sendFile(name, bytes, type) {
    const text = 'B2 file ' + name;
    const lookup = `(${fileComposer.toString()})(document,${JSON.stringify(name)},${JSON.stringify(text)})`;
    try {
      writeFileSync(root + name, bytes);
      adb('push', root + name, '/sdcard/Download/' + name);
      await c.send('Runtime.evaluate', { expression: `${lookup}.file.click()`, userGesture: true });
      await ui.chooseFile(name, (phase, value) => observe('file-picker-' + name + '-' + phase, value));
      await wait(`${lookup}.state.filenamePresent`);
      await c.evaluate(`(()=>{const {textarea}=${lookup};Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea,${JSON.stringify(text)});textarea.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await wait(`${lookup}.state.ready`);
      observe('file-send-before-' + name, await c.evaluate(`${lookup}.state`));
      await click('form[data-composer] [data-composer-action="send"]');
      await wait(`${lookup}.state.value===''`);
      let attachment, matches = [];
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        attachment = (await listing()).find((row) => row.filename === name);
        matches = (await history()).messages.filter((message) => message.content === text);
        assert(matches.length <= 1, 'File send created duplicate fixture messages');
        if (attachment && matches.length === 1 && matches[0].attachments?.some((item) => item.id === attachment.id)) break;
        await delay(100);
      }
      assert(attachment, 'Uploaded attachment missing');
      assert.equal(matches.length, 1, 'Expected one matching fixture message');
      assert(matches[0].attachments?.some((item) => item.id === attachment.id), 'Fixture message must own the uploaded attachment');
      const response = await call('request', { path: '/api/attachments/' + attachment.id, responseType: 'arrayBuffer' });
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(response.bodyBase64, 'base64'), bytes);
      assert.equal(attachment.filename, name);
      assert.equal(attachment.content_type, type);
      return { id: attachment.id, messageId: matches[0].id, name, bytes: bytes.length, sha256: hash(bytes), type: attachment.content_type };
    } catch (error) {
      try {
        observe('file-send-failure-' + name, {
          composer: await c.evaluate(`(()=>{try{return ${lookup}.state}catch(error){return {error:String(error)}}})()`),
          messages: (await history()).messages.filter((message) => message.content === text),
          attachments: (await listing()).filter((item) => item.filename === name),
        });
      } catch (diagnosticError) {
        console.error('File send diagnostic capture failed:', String(diagnosticError));
      }
      try { screenshot('file-send-failure-' + name); }
      catch (diagnosticError) { console.error('File send screenshot failed:', String(diagnosticError)); }
      throw error;
    }
  }
  async function download(name) {
    await probe();
    await click('button[aria-label=' + JSON.stringify('Download ' + name) + ']');
    await ui.waitFor((n) => n.text === 'SAVE');
  }
  async function saveNormal(name, expected) {
    await download(name);
    await ui.tap((n) => n['content-desc'] === 'Show roots');
    await ui.tap((n) => n.text === 'Downloads');
    await ui.tap((n) => n.text === 'SAVE');
    const row = await outcome();
    assert.equal(row.value?.completed, true);
    const bytes = execFileSync(process.env.ANDROID_HOME + '/platform-tools/adb', [
      '-s',
      serial,
      'exec-out',
      'cat',
      '/sdcard/Download/' + name,
    ]);
    assert.deepEqual(bytes, expected);
    return { name, bytes: bytes.length, sha256: hash(bytes), result: row.value };
  }
  async function saveError(name, expected) {
    await download(name);
    await ui.tap((n) => n['content-desc'] === 'Show roots');
    await ui.tap((n) => n.text === 'B2 Save Errors');
    await ui.tap((n) => n.text === 'SAVE');
    const row = await outcome();
    assert.equal(row.rejected, 1);
    assert.match(row.error, expected);
    await wait(
      `document.body.innerText.includes("Couldn't save")||document.body.innerText.includes('B2 destination')`,
    );
    screenshot(name + '-error');
    return { name, error: row.error, settledOnce: true };
  }
  async function openImage(name) {
    await go(channelUrl);
    await click('img[alt=' + JSON.stringify(name) + ']');
    await wait(`!!document.querySelector('[role=dialog] button[aria-label="Share"]')`);
  }
  async function closeDialog() {
    await click('[role=dialog] button[aria-label="Close"]');
    await wait(`!document.querySelector('[role=dialog]')`);
  }
  async function preview(short = false, shortDeadline, onCommitted, onPreviewReady) {
    const prefix = short ? 'short-preview' : 'preview';
    let messageId = null, captureReleased = false;
    const state = async (release = false) => { const value = await c.evaluate(`(()=>{const shown=e=>!e.closest('[inert]')&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;const bars=[...document.querySelectorAll('[role=toolbar][aria-label="Message selection"]')].filter(shown);return {route:location.hash,menus:[...document.querySelectorAll('[role=menuitem]')].map(e=>e.textContent.trim()),toolbarCount:bars.length,toolbarText:bars.map(e=>e.innerText),targetSelected:document.getElementById(${JSON.stringify('msg-' + messageId)})?.querySelector('[role=checkbox]')?.getAttribute('aria-checked')==='true',dialogShareReady:[...document.querySelectorAll('[role=dialog] button[aria-label="Share"]:not(:disabled)')].some(shown),activeElement:document.activeElement?.tagName,...(${previewDialogState.toString()})(document),capture:${short ? `(${shortMenuCapture.toString()})(document,${JSON.stringify(messageId)},${JSON.stringify('#' + channelUrl)},${JSON.stringify(release ? 'release' : 'sample')})` : 'null'}}})()`); if (short && release) captureReleased = value.capture?.release === 'released' || value.capture?.release === 'not_installed'; return value; };
    try {
      await go(channelUrl);
      const posted = await api(path, 'POST', { content: 'B2 preview ' + fixture.channel + (short ? '\n' + 'short selection message\n'.repeat(8) : '') }, token);
      messageId = posted.message?.id;
      assert.equal(typeof messageId, 'string', 'Preview fixture must return a committed message id');
      onCommitted?.(messageId);
      await wait(`!!document.getElementById(${JSON.stringify('msg-' + messageId)})`);
      let target;
      if (short) target = await shortMenuTarget(c, observe, prefix, messageId, '#' + channelUrl, shortDeadline);
      else {
      const evaluated = await c.evaluate(`(()=>{try{return {target:(${messageMenuTarget.toString()})(document,${JSON.stringify(messageId)}),error:null}}catch(error){return {target:error.targetState??null,error:{type:error.name,message:error.message}}}})()`);
      try { observe(prefix + '-menu-target', { ...(evaluated.target ?? { ready:false, reason:'Target evaluation failed before geometry' }), error:evaluated.error }); }
      catch (error) { if (!evaluated.error) throw error; console.error('Preview target observation failed:', String(error)); }
      if (evaluated.error) throw Error(evaluated.error.message);
      target = evaluated.target;
      assert(target?.ready, 'Preview target not ready');
      }
      if (short) await shortContextMenu(c, observe, prefix, target.point, messageId, '#' + channelUrl, shortDeadline);
      else {
        await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'right', clickCount: 1, ...target.point });
        await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'right', clickCount: 1, ...target.point });
        await wait(`!![...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.trim()==='Share…')`);
      }
      observe(prefix + '-menu-open', await state(short));
      screenshot(prefix + '-menu-open');
      // Both intermediate selection and final preview share the former 30s wait.
      const deadline = short ? shortDeadline : Date.now() + 30000;
      const waitStage = async (name, ready) => {
        let actual;
        while (Date.now() < deadline) {
          actual = await state();
          if (actual.route !== '#' + channelUrl) {
            observe(name + '-result', actual);
            throw Error('Unexpected route after ' + name + ': ' + actual.route);
          }
          if (ready(actual)) { observe(name + '-result', actual); return actual; }
          await delay(Math.min(200, Math.max(0, deadline - Date.now())));
        }
        observe(name + '-result', actual);
        throw Error('Preview shared wait budget exhausted at ' + name);
      };
      await click('[role=menuitem]', 'Share…', prefix + '-share-click', deadline, { route: '#' + channelUrl, messageId, selected: false });
      await waitStage(prefix + '-selection', (actual) => actual.toolbarCount === 1 && actual.targetSelected);
      screenshot(prefix + '-selection');
      if (short) {
        const read = (check=false) => c.evaluate(`({...(${shortSelectionLayout.toString()})(document,${JSON.stringify(messageId)},${JSON.stringify(check?{expectedIdentity:target.captureInstall?.identity??null}:null)}),...(${previewDialogState.toString()})(document)})`);
        const before = await read(true); observe('short-selection-before-scroll', before);
        assert(before.scrollTarget?.ready, before.scrollTarget?.reason??'Short scroll target projection unavailable');
        assert(before.viewport.media && before.viewport.height <= 320, 'Actual short CSS viewport not established');
        assert(before.hash === '#' + channelUrl && before.selected && before.message.connected && before.message.intersection?.area > 0, 'Short selected message not visible');
        assert(before.scroller?.hit && before.scroller.max > 0, 'Actual short message scroller unavailable');
        assert(Date.now() < deadline, 'Short preview budget exhausted before wheel');
        await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...before.scroller.point, deltaX: 0, deltaY: before.scroller.top > 0 ? -120 : 120 });
        let after;
        for (let i = 0; i < 4 && Date.now() < deadline; i++) {
          after = await read();
          if (after.scroller?.top !== before.scroller.top) break;
          await delay(Math.min(200, Math.max(0, deadline - Date.now())));
        }
        observe('short-selection-after-scroll', after);
        assert(after?.hash === before.hash && after.timeOrigin === before.timeOrigin && after.viewport.media && after.viewport.height <= 320 && after.selected && after.scroller?.visibleMessages > 0 && after.scroller.top !== before.scroller.top, 'Short message wheel did not preserve visible selection and scroll');
        const controls = await c.evaluate(`['Cancel','Copy markdown','Save image'].map(text=>{const e=[...document.querySelectorAll('[role=toolbar][aria-label="Message selection"] button')].find(e=>e.textContent.trim()===text);e?.scrollIntoView({block:'center'});return (${leftControlTarget.toString()})(document,'[role=toolbar][aria-label="Message selection"] button',text,{route:${JSON.stringify('#' + channelUrl)},messageId:${JSON.stringify(messageId)},selected:true},false)})`);
        observe('short-selection-controls', controls);
        assert(controls.length === 3 && controls.every((x) => !x.fatal && x.ready), 'Short selection action not reachable');
        await c.evaluate('delete window.__b2LeftClickTarget');
      }
      assert(Date.now() < deadline, 'Preview shared wait budget exhausted before Save image');
      await click('[role=toolbar][aria-label="Message selection"] button', 'Save image', prefix + '-save-click', deadline, { route: '#' + channelUrl, messageId, selected: true }, short);
      const opened = await waitStage(prefix + '-dialog', (actual) => actual.dialogShareReady && (!short || actual.previewReady));
      if (short) onPreviewReady?.(opened.previewIdentity);
      const labels = await c.evaluate(`[...document.querySelectorAll('[role=dialog] button[title]')].map(e=>e.title)`);
      assert(!labels.includes('Copy') && !labels.includes('Save'), 'No failed desktop actions on Android preview');
      return { messageId };
    } catch (error) {
      try { observe(prefix + '-menu-failure', await state(short)); }
      catch (diagnosticError) { try { observe(prefix + '-menu-final-state-unknown', { status:'unknown', error:String(diagnosticError), captureRelease:'unconfirmed' }); } catch {} console.error('Preview diagnostic capture failed:', String(diagnosticError)); }
      try { screenshot(prefix + '-menu-failure'); }
      catch (diagnosticError) { console.error('Preview screenshot failed:', String(diagnosticError)); }
      throw error;
    } finally {
      if (short && !captureReleased) {
        // Fallback only if the existing success/failure state read did not release.
        // At most one extra CDP read; errors remain diagnostic and never hide the first failure.
        try { const capture = await c.evaluate(`(${shortMenuCapture.toString()})(document,${JSON.stringify(messageId)},${JSON.stringify('#' + channelUrl)},'release')`); observe(prefix + '-capture-release-fallback', capture); }
        catch (error) { try { observe(prefix + '-capture-release-fallback', { status:'unknown', release:'unconfirmed', error:String(error) }); } catch {} console.error('Short context capture release failed:', String(error)); }
      }
    }
  }
  async function shortPreview() {
    let messageId = null, previewIdentity = null, closeAttempted = false, cancelAttempted = false;
    const read = () => c.evaluate(`({...(${shortSelectionLayout.toString()})(document,${JSON.stringify(messageId)}),...(${previewDialogState.toString()})(document)})`);
    const baseline = await read(); observe('short-selection-baseline', baseline);
    assert(baseline.hash === '#' + channelUrl && baseline.toolbarCount === 0 && baseline.dialogs === 0, 'Short selection baseline differs');
    let exit;
    await shortSelectionWindow(adb, observe, async () => {
      const deadline = Date.now() + 30000;
      ({ messageId } = await preview(true, deadline, id => { messageId = id; }, identity => { previewIdentity = identity; }));
    }, async () => {
      const current = await read();
      assert(current.hash === baseline.hash && current.timeOrigin === baseline.timeOrigin, 'Short cleanup document/route changed');
      assert(current.dialogs <= 1 && current.toolbarCount <= 1, 'Short cleanup surface ambiguous');
      if (current.dialogs === 1 && !closeAttempted) {
        closeAttempted = true;
        assert(previewIdentity && current.previewReady, 'Short cleanup has no observed known Image Preview');
        assert(['origin','hash','timeOrigin'].every(k => previewIdentity[k] === baseline[k]) && current.previewIdentity?.href === previewIdentity.href, 'Short cleanup preview identity changed');
        await click('[role=dialog][data-modal-shell][data-image-export-preview] button[aria-label="Close"]', undefined, 'short-preview-close', null, { route: baseline.hash, previewIdentity }, true);
      }
      let afterClose;
      for (let i = 0; i < 4; i++) {
        afterClose = await read();
        if (afterClose.dialogs === 0) break;
        await delay(200);
      }
      assert(afterClose.dialogs === 0, 'Short preview did not close');
      if (afterClose.toolbarCount === 1 && !cancelAttempted) {
        cancelAttempted = true;
        await click('[role=toolbar][aria-label="Message selection"] button', 'Cancel', 'short-preview-cancel', null, { route: baseline.hash }, true);
      }
      for (let i = 0; i < 4; i++) {
        exit = await read();
        if (exit.dialogs === 0 && exit.toolbarCount === 0 && exit.spacerHeight === exit.expectedSpacerHeight) break;
        await delay(200);
      }
      observe('short-selection-exited', exit);
      assert(exit.dialogs === 0 && exit.toolbarCount === 0 && !exit.selected && exit.spacerHeight === exit.expectedSpacerHeight, 'Short selection did not exit/restore clearance');
      screenshot('short-selection-exited');
    }, async () => {
      try {
        let restored;
        for (let i = 0; i < 4; i++) {
          restored = await read();
          if (restored.viewport.width === baseline.viewport.width && restored.viewport.height === baseline.viewport.height) break;
          await delay(200);
        }
        observe('short-selection-page-restored', restored);
        assert(restored.hash === baseline.hash && restored.timeOrigin === baseline.timeOrigin && restored.toolbarCount === 0 && restored.dialogs === 0 && restored.viewport.width === baseline.viewport.width && restored.viewport.height === baseline.viewport.height, 'Short selection page/window not restored');
      } finally { await c.evaluate('delete window.__b2LeftClickTarget'); }
    });
    return { realWindowResize: '1080x900', actualShortMediaRequired: true, selectionExited: true, windowAndPageRestored: true };
  }
  async function receiver() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        return JSON.parse(adb('exec-out', 'run-as', testPkg, 'cat', 'files/b2-share.json'));
      } catch {}
      await delay(100);
    }
    throw Error('Share receiver did not record an observation');
  }
  let shareObservation;
  async function nativeSnapshot(name, extra) {
    // This is a fresh sample before lookup / after failure, not the last internal poll.
    const record = (suffix, read) => sampleShare(observe, name + '-' + suffix, read);
    const diagnosticAdb = (...args) => execFileSync(process.env.ANDROID_HOME + '/platform-tools/adb',
      ['-s', serial, ...args], { encoding: 'utf8', timeout: 5000 }).trim();
    const uiState = await record('ui', () => ui.nodes());
    const windowState = await record('window', () => {
      const text = diagnosticAdb('shell', 'dumpsys', 'window', 'windows');
      const focus = text.split('\n').filter((line) => /mCurrentFocus|mFocusedApp|mFocusedWindow/.test(line));
      return { status: focus.length ? 'observed' : 'unknown', focus, reason: focus.length ? null : 'No focus fields in window output' };
    });
    if (extra) await extra(record, diagnosticAdb);
    const imageState = await record('screenshot', () => { screenshot(name); return { file: name + '.png' }; });
    return { ...uiState, capture: { window: windowState.status, screenshot: imageState.status } };
  }
  async function shareSnapshot(phase, packageState) {
    await nativeSnapshot('native-share-' + phase, async (record, diagnosticAdb) => {
      await record('bridge', () => c.evaluate(`(${shareBridgeState.toString()})()`));
      if (packageState) {
        await record('test-package', () => diagnosticAdb('shell', 'pm', 'path', testPkg));
        await record('activity-resolution', () => diagnosticAdb('shell', 'cmd', 'package', 'query-activities',
          '--brief', '-a', 'android.intent.action.SEND', '-t', 'image/png'));
      }
    });
  }
  async function withAvatarPicker(scene, action, avatarLabel = 'Change avatar', actionStage = 'file-lookup') {
    const name = 'avatar-file-' + scene;
    const guard = { route: '#/settings?settingsSection=account' };
    let stage = 'change-avatar';
    try {
      await click('button[aria-label=' + JSON.stringify(avatarLabel) + ']', undefined, name + '-change-avatar', null, guard);
      observe(name + '-change-avatar-dispatch-returned', { at: new Date().toISOString(), eventConsumption: 'not_observed' });
      stage = 'upload-photo';
      await click('[role=menuitem]', 'Upload photo', name + '-upload-photo', null, guard);
      observe(name + '-upload-photo-dispatch-returned', { at: new Date().toISOString(), eventConsumption: 'not_observed' });
      stage = actionStage;
      const before = await nativeSnapshot(name + (actionStage === 'file-lookup' ? '-before-lookup' : '-before-more-menu'));
      return await action(before);
    } catch (error) {
      await sampleShare(observe, name + '-first-error', () => ({ stage, type: error?.name ?? typeof error, message: String(error) }));
      await nativeSnapshot(name + '-after-first-error');
      throw error;
    }
  }
  async function chooseAvatarFile(filename, scene) {
    return withAvatarPicker(scene, (before) => chooseAvatarPickerFile(ui, filename,
      (name, value) => observe('avatar-file-' + scene + '-' + name, value),
      (phase) => nativeSnapshot('avatar-file-' + scene + '-' + phase), before));
  }
  async function selectShare(kind, original) {
    let stage = 'probe';
    try {
      await probe();
      adb('shell', 'run-as', testPkg, 'rm', '-f', 'files/b2-share.json');
      stage = 'share-click';
      await clickNativeShareOnce(c, observe, '#' + channelUrl);
      stage = 'native-target-lookup';
      await shareSnapshot(kind.toLowerCase() + '-before-native-target', true);
      await selectNativeShareTarget(ui, observe, () => {
        const name = 'native-share-' + kind.toLowerCase() + '-target-visible';
        screenshot(name);
        return { file: name + '.png' };
      });
      stage = 'bridge-outcome';
      const row = await outcome();
      assert.equal(row.method, 'sharePng');
      assert.equal(row.value?.completed, true);
      stage = 'receiver-record';
      const got = await receiver();
      assert.equal(got.ok, true);
      assert.equal(got.intentMime, 'image/png');
      assert.equal(got.resolvedMime, 'image/png');
      assert(got.readGranted);
      assert.match(got.name, /\.png$/);
      assert.notEqual(
        got.uid,
        Number(adb('shell', 'cmd', 'package', 'list', 'packages', '-U', pkg).match(/uid:(\d+)/)?.[1]),
        'Receiver must run under another UID',
      );
      assert(got.width > 0 && got.height > 0);
      if (kind === 'PNG')
        assert.equal(got.sha256, hash(Buffer.from(row.args.base64, 'base64')), 'PNG bytes changed');
      else {
        assert.equal(got.width, original.width);
        assert.equal(got.height, original.height);
        assert.equal(
          got.pixelsSha256,
          original.pixelsSha256,
          'JPEG decoded pixels changed during PNG normalization',
        );
      }
      shareObservation = got;
      observe('share-' + kind, {
        ...got,
        platformOutcome:
          'system target selected; fixture read stream; not arbitrary recipient delivery',
      });
      return got;
    } catch (error) {
      await sampleShare(observe, 'native-share-first-error', () => ({ stage, type: error?.name ?? typeof error, message: String(error) }));
      await shareSnapshot(kind.toLowerCase() + '-after-first-error', false);
      throw error;
    }
  }
  let uploaded = [];
  const normal = Buffer.from('B2 bytes 中文\n\u0000\u00ff'),
    denied = Buffer.from('denied target'),
    missing = Buffer.from('missing target');
  const handlers = {
    'files.choose-upload-bytes': async () => {
      await go(channelUrl);
      uploaded.push(await sendFile('b2-文件.bin', normal, 'application/octet-stream'));
      uploaded.push(await sendFile('denied-b2.bin', denied, 'application/octet-stream'));
      uploaded.push(await sendFile('missing-b2.bin', missing, 'application/octet-stream'));
      for (const image of images)
        uploaded.push(await sendFile(image.name, Buffer.from(image.base64, 'base64'), image.mime));
      // Remove only this suite's input files before Save As, so a preexisting
      // upload source cannot masquerade as a successfully written output.
      for (const name of ['b2-文件.bin', 'denied-b2.bin', 'missing-b2.bin'])
        adb('shell', 'rm', '/sdcard/Download/' + name);
      return uploaded;
    },
    'files.choose-cancel': async () => {
      const before = { history: await history(), attachments: await listing() };
      await input('textarea', 'B2 retained draft');
      await c.send('Runtime.evaluate', {
        expression: `document.querySelector('input[type=file]').click()`,
        userGesture: true,
      });
      await ui.waitFor((n) => n['content-desc'] === 'Show roots' || n.text === 'Downloads');
      adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
      await wait(`document.querySelector('textarea')?.value==='B2 retained draft'`);
      await delay(300);
      assert.deepEqual(await history(), before.history);
      assert.deepEqual(await listing(), before.attachments);
      await input('textarea', '');
      return { actualDocumentsUICancel: true, noNewUpload: true, draftRetained: true };
    },
    'files.save-normal': () => saveNormal('b2-文件.bin', normal),
    'files.save-cancel': async () => {
      await download('denied-b2.bin');
      adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
      const row = await outcome();
      assert.equal(row.value?.completed, false);
      return { observed: row.value, settledOnce: true };
    },
    'files.target-denied': async () => {
      const error = await saveError('denied-b2.bin', /denied/i);
      const recovered = await saveNormal('denied-b2.bin', denied);
      return { error, recovered };
    },
    'files.target-missing': async () => {
      const error = await saveError('missing-b2.bin', /missing/i);
      const recovered = await saveNormal('missing-b2.bin', missing);
      return { error, recovered };
    },
    'share.preview-selected': async () => {
      await go(channelUrl);
      const shortSelection = await shortPreview();
      await preview();
      const previewResult = await selectShare('PNG');
      await wait(`!document.querySelector('[role=dialog]')`);
      const jpeg = images.find((image) => image.mime === 'image/jpeg');
      await openImage(jpeg.name);
      const labels = await c.evaluate(
        `[...document.querySelectorAll('[role=dialog] button')].map(e=>e.getAttribute('aria-label'))`,
      );
      assert(
        labels.includes('Share') && labels.includes('Download'),
        'Lightbox must retain real Download',
      );
      const jpegResult = await selectShare('JPEG', jpeg);
      await closeDialog();
      return { shortSelection, previewResult, jpegResult };
    },
    'share.cancel': async () => {
      await openImage(images[0].name);
      await probe();
      await click('[role=dialog] button[aria-label="Share"]');
      await ui.waitFor(
        (n) => n.text === 'B2 Share Check' || n['content-desc']?.includes('B2 Share Check'),
      );
      adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
      const row = await outcome();
      assert.equal(row.rejected, 1);
      assert.equal(row.code, 'UNCONFIRMED');
      // A second explicit test action proves pending ownership was released;
      // it is not an automatic retry of the cancelled operation.
      await wait(
        `!!document.querySelector('[role=dialog] button[aria-label="Share"]:not(:disabled)')`,
      );
      await click('[role=dialog] button[aria-label="Share"]');
      await ui.waitFor(
        (n) => n.text === 'B2 Share Check' || n['content-desc']?.includes('B2 Share Check'),
      );
      adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
      const again = await outcome();
      assert.equal(again.rejected, 1);
      await closeDialog();
      return {
        userAction: 'cancel chooser',
        observableOutcome: 'not confirmed; not asserted definite cancellation',
        first: row.error,
        pendingEnded: true,
        newExplicitActionCompleted: true,
      };
    },
    'share.invalid-and-late': async () => {
      let invalid = '';
      try {
        await call('sharePng', { base64: 'AA==' });
      } catch (error) {
        invalid = String(error);
      }
      assert.match(invalid, /invalid|decode/i);
      await openImage(images[0].name);
      await probe();
      await click('[role=dialog] button[aria-label="Share"]');
      await ui.waitFor(
        (n) => n.text === 'B2 Share Check' || n['content-desc']?.includes('B2 Share Check'),
      );
      let concurrent = '';
      try {
        await call('sharePng', { base64: images[0].base64 });
      } catch (error) {
        concurrent = String(error);
      }
      assert.match(concurrent, /pending/i);
      adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
      // Probe's last row is the rejected concurrent request; retain each result
      // rather than confusing it with the original chooser's eventual result.
      await wait(
        `window.__b2Calls.filter(row=>row.method==='sharePng').slice(-2).every(row=>row.settled)`,
      );
      const tail = await c.evaluate(
        `window.__b2Calls.filter(row=>row.method==='sharePng').slice(-2).map(({args,...row})=>row)`,
      );
      assert.equal(tail[0].code, 'UNCONFIRMED');
      assert.equal(tail[1].rejected, 1);
      await closeDialog();
      return {
        invalid,
        concurrent,
        tail,
        callbackOrdering: 'pure JVM ShareResultTest; no fabricated platform callback',
      };
    },
    'share.uri-grant-lifecycle': async () => {
      assert(shareObservation);
      const file = shareObservation.uri.split('/').at(-1);
      assert.match(file, /^[a-f0-9-]+\.png$/);
      adb('shell', 'run-as', pkg, 'ls', 'cache/shared-images/' + file); // remains after selected Activity finished
      adb('shell', 'run-as', testPkg, 'rm', '-f', 'files/b2-share.json');
      adb(
        'shell',
        'am',
        'start',
        '-n',
        testPkg + '/com.silverhand.android.B2ShareReceiver',
        '-a',
        'android.intent.action.SEND',
        '-t',
        'image/png',
        '--eu',
        'android.intent.extra.STREAM',
        shareObservation.uri,
      );
      const ungranted = await receiver();
      assert.equal(ungranted.ok, false);
      assert.equal(ungranted.readGranted, false);
      adb('shell', 'run-as', pkg, 'touch', '-t', '202001010000', 'cache/shared-images/' + file);
      await openImage(images[0].name);
      await probe();
      await click('[role=dialog] button[aria-label="Share"]');
      await ui.waitFor(
        (n) => n.text === 'B2 Share Check' || n['content-desc']?.includes('B2 Share Check'),
      );
      let absent = false;
      try {
        adb('shell', 'run-as', pkg, 'ls', 'cache/shared-images/' + file);
      } catch {
        absent = true;
      }
      assert(absent, 'Stale share file not pruned on next share');
      adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
      await outcome();
      await closeDialog();
      return {
        selectedFileRetainedUntilLazyCleanup: true,
        ungrantedNewActivity: ungranted,
        staleFilePrunedOnNextShare: true,
        notAnExact24HourDeletionGuarantee: true,
      };
    },
    'theme.named-and-restart': async () => {
      const themes = [
        ['glass', 'Glass'],
        ['studio-light', 'Studio Light'],
        ['poster', 'Poster'],
        ['iris', 'Iris'],
        ['slack-dark', 'Slack Dark'],
      ];
      const readings = [];
      await go('/settings?settingsSection=appearance');
      for (const [id, label] of themes) {
        const restarted = await selectTheme(id, label, 'named', true);
        const name = 'theme-named-' + id + '-navigation';
        const readPage = () => c.evaluate(`(${themeRestartPage.toString()})(${JSON.stringify(id)})`);
        try {
          const before = await sampleShare(observe, name + '-before', readPage);
          assert(before.status === 'observed' && before.value.ready, 'Named theme navigation prerequisite lost');
          assert(before.value.origin === restarted.origin && before.value.timeOrigin === restarted.timeOrigin, 'Restart document changed before named theme navigation');
          await go('/settings?settingsSection=appearance'); // One assignment, after cold-start projection; global go is unchanged.
          await sampleShare(observe, name + '-after', readPage);
        } catch (error) {
          await sampleShare(observe, name + '-failure', () => c.evaluate(`({...(${themeRestartPage.toString()})(${JSON.stringify(id)}),bodyText:(document.body?.innerText??'').slice(0,2048)})`));
          await sampleShare(observe, name + '-failure-screenshot', () => { screenshot(name + '-failure'); return { file: name + '-failure.png' }; });
          throw error;
        }
        readings.push(
          await c.evaluate(
            `({theme:document.documentElement.dataset.theme,stored:JSON.parse(localStorage.getItem('silverhand:appearance')),background:getComputedStyle(document.body).backgroundColor})`,
          ),
        );
      }
      return readings;
    },
    'theme.os-and-bars': async () => {
      const original = adb('shell', 'cmd', 'uimode', 'night');
      const modeMatch = original.match(/Night mode:\s*(yes|no|auto)\b/i);
      assert(modeMatch, 'Unknown OS night mode; refusing mutation');
      const observations = [];
      let primary;
      try {
        for (const mode of ['no', 'yes']) {
          adb('shell', 'cmd', 'uimode', 'night', mode);
          await delay(500);
          for (const [id, label] of [
            ['studio-light', 'Studio Light'],
            ['slack-dark', 'Slack Dark'],
          ]) {
            await go('/settings?settingsSection=appearance');
            await selectTheme(id, label, 'os-' + mode);
            const name = 'bars-' + mode + '-' + id;
            const screenshotObservation=context.diagnostic==='coverage-bars'
              ? await observeBarScreenshot(c,observe,name,(onCommand)=>screenshot(name,onCommand))
              : (screenshot(name),undefined);
            const windows = adb('shell', 'dumpsys', 'window', 'windows')
              .split('\n')
              .filter((line) => /mAttrs|appearance|statusBar|navigationBar|Insets/.test(line))
              .slice(-100);
            observations.push({
              mode,
              theme: id,
              screenshot: name + '.png',
              windowConfiguration: windows,
              readability: 'pending screenshot review; no numeric contrast claim',
              ...(screenshotObservation?{screenshotObservation}:{}),
            });
          }
        }
      } catch(error) { primary=error;throw error; } finally {
        if(context.diagnostic==='coverage-bars')restoreGroupedNightMode(adb,observe,modeMatch[1].toLowerCase(),primary);
        else adb('shell', 'cmd', 'uimode', 'night', modeMatch[1].toLowerCase());
      }
      return { observations, systemAutoSelector: 'not applicable; no product option' };
    },
    'avatar.web-save-cancel': async () => {
      await go('/settings?settingsSection=account');
      const before = await api('/api/me', 'GET', undefined, token);
      await click('button[aria-label="Add avatar"],button[aria-label="Change avatar"]');
      await click('[role=menuitem]', 'Make avatar');
      await wait(`!!document.querySelector('[data-avatar-maker]')`);
      await click('[data-avatar-maker] button', 'Cancel');
      await wait(`!document.querySelector('[data-avatar-maker]')`);
      assert.deepEqual(await api('/api/me', 'GET', undefined, token), before);
      await click('button[aria-label="Add avatar"],button[aria-label="Change avatar"]');
      await click('[role=menuitem]', 'Make avatar');
      await wait(`!!document.querySelector('[data-avatar-maker]')`);
      await click('[data-avatar-maker] [role=tab]', 'Eyes');
      const options = await c.evaluate(
        `document.querySelectorAll('[data-avatar-maker] [role=radio]').length`,
      );
      assert(options > 1);
      await c.evaluate(`document.querySelectorAll('[data-avatar-maker] [role=radio]')[1].click()`);
      await click('[data-avatar-maker] button', 'Use avatar');
      await wait(`!document.querySelector('[data-avatar-maker]')`);
      const saved = await api('/api/me', 'GET', undefined, token);
      assert(saved.avatar_url);
      const design = await api('/api/me/avatar/design', 'GET', undefined, token);
      observe('avatar-design-response', design);
      assertSavedAvatarDesign(design);
      await c.evaluate('location.reload()');
      await wait(`!!document.querySelector('img[alt="Your avatar"]')`);
      screenshot('avatar-after-refresh');
      return {
        cancelUnchanged: true,
        user: saved.id,
        avatar: saved.avatar_url,
        design,
        webEditor: true,
        visibleAfterRefresh: true,
      };
    },
    'avatar.error-recovery': async () => {
      await go('/settings?settingsSection=account');
      const before = await api('/api/me', 'GET', undefined, token);
      const parameters = table.B2.find((row) => row.id === 'avatar.error-recovery').parameters;
      assert.equal(parameters.validation, 'frontend-size');
      assert.equal(parameters.bytes, parameters.maxBytes + 1);
      const name = parameters.filename;
      const seed = images.find((image) => image.mime === parameters.mime);
      assert(seed, 'Avatar size fixture requires the existing PNG seed');
      const seedBytes = Buffer.from(seed.base64, 'base64');
      const bytes = Buffer.alloc(parameters.bytes); // Deterministic PNG seed followed by zero padding.
      assert(seedBytes.length < bytes.length, 'Avatar size fixture must exceed the seed size');
      seedBytes.copy(bytes);
      writeFileSync(root + name, bytes);
      const fixture = { name, type: parameters.mime, size: bytes.length, sha256: hash(bytes),
        seed: seed.name, seedSha256: hash(seedBytes), construction: 'existing PNG seed + zero padding', validation: parameters.validation };
      observe('avatar-size-fixture', fixture);
      adb('push', root + name, '/sdcard/Download/' + name);
      const capture = (phase, action = 'read') => sampleShare(observe, 'avatar-file-capture-' + phase,
        () => c.evaluate(`(${avatarFileCapture.toString()})(${JSON.stringify(action)})`));
      await capture('install', 'install');
      try {
        await chooseAvatarFile(name, 'invalid');
        await capture('invalid-after-picker');
        await wait(`document.querySelector('[data-testid="human-avatar-error"]')?.textContent.trim()===${JSON.stringify(parameters.expectedError)}`);
        const feedback = await capture('invalid-feedback');
        const state = feedback?.value;
        assert(feedback?.status === 'observed' && state?.status === 'observed' && state.installed && state.installError === null,
          'Avatar size File capture unavailable');
        assert(state.sameDocument && state.target?.connected && state.target.sameCurrentInput, 'Avatar size File capture identity changed');
        const changes = state.events.filter((event) => event.type === 'change' && event.trusted);
        assert.equal(changes.length, 1, 'Expected one trusted avatar size File change');
        assert.deepEqual(changes[0].file, { name, type: parameters.mime, size: parameters.bytes }, 'Avatar size File metadata mismatch');
        assert.equal((await api('/api/me', 'GET', undefined, token)).avatar_url, before.avatar_url);
        screenshot('avatar-error');
        await chooseAvatarFile(images[0].name, 'valid');
        await capture('valid-after-picker');
        await wait(`!document.querySelector('[data-testid="human-avatar-error"]')`);
        const deadline = Date.now() + 15000;
        let after;
        while (Date.now() < deadline) {
          after = await api('/api/me', 'GET', undefined, token);
          if (after.avatar_url !== before.avatar_url) break;
          await delay(100);
        }
        assert(after.avatar_url && after.avatar_url !== before.avatar_url);
        await wait(`!!document.querySelector('img[alt="Your avatar"]')`);
        return {
          validation: parameters.validation,
          rejectedFile: fixture,
          expectedSizeError: parameters.expectedError,
          visibleFailure: true,
          oldAvatarRetainedOnFailure: true,
          successfulNewExplicitUpload: true,
          avatar: after.avatar_url,
        };
      } catch (error) {
        await capture('failure');
        await sampleShare(observe, 'avatar-error-recovery-account-failure', () => c.evaluate(`(${avatarAccountObservation.toString()})()`));
        await sampleShare(observe, 'avatar-error-recovery-page-screenshot', () => { screenshot('avatar-error-recovery-failure'); return { file: 'avatar-error-recovery-failure.png' }; });
        throw error;
      } finally { await capture('release', 'release'); }
    },
  };
  if(context.diagnostic==='coverage-short') {
    await step('DIAG.short-selection', shortPreview);
    return;
  }
  if(context.diagnostic==='coverage-bars') {
    await step('B2.theme.os-and-bars', handlers['theme.os-and-bars']);
    return;
  }
  for (const row of table.B2.filter((row) => row.scope === 'device')) {
    assert(handlers[row.id], 'Missing B2 action ' + row.id);
    await step('B2.' + row.id, handlers[row.id]);
  }
}
