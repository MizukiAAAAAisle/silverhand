CREATE TABLE messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    body          TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
    created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE message_events (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id   INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind = 'message_created'),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;
