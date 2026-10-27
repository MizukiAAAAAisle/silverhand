// @vitest-environment happy-dom
// Actual React components; chrome/picker/network are controlled, no device claim.
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CreateTaskDialog } from './create-task-dialog';
import { InlineFieldEditor } from './task-detail-shared';
const h=vi.hoisted(()=>({edit:{mutateAsync:vi.fn(),isPending:false,isError:false,reset:vi.fn()},close:null as null|((v:boolean)=>void)}));
vi.mock('@/icons',()=>({SpinnerIcon:()=>null,CheckIcon:()=>null,CloseIcon:()=>null}));
vi.mock('@/features/tasks/hooks/hooks',()=>({useCreateTask:()=>({}),useEditTask:()=>h.edit,useAssignTask:()=>({}),useUpdateTaskStatus:()=>({})}));
vi.mock('@/components/ui/dialog',async()=>{const R=await import('react');const box=({children}:any)=>R.createElement('div',null,children);return {Dialog:({open,onOpenChange,children}:any)=>{h.close=onOpenChange;return open?R.createElement('div',null,children):null;},DialogContent:box,DialogHeader:box,DialogTitle:box,DialogFooter:box};});
vi.mock('@/components/ui/button',async()=>{const R=await import('react');return{Button:({children,variant:_v,...p}:any)=>R.createElement('button',p,children)};});
vi.mock('./create-task-channel-picker',()=>({CreateTaskChannelPicker:()=>null}));
vi.mock('./person-avatar',()=>({PersonAvatar:()=>null,usePersonDirectory:()=>({})}));
vi.mock('./task-status-badge',()=>({TaskStatusBadge:()=>null}));
vi.mock('@/components/channel-icon',()=>({ChannelIcon:()=>null}));
vi.mock('./mini-icon-button',()=>({MiniIconButton:()=>null}));
vi.mock('@/features/conversations/use-conversation-members',()=>({useConversationMembers:()=>({})}));
vi.mock('@/features/direct-pairs/hooks',()=>({useDirectPairPane:()=>({}),projectDirectPairAssignee:()=>null}));
let root:Root,host:HTMLDivElement;
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;h.edit.mutateAsync.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
async function set(sel:string,v:string){const e=host.querySelector(sel) as HTMLInputElement;expect(e).toBeTruthy();await act(async()=>{Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')!.set!.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));});}
async function key(k:string){await act(async()=>{host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:k,code:k}));});}
async function blur(){await act(async()=>{host.querySelector('textarea')!.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));});}
async function submit(){await act(async()=>{host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});}
function deferred(){let resolve!:()=>void,reject!:(e:Error)=>void;const promise=new Promise<void>((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
it('actual create locks pending repeat/close, retains rejected draft and closes once on success',async()=>{
 const p=deferred(),send=vi.fn((_v:any)=>p.promise),close=vi.fn();await act(async()=>root.render(React.createElement(CreateTaskDialog,{open:true,target:{kind:'pick',defaultChannelId:'C',channelOptions:[]},onSubmit:send,onOpenChange:close})));
 await set('#create-task-title','draft');await set('#create-task-body','body');await submit();expect(send).toHaveBeenCalledOnce();expect(send.mock.calls[0]![0]).toEqual({title:'draft',body:'body',conversationId:'C'});
 await act(async()=>h.close!(false));await submit();expect(send).toHaveBeenCalledOnce();expect(close).not.toHaveBeenCalled();
 await act(async()=>p.reject(Error('controlled refusal')));expect((host.querySelector('#create-task-title') as HTMLInputElement).value).toBe('draft');expect(host.textContent).toContain('controlled refusal');send.mockResolvedValueOnce();await submit();expect(close.mock.calls).toEqual([[false]]);
});
it('actual editor Escape beats trailing blur with no mutation',async()=>{
 const done=vi.fn(),cancel=vi.fn();await act(async()=>root.render(React.createElement(InlineFieldEditor,{taskId:'T',field:'title',initial:'old',onDone:done,onCancel:cancel})));await set('textarea','draft');await key('Escape');await blur();expect(cancel).toHaveBeenCalledOnce();expect(done).not.toHaveBeenCalled();expect(h.edit.mutateAsync).not.toHaveBeenCalled();
});
it('actual editor Enter/blur latches one mutation; rejection retains draft and retry works',async()=>{
 const p=deferred(),done=vi.fn();h.edit.mutateAsync.mockReturnValue(p.promise);await act(async()=>root.render(React.createElement(InlineFieldEditor,{taskId:'T',field:'content',initial:'old',onDone:done,onCancel:vi.fn()})));await set('textarea','new body');await key('Enter');await blur();expect(h.edit.mutateAsync).toHaveBeenCalledOnce();expect(h.edit.mutateAsync.mock.calls[0]![0]).toEqual({taskId:'T',body:'new body'});
 await act(async()=>p.reject(Error('controlled edit failure')));expect(done).not.toHaveBeenCalled();expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('new body');h.edit.mutateAsync.mockResolvedValueOnce({});await key('Enter');expect(done).toHaveBeenCalledOnce();expect(h.edit.mutateAsync).toHaveBeenCalledTimes(2);
});
