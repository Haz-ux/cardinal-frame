-- 020_skill_network_gate.sql
-- Per-skill network egress gate: fetch/curl/wget inside the skill sandbox are
-- denied unless the skill row has network_access = 1 (granted by an admin).
-- Default deny. Also repairs skills columns that writers expect but no
-- migration ever created (hub installs and execution_backend updates fail
-- without them).

ALTER TABLE skills ADD COLUMN network_access INTEGER DEFAULT 0;

-- Grandfather existing skills whose code actually uses the network, so the
-- gate doesn't break working installs. Runs once — later revocations stick.
UPDATE skills SET network_access = 1
  WHERE COALESCE(handler, '') LIKE '%fetch(%'
     OR COALESCE(handler, '') LIKE '%curl%'
     OR COALESCE(handler, '') LIKE '%wget%';

-- Repair: columns referenced by writers but never migrated.
ALTER TABLE skills ADD COLUMN content TEXT DEFAULT '';
ALTER TABLE skills ADD COLUMN skill_id TEXT DEFAULT '';
ALTER TABLE skills ADD COLUMN source TEXT DEFAULT '';
ALTER TABLE skills ADD COLUMN execution_backend TEXT DEFAULT 'local';
