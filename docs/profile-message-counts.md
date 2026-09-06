# Profile daily message counts

`GET /api/profiles/{kind}/{id}/message-counts?year=YYYY` requires the existing
human session. `kind` is `user` or `agent`; year is required, 1970–9998.
`ProfileMessageCountsSchema` and `apiPaths.profileMessageCounts` are the shared
consumer contract.

The response contains only `subject: {kind,id}`, `year`,
`time_zone: "Asia/Shanghai"`, ascending `days: [{date,count}]`, and
`available_years`. Every day is present, including zero days (365 or 366 entries).
Available years span the earliest surviving original message's local year through
the current local year; a subject with no messages still offers the current year.
A requested zero-message year is valid even when outside that selection range.
The calendar uses the IANA Shanghai zone, including historical daylight-saving
boundaries; it does not assume that every historical local day has 24 hours.

## Authority and counting

Human profiles reuse the authenticated global-directory visibility. Agent
profiles reuse `AgentDetailReadModel` and `can_view_agent` with active stages;
unknown and invisible subjects both return `404 {error:"profile not found"}`.
Authentication and subject visibility are required on each read. There is no
anonymous API and no new source-channel ACL or audience broadcast.

After subject admission, every viewer sees the same aggregate. Count surviving
original `user`/`agent` message rows across main lines, threads and DMs. Match both
`from_kind` and the corresponding subject ID. Exclude `system` rows and every
`cc_source_message_id` copy. Identical independently sent messages count separately;
a retry that reuses the existing message row does not. Edits do not increase the
count. Physical deletion, including existing foreign-key cascades, reduces it.
This does not introduce a new product message deletion endpoint.

No message body, source conversation, message ID, or navigation target is returned.
Profile MCP, activity logs and tasks do not contribute. No cumulative ledger or
scheduled rebuild is involved.

## Queries and client integration

Migration step 94 adds two partial `(subject_id, created_at)` indexes, one per
sender kind, excluding CC copies. The adapter shares the existing messaging pool.
Earliest timestamp and daily totals use one read transaction. `MIN(created_at)`
seeks the subject index. At most 366 local calendar intervals are passed as JSON
parameters; SQLite aggregates the rows, and only daily totals reach the application.
`CROSS JOIN` fixes the small calendar relation as the outer loop, so each interval
seeks the subject-and-time range index instead of comparing every subject message
against every calendar day. SQL statements and predicates are static.

Actual `EXPLAIN QUERY PLAN` tests require the subject/time-range index for both
kinds and an indexed earliest lookup. On the isolated test machine, one million
message rows / 10,000 subject rows returned a 2024 aggregate in about 1.7 ms after
opening the adapter. This is a local representative measurement, not a service SLA
or a cold-disk benchmark. The database still has to count the selected subject's
matching rows; no constant-time guarantee is claimed.

Client cache identity includes authenticated session, subject kind/id and year;
clear on logout or denied profile access. Refetch on open, year change and focus.
There is no new WS event. Renderer implementation is owned separately.

Both server compositions mount this route behind the existing human perimeter.
API/host/outbound version numbers are unchanged: this is an additive read route.
Older servers return 404 and cannot supply this feature. Step 94 database upgrades
retain the existing migration/backup admission rules; do not open the upgraded
store with a binary that does not understand its migration ledger.
