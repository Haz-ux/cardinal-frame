-- 015_review_jobs.sql
-- Learning daemon review queue. Each daemon run is a row: the review loop
-- picks up queued candidates, validates them, and hands results to the
-- curator promotion gate.

CREATE TABLE IF NOT EXISTS review_jobs (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','passed','failed')),
  scheduled_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  result TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_review_jobs_status ON review_jobs(status);
CREATE INDEX IF NOT EXISTS idx_review_jobs_candidate ON review_jobs(candidate_id);
