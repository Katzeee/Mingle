-- Contacts that are bots: marked when the platform or a local agent says so, or by the owner in the
-- console. Their messages are kept as background and wake the agent only by an explicit @ (docs/spec.md 4.2).
ALTER TABLE contacts ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0;
