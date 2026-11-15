-- People: the same human across the agent's chat apps (docs/spec.md 4.2). Only explicit links make one;
-- Mingle never guesses from names. A person carries a name and a short note the agent reads on demand.
CREATE TABLE people (
  id          TEXT PRIMARY KEY,                -- p3k2, shown to the agent as person=
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name        TEXT,                            -- wins over each contact's own names
  note        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX people_agent ON people(agent_id);

-- Who put the contact in its person: 'owner' (in the console) or 'agent' (mingle contact link). Only the
-- owner's links may ever carry permissions across accounts; the agent's only share a name and a note.
ALTER TABLE contacts ADD COLUMN person_id TEXT REFERENCES people(id) ON DELETE SET NULL;
ALTER TABLE contacts ADD COLUMN linked_by TEXT CHECK (linked_by IN ('owner', 'agent'));
CREATE INDEX contacts_person ON contacts(person_id);
