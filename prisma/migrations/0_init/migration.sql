-- 0_init (REBASELINE 2026-10-11 — theo chỉ thị user quay lại luồng migration chuẩn)
-- Tái sinh toàn bộ từ prisma/schema.prisma bằng: prisma migrate diff --from-empty --to-schema-datamodel
-- Lý do: lịch sử drift — mọi model post-round-32 (QEntry/TuningParam/TuningChangeLog/KpiSnapshot/...
-- + 9 bảng và các index/row mới) từng vào DB bằng db push, 0_init cũ (89 bảng) bị stale.
-- DB vận hành khớp schema 100% (migrate diff --from-url: No difference) nên baseline
-- này khớp cả 2 phía. Đánh dấu applied bằng: prisma migrate resolve --applied 0_init.

-- CreateTable
CREATE TABLE "JobQueue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "documentId" TEXT,
    "input" TEXT,
    "output" TEXT,
    "error" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "DailyTokenUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DailyTokenByProvider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DailyTokenByProviderSlot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DailyTokenByProviderModel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DailyTokenByAgent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "filePath" TEXT NOT NULL DEFAULT '',
    "domain" TEXT NOT NULL DEFAULT 'mixed',
    "pageCount" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "errorMessage" TEXT,
    "userPaused" BOOLEAN NOT NULL DEFAULT false,
    "contentHash" TEXT,
    "duplicateOfId" TEXT,
    "processingSteps" TEXT NOT NULL DEFAULT '[]',
    "processingPercent" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "LocalEntity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT,
    "chunkId" TEXT,
    "entityName" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "description" TEXT,
    "properties" TEXT,
    "confidenceScore" REAL NOT NULL DEFAULT 0.5,
    "source" TEXT NOT NULL DEFAULT 'unknown',
    "domain" TEXT,
    "resolvedEntityId" TEXT,
    "synced" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "LocalRelationship" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT,
    "sourceEntityId" TEXT,
    "targetEntityId" TEXT,
    "sourceEntityName" TEXT,
    "targetEntityName" TEXT,
    "relationshipType" TEXT NOT NULL,
    "description" TEXT,
    "confidenceScore" REAL NOT NULL DEFAULT 0.5,
    "source" TEXT NOT NULL DEFAULT 'unknown',
    "synced" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AgentProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "domain" TEXT NOT NULL DEFAULT 'mixed',
    "capable" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "temperature" REAL NOT NULL DEFAULT 0.7,
    "maxTokens" INTEGER NOT NULL DEFAULT 16384,
    "team" TEXT,
    "position" TEXT,
    "avatar" TEXT,
    "tools" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AgentSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL DEFAULT 'default',
    "sessionId" TEXT NOT NULL,
    "model" TEXT,
    "provider" TEXT,
    "title" TEXT,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "agentProfileId" TEXT,
    "teamMode" TEXT,
    "teamName" TEXT,
    "opusReviewMode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentSession_agentProfileId_fkey" FOREIGN KEY ("agentProfileId") REFERENCES "AgentProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LearningLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT,
    "agentId" TEXT NOT NULL DEFAULT 'default',
    "eventType" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AgentInsight" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL DEFAULT 'default',
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "confidence" REAL NOT NULL DEFAULT 0.5,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AgentCorrection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL DEFAULT 'default',
    "wrongAnswer" TEXT NOT NULL,
    "correctAnswer" TEXT NOT NULL,
    "reason" TEXT,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AgentPreference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL DEFAULT 'default',
    "preferenceKey" TEXT NOT NULL,
    "preferenceValue" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AgentSkill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL DEFAULT 'default',
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'bundled',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "installedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CustomTool" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "parameters" TEXT NOT NULL,
    "handlerCode" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "source" TEXT NOT NULL DEFAULT 'agent',
    "category" TEXT NOT NULL DEFAULT 'custom',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "skillSlug" TEXT,
    "callCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ToolPermission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL DEFAULT 'default',
    "toolName" TEXT NOT NULL,
    "permission" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "KnowledgeAccessPolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL DEFAULT 'default',
    "allowRead" BOOLEAN NOT NULL DEFAULT true,
    "allowWrite" BOOLEAN NOT NULL DEFAULT true,
    "allowDelete" BOOLEAN NOT NULL DEFAULT false,
    "allowedCollections" TEXT NOT NULL DEFAULT 'theopus_documents,theopus_chunks',
    "allowedLabels" TEXT NOT NULL DEFAULT '*'
);

-- CreateTable
CREATE TABLE "CronJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL DEFAULT 'default',
    "expression" TEXT NOT NULL,
    "taskPrompt" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'cron',
    "expr" TEXT NOT NULL DEFAULT '',
    "tz" TEXT,
    "task" TEXT NOT NULL DEFAULT '',
    "sessionId" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "lastError" TEXT,
    "jobHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "scheduleJson" TEXT,
    "executor" TEXT NOT NULL DEFAULT ''
);

-- CreateTable
CREATE TABLE "pending_edits" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "operation" TEXT NOT NULL DEFAULT 'edit',
    "before" TEXT,
    "after" TEXT,
    "diff" TEXT,
    "riskLevel" TEXT NOT NULL DEFAULT 'low',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewerId" TEXT,
    "reviewedAt" DATETIME,
    "appliedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "oldContent" TEXT NOT NULL DEFAULT '',
    "newContent" TEXT NOT NULL DEFAULT '',
    "agentName" TEXT NOT NULL DEFAULT '',
    "resolvedAt" DATETIME
);

-- CreateTable
CREATE TABLE "neo4j_checkpoint_diffs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "full" BOOLEAN NOT NULL DEFAULT false,
    "nodesJson" TEXT NOT NULL,
    "relsJson" TEXT NOT NULL,
    "nodeCount" INTEGER NOT NULL DEFAULT 0,
    "relCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "rootPath" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FsCheckpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "commitHash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AgentModelOverride" (
    "agentName" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL DEFAULT 'default',
    "url" TEXT NOT NULL,
    "events" TEXT NOT NULL,
    "secret" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "StandingOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL DEFAULT 'default',
    "order" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TaskFlow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "stepsJson" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL DEFAULT 'user',
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TaskExecution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" TEXT,
    "errorMessage" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "ChannelConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channelType" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "connectedAt" DATETIME
);

