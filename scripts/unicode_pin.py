"""The ONE reviewed Unicode revision every generated table in this repo is built
from (#task:2016).

A name's verdict — does this title fold to that key, is this code point allowed —
must be a pure function of data we ship, because the backend on Node, the renderer
on Electron's V8, the CLI and a packaged daemon each carry their own ICU. That
property is only as pinned as its GENERATORS: a generator that reads
`unicodedata.unidata_version` and stamps whatever it finds turns "pinned data" into
"whichever CPython was on PATH", and running it under an older interpreter would
rewrite the table AND the fixture to the older revision with every test still
green — the tables agree with each other, they just no longer say what was
reviewed.

So the version is a CONSTANT HERE, asserted before anything is written. Bumping
Unicode is then what it actually is: an edit to this file, reviewed, followed by
regenerating every table and re-running the `title_key` integrity scan because
existing stored keys may fold differently than they did.
"""

from __future__ import annotations

import sys
import unicodedata

#: The reviewed revision. Changing this line is the Unicode version bump.
EXPECTED_UNICODE_VERSION = '16.0.0'


def require_expected_unicode_version() -> str:
    """Return the pinned version, or exit non-zero explaining the mismatch.

    Deliberately not a warning: the failure mode is a silent downgrade of shipped
    data, which no later test can see.
    """
    actual = unicodedata.unidata_version
    if actual != EXPECTED_UNICODE_VERSION:
        sys.exit(
            f'refusing to generate: this interpreter carries Unicode {actual}, '
            f'but scripts/unicode_pin.py pins {EXPECTED_UNICODE_VERSION}.\n'
            f'  python: {sys.version.split()[0]} at {sys.executable}\n'
            'Run a CPython whose unicodedata matches, or — if the bump is '
            'intended — edit EXPECTED_UNICODE_VERSION, regenerate every table, '
            'and re-run the title_key integrity scan.'
        )
    return actual
