-- R31 (audit 31-a/31-b) — Migration bù 5 BẢNG BỊ TRÔI sau đợt reset 2026-10-11
-- =====================================================================================
--
-- Bối cảnh: 5 model dưới đây được thêm vào schema.prisma sau đợt rebaseline
-- 0_init (2026-10-11) và CHỈ sống trong DB qua `prisma db push` (boot self-heal
-- db-setup.ts) — KHÔNG BAO GIỜ có migration. Hệ quả: `bun run db:deploy` trên
-- máy user (doctrine khôi phục: restore backup → deploy → boot self-heal,
-- precedent BUG2-269 R21 fix KbConsultLog bằng migration bù 20261017060000)
-- KHÔNG tạo được 5 bảng này → EVO (BrainSearchRun/Candidate — R24-c), Observation
-- ledger (ObservationEvent — OBS-P1) + trace (BrainInferenceTrace — OBS-P2)
-- + DebtLedger mất lịch sử khi khôi phục.
--
-- IDEMPOTENT: mọi statement dùng IF NOT EXISTS — an toàn CHO CẢ HAI phía:
--  (a) DB tươi (deploy tuần tự 0_init → … → file này): tạo đúng 5 bảng;
--  (b) DB đã có bảng qua db push (sandbox/machine đã chạy): no-op trơn tru,
--      không lỗi "table already exists" (SQLite không hỗ trợ ADD COLUMN IF NOT
--      EXISTS nên cách duy nhất an toàn cho ALTER là... không cần ALTER —
--      diff chỉ chứa CREATE, verify bằng `prisma migrate diff` R31).
--
-- Nguồn SQL: `bunx prisma migrate diff --from-migrations prisma/migrations
-- --to-schema-datamodel prisma/schema.prisma --script` (R31 — diff còn duy
-- nhất 5 bảng; 6 model audit nghi ngờ còn lại dùng @@map snake_case đã có
-- trong 0_init: pending_edits/neo4j_checkpoint_diffs/self_direction_proposals/
-- proposal_steps/opus_settings/self_direction_settings).

-- CreateTable
CREATE TABLE IF NOT EXISTS "DebtLedger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fingerprint" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'agent',
    "status" TEXT NOT NULL DEFAULT 'open',
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "originSessionId" TEXT,
    "originRunId" TEXT,
    "lastAttemptRunId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "recurrenceCount" INTEGER NOT NULL DEFAULT 0,
    "evidence" TEXT,
    "parkReason" TEXT,
    "todoId" TEXT,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" DATETIME,
    "resolvedAt" DATETIME,
    "resolvedByRunId" TEXT,
    "resolutionEvidence" TEXT
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ObservationEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "seq" INTEGER NOT NULL,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "runId" TEXT,
    "sessionId" TEXT,
    "table" TEXT,
    "rowKey" TEXT,
    "summary" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "BrainInferenceTrace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "brain" TEXT NOT NULL,
    "modelVersion" INTEGER NOT NULL,
    "organ" TEXT,
    "runId" TEXT,
    "inputHash" TEXT NOT NULL,
    "inputJson" TEXT,
    "outputJson" TEXT,
    "latencyMs" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "BrainSearchRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "brain" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "seed" INTEGER NOT NULL,
    "heartbeatAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataFingerprint" TEXT NOT NULL,
    "inputMode" TEXT NOT NULL,
    "candidatesMax" INTEGER NOT NULL,
    "wallMsMax" INTEGER NOT NULL,
    "summaryJson" TEXT,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "BrainSearchCandidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "specJson" TEXT NOT NULL,
    "encodingJson" TEXT NOT NULL,
    "metricsJson" TEXT NOT NULL,
    "cvScore" REAL NOT NULL,
    "beatActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DebtLedger_fingerprint_key" ON "DebtLedger"("fingerprint");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DebtLedger_status_lastSeenAt_idx" ON "DebtLedger"("status", "lastSeenAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DebtLedger_kind_idx" ON "DebtLedger"("kind");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DebtLedger_lastAttemptRunId_idx" ON "DebtLedger"("lastAttemptRunId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ObservationEvent_seq_key" ON "ObservationEvent"("seq");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ObservationEvent_ts_idx" ON "ObservationEvent"("ts");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ObservationEvent_runId_ts_idx" ON "ObservationEvent"("runId", "ts");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ObservationEvent_kind_ts_idx" ON "ObservationEvent"("kind", "ts");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BrainInferenceTrace_brain_ts_idx" ON "BrainInferenceTrace"("brain", "ts");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BrainInferenceTrace_runId_ts_idx" ON "BrainInferenceTrace"("runId", "ts");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BrainSearchRun_brain_createdAt_idx" ON "BrainSearchRun"("brain", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BrainSearchCandidate_runId_cvScore_idx" ON "BrainSearchCandidate"("runId", "cvScore" DESC);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "BrainSearchCandidate_runId_idx_key" ON "BrainSearchCandidate"("runId", "idx");