-- CreateTable
CREATE TABLE "LocalResolvedEntity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT,
    "canonicalName" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "description" TEXT,
    "properties" TEXT,
    "avgConfidence" REAL NOT NULL DEFAULT 0.5,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "domains" TEXT,
    "synced" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OpenCodeSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "model" TEXT,
    "provider" TEXT,
    "prompt" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "filesTouched" TEXT NOT NULL DEFAULT '[]',
    "toolsUsed" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MCPBridgeConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "direction" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AutoLearnRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "answerPreview" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "entitiesCount" INTEGER NOT NULL DEFAULT 0,
    "relationshipsCount" INTEGER NOT NULL DEFAULT 0,
    "chunkSaved" BOOLEAN NOT NULL DEFAULT false,
    "neo4jSynced" BOOLEAN NOT NULL DEFAULT false,
    "qdrantPointId" TEXT,
    "documentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "EmbeddingCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hash" TEXT NOT NULL,
    "inputType" TEXT NOT NULL DEFAULT 'passage',
    "model" TEXT NOT NULL,
    "vector" TEXT NOT NULL,
    "hitCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHitAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CodeTeamWorklog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "toolCalls" TEXT NOT NULL DEFAULT '[]',
    "duration" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CodeTeamSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "routingMode" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "currentStep" TEXT NOT NULL DEFAULT 'pending',
    "currentAgent" TEXT,
    "completedAgents" TEXT NOT NULL DEFAULT '[]',
    "partsDefinition" TEXT NOT NULL DEFAULT '[]',
    "opencodeSessionId" TEXT,
    "totalDuration" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "model" TEXT,
    "provider" TEXT,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ChatAttachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT,
    "messageId" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "filePath" TEXT NOT NULL,
    "derivedText" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SmolabTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "sessionId" TEXT NOT NULL,
    "agentProfileId" TEXT,
    "teamName" TEXT,
    "inputSummary" TEXT,
    "result" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    CONSTRAINT "SmolabTask_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession" ("sessionId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentMemory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "sessionId" TEXT,
    "category" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "context" TEXT,
    "importance" REAL NOT NULL DEFAULT 0.5,
    "accessCount" INTEGER NOT NULL DEFAULT 0,
    "lastAccessedAt" DATETIME,
    "qdrantPointId" TEXT,
    "embeddingModel" TEXT,
    "source" TEXT NOT NULL DEFAULT 'auto',
    "tags" TEXT,
    "domain" TEXT NOT NULL DEFAULT 'work',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "tier" TEXT NOT NULL DEFAULT 'warm',
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WorkingMemory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "importance" REAL NOT NULL DEFAULT 0.8,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MemoryArchive" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "originalIds" TEXT NOT NULL,
    "summaryContent" TEXT NOT NULL,
    "domain" TEXT NOT NULL DEFAULT 'work',
    "importance" REAL NOT NULL DEFAULT 0.3,
    "sourceCount" INTEGER NOT NULL DEFAULT 1,
    "qdrantPointId" TEXT,
    "embeddingModel" TEXT,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "UserProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL DEFAULT 'default',
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'auto',
    "confidence" REAL NOT NULL DEFAULT 0.5,
    "accessCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MemoryAccessLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "memoryId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "sessionId" TEXT,
    "query" TEXT,
    "relevance" REAL NOT NULL DEFAULT 0.5,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Todo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL DEFAULT 'default',
    "agentRole" TEXT,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "parentId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT,
    "runId" TEXT,
    "archivedAt" DATETIME,
    "taskMetaJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AgentWorkData" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "runId" TEXT,
    "agentName" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    "expiresAt" DATETIME
);

-- CreateTable
CREATE TABLE "ToolMetric" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "toolName" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "agentRole" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "exitCode" INTEGER,
    "durationMs" INTEGER NOT NULL,
    "errorTag" TEXT,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ToolMetricDaily" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "agentRole" TEXT NOT NULL,
    "calls" INTEGER NOT NULL,
    "successCount" INTEGER NOT NULL,
    "totalDurationMs" BIGINT NOT NULL,
    "topErrorTags" TEXT,
    "computedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MetricAnomaly" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "agentRole" TEXT NOT NULL,
    "value" REAL NOT NULL,
    "bound" REAL NOT NULL,
    "score" REAL NOT NULL,
    "sessionId" TEXT,
    "observedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "KpiSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" TEXT NOT NULL,
    "kpi" TEXT NOT NULL,
    "value" REAL NOT NULL,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "meta" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AgentRunRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "messageId" TEXT,
    "runId" TEXT,
    "parentRunId" TEXT,
    "agentId" TEXT,
    "agentName" TEXT,
    "model" TEXT,
    "status" TEXT,
    "stopReason" TEXT,
    "cycles" INTEGER,
    "tokensUsed" INTEGER,
    "toolCalls" INTEGER,
    "toolFailures" INTEGER,
    "durationMs" INTEGER,
    "evaluatorConfidence" REAL,
    "complete" BOOLEAN,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ArbiterVerdict" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "messageId" TEXT,
    "agentName" TEXT,
    "cycle" INTEGER NOT NULL,
    "complete" BOOLEAN NOT NULL,
    "confidence" REAL NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "missing" TEXT,
    "rootCause" TEXT,
    "forcedDowngrade" BOOLEAN NOT NULL DEFAULT false,
    "runStopReason" TEXT,
    "runComplete" BOOLEAN,
    "outcome" TEXT,
    "outcomeAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WorkflowSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentRole" TEXT NOT NULL,
    "taskDescription" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "contextOverflowCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ExecutionMetrics" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "routingMode" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "totalSteps" INTEGER NOT NULL,
    "completedSteps" INTEGER NOT NULL,
    "failedSteps" INTEGER NOT NULL,
    "totalTokensUsed" INTEGER NOT NULL,
    "totalTokensBudgeted" INTEGER NOT NULL,
    "totalTimeSpent" INTEGER NOT NULL,
    "errorsByType" TEXT NOT NULL,
    "stepSuccessRate" REAL NOT NULL,
    "tokenEfficiency" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "FailurePattern" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "strategiesTried" TEXT NOT NULL,
    "nextStrategy" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "StrategyAdaptationLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "patternId" TEXT,
    "fromStrategy" TEXT NOT NULL,
    "toStrategy" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "successful" BOOLEAN,
    "statsJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CodeTeamCheckpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "completedSteps" TEXT NOT NULL DEFAULT '[]',
    "currentStepIndex" INTEGER NOT NULL DEFAULT 0,
    "filesModified" TEXT NOT NULL DEFAULT '[]',
    "keyDecisions" TEXT NOT NULL DEFAULT '[]',
    "pendingIssues" TEXT NOT NULL DEFAULT '[]',
    "progressSnapshot" TEXT NOT NULL,
    "contextSnapshot" TEXT NOT NULL,
    "routingDecision" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PendingWriteback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "agentId" TEXT,
    "sessionId" TEXT,
    "documentId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "steps" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "failedStep" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EmbeddingModelVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modelName" TEXT NOT NULL,
    "versionTag" TEXT NOT NULL,
    "config" TEXT NOT NULL DEFAULT '{}',
    "activeSince" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deprecatedAt" DATETIME
);

