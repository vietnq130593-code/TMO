-- ============================================================
-- Migration: Add 5 Learning backup tables to Supabase
--   (Phase 3 SMOLAB Proposal 10 — Supabase sync for learning tables)
-- ============================================================
-- Purpose: Persist learning data to the Supabase cloud so it survives
--          sandbox resets. Phase 6 Prop 2 added 3 Prisma models
--          (ExecutionMetrics, FailurePattern, StrategyAdaptationLog)
--          but they were never synced to Supabase. Phase 1 originals
--          (LearningLog, AutoLearnRecord) were also never synced.
--          This migration creates 5 new *_backup tables mirroring the
--          Prisma schema so supabase-sync.ts pushToSupabase() /
--          pullFromSupabase() can upsert rows for them.
--
-- ⚠️  DOCUMENTATION-ONLY FILE — DO NOT auto-run from app code.
--    Run manually in Supabase Dashboard > SQL Editor, OR via:
--      supabase db execute --file scripts/supabase-learning-tables.sql
--    Once applied, restart theopusflashlite (pm2) and call
--      POST /api/storage/supabase-sync?action=push
--    to backfill the 5 new tables from current SQLite rows.
--
-- Schema mirrors prisma/schema.prisma models exactly.
-- ============================================================

-- 1. LearningLog — learning event log (feedback | insight | correction |
--    preference | pattern). Original Prisma model (Phase 1).
CREATE TABLE IF NOT EXISTS learning_log_backup (
  id            TEXT PRIMARY KEY,
  session_id    TEXT,
  agent_id      TEXT DEFAULT 'default',
  event_type    TEXT NOT NULL,        -- feedback | insight | correction | preference | pattern
  content       TEXT NOT NULL,        -- JSON string with event details
  metadata      TEXT,                  -- Optional JSON metadata (nullable)
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_learning_log_backup_agent    ON learning_log_backup (agent_id);
CREATE INDEX IF NOT EXISTS idx_learning_log_backup_event    ON learning_log_backup (event_type);
CREATE INDEX IF NOT EXISTS idx_learning_log_backup_created ON learning_log_backup (created_at);
COMMENT ON TABLE learning_log_backup IS 'Cloud backup of SQLite LearningLog table — learning event log (Phase 3 SMOLAB Prop 10)';

-- 2. AutoLearnRecord — auto-learned knowledge audit (one row per chat
--    exchange that triggered writeback). Original Prisma model (Phase 1).
CREATE TABLE IF NOT EXISTS auto_learn_record_backup (
  id                  TEXT PRIMARY KEY,
  agent_id            TEXT NOT NULL,             -- AgentProfile.id
  agent_name          TEXT NOT NULL,             -- Agent name (denormalized)
  query               TEXT NOT NULL,             -- Original user query
  answer_preview      TEXT NOT NULL,             -- First 500 chars of agent answer
  confidence          REAL NOT NULL,             -- Confidence score of the answer
  provider            TEXT NOT NULL,             -- e.g. "mistral"
  model               TEXT NOT NULL,             -- e.g. "mistral-large-2512"
  entities_count     INTEGER DEFAULT 0,
  relationships_count INTEGER DEFAULT 0,
  chunk_saved         BOOLEAN DEFAULT FALSE,
  neo4j_synced        BOOLEAN DEFAULT FALSE,
  qdrant_point_id     TEXT,
  document_id         TEXT,
  status              TEXT DEFAULT 'pending',    -- pending | completed | failed
  error_message       TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auto_learn_record_backup_agent    ON auto_learn_record_backup (agent_id);
CREATE INDEX IF NOT EXISTS idx_auto_learn_record_backup_created   ON auto_learn_record_backup (created_at);
CREATE INDEX IF NOT EXISTS idx_auto_learn_record_backup_conf      ON auto_learn_record_backup (confidence);
CREATE INDEX IF NOT EXISTS idx_auto_learn_record_backup_status   ON auto_learn_record_backup (status);
COMMENT ON TABLE auto_learn_record_backup IS 'Cloud backup of SQLite AutoLearnRecord table — auto-learned knowledge audits (Phase 3 SMOLAB Prop 10)';

-- 3. ExecutionMetrics — Layer 9 workflow run metrics. Prisma model added
--    by Phase 6 Prop 2. Written by workflow-engine.ts (Phase 2 Prop 7)
--    + master-orchestrator.ts.
CREATE TABLE IF NOT EXISTS execution_metrics_backup (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL,           -- Workflow session ID for correlation
  plan_id               TEXT NOT NULL,           -- Plan ID (from master-orchestrator orchestration plan)
  routing_mode          TEXT NOT NULL,           -- 'A' | 'B' | 'C' (used as proxy for task complexity)
  tier                  INTEGER NOT NULL,        -- 1 | 2 | 3 (complexity tier)
  total_steps           INTEGER NOT NULL,
  completed_steps       INTEGER NOT NULL,
  failed_steps          INTEGER NOT NULL,
  total_tokens_used     INTEGER NOT NULL,
  total_tokens_budgeted INTEGER NOT NULL,
  total_time_spent      INTEGER NOT NULL,        -- Wall-clock time in ms
  errors_by_type        TEXT NOT NULL,           -- JSON map of error_type -> count (e.g. {"type_error": 5, "runtime": 2})
  step_success_rate     REAL NOT NULL,          -- 0.0-1.0 — completedSteps / totalSteps ratio
  token_efficiency      REAL NOT NULL,          -- actual / budgeted (<=1.0 = good, >1.0 = over budget)
  created_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_execution_metrics_backup_session  ON execution_metrics_backup (session_id);
CREATE INDEX IF NOT EXISTS idx_execution_metrics_backup_mode    ON execution_metrics_backup (routing_mode);
CREATE INDEX IF NOT EXISTS idx_execution_metrics_backup_created ON execution_metrics_backup (created_at);
COMMENT ON TABLE execution_metrics_backup IS 'Cloud backup of SQLite ExecutionMetrics table — Layer 9 workflow run metrics (Phase 3 SMOLAB Prop 10; Phase 6 Prop 2 added model)';

-- 4. FailurePattern — Layer 9.2 failure pattern detection. Prisma model
--    added by Phase 6 Prop 2. Written by strategy-adapter.ts.
--    ⚠️ NOTE: FailurePattern has NO createdAt field in Prisma schema —
--       this backup table mirrors that (no created_at column).
CREATE TABLE IF NOT EXISTS failure_pattern_backup (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  type              TEXT NOT NULL,             -- 'repeated_error' | 'approach_exhausted' | 'resource_limit' | 'timeout'
  count             INTEGER DEFAULT 1,
  strategies_tried  TEXT NOT NULL,             -- JSON array of strategies already tried (e.g. ["surgical", "refactoring"])
  next_strategy     TEXT NOT NULL,
  context           TEXT NOT NULL,             -- JSON context: { taskType, routingMode, stepType }
  resolved          BOOLEAN DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_failure_pattern_backup_session  ON failure_pattern_backup (session_id);
CREATE INDEX IF NOT EXISTS idx_failure_pattern_backup_type    ON failure_pattern_backup (type);
CREATE INDEX IF NOT EXISTS idx_failure_pattern_backup_resolved ON failure_pattern_backup (resolved);
COMMENT ON TABLE failure_pattern_backup IS 'Cloud backup of SQLite FailurePattern table — Layer 9.2 failure pattern detection (Phase 3 SMOLAB Prop 10; Phase 6 Prop 2 added model; NOTE: no createdAt column in Prisma schema)';

-- 5. StrategyAdaptationLog — Layer 9.2 adaptation audit log. Prisma model
--    added by Phase 6 Prop 2. Written by strategy-adapter.ts.
CREATE TABLE IF NOT EXISTS strategy_adaptation_log_backup (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  pattern_id      TEXT,                         -- nullable — spontaneous adaptations have no patternId
  from_strategy   TEXT NOT NULL,
  to_strategy     TEXT NOT NULL,
  reason          TEXT NOT NULL,
  confidence      REAL NOT NULL,                -- 0.0-1.0
  successful      BOOLEAN,                      -- null = pending, true = succeeded, false = failed
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_strategy_adaptation_log_backup_session  ON strategy_adaptation_log_backup (session_id);
CREATE INDEX IF NOT EXISTS idx_strategy_adaptation_log_backup_pattern ON strategy_adaptation_log_backup (pattern_id);
CREATE INDEX IF NOT EXISTS idx_strategy_adaptation_log_backup_created  ON strategy_adaptation_log_backup (created_at);
COMMENT ON TABLE strategy_adaptation_log_backup IS 'Cloud backup of SQLite StrategyAdaptationLog table — Layer 9.2 adaptation audit (Phase 3 SMOLAB Prop 10; Phase 6 Prop 2 added model)';

-- ============================================================
-- End of migration. Total: 5 new backup tables, 13 new indexes.
-- After applying this migration, restart theopusflashlite (pm2) and call:
--   curl -X POST 'http://localhost:3000/api/storage/supabase-sync?action=push'
-- to backfill the 5 new tables from current SQLite rows.
-- Then verify with:
--   curl 'http://localhost:3000/api/storage/supabase-sync'
-- Response should include tableCount: 24 and 24 entries in tables[] array.
-- ============================================================
