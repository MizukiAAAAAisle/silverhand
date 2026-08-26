-- Shared cross-language fixture for the GET /api/presence whole-wire body
-- (#task:2195, batch 1 P0-2). Executed VERBATIM against a fresh current-schema
-- database by BOTH the TypeScript oracle (tests/presence-cold-read-parity.test.ts)
-- and the Rust parity test (backend-server/tests/presence_parity.rs), which then
-- assert their real presence authority's serialized body equals expected.json.
--
-- `online.json` names the viewers the live registry reports present; every listed
-- viewer that is online has its stored stamp SUPPRESSED to null, and every offline
-- viewer keeps its stored stamp verbatim (null stays null for a never-seen viewer).
--
-- created_at values are mutually unequal so the listed order is unambiguous across
-- languages without relying on the id tie-break (TypeScript orders on created_at
-- alone; the Rust adapter refines a tie with `id ASC`).

INSERT INTO users (id, name, display_name, created_at, updated_at, last_seen_at)
  VALUES ('user-a', 'a', 'A', 100, 100, 500);
INSERT INTO users (id, name, display_name, created_at, updated_at, last_seen_at)
  VALUES ('user-b', 'b', 'B', 200, 200, 900);
INSERT INTO users (id, name, display_name, created_at, updated_at, last_seen_at)
  VALUES ('user-c', 'c', 'C', 300, 300, NULL);