-- CreateTable
CREATE TABLE "EvalCase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "question" TEXT NOT NULL,
    "expectedAnswer" TEXT NOT NULL,
    "expectedEntities" TEXT NOT NULL DEFAULT '[]',
    "category" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL DEFAULT 'medium',
    "source" TEXT NOT NULL DEFAULT 'llm_generated',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "EvalResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "retrievedChunks" INTEGER NOT NULL DEFAULT 0,
    "expectedEntitiesInAnswer" INTEGER NOT NULL DEFAULT 0,
    "expectedEntitiesRetrieved" INTEGER NOT NULL DEFAULT 0,
    "recallAt5" REAL NOT NULL DEFAULT 0,
    "faithfulnessMedian" REAL NOT NULL DEFAULT 0,
    "faithfulnessScores" TEXT NOT NULL DEFAULT '[]',
    "extractionF1" REAL NOT NULL DEFAULT 0,
    "hallucinationDetected" BOOLEAN NOT NULL DEFAULT false,
    "coverage" REAL NOT NULL DEFAULT 0,
    "answered" BOOLEAN NOT NULL DEFAULT false,
    "rawConfidence" REAL NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "ndcgAt5" REAL NOT NULL DEFAULT 0,
    "mrr" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "EvalRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'running',
    "caseCount" INTEGER NOT NULL DEFAULT 0,
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "avgRecallAt5" REAL NOT NULL DEFAULT 0,
    "avgFaithfulness" REAL NOT NULL DEFAULT 0,
    "avgCoverage" REAL NOT NULL DEFAULT 0,
    "avgCondFaithfulness" REAL NOT NULL DEFAULT 0,
    "answeredCount" INTEGER NOT NULL DEFAULT 0,
    "refusalCount" INTEGER NOT NULL DEFAULT 0,
    "avgF1" REAL NOT NULL DEFAULT 0,
    "avgLatencyMs" INTEGER NOT NULL DEFAULT 0,
    "hallucinationCount" INTEGER NOT NULL DEFAULT 0,
    "avgNdcg" REAL NOT NULL DEFAULT 0,
    "avgMrr" REAL NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "CalibrationModel" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "intercept" REAL NOT NULL DEFAULT 0,
    "coef" REAL NOT NULL DEFAULT 1,
    "trainedAt" DATETIME NOT NULL,
    "sampleSize" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "CalibrationModelV2" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "featureNames" TEXT NOT NULL,
    "means" TEXT NOT NULL,
    "stds" TEXT NOT NULL,
    "coefficients" TEXT NOT NULL,
    "intercept" REAL NOT NULL,
    "oddsRatios" TEXT NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "cvBrier" REAL,
    "cvBrierCi" TEXT,
    "brierV1" REAL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "trainedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DigestGateEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "coverage" REAL,
    "rougeRecall" REAL,
    "method" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RedTeamCase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "question" TEXT NOT NULL,
    "attackVector" TEXT NOT NULL,
    "generationNote" TEXT NOT NULL DEFAULT '',
    "origin" TEXT NOT NULL DEFAULT 'generated',
    "generatedBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "breachCount" INTEGER NOT NULL DEFAULT 0,
    "lastBreachAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RedTeamRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'running',
    "caseCount" INTEGER NOT NULL DEFAULT 0,
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "breachCount" INTEGER NOT NULL DEFAULT 0,
    "defendedCount" INTEGER NOT NULL DEFAULT 0,
    "breachesByVector" TEXT NOT NULL DEFAULT '{}',
    "avgLatencyMs" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "RedTeamResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "breached" BOOLEAN NOT NULL DEFAULT false,
    "attackVerdict" TEXT NOT NULL DEFAULT '{}',
    "defenseVerdict" TEXT NOT NULL DEFAULT '{}',
    "retrievedChunks" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "DeletedSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "deletedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ToolAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentKey" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SkillAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentKey" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ToolConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "toolName" TEXT NOT NULL,
    "description" TEXT,
    "updatedBy" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EpisodeRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "contextSummary" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "confidence" REAL NOT NULL DEFAULT 0.5,
    "agent" TEXT NOT NULL,
    "sessionId" TEXT,
    "importance" REAL NOT NULL DEFAULT 0.8,
    "accessCount" INTEGER NOT NULL DEFAULT 0,
    "cycles" INTEGER,
    "tokensUsed" INTEGER,
    "toolCalls" INTEGER,
    "toolFailures" INTEGER,
    "stopReason" TEXT,
    "actionsJson" TEXT,
    "errorsJson" TEXT,
    "lessonsJson" TEXT,
    "embeddingId" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "LessonRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "statement" TEXT NOT NULL,
    "triggerCondition" TEXT,
    "rootCause" TEXT,
    "appliesTo" TEXT,
    "source" TEXT NOT NULL DEFAULT 'SELF_DERIVED',
    "confidence" REAL NOT NULL DEFAULT 0.6,
    "timesApplied" INTEGER NOT NULL DEFAULT 0,
    "timesValidated" INTEGER NOT NULL DEFAULT 0,
    "timesFailed" INTEGER NOT NULL DEFAULT 0,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "embeddingId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "self_direction_proposals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'improvement',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "problem" TEXT NOT NULL,
    "solution" TEXT NOT NULL,
    "implementation" TEXT NOT NULL,
    "scheduleAt" DATETIME,
    "impact" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "source" TEXT NOT NULL DEFAULT 'scan',
    "executionMode" TEXT NOT NULL DEFAULT 'llm',
    "createdBy" TEXT NOT NULL DEFAULT 'self-direction-scan',
    "automationJson" TEXT,
    "userNotes" TEXT,
    "reviewer" TEXT,
    "decisionReason" TEXT,
    "reviewedAt" DATETIME,
    "planSummary" TEXT,
    "omegaReport" TEXT,
    "executedAt" DATETIME,
    "completedAt" DATETIME,
    "opusFollowUpAt" DATETIME,
    "opusFollowUpResult" TEXT,
    "followUpParentId" TEXT,
    "followUpDepth" INTEGER NOT NULL DEFAULT 0,
    "reviewEdits" JSONB,
    "replanHistory" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "proposal_steps" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "proposalId" TEXT NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "assignee" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "output" TEXT,
    "evaluation" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "workspaceReceipt" JSONB,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "proposal_steps_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "self_direction_proposals" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "self_direction_settings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "opusDelegated" BOOLEAN NOT NULL DEFAULT false,
    "delegatedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TaskContextArchive" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT,
    "sessionId" TEXT,
    "agentName" TEXT,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tags" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "OpusReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "runRef" TEXT,
    "messageId" TEXT,
    "decision" TEXT NOT NULL,
    "verdict" TEXT,
    "triggerMode" TEXT NOT NULL DEFAULT 'manual',
    "model" TEXT,
    "tokensUsed" INTEGER,
    "durationMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "IssueLedger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "runRef" TEXT,
    "opusReviewId" TEXT,
    "title" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "evidence" TEXT,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "resolvedBy" TEXT
);

