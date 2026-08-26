import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import fixture from '../fixtures/conversation-message-window-wire.json' with { type: 'json' };

function seed(t: TestApp): void {
  t.ctx.db.exec(`
    INSERT OR IGNORE INTO users(id,name,display_name,created_at,updated_at) VALUES
      ('reply-a','reply-a','Reply A',1,1),
      ('reply-b','reply-b','Reply B',1,1),
      ('outsider','outsider','Outsider',1,1);
    INSERT INTO workspaces(id,name,name_key,created_at,updated_at)
      VALUES('window-w','Window Workspace','window-workspace',1,1);
    INSERT OR IGNORE INTO workspace_users(workspace_id,user_id,joined_at,role)
      VALUES('window-w','local',1,'member');
    INSERT INTO conversations(
      id,workspace_id,placement_kind,roster_policy,title,title_key,status,visibility,
      latest_message_seq,created_at,updated_at
    ) VALUES('c','window-w','workspace','open','Window','window','idle','public',5,1,1);
    INSERT OR IGNORE INTO conversation_users(conversation_id,user_id,joined_at)
      VALUES('c','local',1);
    INSERT INTO messages(
      id,conversation_id,from_kind,from_user_id,content,seq,created_at,
      author_id,author_name,author_display_name
    ) VALUES
      ('root-1','c','user','local','root one',1,10,'local','local','Local User'),
      ('root-2','c','user','local','root two',2,20,'local','local','Local User');
    INSERT INTO messages(
      id,conversation_id,from_kind,from_user_id,content,metadata,seq,created_at,
      thread_root_id,author_id,author_name,author_display_name
    ) VALUES
      ('reply-1','c','user','reply-a',' first   reply ',NULL,3,30,'root-1',
       'reply-a','reply-a','Reply A'),
      ('reply-system','c','system',NULL,'system reply',NULL,4,40,'root-1',NULL,NULL,NULL),
      ('reply-2','c','user','reply-b','second reply',
       '{"attachments":[{"id":"att-2","filename":"note.txt","size":4,"content_type":"text/plain","label":"File #2"}]}',
       5,50,'root-1','reply-b','reply-b','Reply B');
    INSERT INTO conversation_stream_heads(conversation_id,thread_root_id,latest_seq) VALUES
      ('c',NULL,2),('c','root-1',5);
    INSERT INTO message_reactions(id,message_id,reactor_kind,reactor_id,emoji,created_at) VALUES
      ('reaction-1','root-2','user','local','👍',3),
      ('reaction-2','root-2','user','outsider','👍',4);
    INSERT INTO tasks(
      id,workspace_id,task_number,conversation_id,title,status,creator_kind,
      creator_user_id,source_message_id,created_at,board_key
    ) VALUES('task-1','window-w',1,'c','Linked task','todo','user','local','root-2',1,'ws:window-w');
  `);
}

describe('conversation message-window fixture uses the production TypeScript route', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('signs the minimal stream, window and public-projection authority cells', async () => {
    t = buildTestApp();
    seed(t);
    for (const entry of fixture) {
      if (entry.name.startsWith('public_')) {
        t.ctx.db.prepare(
          "DELETE FROM conversation_users WHERE conversation_id='c' AND user_id='local'",
        ).run();
      }
      const response = await http(t).get(`/api/channels/c/messages${entry.query}`);
      expect(response.status, entry.name).toBe(entry.status);
      expect(await response.json(), entry.name).toEqual(entry.body);
    }
    expect(fixture).toHaveLength(3);
  });
});
