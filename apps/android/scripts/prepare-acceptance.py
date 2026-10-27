#!/usr/bin/env python3
"""Start only the disposable local backend and TLS proxy; no production data/env."""
import argparse,subprocess,os,json,shutil
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--renew-ca',action='store_true');p.add_argument('--existing-ca',action='store_true');p.add_argument('--search-control',type=Path);p.add_argument('--search-events',type=Path);p.add_argument('--task-control',type=Path);p.add_argument('--task-events',type=Path);p.add_argument('--task-tls-events',type=Path);p.add_argument('--task-write-observer',type=Path);p.add_argument('--task-write-events',type=Path);a=p.parse_args()
app=Path(__file__).resolve().parents[1];repo=app.parents[1];openssl_bin=os.environ['OPENSSL_BIN'];assert Path(openssl_bin).is_absolute(),'OPENSSL_BIN must be an explicit absolute path';run=Path(os.environ['SILVERHAND_ANDROID_RUN_ROOT']).resolve() if os.environ.get('SILVERHAND_ANDROID_RUN_ROOT') else None;root=run/'acceptance' if run else app/'.generated/acceptance';cert=root/'certs';cert.mkdir(parents=True,exist_ok=True)
assert (a.search_control is None) == (a.search_events is None), 'S2 control/events must be paired'
proxy_env = os.environ.copy()
for variable in ['SILVERHAND_S2_CONTROL', 'SILVERHAND_S2_EVENTS', 'SILVERHAND_T1_CONTROL', 'SILVERHAND_T1_EVENTS', 'SILVERHAND_T1_TLS_EVENTS', 'SILVERHAND_T2_OBSERVER', 'SILVERHAND_T2_EVENTS', 'SILVERHAND_T2_TLS_EVENTS']: proxy_env.pop(variable, None)
if a.search_control is not None:
 control, events = a.search_control, a.search_events
 assert run and control.is_absolute() and control.resolve() == control and events.is_absolute() and events.resolve() == events, 'S2 path identity changed'
 assert control.parent == events.parent and control.name == 's2-control.json' and events.name == 's2-proxy-events.jsonl', 'S2 control/output mismatch'
 assert control.parent.parent == root/'b3/search-isolation/attempts' and not events.exists(), 'S2 output occupied or outside unit'
 spec=json.loads(control.read_text());assert spec['version']==1 and spec['unit']=='search-isolation' and spec['attempt']==control.parent.name and spec['active'] is False and not spec['users'] and not spec['rules'], 'S2 initial control not transparent'
 proxy_env.update(SILVERHAND_S2_CONTROL=str(control), SILVERHAND_S2_EVENTS=str(events))
assert (a.task_control is None) == (a.task_events is None), 'T1 control/events must be paired'
assert not (a.task_control is not None and a.search_control is not None), 'Only one explicit unit control may run'
if a.task_control is not None:
 control, events = a.task_control, a.task_events
 assert run and control.is_absolute() and control.resolve() == control and events.is_absolute() and events.resolve() == events, 'T1 path identity changed'
 assert control.parent == events.parent and control.name == 't1-control.json' and events.name == 't1-proxy-events.jsonl', 'T1 control/output mismatch'
 assert control.parent.parent == root/'b3/task-read/attempts' and not events.exists(), 'T1 output occupied or outside unit'
 spec=json.loads(control.read_text());assert spec['version']==1 and spec['unit']=='task-read' and spec['attempt']==control.parent.name and spec['active'] is False and not spec['users'] and not spec['taskIds'] and not spec['channelIds'] and not spec['routes'] and not spec['rules'] and spec['releaseAll'] is False, 'T1 initial control not transparent'
 proxy_env.update(SILVERHAND_T1_CONTROL=str(control), SILVERHAND_T1_EVENTS=str(events))
assert (a.task_write_observer is None) == (a.task_write_events is None), 'T2 observer/events must pair'
if a.task_write_observer is not None:
 assert a.search_control is None and a.task_control is None, 'T2 must be independent'
 observer, events = a.task_write_observer, a.task_write_events
 assert run and observer.is_absolute() and events.is_absolute() and observer.resolve() == observer and events.resolve() == events, 'T2 absolute paths required'
 assert observer.parent == events.parent and observer.name == 't2-observer-private.json' and events.name == 't2-events.jsonl' and observer.parent.parent == root/'b3/task-write/attempts' and not events.exists(), 'T2 output outside attempt or occupied'
 assert observer.is_file() and not observer.is_symlink(), 'T2 observer must be regular private file'
 initial=json.loads(observer.read_text());assert initial == {'version':1,'unit':'task-write','active':False}, 'T2 initial state'
 assert observer.stat().st_mode & 0o077 == 0, 'T2 private permissions'
 proxy_env.update(SILVERHAND_T2_OBSERVER=str(observer), SILVERHAND_T2_EVENTS=str(events))