-- CreateTable
CREATE TABLE "opus_settings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "killed" BOOLEAN NOT NULL DEFAULT false,
    "killedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GoalLoopJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "messageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "input" TEXT NOT NULL,
    "cyclesDone" INTEGER NOT NULL DEFAULT 0,
    "checkpoint" TEXT,
    "result" TEXT,
    "stopReason" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "cancelRequestedAt" DATETIME,
    "heartbeatAt" DATETIME,
    "workerPid" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ResearchMission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "request" TEXT NOT NULL,
    "missionType" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "confidenceJson" TEXT NOT NULL DEFAULT '{}',
    "decisionLogJson" TEXT NOT NULL DEFAULT '[]',
    "changelogJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ResearchTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "missionId" TEXT NOT NULL,
    "partIdx" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "taskMdPath" TEXT NOT NULL,
    "successCriteriaJson" TEXT NOT NULL DEFAULT '[]',
    "assignedGroup" TEXT,
    "status" TEXT NOT NULL,
    "amendmentsJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ResearchTask_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "ResearchMission" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResearchWorklog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "entryJson" TEXT NOT NULL,
    "evidenceJson" TEXT NOT NULL DEFAULT '[]',
    "artifactMapJson" TEXT,
    "modelSwitchedJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResearchWorklog_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ResearchTask" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ResearchWorklog_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "ResearchMission" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResearchKBEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sourceMission" TEXT,
    "phase" INTEGER NOT NULL DEFAULT 1,
    "snapshotMdPath" TEXT,
    "retiredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ResearchProposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "schemaJson" TEXT NOT NULL,
    "branchName" TEXT,
    "diffSummary" TEXT,
    "reviewedBy" TEXT,
    "timeoutAt" DATETIME,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ResearchProposal_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "ResearchMission" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ModelSwitchEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "fromModel" TEXT NOT NULL,
    "toModel" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "nextCheck" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CouncilTranscript" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "missionId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "kind" INTEGER NOT NULL,
    "verdict" TEXT NOT NULL,
    "blocking" BOOLEAN NOT NULL DEFAULT true,
    "transcript" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "HypothesisRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "missionId" TEXT NOT NULL,
    "problemStmt" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "scoreAJson" TEXT NOT NULL DEFAULT '{}',
    "killCriteria" TEXT,
    "killTestResult" TEXT,
    "status" TEXT NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ExperimentRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "missionId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "hypothesisRef" TEXT,
    "specPath" TEXT,
    "branchName" TEXT,
    "scoreExpected" TEXT NOT NULL DEFAULT '{}',
    "scoreMeasured" TEXT,
    "deltaJson" TEXT,
    "metricsJson" TEXT,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "StructuredHypothesis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "agentName" TEXT,
    "sourceRunId" TEXT,
    "contextSig" TEXT NOT NULL,
    "intervention" TEXT NOT NULL,
    "predictedDelta" TEXT NOT NULL,
    "mechanicsClaim" TEXT NOT NULL,
    "alpha" INTEGER NOT NULL DEFAULT 0,
    "beta" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "pendingJudgment" TEXT,
    "cotRef" TEXT,
    "sourceCycle" INTEGER,
    "lastRenderedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CotSample" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "agentName" TEXT,
    "contextSig" TEXT NOT NULL,
    "mechanics" TEXT NOT NULL,
    "conclusion" TEXT NOT NULL,
    "sampleText" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "parentRef" TEXT,
    "posterior" REAL NOT NULL DEFAULT 0.5,
    "drifted" BOOLEAN NOT NULL DEFAULT false,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "lastRetrievedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RunContext" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "dataScope" TEXT,
    "goalDigest" TEXT,
    "contextKeywords" TEXT,
    "acceptanceCriteria" TEXT,
    "uncertainItems" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "QEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stateKey" TEXT NOT NULL,
    "actionKey" TEXT NOT NULL,
    "qValue" REAL NOT NULL DEFAULT 0,
    "visits" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TuningParam" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TuningChangeLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromStoreValue" TEXT,
    "toStoreValue" TEXT,
    "fromEffectiveValue" TEXT NOT NULL,
    "toEffectiveValue" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "JobQueue_status_priority_idx" ON "JobQueue"("status", "priority");

-- CreateIndex
CREATE INDEX "JobQueue_type_status_idx" ON "JobQueue"("type", "status");

-- CreateIndex
CREATE INDEX "JobQueue_documentId_idx" ON "JobQueue"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "DailyTokenUsage_date_key" ON "DailyTokenUsage"("date");

-- CreateIndex
CREATE INDEX "DailyTokenUsage_date_idx" ON "DailyTokenUsage"("date");

-- CreateIndex
CREATE INDEX "DailyTokenByProvider_date_idx" ON "DailyTokenByProvider"("date");

-- CreateIndex
CREATE UNIQUE INDEX "DailyTokenByProvider_date_provider_key" ON "DailyTokenByProvider"("date", "provider");

-- CreateIndex
CREATE INDEX "DailyTokenByProviderSlot_date_idx" ON "DailyTokenByProviderSlot"("date");

-- CreateIndex
CREATE UNIQUE INDEX "DailyTokenByProviderSlot_date_provider_slot_key" ON "DailyTokenByProviderSlot"("date", "provider", "slot");

-- CreateIndex
CREATE INDEX "DailyTokenByProviderModel_date_idx" ON "DailyTokenByProviderModel"("date");

-- CreateIndex
CREATE UNIQUE INDEX "DailyTokenByProviderModel_date_provider_model_key" ON "DailyTokenByProviderModel"("date", "provider", "model");

-- CreateIndex
CREATE INDEX "DailyTokenByAgent_date_idx" ON "DailyTokenByAgent"("date");

-- CreateIndex
CREATE INDEX "DailyTokenByAgent_agentId_idx" ON "DailyTokenByAgent"("agentId");

-- CreateIndex
CREATE INDEX "DailyTokenByAgent_date_agentId_idx" ON "DailyTokenByAgent"("date", "agentId");

-- CreateIndex
CREATE UNIQUE INDEX "DailyTokenByAgent_date_agentId_provider_model_key" ON "DailyTokenByAgent"("date", "agentId", "provider", "model");

-- CreateIndex
CREATE UNIQUE INDEX "Document_title_key" ON "Document"("title");

-- CreateIndex
CREATE INDEX "Document_status_idx" ON "Document"("status");

-- CreateIndex
CREATE INDEX "Document_domain_idx" ON "Document"("domain");

-- CreateIndex
CREATE INDEX "Document_createdAt_idx" ON "Document"("createdAt");

-- CreateIndex
CREATE INDEX "Document_userPaused_idx" ON "Document"("userPaused");

-- CreateIndex
CREATE INDEX "Document_contentHash_idx" ON "Document"("contentHash");

-- CreateIndex
CREATE INDEX "LocalEntity_documentId_idx" ON "LocalEntity"("documentId");

