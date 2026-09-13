-- 032_learning_skill_versions_one_active.sql
-- M9 fix (audit 2026-09-13-v2): exactly-one-active-version must be
-- DB-enforced, not just app-enforced.
--
-- The activate route already rolls other actives back inside its
-- transaction, but nothing stopped a second 'active' version per
-- candidate via a second process, a direct DB write, or a future code
-- path outside that transaction. Partial unique index (same pattern as
-- 022's idempotency index): a candidate may hold any number of versions
-- in other states, but at most one 'active' version.
CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_skill_versions_one_active
  ON learning_skill_versions(candidate_id)
  WHERE state = 'active';
