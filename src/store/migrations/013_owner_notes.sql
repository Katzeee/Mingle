-- What the owner changed from the console (a reminder cancelled, a task closed), told to the agent
-- with its next input rather than in a turn of its own (docs/spec.md 4.6).
CREATE TABLE owner_notes (
  id          INTEGER PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX owner_notes_agent ON owner_notes(agent_id, id);
