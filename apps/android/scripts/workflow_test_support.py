"""Boot metadata only; callers mock stop_emulator, whose real group tests stay separate."""
import json
from types import SimpleNamespace


def controlled_boot(out, **_kwargs):
    process = SimpleNamespace(pid=999990)
    (out / 'emulator.json').write_text(json.dumps({'controlled': True, 'pid': process.pid}))
    return process, None
