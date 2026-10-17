-- BRAIN-D1 (FB-D1-R1-01, task R21) — migration cho model KbConsultLog
-- (commit 4394507 thêm model vào schema.prisma bằng db push nhưng KHÔNG kèm
-- migration → máy user theo luồng chuẩn "git pull → bun run db:deploy"
-- (doctrine FB-P3) sẽ KHÔNG có bảng → mọi logKbConsult fail-open im lặng
-- (warn throttle 60s) → corpus D1 không bao giờ tích lũy trên máy duy nhất
-- có Qdrant populated. Migration additive — không đụng bảng cũ (H5).
-- Lưu ý drift có sẵn từ trước: BrainSearchRun/Candidate cũng thiếu migration
-- (ghi nhận FB-D1-R1 ngoài phạm vi — bàn đợt EVO-P4).

-- CreateTable
CREATE TABLE "KbConsultLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "taskType" TEXT,
    "intent" TEXT,
    "queryText" TEXT,
    "retrievalConfigJson" TEXT NOT NULL,
    "sourcesJson" TEXT NOT NULL,
    "topResultsJson" TEXT NOT NULL,
    "confidence" REAL,
    "rawConfidence" REAL,
    "step2Used" BOOLEAN,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL,
    "runId" TEXT,
    "sessionId" TEXT,
    "agentId" TEXT
);

-- CreateIndex
CREATE INDEX "KbConsultLog_createdAt_idx" ON "KbConsultLog"("createdAt");

-- CreateIndex
CREATE INDEX "KbConsultLog_runId_idx" ON "KbConsultLog"("runId");

-- CreateIndex
CREATE INDEX "KbConsultLog_taskType_idx" ON "KbConsultLog"("taskType");