if a.task_tls_events is not None:
 assert (a.task_control is not None) != (a.task_write_observer is not None), 'TLS requires exactly one task owner'
 owner = a.task_write_observer if a.task_write_observer is not None else a.task_control
 prefix = 't2' if a.task_write_observer is not None else 't1'
 assert a.task_tls_events.parent == owner.parent and a.task_tls_events.name == prefix+'-tls-events.jsonl' and a.task_tls_events.is_absolute() and a.task_tls_events.resolve() == a.task_tls_events and not a.task_tls_events.exists(), 'Task TLS output outside fixed attempt'
 proxy_env['SILVERHAND_'+prefix.upper()+'_TLS_EVENTS'] = str(a.task_tls_events)
for name in ['backend','proxy']:
 pid=root/(name+'.pid')
 if pid.exists():
  try:os.kill(int(pid.read_text()),0)
  except ProcessLookupError:pass
  else:raise SystemExit(f'{name} is still running; stop the recorded process before starting another')
import socket
for port in [18480,29443]:
 with socket.socket() as probe:
  if probe.connect_ex(('127.0.0.1',port)) == 0: raise SystemExit(f'Acceptance port {port} already in use')
if a.existing_ca:
 assert not a.renew_ca and all((cert/name).is_file() for name in ['ca.pem','server.pem','server.key']), 'Existing certificate chain required;generation forbidden'
if not a.existing_ca and (a.renew_ca or not (cert/'ca.pem').exists()):
 def openssl(*args):subprocess.run([openssl_bin,*args],cwd=cert,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 (cert/'ca.cnf').write_text('[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Silverhand Stage1 Acceptance CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n')
 openssl('req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','2','-config','ca.cnf')
 openssl('req','-newkey','rsa:2048','-nodes','-keyout','server.key','-out','server.csr','-subj','/CN=localhost')
 (cert/'server.ext').write_text('subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n')
 openssl('x509','-req','-in','server.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out','server.pem','-days','2','-extfile','server.ext')
 for f in cert.glob('*.key'): f.chmod(0o600)
for name in ['ca.pem','server.pem']:
 subprocess.run([openssl_bin,'x509','-in',str(cert/name),'-checkend','3600','-noout'],check=True,stdout=subprocess.DEVNULL)
subprocess.run([openssl_bin,'verify','-CAfile',str(cert/'ca.pem'),'-verify_hostname','localhost',str(cert/'server.pem')],check=True,stdout=subprocess.DEVNULL)
backend=Path(os.environ.get('SILVERHAND_ACCEPTANCE_BACKEND',str(repo/'rust/target/debug/silverhand-backend')))
if not backend.is_file(): raise SystemExit(f'Missing freshly built acceptance backend: {backend}')
assets=run/'app-build/acceptance-assets' if run else app/'app/build/acceptance-assets';assets.mkdir(parents=True,exist_ok=True);shutil.copy(cert/'ca.pem',assets/'acceptance-ca.pem')
data=root/'backend';data.mkdir(exist_ok=True)
env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'SILVERHAND_DIR':str(data),'SILVERHAND_DEPLOYMENT_PROFILE':'remote-only','SILVERHAND_DATABASE_PATH':str(data/'im.db'),'SILVERHAND_BLOBS_ROOT':str(data/'blobs'),'SILVERHAND_LOG_DIR':str(data/'logs'),'SILVERHAND_LISTEN_ADDR':'127.0.0.1:18480','SILVERHAND_ALLOWED_ORIGINS':'https://localhost:29443,https://localhost','SILVERHAND_DISABLE_SIGNUP':'0','SILVERHAND_MIGRATE':'1'}
for name,cmd,e in [('backend',[os.environ.get('SILVERHAND_ACCEPTANCE_BACKEND',str(repo/'rust/target/debug/silverhand-backend'))],env),('proxy',['node',str(app/'scripts/acceptance-server.mjs'),str(cert)],proxy_env)]:
 child=subprocess.Popen(cmd,env=e,stdout=(root/(name+'.log')).open('w'),stderr=subprocess.STDOUT,start_new_session=True);(root/(name+'.pid')).write_text(str(child.pid))
print('Disposable backend and TLS proxy started; process IDs saved under .generated/acceptance')
