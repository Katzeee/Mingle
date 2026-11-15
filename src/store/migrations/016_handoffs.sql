-- What the owner handed an agent from another conversation (docs/spec.md 4.12): kept, delivered
-- as an input of its own, and shown in the console.
CREATE TABLE handoffs (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  via           TEXT NOT NULL CHECK (via IN ('command', 'paste')),
  state         TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'delivered')),
  created_at    INTEGER NOT NULL,
  delivered_at  INTEGER
) STRICT;
CREATE INDEX handoffs_agent ON handoffs(agent_id, created_at);
