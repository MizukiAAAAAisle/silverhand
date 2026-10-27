"""Actual stop_emulator consumer, controlled process/group/clock only;no ADB/emulator."""
import io,json,unittest,tempfile
from unittest.mock import Mock,patch
from pathlib import Path
import workflow as w
class Log(io.StringIO):
    def close(self):self.saved=self.getvalue();super().close()
class StopWait(unittest.TestCase):
    def process(self,live=False):
        p=Mock(pid=900001,silverhand_emulator_pgid=900001);p.poll.return_value=None if live else 0;return p
    def invoke(self,groups,*,live=False,error=None):
        p=self.process(live);log=Log();time=[0]
        def sample(*a,**kw):
            self.assertEqual(a,(p.pid,));self.assertIs(kw['include_zombies'],True)
            if error:raise error
            if len(groups)>1:return groups.pop(0)
            return groups[0]
        with patch.object(w.time,'monotonic',side_effect=lambda:time[0]),patch.object(w.time,'sleep',side_effect=lambda ms:time.__setitem__(0,time[0]+ms)),patch.object(w,'group_members',side_effect=sample) as query,patch.object(w.subprocess,'run',return_value=w.SimpleNamespace(returncode=0,stdout='OK',stderr='')) as adb:
            try:w.stop_emulator(p,log);caught=None
            except Exception as e:caught=e
        self.assertTrue(log.closed);report=json.loads(log.saved.split('EMULATOR_STOP ')[1]);return p,caught,report,time[0],query,adb
    def test_parent_exited_group_still_live_then_empty(self):
        p,e,r,t,q,a=self.invoke([[900002],[900002],[]]);self.assertIsNone(e);self.assertEqual(r['status'],'passed');self.assertEqual([x['members'] for x in r['group_samples']],[[900002],[900002],[]]);self.assertGreater(t,0);a.assert_not_called();p.terminate.assert_not_called()
    def test_live_parent_stop_then_owned_group(self):
        p,e,r,t,q,a=self.invoke([[900002],[]],live=True);self.assertIsNone(e);a.assert_called_once();p.wait.assert_called_once();self.assertEqual(r['pgid'],p.pid)
    def test_group_never_exits_keeps_failure(self):
        p,e,r,t,q,a=self.invoke([[900002]]);self.assertIsInstance(e,TimeoutError);self.assertEqual(r['status'],'failed');self.assertLessEqual(t,30.1);p.terminate.assert_not_called();self.assertEqual(r['group_samples'][-1]['members'],[900002])
    def test_query_failure_never_means_empty(self):
        error=PermissionError('controlled group query denied');p,e,r,t,q,a=self.invoke([[]],error=error);self.assertIs(e,error);self.assertEqual(r['status'],'failed');self.assertEqual(r['error']['type'],'PermissionError');self.assertEqual(r['group_samples'],[])
    def test_missing_spawn_group_refuses_stop(self):
        p=self.process();del p.silverhand_emulator_pgid;log=Log()
        with patch.object(w,'group_members') as q:
            with self.assertRaisesRegex(AssertionError,'spawn-owned'):w.stop_emulator(p,log)
        q.assert_not_called();p.terminate.assert_not_called();self.assertTrue(log.closed)
    def test_failed_stop_keeps_existing_primary_error(self):
        error=RuntimeError('original business failure');p=self.process();log=Log()
        with patch.object(w,'group_members',side_effect=PermissionError('query failed')),patch.object(w,'cleanup_services',return_value={'status':'passed'}),patch.object(w,'write') as save:
            w.finish_cleanup(Path('/controlled'),[('stop-owned-emulator',lambda:w.stop_emulator(p,log))],error)
        report=save.call_args.args[1];self.assertEqual(report['primary_error'],str(error));self.assertEqual(report['actions'][0]['status'],'failed');self.assertEqual(report['status'],'failed')
    def test_actual_boot_carries_spawn_group_to_stop(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);run=root/'run';run.mkdir();avd=root/'avd/silverhand_stage1_api36.avd';avd.mkdir(parents=True);(avd/'config.ini').write_text('controlled config')
            p=Mock(pid=900001);p.poll.return_value=None
            with patch.dict(w.ENV,ANDROID_SERIAL='emulator-5584',ANDROID_AVD_HOME=str(root/'avd')),patch.object(w.socket.socket,'connect_ex',return_value=1),patch.object(w.subprocess,'Popen',return_value=p) as spawn,patch.object(w,'adb',side_effect=['1','controlled fingerprint','controlled webview']),patch.object(w,'output',return_value='silverhand_stage1_api36'):
                actual,log=w.boot(run)
                self.assertIs(actual,p);self.assertIs(spawn.call_args.kwargs['start_new_session'],True)
                record=json.loads((run/'emulator.json').read_text());self.assertEqual(record['pid'],record['pgid']);self.assertEqual(record['pgid'],actual.silverhand_emulator_pgid)
                p.poll.return_value=0
                with patch.object(w,'group_members',return_value=[]) as query:w.stop_emulator(actual,log)
                self.assertEqual(query.call_args.args,(record['pgid'],));self.assertIs(query.call_args.kwargs['include_zombies'],True)
    def test_actual_group_query_keeps_zombies_only_for_strict_stop(self):
        answer=w.SimpleNamespace(stdout='900002 900001 S\n900003 900001 Z\n900004 900004 S\n')
        with patch.object(w.subprocess,'run',return_value=answer) as query:
            self.assertEqual(w.group_members(900001),[900002]);self.assertEqual(w.group_members(900001,include_zombies=True,timeout=.2),[900002,900003]);self.assertIs(query.call_args.kwargs['check'],True);self.assertEqual(query.call_args.kwargs['timeout'],.2)
if __name__=='__main__':unittest.main(verbosity=2)
