-- Who can put the agent to work (docs/spec.md 4.7).
-- contacts.access and chats.access: 'allowed' | 'blocked' | NULL. NULL is "not decided yet": where
-- the bot is open to the public, Mingle asks the owner before such a person or group reaches the
-- agent; elsewhere it lets them through and records 'allowed'. chats.access matters for groups only.
ALTER TABLE contacts ADD COLUMN access TEXT;
ALTER TABLE chats ADD COLUMN access TEXT;
-- agents.ask_all: ask the owner about new people and groups on every chat app, not only public ones.
ALTER TABLE agents ADD COLUMN ask_all INTEGER NOT NULL DEFAULT 0;
-- A bot whose owner the platform did not report is claimed by sending it this one-time code.
ALTER TABLE connections ADD COLUMN claim_code TEXT;
ALTER TABLE connections ADD COLUMN claim_expires_at INTEGER;
-- Nobody already talking to an agent is cut off by the upgrade: everyone who wrote, and every group
-- the bot is in, is allowed.
UPDATE contacts SET access = 'allowed'
  WHERE EXISTS (
    SELECT 1 FROM messages m JOIN chats c ON c.id = m.chat_id
    WHERE c.connection_id = contacts.connection_id AND m.direction = 'in' AND m.sender_id = contacts.platform_id
  );
UPDATE chats SET access = 'allowed' WHERE kind <> 'dm';
CREATE INDEX messages_held ON messages(state) WHERE state = 'held';