-- CreateIndex
CREATE INDEX "LocalEntity_entityName_idx" ON "LocalEntity"("entityName");

-- CreateIndex
CREATE INDEX "LocalEntity_entityType_idx" ON "LocalEntity"("entityType");

-- CreateIndex
CREATE INDEX "LocalEntity_domain_idx" ON "LocalEntity"("domain");

-- CreateIndex
CREATE INDEX "LocalEntity_synced_idx" ON "LocalEntity"("synced");

-- CreateIndex
CREATE INDEX "LocalRelationship_documentId_idx" ON "LocalRelationship"("documentId");

-- CreateIndex
CREATE INDEX "LocalRelationship_relationshipType_idx" ON "LocalRelationship"("relationshipType");

-- CreateIndex
CREATE INDEX "LocalRelationship_sourceEntityId_idx" ON "LocalRelationship"("sourceEntityId");

-- CreateIndex
CREATE INDEX "LocalRelationship_targetEntityId_idx" ON "LocalRelationship"("targetEntityId");

-- CreateIndex
CREATE INDEX "LocalRelationship_synced_idx" ON "LocalRelationship"("synced");

-- CreateIndex
CREATE UNIQUE INDEX "AgentProfile_name_key" ON "AgentProfile"("name");

-- CreateIndex
CREATE INDEX "AgentProfile_team_idx" ON "AgentProfile"("team");

-- CreateIndex
CREATE INDEX "AgentProfile_provider_idx" ON "AgentProfile"("provider");

-- CreateIndex
CREATE INDEX "AgentProfile_enabled_idx" ON "AgentProfile"("enabled");

-- CreateIndex
CREATE INDEX "AgentProfile_isSystem_idx" ON "AgentProfile"("isSystem");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSession_sessionId_key" ON "AgentSession"("sessionId");

-- CreateIndex
CREATE INDEX "AgentSession_agentId_idx" ON "AgentSession"("agentId");

-- CreateIndex
CREATE INDEX "AgentSession_agentProfileId_idx" ON "AgentSession"("agentProfileId");

-- CreateIndex
CREATE INDEX "AgentSession_teamName_idx" ON "AgentSession"("teamName");

-- CreateIndex
CREATE INDEX "AgentSession_createdAt_idx" ON "AgentSession"("createdAt");

-- CreateIndex
CREATE INDEX "LearningLog_agentId_idx" ON "LearningLog"("agentId");

-- CreateIndex
CREATE INDEX "LearningLog_eventType_idx" ON "LearningLog"("eventType");

-- CreateIndex
CREATE INDEX "LearningLog_createdAt_idx" ON "LearningLog"("createdAt");

-- CreateIndex
CREATE INDEX "AgentInsight_agentId_idx" ON "AgentInsight"("agentId");

-- CreateIndex
CREATE INDEX "AgentInsight_type_idx" ON "AgentInsight"("type");

-- CreateIndex
CREATE INDEX "AgentInsight_createdAt_idx" ON "AgentInsight"("createdAt");

-- CreateIndex
CREATE INDEX "AgentCorrection_agentId_idx" ON "AgentCorrection"("agentId");

-- CreateIndex
CREATE INDEX "AgentCorrection_applied_idx" ON "AgentCorrection"("applied");

-- CreateIndex
CREATE UNIQUE INDEX "AgentPreference_agentId_preferenceKey_key" ON "AgentPreference"("agentId", "preferenceKey");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSkill_agentId_slug_key" ON "AgentSkill"("agentId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "CustomTool_name_key" ON "CustomTool"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ToolPermission_agentId_toolName_key" ON "ToolPermission"("agentId", "toolName");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeAccessPolicy_agentId_key" ON "KnowledgeAccessPolicy"("agentId");

-- CreateIndex
CREATE INDEX "CronJob_agentId_idx" ON "CronJob"("agentId");

-- CreateIndex
CREATE INDEX "CronJob_enabled_idx" ON "CronJob"("enabled");

-- CreateIndex
CREATE INDEX "CronJob_status_idx" ON "CronJob"("status");

-- CreateIndex
CREATE INDEX "CronJob_nextRunAt_idx" ON "CronJob"("nextRunAt");

-- CreateIndex
CREATE INDEX "CronJob_jobHash_idx" ON "CronJob"("jobHash");

-- CreateIndex
CREATE INDEX "pending_edits_sessionId_idx" ON "pending_edits"("sessionId");

-- CreateIndex
CREATE INDEX "pending_edits_status_idx" ON "pending_edits"("status");

-- CreateIndex
CREATE INDEX "neo4j_checkpoint_diffs_sessionId_idx" ON "neo4j_checkpoint_diffs"("sessionId");

-- CreateIndex
CREATE INDEX "neo4j_checkpoint_diffs_createdAt_idx" ON "neo4j_checkpoint_diffs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_rootPath_key" ON "Workspace"("rootPath");

-- CreateIndex
CREATE INDEX "Workspace_isActive_idx" ON "Workspace"("isActive");

-- CreateIndex
CREATE INDEX "FsCheckpoint_sessionId_idx" ON "FsCheckpoint"("sessionId");

-- CreateIndex
CREATE INDEX "FsCheckpoint_workspaceId_idx" ON "FsCheckpoint"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentModelOverride_agentName_key" ON "AgentModelOverride"("agentName");

-- CreateIndex
CREATE INDEX "Webhook_agentId_idx" ON "Webhook"("agentId");

-- CreateIndex
CREATE INDEX "StandingOrder_agentId_idx" ON "StandingOrder"("agentId");

-- CreateIndex
CREATE INDEX "TaskFlow_enabled_idx" ON "TaskFlow"("enabled");

-- CreateIndex
CREATE INDEX "TaskFlow_nextRunAt_idx" ON "TaskFlow"("nextRunAt");

-- CreateIndex
CREATE INDEX "TaskExecution_type_idx" ON "TaskExecution"("type");

-- CreateIndex
CREATE INDEX "TaskExecution_status_idx" ON "TaskExecution"("status");

-- CreateIndex
CREATE INDEX "TaskExecution_startedAt_idx" ON "TaskExecution"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelConfig_channelType_key" ON "ChannelConfig"("channelType");

-- CreateIndex
CREATE UNIQUE INDEX "LocalResolvedEntity_canonicalName_key" ON "LocalResolvedEntity"("canonicalName");

-- CreateIndex
CREATE INDEX "LocalResolvedEntity_documentId_idx" ON "LocalResolvedEntity"("documentId");

-- CreateIndex
CREATE INDEX "LocalResolvedEntity_synced_idx" ON "LocalResolvedEntity"("synced");

-- CreateIndex
CREATE UNIQUE INDEX "OpenCodeSession_sessionId_key" ON "OpenCodeSession"("sessionId");

-- CreateIndex
CREATE INDEX "OpenCodeSession_status_idx" ON "OpenCodeSession"("status");

-- CreateIndex
CREATE INDEX "OpenCodeSession_createdAt_idx" ON "OpenCodeSession"("createdAt");

-- CreateIndex
CREATE INDEX "MCPBridgeConfig_direction_idx" ON "MCPBridgeConfig"("direction");

-- CreateIndex
CREATE UNIQUE INDEX "MCPBridgeConfig_direction_toolName_key" ON "MCPBridgeConfig"("direction", "toolName");

-- CreateIndex
CREATE INDEX "AutoLearnRecord_agentId_idx" ON "AutoLearnRecord"("agentId");

-- CreateIndex
CREATE INDEX "AutoLearnRecord_createdAt_idx" ON "AutoLearnRecord"("createdAt");

-- CreateIndex
CREATE INDEX "AutoLearnRecord_confidence_idx" ON "AutoLearnRecord"("confidence");

-- CreateIndex
CREATE INDEX "AutoLearnRecord_status_idx" ON "AutoLearnRecord"("status");

-- CreateIndex
CREATE INDEX "EmbeddingCache_expiresAt_idx" ON "EmbeddingCache"("expiresAt");

-- CreateIndex
CREATE INDEX "EmbeddingCache_lastHitAt_idx" ON "EmbeddingCache"("lastHitAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmbeddingCache_hash_inputType_key" ON "EmbeddingCache"("hash", "inputType");

-- CreateIndex
CREATE INDEX "CodeTeamWorklog_sessionId_idx" ON "CodeTeamWorklog"("sessionId");

-- CreateIndex
CREATE INDEX "CodeTeamWorklog_agentName_idx" ON "CodeTeamWorklog"("agentName");

-- CreateIndex
CREATE INDEX "CodeTeamWorklog_sessionId_position_idx" ON "CodeTeamWorklog"("sessionId", "position");

-- CreateIndex
CREATE INDEX "CodeTeamWorklog_createdAt_idx" ON "CodeTeamWorklog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CodeTeamSession_sessionId_key" ON "CodeTeamSession"("sessionId");

-- CreateIndex
CREATE INDEX "CodeTeamSession_sessionId_idx" ON "CodeTeamSession"("sessionId");

-- CreateIndex
CREATE INDEX "CodeTeamSession_currentStep_idx" ON "CodeTeamSession"("currentStep");

-- CreateIndex
CREATE INDEX "CodeTeamSession_createdAt_idx" ON "CodeTeamSession"("createdAt");

-- CreateIndex
CREATE INDEX "ChatMessage_sessionId_idx" ON "ChatMessage"("sessionId");

-- CreateIndex
CREATE INDEX "ChatMessage_role_idx" ON "ChatMessage"("role");

-- CreateIndex
CREATE INDEX "ChatMessage_createdAt_idx" ON "ChatMessage"("createdAt");

-- CreateIndex
CREATE INDEX "ChatAttachment_sessionId_idx" ON "ChatAttachment"("sessionId");

-- CreateIndex
CREATE INDEX "ChatAttachment_createdAt_idx" ON "ChatAttachment"("createdAt");

-- CreateIndex
CREATE INDEX "SmolabTask_sessionId_idx" ON "SmolabTask"("sessionId");

-- CreateIndex
CREATE INDEX "SmolabTask_agentProfileId_status_idx" ON "SmolabTask"("agentProfileId", "status");

-- CreateIndex
CREATE INDEX "SmolabTask_teamName_status_idx" ON "SmolabTask"("teamName", "status");

-- CreateIndex
CREATE INDEX "SmolabTask_status_idx" ON "SmolabTask"("status");

-- CreateIndex
CREATE INDEX "SmolabTask_createdAt_idx" ON "SmolabTask"("createdAt");

-- CreateIndex
CREATE INDEX "AgentMemory_agentId_idx" ON "AgentMemory"("agentId");

-- CreateIndex
CREATE INDEX "AgentMemory_category_idx" ON "AgentMemory"("category");

-- CreateIndex
CREATE INDEX "AgentMemory_importance_idx" ON "AgentMemory"("importance");

-- CreateIndex
CREATE INDEX "AgentMemory_accessCount_idx" ON "AgentMemory"("accessCount");

-- CreateIndex
CREATE INDEX "AgentMemory_isActive_idx" ON "AgentMemory"("isActive");

-- CreateIndex
CREATE INDEX "AgentMemory_createdAt_idx" ON "AgentMemory"("createdAt");

-- CreateIndex
CREATE INDEX "AgentMemory_lastAccessedAt_idx" ON "AgentMemory"("lastAccessedAt");

-- CreateIndex
CREATE INDEX "AgentMemory_domain_idx" ON "AgentMemory"("domain");

-- CreateIndex
CREATE INDEX "AgentMemory_tier_idx" ON "AgentMemory"("tier");

-- CreateIndex
CREATE INDEX "WorkingMemory_agentId_sessionId_idx" ON "WorkingMemory"("agentId", "sessionId");

-- CreateIndex
CREATE INDEX "WorkingMemory_expiresAt_idx" ON "WorkingMemory"("expiresAt");

-- CreateIndex
CREATE INDEX "WorkingMemory_createdAt_idx" ON "WorkingMemory"("createdAt");

-- CreateIndex
CREATE INDEX "MemoryArchive_agentId_idx" ON "MemoryArchive"("agentId");

-- CreateIndex
CREATE INDEX "MemoryArchive_expiresAt_idx" ON "MemoryArchive"("expiresAt");

-- CreateIndex
CREATE INDEX "MemoryArchive_domain_idx" ON "MemoryArchive"("domain");

-- CreateIndex
CREATE INDEX "MemoryArchive_importance_idx" ON "MemoryArchive"("importance");

-- CreateIndex
CREATE INDEX "UserProfile_userId_idx" ON "UserProfile"("userId");

-- CreateIndex
CREATE INDEX "UserProfile_key_idx" ON "UserProfile"("key");

-- CreateIndex
CREATE INDEX "UserProfile_isActive_idx" ON "UserProfile"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_userId_key_key" ON "UserProfile"("userId", "key");

-- CreateIndex
CREATE INDEX "MemoryAccessLog_memoryId_idx" ON "MemoryAccessLog"("memoryId");

-- CreateIndex
CREATE INDEX "MemoryAccessLog_agentId_idx" ON "MemoryAccessLog"("agentId");

-- CreateIndex
CREATE INDEX "MemoryAccessLog_createdAt_idx" ON "MemoryAccessLog"("createdAt");

-- CreateIndex
CREATE INDEX "Todo_sessionId_idx" ON "Todo"("sessionId");

-- CreateIndex
CREATE INDEX "Todo_sessionId_agentRole_idx" ON "Todo"("sessionId", "agentRole");

-- CreateIndex
CREATE INDEX "Todo_sessionId_runId_idx" ON "Todo"("sessionId", "runId");

-- CreateIndex
CREATE INDEX "Todo_parentId_idx" ON "Todo"("parentId");

-- CreateIndex
CREATE INDEX "Todo_idempotencyKey_idx" ON "Todo"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AgentWorkData_sessionId_status_idx" ON "AgentWorkData"("sessionId", "status");

-- CreateIndex
CREATE INDEX "AgentWorkData_status_expiresAt_idx" ON "AgentWorkData"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "AgentWorkData_runId_idx" ON "AgentWorkData"("runId");

-- CreateIndex
CREATE INDEX "ToolMetric_toolName_idx" ON "ToolMetric"("toolName");

-- CreateIndex
CREATE INDEX "ToolMetric_sessionId_idx" ON "ToolMetric"("sessionId");

-- CreateIndex
CREATE INDEX "ToolMetric_timestamp_idx" ON "ToolMetric"("timestamp");

-- CreateIndex
CREATE INDEX "ToolMetric_success_idx" ON "ToolMetric"("success");

-- CreateIndex
CREATE INDEX "ToolMetricDaily_toolName_date_idx" ON "ToolMetricDaily"("toolName", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ToolMetricDaily_date_toolName_agentRole_key" ON "ToolMetricDaily"("date", "toolName", "agentRole");

-- CreateIndex
CREATE INDEX "MetricAnomaly_kind_observedAt_idx" ON "MetricAnomaly"("kind", "observedAt");

-- CreateIndex
CREATE INDEX "MetricAnomaly_toolName_observedAt_idx" ON "MetricAnomaly"("toolName", "observedAt");

-- CreateIndex
CREATE INDEX "KpiSnapshot_kpi_date_idx" ON "KpiSnapshot"("kpi", "date");

-- CreateIndex
CREATE UNIQUE INDEX "KpiSnapshot_date_kpi_key" ON "KpiSnapshot"("date", "kpi");

-- CreateIndex
CREATE INDEX "AgentRunRecord_sessionId_createdAt_idx" ON "AgentRunRecord"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRunRecord_createdAt_idx" ON "AgentRunRecord"("createdAt");

-- CreateIndex
CREATE INDEX "AgentRunRecord_stopReason_idx" ON "AgentRunRecord"("stopReason");

-- CreateIndex
CREATE INDEX "AgentRunRecord_runId_idx" ON "AgentRunRecord"("runId");

-- CreateIndex
CREATE INDEX "AgentRunRecord_parentRunId_idx" ON "AgentRunRecord"("parentRunId");

-- CreateIndex
CREATE INDEX "ArbiterVerdict_sessionId_createdAt_idx" ON "ArbiterVerdict"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "ArbiterVerdict_outcome_idx" ON "ArbiterVerdict"("outcome");

-- CreateIndex
CREATE INDEX "ArbiterVerdict_confidence_idx" ON "ArbiterVerdict"("confidence");

-- CreateIndex
CREATE INDEX "WorkflowSession_status_updatedAt_idx" ON "WorkflowSession"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "ExecutionMetrics_sessionId_idx" ON "ExecutionMetrics"("sessionId");

-- CreateIndex
CREATE INDEX "ExecutionMetrics_routingMode_idx" ON "ExecutionMetrics"("routingMode");

-- CreateIndex
CREATE INDEX "ExecutionMetrics_createdAt_idx" ON "ExecutionMetrics"("createdAt");

-- CreateIndex
CREATE INDEX "FailurePattern_sessionId_idx" ON "FailurePattern"("sessionId");

-- CreateIndex
CREATE INDEX "FailurePattern_type_idx" ON "FailurePattern"("type");

-- CreateIndex
CREATE INDEX "FailurePattern_resolved_idx" ON "FailurePattern"("resolved");

-- CreateIndex
CREATE INDEX "StrategyAdaptationLog_sessionId_idx" ON "StrategyAdaptationLog"("sessionId");

-- CreateIndex
CREATE INDEX "StrategyAdaptationLog_patternId_idx" ON "StrategyAdaptationLog"("patternId");

-- CreateIndex
CREATE INDEX "StrategyAdaptationLog_createdAt_idx" ON "StrategyAdaptationLog"("createdAt");

-- CreateIndex
CREATE INDEX "StrategyAdaptationLog_toStrategy_idx" ON "StrategyAdaptationLog"("toStrategy");

-- CreateIndex
CREATE INDEX "CodeTeamCheckpoint_sessionId_idx" ON "CodeTeamCheckpoint"("sessionId");

-- CreateIndex
CREATE INDEX "CodeTeamCheckpoint_createdAt_idx" ON "CodeTeamCheckpoint"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PendingWriteback_batchId_key" ON "PendingWriteback"("batchId");

-- CreateIndex
CREATE INDEX "PendingWriteback_status_idx" ON "PendingWriteback"("status");

-- CreateIndex
CREATE INDEX "PendingWriteback_agentId_idx" ON "PendingWriteback"("agentId");

-- CreateIndex
CREATE INDEX "EmbeddingModelVersion_modelName_idx" ON "EmbeddingModelVersion"("modelName");

-- CreateIndex
CREATE UNIQUE INDEX "EmbeddingModelVersion_modelName_versionTag_key" ON "EmbeddingModelVersion"("modelName", "versionTag");

-- CreateIndex
CREATE INDEX "EvalCase_category_active_idx" ON "EvalCase"("category", "active");

-- CreateIndex
CREATE INDEX "EvalResult_runId_idx" ON "EvalResult"("runId");

-- CreateIndex
CREATE INDEX "EvalResult_caseId_idx" ON "EvalResult"("caseId");

-- CreateIndex
CREATE INDEX "EvalRun_startedAt_idx" ON "EvalRun"("startedAt");

-- CreateIndex
CREATE INDEX "DigestGateEvent_createdAt_idx" ON "DigestGateEvent"("createdAt");

-- CreateIndex
CREATE INDEX "DigestGateEvent_kind_outcome_idx" ON "DigestGateEvent"("kind", "outcome");

-- CreateIndex
CREATE INDEX "RedTeamCase_attackVector_status_idx" ON "RedTeamCase"("attackVector", "status");

-- CreateIndex
CREATE INDEX "RedTeamCase_origin_idx" ON "RedTeamCase"("origin");

-- CreateIndex
CREATE INDEX "RedTeamRun_startedAt_idx" ON "RedTeamRun"("startedAt");

-- CreateIndex
CREATE INDEX "RedTeamResult_runId_idx" ON "RedTeamResult"("runId");

-- CreateIndex
CREATE INDEX "RedTeamResult_caseId_idx" ON "RedTeamResult"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "DeletedSession_sessionId_key" ON "DeletedSession"("sessionId");

-- CreateIndex
CREATE INDEX "ToolAssignment_agentKey_idx" ON "ToolAssignment"("agentKey");

-- CreateIndex
CREATE UNIQUE INDEX "ToolAssignment_agentKey_toolName_key" ON "ToolAssignment"("agentKey", "toolName");

-- CreateIndex
CREATE INDEX "SkillAssignment_agentKey_idx" ON "SkillAssignment"("agentKey");

-- CreateIndex
CREATE UNIQUE INDEX "SkillAssignment_agentKey_slug_key" ON "SkillAssignment"("agentKey", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "ToolConfig_toolName_key" ON "ToolConfig"("toolName");

-- CreateIndex
CREATE INDEX "EpisodeRecord_agent_idx" ON "EpisodeRecord"("agent");

-- CreateIndex
CREATE INDEX "EpisodeRecord_outcome_idx" ON "EpisodeRecord"("outcome");

-- CreateIndex
CREATE INDEX "EpisodeRecord_createdAt_idx" ON "EpisodeRecord"("createdAt");

-- CreateIndex
CREATE INDEX "LessonRecord_confidence_idx" ON "LessonRecord"("confidence");

-- CreateIndex
CREATE INDEX "LessonRecord_needsReview_idx" ON "LessonRecord"("needsReview");

-- CreateIndex
CREATE INDEX "LessonRecord_rootCause_idx" ON "LessonRecord"("rootCause");

-- CreateIndex
CREATE INDEX "self_direction_proposals_status_idx" ON "self_direction_proposals"("status");

-- CreateIndex
CREATE INDEX "self_direction_proposals_opusFollowUpAt_idx" ON "self_direction_proposals"("opusFollowUpAt");

-- CreateIndex
CREATE INDEX "self_direction_proposals_createdAt_idx" ON "self_direction_proposals"("createdAt");

-- CreateIndex
CREATE INDEX "proposal_steps_proposalId_stepOrder_idx" ON "proposal_steps"("proposalId", "stepOrder");

-- CreateIndex
CREATE INDEX "TaskContextArchive_runId_idx" ON "TaskContextArchive"("runId");

-- CreateIndex
CREATE INDEX "TaskContextArchive_sessionId_createdAt_idx" ON "TaskContextArchive"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "TaskContextArchive_kind_createdAt_idx" ON "TaskContextArchive"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "OpusReview_sessionId_createdAt_idx" ON "OpusReview"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "OpusReview_runRef_idx" ON "OpusReview"("runRef");

-- CreateIndex
CREATE INDEX "OpusReview_decision_idx" ON "OpusReview"("decision");

-- CreateIndex
CREATE INDEX "IssueLedger_sessionId_status_idx" ON "IssueLedger"("sessionId", "status");

-- CreateIndex
CREATE INDEX "IssueLedger_severity_idx" ON "IssueLedger"("severity");

-- CreateIndex
CREATE INDEX "GoalLoopJob_status_createdAt_idx" ON "GoalLoopJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "GoalLoopJob_sessionId_createdAt_idx" ON "GoalLoopJob"("sessionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchMission_code_key" ON "ResearchMission"("code");

-- CreateIndex
CREATE INDEX "ResearchMission_status_createdAt_idx" ON "ResearchMission"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ResearchMission_tier_status_idx" ON "ResearchMission"("tier", "status");

-- CreateIndex
CREATE INDEX "ResearchTask_missionId_partIdx_idx" ON "ResearchTask"("missionId", "partIdx");

-- CreateIndex
CREATE INDEX "ResearchTask_status_idx" ON "ResearchTask"("status");

-- CreateIndex
CREATE INDEX "ResearchWorklog_missionId_createdAt_idx" ON "ResearchWorklog"("missionId", "createdAt");

-- CreateIndex
CREATE INDEX "ResearchWorklog_taskId_createdAt_idx" ON "ResearchWorklog"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "ResearchWorklog_phase_idx" ON "ResearchWorklog"("phase");

-- CreateIndex
CREATE INDEX "ResearchKBEntry_category_phase_idx" ON "ResearchKBEntry"("category", "phase");

-- CreateIndex
CREATE INDEX "ResearchKBEntry_retiredAt_idx" ON "ResearchKBEntry"("retiredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchProposal_code_key" ON "ResearchProposal"("code");

-- CreateIndex
CREATE INDEX "ResearchProposal_missionId_status_idx" ON "ResearchProposal"("missionId", "status");

-- CreateIndex
CREATE INDEX "ResearchProposal_status_timeoutAt_idx" ON "ResearchProposal"("status", "timeoutAt");

-- CreateIndex
CREATE INDEX "ModelSwitchEvent_agentId_at_idx" ON "ModelSwitchEvent"("agentId", "at");

-- CreateIndex
CREATE INDEX "CouncilTranscript_missionId_round_idx" ON "CouncilTranscript"("missionId", "round");

-- CreateIndex
CREATE INDEX "HypothesisRecord_missionId_status_idx" ON "HypothesisRecord"("missionId", "status");

-- CreateIndex
CREATE INDEX "HypothesisRecord_round_idx" ON "HypothesisRecord"("round");

-- CreateIndex
CREATE INDEX "ExperimentRecord_missionId_optionId_idx" ON "ExperimentRecord"("missionId", "optionId");

-- CreateIndex
CREATE INDEX "ExperimentRecord_status_idx" ON "ExperimentRecord"("status");

-- CreateIndex
CREATE INDEX "StructuredHypothesis_sessionId_status_idx" ON "StructuredHypothesis"("sessionId", "status");

-- CreateIndex
CREATE INDEX "StructuredHypothesis_sessionId_contextSig_idx" ON "StructuredHypothesis"("sessionId", "contextSig");

-- CreateIndex
CREATE INDEX "StructuredHypothesis_status_alpha_beta_idx" ON "StructuredHypothesis"("status", "alpha", "beta");

-- CreateIndex
CREATE INDEX "CotSample_sessionId_drifted_idx" ON "CotSample"("sessionId", "drifted");

-- CreateIndex
CREATE INDEX "CotSample_sessionId_posterior_idx" ON "CotSample"("sessionId", "posterior");

-- CreateIndex
CREATE UNIQUE INDEX "RunContext_runId_key" ON "RunContext"("runId");

-- CreateIndex
CREATE INDEX "RunContext_sessionId_idx" ON "RunContext"("sessionId");

-- CreateIndex
CREATE INDEX "QEntry_stateKey_idx" ON "QEntry"("stateKey");

-- CreateIndex
CREATE UNIQUE INDEX "QEntry_stateKey_actionKey_key" ON "QEntry"("stateKey", "actionKey");

-- CreateIndex
CREATE UNIQUE INDEX "TuningParam_key_key" ON "TuningParam"("key");

-- CreateIndex
CREATE INDEX "TuningParam_key_idx" ON "TuningParam"("key");

-- CreateIndex
CREATE INDEX "TuningChangeLog_createdAt_idx" ON "TuningChangeLog"("createdAt");

-- CreateIndex
CREATE INDEX "TuningChangeLog_key_createdAt_idx" ON "TuningChangeLog"("key", "createdAt");

