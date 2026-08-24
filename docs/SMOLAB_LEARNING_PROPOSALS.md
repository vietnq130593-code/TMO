# Smolab & Learning Subsystem — Improvement Proposals & Implementation Plan

> **Scope**: TMO app (`Theopusflashlite`), module **Smolab** (`src/lib/smolab/*`, `src/app/api/smolab/*`) và **Learning subsystem** (Layer 9 — `src/lib/learning/*`, `src/lib/auto-learn.ts`, `src/lib/kb-routing/*`, `src/app/api/openclaw/learning/*`).
> **Source of truth**: Code thực tế trong `/home/z/tmo-app/src` + Prisma schema `prisma/schema.prisma` + `.env` đã cấu hình.
> **Method**: Static analysis bằng `tsc --noEmit` + đọc toàn bộ file liệt kê trong worklog Task ID 3-analysis + ML review (Task ID 5).
> **Companion doc**: `/home/z/tmo-app/docs/SMOLAB_LEARNING_PROPOSALS_ML_REVIEW.md` — review dưới góc nhìn ML engineer (giải thích lý do các ML proposals được thêm vào file này).

---

## Mục lục

- [Tóm tắt kiến trúc hiện tại](#tóm-tắt-kiến-trúc-hiện-tại)
- [Danh sách vấn đề xác định được](#danh-sách-vấn-đề-xác-định-được)
- [Pre-Phase 1 — STOP CONTAMINATION (P0 ML, 1 session)](#pre-phase-1--stop-contamination-p0-ml-1-session)
  - [Proposal P0.1: Loại bỏ pseudo-hash fallback embedding](#proposal-p01-loại-bỏ-pseudo-hash-fallback-embedding)
  - [Proposal P0.2: Auto-learn verification gate (đảo ngược logic)](#proposal-p02-auto-learn-verification-gate-đảo-ngược-logic)
  - [Proposal P0.3: Proper chunking strategy (recursive 400+50)](#proposal-p03-proper-chunking-strategy-recursive-40050)
  - [Proposal P0.4: Cache key normalization](#proposal-p04-cache-key-normalization)
- [Phase 1 — STABILIZE (P0 engineering, 1-2 sessions)](#phase-1--stabilize-p0-engineering-1-2-sessions)
  - [Proposal 1: Sửa NVIDIA embedding dimension mismatch](#proposal-1-sửa-nvidia-embedding-dimension-mismatch)
  - [Proposal 2: Thêm 3 Prisma models còn thiếu cho Layer 9](#proposal-2-thêm-3-prisma-models-còn-thiếu-cho-layer-9)
  - [Proposal 3: Sửa writeback.ts Neo4j signatures + ChunkPayload](#proposal-3-sửa-writebackts-neo4j-signatures--chunkpayload)
  - [Proposal 4: Sửa kb-access.ts QdrantClient.search()](#proposal-4-sửa-kb-accessts-qdrantclientsearch)
  - [Proposal 5: Wire `runSmartKB` orchestrator vào `/api/openclaw/chat`](#proposal-5-wire-runtsmartkb-orchestrator-vào-apiopenclawchat)
- [Phase 2 — STRENGTHEN + STOP CONTAMINATION (P1, 2-3 sessions)](#phase-2--strengthen--stop-contamination-p1-2-3-sessions)
  - [Proposal 6: Atomic multi-store writeback transaction](#proposal-6-atomic-multi-store-writeback-transaction)
  - [Proposal 7: Hook Layer 9 vào code-team workflow](#proposal-7-hook-layer-9-vào-code-team-workflow)
  - [Proposal 8: Learning metrics dashboard](#proposal-8-learning-metrics-dashboard)
  - [Proposal 2.5: Embedding-based entity resolution](#proposal-25-embedding-based-entity-resolution)
  - [Proposal 4.4: Cold start mode (no auto-learn first N queries)](#proposal-44-cold-start-mode-no-auto-learn-first-n-queries)
- [Phase 3 — SCALE + OBSERVABILITY (P1-P2, 2-3 sessions)](#phase-3--scale--observability-p1-p2-2-3-sessions)
  - [Proposal 9: Durable SQLite-backed Smolab task queue](#proposal-9-durable-sqlite-backed-smolab-task-queue)
  - [Proposal 10: Supabase backup cho learning tables](#proposal-10-supabase-backup-cho-learning-tables)
  - [Proposal 10.5: Full backup Qdrant snapshot + Neo4j dump → R2](#proposal-105-full-backup-qdrant-snapshot--neo4j-dump--r2)
  - [Proposal 4.1: Embedding model versioning](#proposal-41-embedding-model-versioning)
- [Phase 4 — ML QUALITY (P2, 3-5 sessions)](#phase-4--ml-quality-p2-3-5-sessions)
  - [Proposal 11': Eval harness với cross-model judge (REPLACES Proposal 11)](#proposal-11-eval-harness-với-cross-model-judge-replaces-proposal-11)
  - [Proposal 3.5: Confidence calibration](#proposal-35-confidence-calibration)
  - [Proposal 3.6: 2-stage retrieval (bi-encoder + cross-encoder rerank)](#proposal-36-2-stage-retrieval-bi-encoder--cross-encoder-rerank)
  - [Proposal 3.7: Hybrid search (BM25 + dense, RRF fusion)](#proposal-37-hybrid-search-bm25--dense-rrf-fusion)
  - [Proposal 3.8: MMR diversity trong top-K](#proposal-38-mmr-diversity-trong-top-k)
  - [Proposal 3.9: Query rewriting + HyDE](#proposal-39-query-rewriting--hyde)
  - [Proposal 3.10: Memory decay algorithm](#proposal-310-memory-decay-algorithm)
  - [Proposal 3.11: Semantic graph search](#proposal-311-semantic-graph-search)
- [Phase 5 — ADVANCED ML (P3, 2-4 sessions)](#phase-5--advanced-ml-p3-2-4-sessions)
  - [Proposal 5.1: Concept drift detection](#proposal-51-concept-drift-detection)
  - [Proposal 5.2: Hard negative mining cho entity threshold](#proposal-52-hard-negative-mining-cho-entity-threshold)
- [Bảng tổng hợp — tất cả proposals](#bảng-tổng-hợp--tất-cả-proposals)
- [Tiêu chí thành công (Definition of Done) cho từng Phase](#tiêu-chí-thành-công-definition-of-done-cho-từng-phase)
- [Verification checklist dùng được ngay](#verification-checklist-dùng-được-ngay)

---

## Tóm tắt kiến trúc hiện tại

Hệ TMO gồm **3 sub-system liên quan đến learning**, chạy trong cùng process Next.js (PM2 `theopusflashlite`):

| Sub-system | Vai trò | Files chính | Trigger Learning? |
|---|---|---|---|
| **Smolab** | Background task scheduler in-process (singleton via `globalThis.smolabWorker`, max 3 concurrent) | `src/lib/smolab/{background-task-worker,session-manager}.ts`, `src/app/api/smolab/*` | ❌ KHÔNG — chỉ điều phối chat task |
| **OpenClaw** | Agent chat + learning API surface (intent → writeback → auto-learn → memory) | `src/app/api/openclaw/*`, `src/lib/{auto-learn,kb-routing,openclaw}.ts` | ✅ ĐÂY là nơi learning thực sự chạy |
| **OpenCode** | Code execution backend (Bun mini-service, port 18790) | `mini-services/opencode-server/*`, `src/lib/opencode.ts` | ❌ Không liên quan |

**Layer 9** trong tài liệu `docs/fullstack-agent-architecture-v2.md` là "Learning & Adaptation" — gồm 3 sub-module:
- **9.1a** Metrics Collector: thu real-time metrics trong workflow (`src/lib/learning/metrics-collector.ts`, 153 dòng)
- **9.1b** Historical Feedback: phân tích `ExecutionMetrics` quá khứ → `AggregatedMetrics` (`src/lib/learning/historical-feedback.ts`, 136 dòng)
- **9.2** Strategy Adapter: detect failure pattern → recommend adaptation (`src/lib/learning/strategy-adapter.ts`, 284 dòng)

**2 vấn đề cốt lõi** (engineering + ML):

1. **Engineering**: Layer 9 đã code đầy đủ NHƯNG trỏ tới 3 Prisma models không tồn tại → mọi lời gọi `db.executionMetrics`/`db.failurePattern`/`db.strategyAdaptationLog` đều throw `TypeError` runtime → bị catch và nuốt error im lặng → hệ "có vẻ chạy" nhưng không học gì cả.

2. **ML** (theo ML review Task ID 5): Ngay cả khi engineering fix xong, hệ thống vẫn có **4 critical ML issues**:
   - Pseudo-hash fallback embedding → silent garbage vector trong Qdrant
   - Auto-learn gate đang **NGƯỢC** (LEARN unverified LLM output khi retrieval confidence 0.5-0.85 → self-reinforcing hallucination loop)
   - Chunking không tồn tại (naive `.slice(0, 2000)`) → recall suy giảm 5-15%
   - Entity resolution bằng string name → collision + duplication

**⇒ Do đó file này chia 6 Phase: Pre-Phase 1 (ngắt ML contamination TRƯỚC khi fix engineering) → Phase 1-3 (engineering) → Phase 4 (ML quality) → Phase 5 (advanced ML).**

**Đường ống learning hiện tại (qua OpenClaw chat route)**:
1. User chat → `POST /api/openclaw/chat`
2. `classifyIntent()` → 'casual' | 'factual' | 'procedural' | 'meta'
3. Nếu cần KB → `accessKnowledgeBase()` (đang throw vì `qdrant.search()` không còn tồn tại)
4. LLM generate answer (NVIDIA NIM `nvidia/nemotron-3-ultra-550b-a55b`)
5. `writebackToKB()` (đang throw vì sai signature → catch → fallback `autoLearnFromAnswer()`)
6. `autoLearnFromAnswer()`: `extractKnowledgeFromAnswer` (LLM) → `generateEmbedding` (NVIDIA trả 1536-dim, code expect 2048-dim → fail → fallback pseudo-hash) → `saveChunkToQdrant` (bỏ qua vì dim sai) → SQLite buffer (`LocalEntity`, `LocalRelationship` với `synced=false`) + `AgentInsight` + `LearningLog` + `AutoLearnRecord`
7. **Neo4j KHÔNG được enrich từ chat path** (writeback fail, auto-learn chỉ queue buffer table).
8. **Supabase KHÔNG backup learning tables** (chỉ 8 tables khác được sync).

---

## Danh sách vấn đề xác định được

### A. Engineering bugs (compile/runtime)

| # | File:Line | Bug | Severity |
|---|---|---|---|
| 1 | `src/lib/learning/historical-feedback.ts:17` | `db.executionMetrics` không tồn tại | CRITICAL |
| 2 | `src/lib/learning/metrics-collector.ts:126` | `db.executionMetrics` không tồn tại | CRITICAL |
| 3 | `src/lib/learning/strategy-adapter.ts:234` | `db.failurePattern` không tồn tại | CRITICAL |
| 4 | `src/lib/learning/strategy-adapter.ts:268` | `db.strategyAdaptationLog` không tồn tại | CRITICAL |
| 5 | `src/lib/kb-routing/writeback.ts:256` | `upsertEntitiesBatch(entityNodes)` thiếu 2nd arg `documentId` | CRITICAL |
| 6 | `src/lib/kb-routing/writeback.ts:279` | `upsertRelationshipsBatch(edges)` thiếu 2nd arg `documentId` | CRITICAL |
| 7 | `src/lib/kb-routing/kb-access.ts:115` | `qdrant.search()` không còn tồn tại trên `QdrantClient` type | CRITICAL |
| 8 | `src/lib/kb-routing/writeback.ts:229` | `ChunkPayload` thiếu các field required | HIGH |
| 9 | `.env NVIDIA_EMBED_DIMENSIONS=1536` vs `embeddings.ts:34 EMBEDDING_DIMENSION=2048` | Mismatch → NVIDIA fail → fallback pseudo-hash | HIGH |
| 10 | `src/lib/supabase-sync.ts` | Chỉ sync 8 tables, bỏ qua toàn bộ learning tables | HIGH (silent data loss) |
| 11 | `src/lib/kb-routing/index.ts` `runSmartKB` | Orchestrator đầy đủ KHÔNG được gọi từ chat route | HIGH |
| 12 | `SmolabTaskType = 'agent_react' \| 'memory_extraction'` | Declared nhưng không bao giờ enqueue | LOW (dead enum) |

### B. ML issues (theo ML review Task ID 5)

| # | Vấn đề ML | Severity |
|---|---|---|
| M1 | Pseudo-hash fallback embedding (`src/lib/embeddings.ts` cuối file) — silent garbage vector, không phân biệt được với NVIDIA thật | CRITICAL |
| M2 | Auto-learn confidence gate đang NGƯỢC (`src/lib/auto-learn.ts:88-95`) — LEARN unverified LLM output → self-reinforcing hallucination loop | CRITICAL |
| M3 | Chunking không tồn tại (`src/lib/auto-learn.ts:125` `slice(0, 2000)`) — recall suy giảm 5-15% | CRITICAL |
| M4 | Entity resolution bằng string MERGE (`src/lib/neo4j.ts:870`) — collision + duplication | HIGH |
| M5 | Confidence scoring thuần heuristic, không calibrated (`src/lib/kb-routing/kb-access.ts:175-196`) | HIGH |
| M6 | Không có cross-encoder re-ranking (recall suy giảm 5-15%) | HIGH |
| M7 | Không có hybrid search BM25+dense (exact match query yếu) | HIGH |
| M8 | Không có MMR diversity (top-K redundant) | MEDIUM |
| M9 | LLM-as-judge circular bias trong Phase 4 (cùng NVIDIA NIM cho 3 vai trò) | HIGH |
| M10 | Không có query rewriting / HyDE (conversational recall yếu) | MEDIUM |
| M11 | Memory decay algorithm không cụ thể | MEDIUM |
| M12 | Graph search chỉ dùng `CONTAINS` (lexical), không semantic | HIGH |
| M13 | Không có embedding model versioning (silent model update → vector invalidated) | MEDIUM |
| M14 | Cache key không normalized (hit rate thấp) | MEDIUM |
| M15 | Không có concept drift detection (long-term health) | LOW |
| M16 | Không có cold start mode (fresh install → KB fill đầy unverified output) | HIGH |
| M17 | Entity threshold 0.85 chọn tay, không validate (cần hard negative mining) | LOW |

---

## Pre-Phase 1 — STOP CONTAMINATION (P0 ML, 1 session)

**Mục tiêu**: Ngắt silent ML corruption TRƯỚC khi fix engineering. Nếu fix engineering xong trước → auto-learn sẽ chạy ào ào → KB fill đầy garbage mất 1-2 tuần để flush ra.

**Proposals**: P0.1, P0.2, P0.3, P0.4.

**Lý do đặt trước Phase 1**: Bất kỳ fix engineering nào cũng sẽ "unlock" pipeline learning → nếu ML gate chưa có, hệ sẽ học sai ngay lập tức. Pre-Phase 1 phải chạy xong (~1 session) trước khi đụng vào engineering.

---

### Proposal P0.1: Loại bỏ pseudo-hash fallback embedding

**Problem** (ML issue M1)
- `src/lib/embeddings.ts` cuối file có hàm `generatePseudoHashEmbedding` — fallback cuối khi NVIDIA + OpenRouter đều fail.
- Tạo 2048-dim vector bằng SHA-256(text) trải đều. Hai text khác 1 ký tự → vector hoàn toàn khác (cosine ~0).
- Hệ **không phân biệt được** pseudo-hash vs NVIDIA thật — cùng type `number[]` length 2048, cùng insert vào Qdrant thành công.
- Dashboard báo "healthy" nhưng search trả garbage.
- Hiện tượng sẽ TĂNG khi NVIDIA rate-limit (160 RPM là rất thấp cho production).

**Cách triển khai thực tế**

**Bước P0.1.1** — Sửa `src/lib/embeddings.ts`:
```ts
// Trước: generatePseudoHashEmbedding() trả vector giả
// Sau: THROW thay vì trả vector giả. Caller phải handle null.

export async function generateEmbedding(text: string): Promise<EmbeddingResult> {
  // ... NVIDIA attempt ...
  // ... OpenRouter attempt ...
  // TRƯỚC: return generatePseudoHashEmbedding(text)
  // SAU:
  console.error('[Embedding] ALL providers failed — returning null (no pseudo-hash fallback)')
  return { vector: null as unknown as number[], model: 'none' }
  // Hoặc: throw new Error('Embedding unavailable — all providers failed')
}

export async function generateQueryEmbedding(query: string): Promise<EmbeddingResult> {
  // Tương tự — throw thay vì fallback
}
```

**Bước P0.1.2** — Caller phải check `vector === null`:
```ts
// src/lib/auto-learn.ts:126
const embResult = await generateEmbedding(textToEmbed)
if (!embResult.vector || embResult.vector.length === 0) {
  console.warn('[AutoLearn] Embedding unavailable — skipping Qdrant write (no pseudo-hash)')
  // Không throw — vẫn tiếp tục SQLite write, chỉ skip vector
}

// src/lib/kb-routing/kb-access.ts:114
const { vector } = await generateQueryEmbedding(query)
if (!vector || vector.length === 0) {
  console.warn('[KB-Access] Query embedding unavailable — skipping vector search')
  return []  // chỉ fallback sang entity/memory search
}
```

**Bước P0.1.3** — Thêm field `vector_provider` vào Qdrant payload để audit:
```ts
// src/lib/qdrant.ts ChunkPayload type:
interface ChunkPayload {
  // existing fields...
  vector_provider: 'nvidia' | 'openrouter' | 'pseudo-hash' | 'none'
  embedding_model_version: string  // vd "nemotron-embed-1b-v2-2025-XX-XX"
}
```
Mọi nơi insert Qdrant chunk đều phải set field này.

**Bước P0.1.4** — Migration cho existing Qdrant points (audit pseudo-hash vectors):
```bash
# Query tất cả points, check pattern pseudo-hash (256 byte đầu là SHA-256 hex)
curl -sX POST http://localhost:6333/collections/theopus_chunks/points/scroll \
  -H 'Content-Type: application/json' \
  -d '{"limit": 100, "with_payload": true, "with_vector": true}' | \
  jq '.result.points | map({
    id: .id,
    has_vector_provider: (.payload.vector_provider != null),
    pseudo_hash_suspect: ((.vector[0:32] | map(. * 256 | floor | tostring | .[0:2])) | length > 0)
  })'
# → Flag các point không có vector_provider field (chưa audit) → re-embed sau này
```

**Bước P0.1.5** — Verify:
```bash
# Tắt NVIDIA key tạm thời (rename .env NVIDIA_API_KEY_1 → NVIDIA_API_KEY_1_OFF)
sed -i 's/NVIDIA_API_KEY_1=/NVIDIA_API_KEY_1_OFF=/' /home/z/tmo-app/.env
pm2 restart theopusflashlite

# Query 1 câu
curl -sX POST http://localhost:3000/api/openclaw/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"test","agentProfileId":"...","sessionId":"..."}'

# Check log: phải thấy warning, KHÔNG thấy "pseudo-hash" hay "vector inserted"
tail -50 /home/z/my-project/dev.log | grep -iE 'embedding|pseudo|vector'
# Phải thấy: "[Embedding] ALL providers failed — returning null (no pseudo-hash fallback)"

# Restore
sed -i 's/NVIDIA_API_KEY_1_OFF=/NVIDIA_API_KEY_1=/' /home/z/tmo-app/.env
pm2 restart theopusflashlite
```

**Files to edit**: `src/lib/embeddings.ts`, `src/lib/auto-learn.ts`, `src/lib/kb-routing/{kb-access,writeback}.ts`, `src/lib/qdrant.ts` (ChunkPayload type).
**Env vars**: Không.
**Dependencies**: Không.
**Effort**: S (~2 giờ).
**Priority**: P0 ML.
**Risks**: Nếu caller nào không check null → runtime throw. Cần grep toàn bộ `generateEmbedding`/`generateQueryEmbedding` callers.

---

### Proposal P0.2: Auto-learn verification gate (đảo ngược logic)

**Problem** (ML issue M2)
- `src/lib/auto-learn.ts:88-95`: SKIP nếu confidence < 0.5 ("too unreliable"), SKIP nếu >= 0.85 ("KB already had enough"), LEARN khi 0.5 ≤ confidence < 0.85.
- `confidence = 0.6` nghĩa là **KB CHƯA đủ thông tin** → câu LLM là **best guess chưa verify**.
- Persist cái đó làm "knowledge" = **knowledge contamination**.
- Lần sau query tương tự → retrieve chính chunk unverified → confidence tăng → reinforced.
- Đây là **self-reinforcing hallucination loop** — pattern rất phổ biến trong RAG kém thiết kế.

**Cách triển khai thực tế**

**Bước P0.2.1** — Thêm 2 field vào Prisma model `AgentInsight`:
```prisma
model AgentInsight {
  // existing fields...
  verified         Boolean  @default(false)
  verificationSource String?  // 'user_feedback' | 'eval_pass' | 'human_review' | 'llm_judge_cross_model' | null
  verifiedAt       DateTime?
}
```
Run `bun run db:push`. Existing rows → `verified = false` (default).

**Bước P0.2.2** — Sửa `src/lib/auto-learn.ts`:
```ts
// Giữ nguyên gate 0.5 ≤ confidence < 0.85 (vẫn extract knowledge)
// NHƯNG mark verified = false khi insert

await db.agentInsight.create({
  data: {
    agentId: input.agentId,
    content: `Query: ${input.query}\n\nAnswer: ${input.answer.slice(0, 800)}`,
    source: 'auto',
    type: 'factual',
    confidence: input.confidence,
    verified: false,  // MỚI — chưa verify
    verificationSource: null,
  },
})
```

**Bước P0.2.3** — Sửa retrieval để KHÔNG inject unverified insights vào prompt:
```ts
// src/lib/kb-routing/kb-access.ts hoặc nơi inject insight vào chat prompt
// Trước:
const insights = await db.agentInsight.findMany({ where: { agentId } })
// Sau:
const insights = await db.agentInsight.findMany({
  where: { agentId, verified: true }  // CHỈ inject verified
})
```

**Bước P0.2.4** — Verification triggers (khi nào set `verified = true`):

**Trigger 1** — User 👍 feedback:
```ts
// src/app/api/openclaw/feedback/route.ts
if (type === 'positive') {
  // Tìm tất cả insight được extract từ answer đó → mark verified
  const insights = await db.agentInsight.findMany({
    where: {
      agentId,
      content: { contains: messageId },
    },
  })
  for (const i of insights) {
    await db.agentInsight.update({
      where: { id: i.id },
      data: {
        verified: true,
        verificationSource: 'user_feedback',
        verifiedAt: new Date(),
        confidence: Math.max(i.confidence, 0.7),  // boost
      },
    })
  }
}
```

**Trigger 2** — Eval pass (Phase 4 Proposal 11'):
```ts
// Sau mỗi eval case có faithfulness > 0.8 → mark verified
await db.agentInsight.updateMany({
  where: { /* match insight → case */ },
  data: { verified: true, verificationSource: 'eval_pass', verifiedAt: new Date() },
})
```

**Trigger 3** — Human review qua UI teach endpoint (đã có):
- `/api/openclaw/learning/teach` với `type=insight` → insert mới với `verified = true, source = 'manual'`.

**Trigger 4** — LLM-judge cross-model (Phase 4 Proposal 11'):
- Khi judge (GPT-4o-mini) chấm faithfulness > 0.7 → mark verified.

**Bước P0.2.5** — UI badge "✓ Verified":
```tsx
// src/app/page.tsx LearningTabContent
{insight.verified ? (
  <Badge variant="default" className="ml-2">
    <CheckCircle className="h-3 w-3 mr-1" /> Verified
  </Badge>
) : (
  <Badge variant="outline" className="ml-2 text-muted-foreground">
    Unverified (awaiting feedback)
  </Badge>
)}
```

**Bước P0.2.6** — Verify:
```bash
pm2 restart theopusflashlite

# Chat 1 câu factual (vd "What is React?")
# → Auto-learn triggers, AgentInsight inserted với verified=false

sqlite3 /home/z/my-project/db/custom.db \
  "SELECT id, verified, verificationSource FROM AgentInsight ORDER BY createdAt DESC LIMIT 5;"
# Phải thấy: verified=0 (false), verificationSource=NULL

# Query lại cùng câu → check chat prompt (qua dev.log) KHÔNG có insight inject
tail -100 /home/z/my-project/dev.log | grep -i 'insight'
# Không thấy "injecting insight" log

# Send 👍 feedback cho answer
curl -sX POST http://localhost:3000/api/openclaw/feedback \
  -H 'Content-Type: application/json' \
  -d '{"type":"positive","messageId":"...","agentId":"..."}'

# Verify insight được promote
sqlite3 /home/z/my-project/db/custom.db \
  "SELECT verified, verificationSource FROM AgentInsight ORDER BY verifiedAt DESC LIMIT 5;"
# Phải thấy verified=1, verificationSource='user_feedback'

# Query lại → check chat prompt CÓ insight inject
tail -100 /home/z/my-project/dev.log | grep -i 'insight'
```

**Files to edit**: `prisma/schema.prisma`, `src/lib/auto-learn.ts`, `src/lib/kb-routing/{kb-access,writeback}.ts`, `src/app/api/openclaw/feedback/route.ts`, `src/app/page.tsx`.
**Env vars**: Không.
**Dependencies**: Không (chạy độc lập).
**Effort**: M (~4 giờ).
**Priority**: P0 ML.
**Risks**: Insight hiện có trong DB sẽ đều `verified=false` → user có thể thấy agent "quên" hết tạm thời. Cần thông báo trong UI "X insights awaiting verification".

---

### Proposal P0.3: Proper chunking strategy (recursive 400+50)

**Problem** (ML issue M3)
- `src/lib/auto-learn.ts:125`: `input.answer.slice(0, MAX_EMBEDDING_TEXT_LENGTH)` với MAX = 2000 chars.
- Cắt ngẫu nhiên giữa câu, mất ngữ cảnh.
- RAG papers ([Lewis et al. 2020](https://arxiv.org/abs/2005.11401), [Gao et al. 2023](https://arxiv.org/abs/2312.10997)) chứng minh chunk size ảnh hưởng recall 5-15%.
- 2000 chars (~500 tokens) là quá lớn cho `nemotron-embed-1b-v2` (peak quality ở 256-512 tokens).
- Không có chunk overlap → mất context qua boundary.

**Cách triển khai thực tế**

**Bước P0.3.1** — Tạo `src/lib/chunking.ts`:
```ts
/**
 * Recursive Character Text Splitter
 * - chunkSize: 400 tokens (~1600 chars) — sweet spot cho nemotron-embed-1b-v2
 * - chunkOverlap: 50 tokens (~200 chars) — 12.5% overlap
 * - separators: ưu tiên split theo \n\n (paragraph) > \n (line) > . (sentence) > space (word)
 */

interface ChunkOptions {
  chunkSize?: number  // tokens
  chunkOverlap?: number  // tokens
  separators?: string[]
}

const DEFAULT_SEPARATORS = ['\n\n', '\n', '. ', '! ', '? ', ' ']

// Roughly 4 chars = 1 token (English); adjust if multilingual
const CHARS_PER_TOKEN = 4

export function recursiveCharacterSplit(
  text: string,
  options: ChunkOptions = {}
): string[] {
  const chunkSize = options.chunkSize ?? 400
  const chunkOverlap = options.chunkOverlap ?? 50
  const separators = options.separators ?? DEFAULT_SEPARATORS
  
  const targetChars = chunkSize * CHARS_PER_TOKEN
  const overlapChars = chunkOverlap * CHARS_PER_TOKEN
  
  if (text.length <= targetChars) return [text]
  
  const chunks: string[] = []
  let start = 0
  
  while (start < text.length) {
    const end = Math.min(start + targetChars, text.length)
    let actualEnd = end
    
    // Ưu tiên split tại separator gần nhất
    if (end < text.length) {
      for (const sep of separators) {
        const lastSep = text.lastIndexOf(sep, end)
        if (lastSep > start + targetChars * 0.5) {  // separator trong nửa sau
          actualEnd = lastSep + sep.length
          break
        }
      }
    }
    
    chunks.push(text.slice(start, actualEnd).trim())
    start = actualEnd - overlapChars  // overlap để giữ context
    if (start < 0) start = 0
    if (start >= text.length) break
  }
  
  return chunks.filter(c => c.length > 0)
}

export const CHUNKING_STRATEGY = 'recursive-400-50'
```

**Bước P0.3.2** — Sửa `src/lib/auto-learn.ts`:
```ts
// Trước (line 124-142):
const textToEmbed = input.answer.slice(0, MAX_EMBEDDING_TEXT_LENGTH)
const embResult = await generateEmbedding(textToEmbed)
const chunkSaved = embResult.vector.length === getEmbeddingDimension()
if (chunkSaved) {
  qdrantPointId = await saveChunkToQdrant({...})
}

// Sau:
import { recursiveCharacterSplit, CHUNKING_STRATEGY } from '@/lib/chunking'

const chunks = recursiveCharacterSplit(input.answer)
let chunksSaved = 0
const qdrantPointIds: string[] = []

for (let i = 0; i < chunks.length; i++) {
  const chunkText = chunks[i]
  const embResult = await generateEmbedding(chunkText)
  if (!embResult.vector || embResult.vector.length === 0) {
    console.warn(`[AutoLearn] Chunk ${i} embedding failed — skipping`)
    continue
  }
  const pointId = await saveChunkToQdrant({
    documentId,
    content: chunkText,
    chunkIndex: i,  // MỚI
    chunkingStrategy: CHUNKING_STRATEGY,  // MỚI
    totalChunks: chunks.length,  // MỚI
    vector: embResult.vector,
    agentName: input.agentName,
    query: input.query,
    confidence: input.confidence,
    provider: input.provider,
    model: input.model,
  })
  if (pointId) {
    qdrantPointIds.push(pointId)
    chunksSaved++
  }
}
```

**Bước P0.3.3** — Sửa `saveChunkToQdrant` payload (file `src/lib/auto-learn.ts` hoặc `qdrant.ts`):
```ts
// Thêm vào ChunkPayload:
chunk_index: number
chunking_strategy: string  // 'recursive-400-50' | 'naive-2000' | 'entity-per-chunk'
total_chunks: number
```

**Bước P0.3.4** — Migration existing Qdrant points:
```bash
# Query existing points, set chunking_strategy = 'naive-2000' cho points cũ
curl -sX POST http://localhost:6333/collections/theopus_chunks/points/payload \
  -H 'Content-Type: application/json' \
  -d '{
    "points": ["<all-ids>"],
    "payload": {"chunking_strategy": "naive-2000"},
    "filter": {"must_not": [{"key": "chunking_strategy", "exists": true}]}
  }'
# Sau này có thể filter + re-embed các chunks 'naive-2000' bằng script
```

**Bước P0.3.5** — Verify:
```bash
pm2 restart theopusflashlite

# Query 1 câu answer dài (>2000 chars)
curl -sX POST http://localhost:3000/api/openclaw/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Explain neural networks in detail","agentProfileId":"...","sessionId":"..."}'

# Check Qdrant có nhiều chunks cho 1 answer
curl -sX POST http://localhost:6333/collections/theopus_chunks/points/scroll \
  -H 'Content-Type: application/json' \
  -d '{"filter":{"must":[{"key":"document_id","match":{"value":"<doc-id>"}}]},"limit":10,"with_payload":true}' | \
  jq '.result.points | length'
# Phải > 1 (nhiều chunks)

# Check chunking_strategy field
curl -sX POST http://localhost:6333/collections/theopus_chunks/points/scroll \
  -H 'Content-Type: application/json' \
  -d '{"limit":5,"with_payload":true}' | \
  jq '.result.points[].payload.{strategy: .chunking_strategy, idx: .chunk_index, total: .total_chunks}'
```

**Files to edit**: `src/lib/chunking.ts` (new), `src/lib/auto-learn.ts`, `src/lib/qdrant.ts` (ChunkPayload type), `src/lib/kb-routing/writeback.ts`, `src/lib/ingestion/*`.
**Env vars**: `CHUNK_SIZE_TOKENS=400`, `CHUNK_OVERLAP_TOKENS=50` (optional override).
**Dependencies**: Không.
**Effort**: S (~3 giờ).
**Priority**: P0 ML.
**Risks**: Nếu chunk quá ngắn → nhiều Qdrant writes cho 1 answer → tốn NVIDIA quota. Cần rate limit (vd max 5 chunks/answer).

---

### Proposal P0.4: Cache key normalization

**Problem** (ML issue M14)
- `src/lib/embeddings.ts:234`: `hashText(text) = createHash('sha256').update(text).digest('hex')`.
- "What is React?" vs "what is react? " (khoảng trắng cuối) → 2 hash khác nhau → cache miss.
- Tỷ lệ hit cache thấp → tốn NVIDIA quota không cần thiết.

**Cách triển khai thực tế**

**Bước P0.4.1** — Sửa `src/lib/embeddings.ts`:
```ts
// Trước (line 234):
function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

// Sau:
function hashText(text: string): string {
  // Normalize: lowercase + trim + collapse whitespace + remove punctuation
  const normalized = text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')      // collapse whitespace
    .replace(/[.?!,;:]+$/g, '') // remove trailing punctuation
  return createHash('sha256').update(normalized).digest('hex')
}
```

**Bước P0.4.2** — Migration: clear existing cache (hash scheme thay đổi):
```bash
sqlite3 /home/z/my-project/db/custom.db "DELETE FROM EmbeddingCache;"
echo "Cache cleared — sẽ rebuild khi query"
```

**Bước P0.4.3** — Đo cache hit rate trước/sau:
```bash
# Trước khi apply fix (baseline)
pm2 restart theopusflashlite
# Chat 10 câu tương tự nhau (vd "What is React?", "what is react", "What is React")
# Check log:
grep "cache hit" /home/z/my-project/dev.log | wc -l  # baseline
grep "cache miss" /home/z/my-project/dev.log | wc -l  # baseline

# Apply fix, restart
pm2 restart theopusflashlite

# Chat 10 câu tương tự
# Check log:
grep "cache hit" /home/z/my-project/dev.log | wc -l  # phải tăng 20-30%
```

(Nota: code hiện không log cache hit/miss — cần thêm log tạm cho measure:
```ts
// Trong getCachedEmbedding:
console.log(`[Embedding] cache ${cached ? 'HIT' : 'MISS'} key=${cacheKey.slice(0, 8)}`)
```
)

**Files to edit**: `src/lib/embeddings.ts`.
**Env vars**: Không.
**Dependencies**: Không.
**Effort**: S (~30 phút).
**Priority**: P0 ML.
**Risks**: Existing cache bị invalidate (đã handle ở Bước P0.4.2). Cache warm-up lại tốn ~1 ngày đầu.

---

## Phase 1 — STABILIZE (P0 engineering, 1-2 sessions)

**Mục tiêu**: Làm cho pipeline learning thực sự chạy end-to-end. Ngắt mọi silent engineering failure path.

**Prerequisite**: Pre-Phase 1 đã xong (ML gate đã có, không sợ auto-learn chạy ào ào).

**Proposals**: 1, 2, 3, 4, 5.

---

### Proposal 1: Sửa NVIDIA embedding dimension mismatch

**Problem**
- `.env`: `NVIDIA_EMBED_DIMENSIONS=1536`
- `src/lib/embeddings.ts:34`: `const EMBEDDING_DIMENSION = 2048` (hardcode)
- `embeddings.ts:371`: `if (embedding.length === EMBEDDING_DIMENSION)` → NVIDIA trả 1536-dim → fail check → fallback sang OpenRouter (chưa cấu hình key) → fallback sang pseudo-hash (đã bỏ ở Pre-Phase 1 Proposal P0.1).
- Kết quả sau Pre-Phase 1: NVIDIA trả 1536-dim → fail → THROW (không còn fallback) → mọi embedding call fail → toàn bộ auto-learn skip Qdrant write.

**Cách triển khai thực tế**

**Bước 1.1** — Quyết định dimension:
- NVIDIA `nemotron-embed-1b-v2` là Matryoshka, hỗ trợ 2048 native (full capacity).
- Qdrant collection `theopus_chunks` đã tạo ở 2048-dim.
- **Quyết định**: đặt `NVIDIA_EMBED_DIMENSIONS=2048` trong `.env` (đổi từ 1536 → 2048).
- Trade-off: 2048-dim tốn 1.34× storage + RAM so với 1536-dim, nhưng chất lượng retrieval cao hơn ~5-10% (Matryoshka truncate loss).

**Bước 1.2** — Sửa `src/lib/embeddings.ts`:
```ts
// Trước (line 34):
const EMBEDDING_DIMENSION = 2048

// Sau — dùng chung env var với code ở line 38:
const EMBEDDING_DIMENSION = parseInt(process.env.NVIDIA_EMBED_DIMENSIONS || '2048', 10)
```
(Nota: line 38 đã có `NVIDIA_EMBED_DIMENSIONS` đọc từ env — chỉ cần xóa hardcoded `EMBEDDING_DIMENSION` ở line 34, dùng luôn biến line 38.)

**Bước 1.3** — Restart + verify:
```bash
sed -i 's/NVIDIA_EMBED_DIMENSIONS=1536/NVIDIA_EMBED_DIMENSIONS=2048/' /home/z/tmo-app/.env
pm2 restart theopusflashlite

# Test embedding trực tiếp
curl -sX POST http://localhost:3000/api/query \
  -H 'Content-Type: application/json' \
  -d '{"query":"What is a neural network?"}' | jq

# Check log
tail -50 /home/z/my-project/dev.log | grep -E 'Embedding|NVIDIA'
# Phải thấy: "[Embedding] NVIDIA nemotron-embed-1b ✓ (2048d"
```

**Bước 1.4** — Sanity check ML correctness (cosine similarity):
```bash
# Embed 2 text tương tự + 1 không liên quan, verify cosine
# (Cần 1 script test hoặc API debug)
curl -sX POST http://localhost:3000/api/debug/embed \
  -H 'Content-Type: application/json' \
  -d '{"texts":["machine learning","deep learning","weather forecast"]}' | \
  jq '.vectors | {
    ml_vs_dl: cosine(.[0], .[1]),  # phải > 0.7
    ml_vs_weather: cosine(.[0], .[2])  # phải < 0.3
  }'
```
(Nếu chưa có endpoint `/api/debug/embed`, tạo tạm cho verify.)

**Bước 1.5** — Check Qdrant collection dim:
```bash
curl -s http://localhost:6333/collections/theopus_chunks | jq '.result.config.params.vectors.size'
# Phải trả 2048
```

**ML note**: Sau khi fix, chạy sanity check cosine (Bước 1.4) — không chỉ check "✓ (2048d" trong log. Có thể NVIDIA trả đúng dim nhưng vector bị zero-pad do bug params → search vẫn garbage. Cosine test là verify ML-đúng.

**Files to edit**: `src/lib/embeddings.ts`, `.env`.
**Env vars affected**: `NVIDIA_EMBED_DIMENSIONS`.
**Dependencies**: Pre-Phase 1 Proposal P0.1 (đã bỏ pseudo-hash → fix này mới có ý nghĩa).
**Effort**: S (~30 phút).
**Priority**: P0 — ảnh hưởng mọi embedding call.

---

### Proposal 2: Thêm 3 Prisma models còn thiếu cho Layer 9

**Problem**
- `db.executionMetrics`/`db.failurePattern`/`db.strategyAdaptationLog` không tồn tại → Layer 9 persistence chết.

**Cách triển khai thực tế**

**Bước 2.1** — Append 3 models vào `prisma/schema.prisma`:
```prisma
model ExecutionMetrics {
  id                  String   @id @default(cuid())
  sessionId           String
  planId              String
  routingMode         String
  tier                Int
  totalSteps          Int
  completedSteps      Int      @default(0)
  failedSteps          Int      @default(0)
  totalTokensUsed     Int      @default(0)
  totalTokensBudgeted Int
  totalTimeSpent      Int      @default(0)
  errorsByType        String   @default("{}")
  stepSuccessRate     Float    @default(0)
  tokenEfficiency     Float    @default(0)
  // ML bổ sung (theo review):
  embeddingModelVersion String?
  vectorCount          Int      @default(0)
  graphNodeCount       Int      @default(0)
  recallAt5            Float?  // ML metric — populate by Proposal 7 + 11'
  faithfulness         Float?  // ML metric
  createdAt            DateTime @default(now())

  @@index([sessionId])
  @@index([routingMode])
  @@index([createdAt])
}

model FailurePattern {
  id              String   @id @default(cuid())
  sessionId       String   @default("unknown")
  type            String
  count           Int      @default(1)
  strategiesTried String   @default("[]")
  nextStrategy    String
  context         String   @default("{}")
  resolved        Boolean  @default(false)
  createdAt       DateTime @default(now())

  @@index([sessionId])
  @@index([type])
}

model StrategyAdaptationLog {
  id           String   @id @default(cuid())
  sessionId    String
  patternId    String?
  fromStrategy String
  toStrategy   String
  reason       String
  confidence   Float
  successful   Boolean?
  createdAt    DateTime @default(now())

  @@index([sessionId])
  @@index([createdAt])
}
```

**Bước 2.2** — Push + regen:
```bash
cd /home/z/tmo-app
DATABASE_URL=file:/home/z/my-project/db/custom.db bun run db:push
bunx prisma generate
bunx tsc --noEmit 2>&1 | grep -E 'executionMetrics|failurePattern|strategyAdaptationLog'
# Phải trả rỗng
pm2 restart theopusflashlite
```

**ML note**: 3 field ML bổ sung (`embeddingModelVersion`, `vectorCount`, `graphNodeCount`, `recallAt5`, `faithfulness`) cho phép correlate "lần này retrieval kém" với "model version X" hoặc "KB có ít node lúc đó" — quan trọng cho root cause analysis sau này.

**Files to edit**: `prisma/schema.prisma`.
**Dependencies**: Không.
**Effort**: S (~30 phút).
**Priority**: P0.

---

### Proposal 3: Sửa writeback.ts Neo4j signatures + ChunkPayload

**Problem** (Bug #5, #6, #8)
- `writeback.ts:256` gọi `upsertEntitiesBatch(entityNodes)` thiếu `documentId`.
- `writeback.ts:279` tương tự với `upsertRelationshipsBatch(edges)`.
- `writeback.ts:229` ChunkPayload thiếu fields.

**Cách triển khai thực tế**

**Bước 3.1** — Sửa signatures:
```ts
// writeback.ts:256
await upsertEntitiesBatch(entityNodes, documentId);  // thêm documentId

// writeback.ts:279
await upsertRelationshipsBatch(edges, documentId);
```

**Bước 3.2** — Sửa ChunkPayload:
```ts
const chunkPayload: ChunkPayload = {
  document_id: documentId,
  chunk_index: idx,
  content: chunkText,
  heading_path: `Auto-Learn: ${agentName}`,
  token_count: Math.ceil(chunkText.length / 4),
  domain: 'auto-learned',
  source: 'auto-learn',
  entity_name: entity.name,
  entity_type: entity.type,
  confidence: entity.confidence,
  chunking_strategy: 'entity-per-chunk',  // MỚI — distinguish từ auto-learn chunks
  created_at: new Date().toISOString(),
  vector_provider: 'nvidia',  // MỚI — audit field (Pre-Phase 1 P0.1)
}
```

**Bước 3.3** — Verify:
```bash
bunx tsc --noEmit 2>&1 | grep writeback
# Phải trả rỗng

pm2 restart theopusflashlite

# Chat 1 câu factual → check Neo4j có node mới
curl -sX POST http://localhost:3000/api/openclaw/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"What is React?","agentProfileId":"<id>","sessionId":"<id>"}'

# Neo4j check
cypher-shell -a neo4j+s://6e688b02.databases.neo4j.io -u 6e688b02 -p "$NEO4J_PASSWORD" \
  "MATCH (n:Concept) WHERE toLower(n.name) CONTAINS 'react' RETURN count(n)"
# Count phải tăng sau chat
```

**Files to edit**: `src/lib/kb-routing/writeback.ts`.
**Dependencies**: Không.
**Effort**: S (~45 phút).
**Priority**: P0.

---

### Proposal 4: Sửa kb-access.ts QdrantClient.search()

**Problem** (Bug #7)
- `kb-access.ts:115` dùng `qdrant.search()` deprecated.

**Cách triển khai thực tế**

**Bước 4.1** — Sửa sang `queryPoints`:
```ts
// Trước:
const results = await qdrant.search(COLLECTION_CHUNKS, {
  vector,
  limit: topK,
  with_payload: true,
  score_threshold: 0.3,
})

// Sau:
const searchResult = await qdrant.queryPoints(COLLECTION_CHUNKS, {
  query: vector,
  using: 'default',
  limit: topK,
  with_payload: true,
  score_threshold: 0.3,  // ML note: 0.3 heuristic — cần tune qua Proposal 3.5
  // ML note: cho production với >100k points, thêm:
  // params: { quantization: { ignore: false, rescore: true, oversampling: 2.0 } }
})
return searchResult.points.map(point => ({
  id: String(point.id),
  text: (point.payload?.text as string) || '',
  score: point.score,
  documentId: point.payload?.documentId as string | undefined,
  source: point.payload?.source as string | undefined,
  vectorProvider: point.payload?.vector_provider as string | undefined,  // MỚI — audit
}))
```

**Bước 4.2** — Verify:
```bash
bunx tsc --noEmit 2>&1 | grep kb-access
pm2 restart theopusflashlite

# Query 1 câu đã có dữ liệu (cần Pre-Phase 1 + Proposal 1+3 đã xong)
curl -sX POST http://localhost:3000/api/openclaw/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"<query đã học>","agentProfileId":"...","sessionId":"..."}'

tail -50 /home/z/my-project/dev.log | grep 'KB-Access'
# Phải thấy "chunks found: N" với N > 0
```

**ML note**: `score_threshold: 0.3` là heuristic — sau Phase 4 (Proposal 3.5 Calibration + Proposal 11' Eval) sẽ tune threshold dựa trên data thật.

**Files to edit**: `src/lib/kb-routing/kb-access.ts`.
**Dependencies**: Pre-Phase 1 + Proposal 1 + 3 (cần data trong Qdrant để test).
**Effort**: S (~30 phút).
**Priority**: P0.

---

### Proposal 5: Wire `runSmartKB` orchestrator vào `/api/openclaw/chat`

**Problem** (Bug #11)
- `kb-routing/index.ts` export `runSmartKB` đầy đủ (classifyIntent → accessKnowledgeBase → searchModelKnowledge → synthesizeAnswer) NHƯNG chat route không gọi.

**Cách triển khai thực tế**

**Bước 5.1** — Refactor ReAct path trong `src/app/api/openclaw/chat/route.ts` (line ~740-810):
```ts
const smartKBResult = await runSmartKB({
  message: lastUserContent,
  agentId: agentProfileId!,
  agentName: agentProfileName,
  sessionId,
}).catch(err => {
  console.warn('[Chat] runSmartKB failed, using raw LLM content', err);
  return null;
});

return NextResponse.json({
  content: smartKBResult?.synthesis?.content ?? content,
  sources: smartKBResult?.kbAccess?.step1?.chunks ?? [],
  confidence: smartKBResult?.kbAccess?.step1?.confidence ?? 0.5,
  intent: smartKBResult?.intent?.intent ?? 'factual',
  usedKB: smartKBResult?.kbAccess?.step1?.used ?? false,
  // Giữ các field cũ cho backward compat
});
```

**Bước 5.2** — Refactor fallback path (line ~970-1040): tương tự.

**Bước 5.3** — Verify end-to-end:
```bash
pm2 restart theopusflashlite

curl -sX POST http://localhost:3000/api/openclaw/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"<câu đã học>","agentProfileId":"<id>","sessionId":"<id>"}' | jq

# Response phải có:
# - "sources": [{score, payload:{content, source:"auto-learn"}}]
# - "usedKB": true
# - "intent": "factual" (hoặc procedural)
# - content phải có tag "[User KB]" hoặc "[Model Knowledge]"
```

**ML note**: Synthesis layer ghép Step 1 (user KB) + Step 2 (model knowledge) có thể **contradict** (Step 1 nói "React là framework", Step 2 nói "react trong hóa học nghĩa là..."). Cần thêm conflict check:
```ts
// Trong synthesizeAnswer, trước khi ghép:
const step1Emb = await generateEmbedding(step1.content)
const step2Emb = await generateEmbedding(step2.content)
const cosine = computeCosine(step1Emb.vector, step2Emb.vector)
if (cosine < 0.3) {
  // Conflict — prefer user KB (trusted hơn)
  return { content: step1.content, source: 'user-kb' }
}
```
Đây là ML fix nhỏ — thêm vào Phase 4 Proposal 3.9 (Query rewriting) hoặc tách thành Proposal 5.5.

**Files to edit**: `src/app/api/openclaw/chat/route.ts` (2 code paths).
**Dependencies**: Pre-Phase 1 + Proposal 3 + 4.
**Effort**: M (~2-3 giờ).
**Priority**: P0.

---

## Phase 2 — STRENGTHEN + STOP CONTAMINATION (P1, 2-3 sessions)

**Mục tiêu**: Đóng loop Layer 9 design, thêm observability, làm writeback transactional. Ngắt nốt contamination còn sót (entity resolution, cold start).

**Proposals**: 6, 7, 8 (existing) + 2.5, 4.4 (new ML).

---

### Proposal 6: Atomic multi-store writeback transaction

**Problem**
- `writebackToKB()` viết 5 nơi độc lập (Qdrant + Neo4j + AgentMemory + AgentInsight + LearningLog). Partial failure → orphan records.

**Cách triển khai thực tế**

**Bước 6.1** — Thêm Prisma model `PendingWriteback`:
```prisma
model PendingWriteback {
  id           String   @id @default(cuid())
  batchId      String   @unique
  agentId      String
  sessionId    String
  documentId   String
  payload      String   // JSON plan
  steps        String   @default("[]")
  status       String   @default("pending")
  failedStep   String?
  attempts     Int      @default(0)
  maxAttempts  Int      @default(3)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@index([status])
  @@index([agentId])
}
```

**Bước 6.2** — Tạo `src/lib/kb-routing/transactional-writeback.ts`:
- Stamp `batch_id` vào tất cả payload (Qdrant + Neo4j + SQLite).
- Execute steps idempotent (Neo4j MERGE idempotent ✓, Qdrant upsert idempotent với cùng point id ✓, SQLite `upsert` thay `create`).
- Mark `partial` + `failedStep` nếu 1 step fail.
- Cron reconcile mỗi 5 phút.

(Chi tiết implementation như file gốc — không đổi.)

**ML note**: Bổ sung `vectorValidationStep` sau khi insert Qdrant — query lại chính vector vừa insert bằng cùng query embedding, check top-1 trả về chính nó. Nếu không → flag "vector self-retrieval failed" (lỗi nghiêm trọng — dimension mismatch hoặc collection config sai).

**Bước 6.3** — Endpoint reconcile: `src/app/api/storage/reconcile-writebacks/route.ts`.

**Bước 6.4** — UI audit card trong LearningTabContent.

**Files to edit**: `prisma/schema.prisma`, `src/lib/kb-routing/{writeback,transactional-writeback}.ts`, `src/app/api/storage/{reconcile-writebacks,writebacks}/route.ts`, `src/app/page.tsx`.
**Dependencies**: Proposal 3.
**Effort**: M (~1 ngày).
**Priority**: P1.

---

### Proposal 7: Hook Layer 9 vào code-team workflow

**Problem**
- Layer 9 (`metrics-collector`, `historical-feedback`, `strategy-adapter`) đã code đầy đủ NHƯNG không có caller.

**Cách triển khai thực tế**

**Bước 7.1** — Sửa `src/lib/code-team/workflow-engine.ts`:
- Workflow start → `createMetricsCollector()`.
- Mỗi step → `recordStepStart` → `recordStepComplete` hoặc `recordStepError`.
- On error → `detectFailurePattern` → `recommendAdaptation` → `applyAdaptation`.
- Workflow end → `metrics.flush()`.

(Chi tiết implementation như file gốc.)

**ML note**: Layer 9 hiện track **operational metrics** (token cost, success rate, time spent) — KHÔNG track **ML quality metrics** (recall@5, faithfulness, entity extraction F1). Cần bổ sung:
```ts
// Trong recordStepComplete:
metrics.recallAt5 = await measureRecall(step.expectedEntities, retrievedChunks)
metrics.faithfulness = await measureFaithfulness(step.expectedAnswer, actualAnswer)  // cần cross-model judge
```
- `measureRecall`: % expected entities thực sự được retrieve trong top-5 chunks.
- `measureFaithfulness`: LLM-as-judge (cross-model, per Proposal 11').

Hai metric này populate sau khi Phase 4 (Proposal 11') chạy. Tạm thời schema đã có field (Proposal 2 đã thêm `recallAt5`, `faithfulness`), chỉ populate khi Phase 4 ready.

**Files to edit**: `src/lib/code-team/workflow-engine.ts`.
**Dependencies**: Proposal 2.
**Effort**: M (~1 ngày).
**Priority**: P1.

---

### Proposal 8: Learning metrics dashboard

**Problem**: Layer 9 ghi DB nhưng không có UI hiển thị.

**Cách triển khai thực tế**

**Bước 8.1** — Endpoint `GET /api/openclaw/learning/layer9-metrics`:
- Trả `aggregatedMetrics`, `recentPatterns`, `recentAdaptations`, `successRateTrend`.

**Bước 8.2** — Subpanel "Layer 9 — Adaptation Intelligence" trong LearningTabContent.

**Bước 8.3** — Bổ sung panel **"ML Quality"** (theo ML review):
- Retrieval recall trend (cần Proposal 11' eval data)
- Embedding cache hit rate (hiện đã track, surface lên)
- **Pseudo-hash vector count** (audit metric — phải luôn = 0 sau Pre-Phase 1 Proposal P0.1)
- Auto-learn verification rate (% AgentInsight có `verified=true`)

**Files to edit**: `src/app/api/openclaw/learning/layer9-metrics/route.ts` (new), `src/app/page.tsx`.
**Dependencies**: Proposal 7.
**Effort**: M (~1 ngày).
**Priority**: P1.

---

### Proposal 2.5: Embedding-based entity resolution

**Problem** (ML issue M4)
- `neo4j.ts:870` `MERGE (n:Label {id: e.id})` với `e.id` derive từ name → collision ("React" JS vs "react" chemistry), duplication ("GPT-4" vs "GPT4").

**Cách triển khai thực tế**

**Bước 2.5.1** — Thêm property `embedding` lên Neo4j entity nodes:
```cypher
// Tạo vector index trên Neo4j (cần Aura 5.0+ hoặc Neo4j 5.16+ desktop)
CREATE VECTOR INDEX entity_embedding_index
FOR (n:Concept|Technology|Framework|Vulnerability|Principle|Domain|Document|Person)
ON (n.embedding)
OPTIONS { indexConfig: { `vector.dimensions`: 2048, `vector.similarity_function`: 'cosine' } }
```

**Bước 2.5.2** — Sửa `src/lib/ingestion/entity-resolver.ts` (đã có file, wire vào writeback path):
```ts
export async function resolveEntity(entity: { name: string; description: string; type: string }) {
  // 1. Generate embedding cho entity (name + description)
  const entityText = `${entity.name}: ${entity.description}`
  const { vector } = await generateEmbedding(entityText)
  
  // 2. Query top-5 nearest existing entities bằng vector similarity
  const candidates = await db.$queryRaw`
    MATCH (n:${entity.type})
    WHERE n.embedding IS NOT NULL
    WITH n, vector.similarity(n.embedding, ${vector}) AS score
    WHERE score > 0.85
    RETURN n, score
    ORDER BY score DESC
    LIMIT 5
  `
  
  if (candidates.length === 0) {
    // Không match → create new entity
    return { id: generateId(), isNew: true, embedding: vector }
  }
  
  // 3. Có match → hỏi LLM disambiguate
  const topCandidate = candidates[0]
  const isSame = await llmDisambiguate(entity.name, topCandidate.n.name, entity.description, topCandidate.n.description)
  
  if (isSame) {
    // Merge: update description if longer
    return { id: topCandidate.n.id, isNew: false, embedding: vector }
  } else {
    // Distinct → create new
    return { id: generateId(), isNew: true, embedding: vector }
  }
}

async function llmDisambiguate(name1: string, name2: string, desc1: string, desc2: string): Promise<boolean> {
  const prompt = `Are these two entities the same concept?
Entity 1: "${name1}" — ${desc1}
Entity 2: "${name2}" — ${desc2}
Reply with only "YES" or "NO".`
  const r = await callLLM(prompt, undefined, 'disambiguation', { temperature: 0, maxTokens: 5 })
  return r.content.trim().toUpperCase().startsWith('YES')
}
```

**Bước 2.5.3** — Wire vào writeback path:
```ts
// src/lib/kb-routing/writeback.ts — thay vì gọi upsertEntitiesBatch trực tiếp:
for (const entity of entityNodes) {
  const resolved = await resolveEntity(entity)
  // Upsert bằng resolved.id (canonical)
}
```

**Bước 2.5.4** — Migration: sinh embedding cho existing Neo4j entities (script one-time):
```ts
// scripts/backfill-entity-embeddings.ts
import { db } from '../src/lib/db'
import { generateEmbedding } from '../src/lib/embeddings'

const entities = await db.localEntity.findMany({ where: { synced: true } })
for (const e of entities) {
  const { vector } = await generateEmbedding(`${e.entityName}: ${e.description}`)
  // Update Neo4j node embedding property
  await neo4jExecute(`
    MATCH (n:${e.entityType} {id: $id})
    SET n.embedding = $vector
  `, { id: e.id, vector })
}
```

**Bước 2.5.5** — Verify:
```bash
pm2 restart theopusflashlite

# Chat 2 câu cùng entity (vd "React là gì?" rồi "Tell me about React framework")
# Check Neo4j không tạo 2 node "React" khác nhau
cypher-shell -a neo4j+s://6e688b02.databases.neo4j.io -u 6e688b02 -p "$NEO4J_PASSWORD" \
  "MATCH (n:Framework) WHERE toLower(n.name) CONTAINS 'react' RETURN n.name, n.id"
# Phải trả 1 row duy nhất (canonical) — không 2 row
```

**Files to edit**: `src/lib/ingestion/entity-resolver.ts`, `src/lib/kb-routing/writeback.ts`, `scripts/backfill-entity-embeddings.ts` (new).
**Dependencies**: Pre-Phase 1 + Proposal 1 (embedding work) + Proposal 3 (writeback fixed).
**Effort**: M (~1 ngày).
**Priority**: P1.
**Risks**: Neo4j Aura Free có thể không support vector index — cần verify Aura tier. Nếu không support, dùng external index (Qdrant) cho entity vectors + graph query kết hợp.

---

### Proposal 4.4: Cold start mode (no auto-learn first N queries)

**Problem** (ML issue M16)
- Fresh install → KB empty → mọi query confidence < 0.85 → auto-learn trigger cho mọi query → KB fill đầy unverified LLM output trong vài giờ đầu.

**Cách triển khai thực tế**

**Bước 4.4.1** — Sửa `src/lib/auto-learn.ts`:
```ts
// Thêm check cold start
async function shouldAutoLearnConsideringColdStart(agentId: string, confidence: number): Promise<boolean> {
  const insightCount = await db.agentInsight.count({ where: { agentId } })
  
  const COLD_START_THRESHOLD = parseInt(process.env.COLD_START_INSIGHT_THRESHOLD || '100')
  const CONSERVATIVE_THRESHOLD = parseInt(process.env.CONSERVATIVE_INSIGHT_THRESHOLD || '500')
  const CONSERVATIVE_CONFIDENCE_MIN = parseFloat(process.env.CONSERVATIVE_CONFIDENCE_MIN || '0.7')
  
  if (insightCount < COLD_START_THRESHOLD) {
    console.log(`[AutoLearn] Cold start mode — only ${insightCount}/${COLD_START_THRESHOLD} insights, skipping auto-learn`)
    return false
  }
  
  if (insightCount < CONSERVATIVE_THRESHOLD) {
    // Conservative mode — yêu cầu confidence cao hơn
    if (confidence < CONSERVATIVE_CONFIDENCE_MIN) {
      console.log(`[AutoLearn] Conservative mode — confidence ${confidence.toFixed(2)} < ${CONSERVATIVE_CONFIDENCE_MIN}, skipping`)
      return false
    }
  }
  
  // Normal mode — fallback sang Pre-Phase 1 P0.2 logic (verified=false)
  return true
}

// Trong autoLearnFromAnswer:
if (!await shouldAutoLearnConsideringColdStart(input.agentId, input.confidence)) {
  return false
}
// ... tiếp tục logic chuẩn ...
```

**Bước 4.4.2** — Env vars:
```bash
# .env thêm
COLD_START_INSIGHT_THRESHOLD=100
CONSERVATIVE_INSIGHT_THRESHOLD=500
CONSERVATIVE_CONFIDENCE_MIN=0.7
```

**Bước 4.4.3** — Verify:
```bash
pm2 restart theopusflashlite

# Fresh DB: clear AgentInsight
sqlite3 /home/z/my-project/db/custom.db "DELETE FROM AgentInsight;"

# Chat 10 câu factual
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -sX POST http://localhost:3000/api/openclaw/chat \
    -H 'Content-Type: application/json' \
    -d "{\"message\":\"What is topic $i?\",\"agentProfileId\":\"...\",\"sessionId\":\"...\"}" > /dev/null
done

# Check: 0 insight được tạo (cold start)
sqlite3 /home/z/my-project/db/custom.db "SELECT COUNT(*) FROM AgentInsight;"
# Phải thấy 0

# Test conservative mode: insert 100 fake insights
for i in $(seq 1 100); do
  sqlite3 /home/z/my-project/db/custom.db "INSERT INTO AgentInsight (id, agentId, content, source, type, confidence, verified, createdAt, updatedAt) VALUES ('fake-$i', 'default', 'fake $i', 'manual', 'factual', 0.7, 1, datetime('now'), datetime('now'));"
done

# Chat 1 câu với confidence thấp (0.5) → KHÔNG auto-learn (conservative mode)
# Chat 1 câu với confidence cao (0.8) → auto-learn (conservative mode pass)
```

**Files to edit**: `src/lib/auto-learn.ts`, `.env`.
**Dependencies**: Pre-Phase 1 Proposal P0.2 (verified=false logic).
**Effort**: S (~2 giờ).
**Priority**: P1.

---

## Phase 3 — SCALE + OBSERVABILITY (P1-P2, 2-3 sessions)

**Mục tiêu**: Smolab durable, learning data backup full (SQLite + Qdrant + Neo4j), observability cho embedding model version.

**Proposals**: 9, 10 (existing) + 10.5, 4.1 (new).

---

### Proposal 9: Durable SQLite-backed Smolab task queue

(Implementation như file gốc — không thay đổi.)

**Files to edit**: `prisma/schema.prisma`, `src/lib/smolab/{background-task-worker,task-handlers,index}.ts`, `src/instrumentation.ts`.
**Dependencies**: Không.
**Effort**: M (~1-2 ngày).
**Priority**: P1.

---

### Proposal 10: Supabase backup cho learning tables

(Implementation như file gốc — không thay đổi.)

**ML note**: Sau khi backup, cần verify restore đầy đủ — bao gồm `verified` field (Pre-Phase 1 Proposal P0.2) và `chunking_strategy` (Pre-Phase 1 Proposal P0.3) trên Qdrant. Nếu restore SQLite nhưng Qdrant trống → vẫn mất vector. Cần Proposal 10.5 cho full backup.

**Files to edit**: `src/lib/supabase-sync.ts`, new migration SQL.
**Dependencies**: Không.
**Effort**: S (~3-4 giờ).
**Priority**: P1.

---

### Proposal 10.5: Full backup Qdrant snapshot + Neo4j dump → R2

**Problem**
- Proposal 10 chỉ backup SQLite metadata. Nếu sandbox reset → restore SQLite nhưng Qdrant + Neo4j trống → query rỗng.

**Cách triển khai thực tế**

**Bước 10.5.1** — Qdrant snapshot:
```bash
# Tạo snapshot
curl -sX POST http://localhost:6333/collections/theopus_chunks/snapshot \
  -H 'Content-Type: application/json'

# List snapshots
curl -s http://localhost:6333/collections/theopus_chunks/snapshot | jq

# Download snapshot file
curl -s http://localhost:6333/collections/theopus_chunks/snapshots/<snapshot-name> -o /tmp/qdrant-snapshot.tar.gz

# Upload lên R2 (dùng aws-cli hoặc rclone)
aws s3 cp /tmp/qdrant-snapshot.tar.gz s3://themagnumopus/backups/qdrant/$(date +%Y%m%d).tar.gz \
  --endpoint-url https://<account-id>.r2.cloudflarestorage.com
```

**Bước 10.5.2** — Neo4j dump:
```bash
# Dùng cypher-shell với apoc.export
cypher-shell -a neo4j+s://6e688b02.databases.neo4j.io -u 6e688b02 -p "$NEO4J_PASSWORD" \
  "CALL apoc.export.cypher.all('/tmp/neo4j-dump.cypher', {format: 'cypher', useOptimizations: {type: 'NONE'}})"

# Compress + upload R2
tar -czf /tmp/neo4j-dump.tar.gz -C /tmp neo4j-dump.cypher
aws s3 cp /tmp/neo4j-dump.tar.gz s3://themagnumopus/backups/neo4j/$(date +%Y%m%d).tar.gz \
  --endpoint-url https://<account-id>.r2.cloudflarestorage.com
```

**Bước 10.5.3** — Endpoint tạo + restore:
```ts
// src/app/api/storage/snapshot-full/route.ts
import { r2Storage } from '@/lib/r2-storage'

export async function POST(req: Request) {
  const { store } = await req.json()  // 'qdrant' | 'neo4j' | 'all'
  
  if (store === 'qdrant' || store === 'all') {
    // Trigger Qdrant snapshot
    await fetch('http://localhost:6333/collections/theopus_chunks/snapshot', { method: 'POST' })
    // Wait + download + upload R2
    const snapshotUrl = await downloadAndUploadQdrantSnapshot()
  }
  
  if (store === 'neo4j' || store === 'all') {
    const dumpUrl = await exportAndUploadNeo4jDump()
  }
  
  return NextResponse.json({ status: 'completed', snapshots: { qdrant: snapshotUrl, neo4j: dumpUrl } })
}

// src/app/api/storage/restore-full/route.ts
export async function POST(req: Request) {
  const { date } = await req.json()
  // Download từ R2 → restore Qdrant + Neo4j
}
```

**Bước 10.5.4** — Schedule weekly cron (Saturday 3AM):
```bash
# Crontab hoặc qua app's CronJob table
0 3 * * 6 curl -X POST http://localhost:3000/api/storage/snapshot-full -H 'Content-Type: application/json' -d '{"store":"all"}'
```

**Bước 10.5.5** — Verify:
```bash
# Tạo snapshot
curl -sX POST http://localhost:3000/api/storage/snapshot-full -H 'Content-Type: application/json' -d '{"store":"all"}'

# Check R2 bucket
aws s3 ls s3://themagnumopus/backups/ --endpoint-url https://<account-id>.r2.cloudflarestorage.com
# Phải thấy qdrant/<date>.tar.gz + neo4j/<date>.tar.gz

# Test restore (trên sandbox khác hoặc sau khi reset)
curl -sX POST http://localhost:3000/api/storage/restore-full -H 'Content-Type: application/json' -d '{"date":"2025-XX-XX"}'
# Phải restore đầy đủ Qdrant chunks + Neo4j nodes
```

**Files to edit**: `src/app/api/storage/{snapshot-full,restore-full}/route.ts` (new), `src/lib/r2-storage.ts` (extend).
**Dependencies**: Proposal 10 (Supabase backup cho metadata).
**Effort**: M (~1 ngày).
**Priority**: P1.
**Risks**: Neo4j Aura Free có thể không support `apoc.export.cypher.all` — cần verify tier. Nếu không support, dùng `cypher-shell` dump tay (export từng label một).

---

### Proposal 4.1: Embedding model versioning

**Problem** (ML issue M13)
- NVIDIA silent update `nemotron-embed-1b-v2` → vector cũ invalidated → không có alert.

**Cách triển khai thực tế**

**Bước 4.1.1** — Thêm field `embedding_model_version` vào Qdrant payload (đã có trong Pre-Phase 1 P0.1):
```ts
// Mọi chunk insert phải set:
embedding_model_version: process.env.NVIDIA_EMBED_MODEL + '@' + EMBEDDING_MODEL_RELEASE_DATE
// vd: 'nvidia/llama-nemotron-embed-1b-v2@2025-03-15'
```

**Bước 4.1.2** — Track current_model_version:
```prisma
model EmbeddingModelVersion {
  id          String   @id @default(cuid())
  modelName   String   // 'nvidia/llama-nemotron-embed-1b-v2'
  versionTag  String   // '2025-03-15'
  activeSince DateTime @default(now())
  deprecatedAt DateTime?
  
  @@unique([modelName, versionTag])
}
```

**Bước 4.1.3** — Drift check trước retrieve:
```ts
// src/lib/kb-routing/kb-access.ts
async function checkModelDrift(): Promise<{ drifted: boolean; oldestVersion?: string }> {
  // Sample 10 points random từ Qdrant
  const sample = await qdrant.scroll(COLLECTION_CHUNKS, { limit: 10, with_payload: true })
  const versions = sample.points.map(p => p.payload?.embedding_model_version).filter(Boolean)
  
  if (versions.length === 0) {
    return { drifted: false }  // chưa có data
  }
  
  const currentVersion = process.env.NVIDIA_EMBED_MODEL + '@' + EMBEDDING_MODEL_RELEASE_DATE
  const hasOldVersion = versions.some(v => v !== currentVersion)
  
  if (hasOldVersion) {
    console.warn('[KB-Access] Embedding model drift detected — some vectors use old version')
    return { drifted: true, oldestVersion: versions[0] }
  }
  return { drifted: false }
}
```

**Bước 4.1.4** — Re-embed script:
```ts
// scripts/reembed-all.ts
import { db } from '../src/lib/db'
import { generateEmbedding } from '../src/lib/embeddings'
import { qdrant, COLLECTION_CHUNKS } from '../src/lib/qdrant'

const points = await qdrant.scroll(COLLECTION_CHUNKS, { limit: 100, with_payload: true })
for (const p of points.points) {
  const text = p.payload?.content
  if (!text) continue
  
  const { vector } = await generateEmbedding(text)
  await qdrant.upsert(COLLECTION_CHUNKS, {
    points: [{
      id: p.id,
      vector,
      payload: { ...p.payload, embedding_model_version: CURRENT_VERSION },
    }]
  })
}
```

**Bước 4.1.5** — Verify:
```bash
pm2 restart theopusflashlite

# Query 1 câu → check log drift check
tail -20 /home/z/my-project/dev.log | grep 'model drift'
# Nếu KB empty → "drifted: false"
# Nếu có data cũ không có version → "drifted: true"
```

**Files to edit**: `prisma/schema.prisma`, `src/lib/qdrant.ts`, `src/lib/kb-routing/kb-access.ts`, `scripts/reembed-all.ts` (new).
**Dependencies**: Pre-Phase 1 Proposal P0.1 (vector_provider field).
**Effort**: S (~3 giờ).
**Priority**: P2.

---

## Phase 4 — ML QUALITY (P2, 3-5 sessions)

**Mục tiêu**: Từ "hệ thống học" → "chứng minh được hệ thống học". Đo + cải thiện chất lượng ML thực sự (recall, faithfulness, F1).

**Prerequisite**: Pre-Phase 1 + Phase 1-3 đã xong. ML pipeline chạy đúng, có data thật để eval.

**Proposals**: 11' (replaces 11), 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11.

---

### Proposal 11': Eval harness với cross-model judge (REPLACES Proposal 11)

**Problem** (ML issue M9)
- Proposal 11 gốc dùng cùng NVIDIA NIM cho 3 vai trò: sinh golden Q&A + sinh answer + LLM-as-judge → 3 lần circular bias (self-preference + verbosity + position).
- Golden set LLM-generated → bias kép (model sinh câu hỏi nó giỏi trả lời).
- Single judge → không có variance estimate.
- Free-form scoring "score 0-1" dễ bias hơn binary rubric.

**Cách triển khai thực tế**

**Bước 11'.1** — Prisma models:
```prisma
model EvalCase {
  id               String   @id @default(cuid())
  question         String
  expectedAnswer   String
  expectedEntities String   @default("[]")  // JSON: [{name, type}]
  category         String   // "programming" | "algorithm" | "ml" | "security" | "linux"
  difficulty       String   @default("medium")
  source           String   @default("llm_generated")  // "llm_generated" | "human_curated" — MỚI
  active           Boolean  @default(true)
  createdAt        DateTime @default(now())
  @@index([category, active])
}

model EvalResult {
  id                          String   @id @default(cuid())
  caseId                      String
  runId                       String
  answer                      String
  retrievedChunks             Int      @default(0)
  expectedEntitiesInAnswer    Int      @default(0)
  expectedEntitiesExtracted    Int      @default(0)
  recallAt5                   Float    @default(0)
  faithfulnessMedian          Float    @default(0)  // MỚI — median của 3 judges
  faithfulnessScores          String   @default("[]")  // JSON: [score_judge1, score_judge2, score_judge3]
  extractionF1                Float    @default(0)
  latencyMs                   Int
  createdAt                    DateTime @default(now())
  @@index([runId])
  @@index([caseId])
}

model EvalRun {
  id            String   @id @default(cuid())
  caseCount     Int
  avgRecallAt5  Float
  avgFaithfulness Float
  avgF1         Float
  avgLatencyMs  Int
  startedAt     DateTime @default(now())
  completedAt   DateTime?
}
```

**Bước 11'.2** — Golden set: 50% LLM + 50% human-curated:
```ts
// scripts/seed-eval.ts
async function generateLLMCases(): Promise<EvalCase[]> {
  // 50 cases sinh bằng NVIDIA NIM với constraint diversity
  // ...
}

async function importHumanCuratedCases(): Promise<EvalCase[]> {
  // Import từ AgentInsight có verified=true + có AgentCorrection (đã có user feedback)
  // Insight verified + correction = đúng format cho eval case
  const insights = await db.agentInsight.findMany({
    where: { verified: true, source: 'manual' },
    take: 50,
  })
  return insights.map(i => ({
    question: extractQueryFromContent(i.content),
    expectedAnswer: extractAnswerFromContent(i.content),
    expectedEntities: '[]',  // có thể extract sau
    source: 'human_curated',
    category: 'mixed',
    difficulty: 'medium',
  }))
}

// Mix: 50 LLM + 50 human = 100 cases
```

**Bước 11'.3** — Cross-model judge (3 judges):
```ts
// src/lib/eval/judges.ts
type JudgeResult = { score: number; reasoning: string }

const JUDGES = [
  { name: 'openai-gpt4o-mini', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
  { name: 'anthropic-claude-haiku', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-3-5-haiku-20241022' },
  // Judge 3: dùng NVIDIA nhưng với prompt hoàn toàn khác + binary rubric thay vì free-form
  { name: 'nvidia-binary-rubric', endpoint: NVIDIA_ENDPOINT, model: 'nvidia/nemotron-3-ultra-550b-a55b', isBinary: true },
]

async function judgeAnswer(question: string, expected: string, actual: string): Promise<{ median: number; scores: number[]; reasoning: string[] }> {
  const results: JudgeResult[] = []
  
  for (const judge of JUDGES) {
    if (judge.isBinary) {
      // Binary rubric — dễ hơn cho LLM, ít bias hơn
      const checks = [
        `Does the answer mention "${extractKeyTerms(expected)[0]}"? Y/N`,
        `Does the answer correctly state that ${extractKeyClaim(expected)}? Y/N`,
        `Is the answer free from hallucinated facts not in expected answer? Y/N`,
      ]
      let yesCount = 0
      for (const check of checks) {
        const r = await callJudge(judge, check)
        if (r.trim().toUpperCase().startsWith('Y')) yesCount++
      }
      results.push({ score: yesCount / checks.length, reasoning: `${yesCount}/${checks.length} checks passed` })
    } else {
      // Free-form (judge 1 + 2)
      const prompt = `Question: ${question}\nExpected: ${expected}\nActual: ${actual}\n\nScore 0-1 how faithful the actual is to expected. Reply with just a number.`
      const r = await callJudge(judge, prompt)
      const score = parseFloat(r.trim()) || 0
      results.push({ score, reasoning: '' })
    }
  }
  
  const scores = results.map(r => r.score)
  const median = scores.sort()[Math.floor(scores.length / 2)]
  return { median, scores, reasoning: results.map(r => r.reasoning) }
}
```

**Bước 11'.4** — Endpoint `POST /api/eval/run`:
```ts
// Giống Proposal 11 gốc NHƯNG:
// - Golden set mix 50/50 LLM + human
// - 3 judges cross-model, median thay vì single
// - Binary rubric cho judge #3
// - Track `faithfulnessScores` (array) + `faithfulnessMedian` (number)

// Sau eval pass với faithfulnessMedian > 0.7:
// Mark AgentInsight verified=true (Pre-Phase 1 P0.2 Trigger 2)
await db.agentInsight.updateMany({
  where: { /* match insight → case */ },
  data: { verified: true, verificationSource: 'eval_pass', verifiedAt: new Date() },
})
```

**Bước 11'.5** — Negative eval cases (out-of-domain queries):
```ts
// Thêm 10 negative cases vào EvalCase (câu hỏi về topic KB không có)
// vd: "What is the capital of Mars?" → expected answer: "I don't know"
// Metric: hệ thống phải return "I don't know" (KHÔNG hallucinate)
// If hallucinate → faithfulnessMedian thấp, flag "hallucination detected"
```

**Bước 11'.6** — UI card "Evaluation Results" trong Learning tab:
```tsx
<Card>
  <CardHeader>
    <CardTitle className="text-sm">Evaluation Results</CardTitle>
    <Button size="sm" onClick={() => runEval()}>Run Eval (100 cases)</Button>
  </CardHeader>
  <CardContent>
    {evalResults && (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <div><div className="text-muted-foreground">Recall@5</div><div className="text-2xl font-mono">{(evalResults.avgRecallAt5 * 100).toFixed(0)}%</div></div>
        <div><div className="text-muted-foreground">Faithfulness (median)</div><div className="text-2xl font-mono">{(evalResults.avgFaithfulness * 100).toFixed(0)}%</div></div>
        <div><div className="text-muted-foreground">Entity F1</div><div className="text-2xl font-mono">{(evalResults.avgF1 * 100).toFixed(0)}%</div></div>
        <div><div className="text-muted-foreground">Hallucination</div><div className="text-2xl font-mono">{evalResults.hallucinationCount}</div></div>
        <div><div className="text-muted-foreground">Latency</div><div className="text-2xl font-mono">{(evalResults.avgLatencyMs / 1000).toFixed(1)}s</div></div>
      </div>
    )}
  </CardContent>
</Card>
```

**Bước 11'.7** — Run eval định kỳ (cron nightly 2AM).

**Bước 11'.8** — Verify:
```bash
pm2 restart theopusflashlite

# Run eval 10 cases (dryRun trước)
curl -sX POST http://localhost:3000/api/eval/run -H 'Content-Type: application/json' -d '{"caseLimit":10}'

# Check EvalResult có 3 scores (judges), median
sqlite3 /home/z/my-project/db/custom.db \
  "SELECT caseId, faithfulnessMedian, faithfulnessScores FROM EvalResult ORDER BY createdAt DESC LIMIT 5;"

# Check hallucination detection (negative cases)
sqlite3 /home/z/my-project/db/custom.db \
  "SELECT COUNT(*) FROM EvalResult r JOIN EvalCase c ON r.caseId = c.id WHERE c.expectedAnswer LIKE '%I don%'t know%' AND r.answer NOT LIKE '%I don%'t know%';"
```

**Files to edit**: `prisma/schema.prisma` (+EvalRun model, EvalCase thêm `source`, EvalResult thêm `faithfulnessMedian`+`faithfulnessScores`), `scripts/seed-eval.ts`, `src/lib/eval/judges.ts` (new), `src/app/api/eval/{run,results}/route.ts`, `src/app/page.tsx`.
**Env vars**: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (cho 2 judges cross-model).
**Dependencies**: Pre-Phase 1 + Phase 1 + 2.5 + 4.4 (pipeline phải chạy đúng để eval đo đúng).
**Effort**: L (~2-3 ngày).
**Priority**: P2.
**Risks**: 
- Tốn token (100 cases × 5 LLM calls/case × 3 judges = 1500 calls/run). Nên có flag `dryRun` + limit cases.
- OpenAI/Anthropic API cost: 100 cases × ~$0.001/call = $0.10/run — acceptable cho nightly.
- Binary rubric judge cần prompt tuning — nếu rubric sai → metric sai.

---

### Proposal 3.5: Confidence calibration

**Problem** (ML issue M5)
- `kb-access.ts:175` heuristic: `chunks_score × 0.5 + min(0.3, entities × 0.1) + min(0.2, memories × 0.1)`.
- Linear combine các signal khác bản chất → sai về probability theory.
- Không calibrate trên data thật.

**Cách triển khai thực tế**

**Bước 3.5.1** — Sau khi có EvalResult (Proposal 11'), train logistic regression:
```ts
// scripts/train-calibration.ts
import { db } from '../src/lib/db'

async function trainCalibration() {
  // Lấy tất cả EvalResult có faithfulnessMedian
  const results = await db.evalResult.findMany({
    where: { faithfulnessMedian: { not: null } },
    include: { case: true },
  })
  
  // Build training set: (raw_confidence, was_answer_correct)
  // raw_confidence = retrieval_confidence (Step 1) — cần track riêng
  // was_answer_correct = faithfulnessMedian > 0.7 ? 1 : 0
  
  const X = results.map(r => r.rawRetrievalConfidence)  // cần thêm field này vào EvalResult
  const Y = results.map(r => r.faithfulnessMedian > 0.7 ? 1 : 0)
  
  // Logistic regression (đơn giản — gradient descent)
  // y = sigmoid(intercept + coef * x)
  let intercept = 0, coef = 1, lr = 0.01, epochs = 1000
  for (let e = 0; e < epochs; e++) {
    let gradIntercept = 0, gradCoef = 0
    for (let i = 0; i < X.length; i++) {
      const pred = 1 / (1 + Math.exp(-(intercept + coef * X[i])))
      gradIntercept += (pred - Y[i])
      gradCoef += (pred - Y[i]) * X[i]
    }
    intercept -= lr * gradIntercept / X.length
    coef -= lr * gradCoef / X.length
  }
  
  console.log(`Calibrated: intercept=${intercept}, coef=${coef}`)
  // Lưu vào DB
  await db.calibrationModel.upsert({
    where: { id: 'default' },
    create: { id: 'default', intercept, coef, trainedAt: new Date() },
    update: { intercept, coef, trainedAt: new Date() },
  })
}

trainCalibration()
```

**Bước 3.5.2** — Thêm Prisma model:
```prisma
model CalibrationModel {
  id          String   @id @default("default")
  intercept   Float
  coef        Float
  trainedAt   DateTime @updatedAt
  sampleSize  Int
}
```

**Bước 3.5.3** — Apply calibration trong `kb-access.ts`:
```ts
async function getCalibratedConfidence(rawConfidence: number): Promise<number> {
  const model = await db.calibrationModel.findUnique({ where: { id: 'default' } })
  if (!model) return rawConfidence  // fallback nếu chưa train
  return 1 / (1 + Math.exp(-(model.intercept + model.coef * rawConfidence)))
}

// Trong calculateConfidence:
const raw = calculateRawConfidence(chunks, entities, memories)
const calibrated = await getCalibratedConfidence(raw)
return calibrated
```

**Bước 3.5.4** — Auto-retrain mỗi 100 eval runs:
```ts
// Trong POST /api/eval/run sau khi xong:
const runCount = await db.evalRun.count()
if (runCount % 100 === 0) {
  await fetch('/api/eval/retrain-calibration', { method: 'POST' })
}
```

**Bước 3.5.5** — Verify:
```bash
# Sau khi có 50+ EvalResult:
sqlite3 /home/z/my-project/db/custom.db "SELECT COUNT(*) FROM EvalResult WHERE faithfulnessMedian IS NOT NULL;"
# Phải > 50

bun run scripts/train-calibration.ts
# Log: "Calibrated: intercept=..., coef=..."

sqlite3 /home/z/my-project/db/custom.db "SELECT * FROM CalibrationModel;"
# Có row với intercept + coef

# Query lại 1 câu → check calibrated confidence
tail -20 /home/z/my-project/dev.log | grep 'KB-Access'
# Log phải thấy "confidence=0.X (calibrated=0.Y)"
```

**Files to edit**: `prisma/schema.prisma`, `src/lib/kb-routing/kb-access.ts`, `scripts/train-calibration.ts` (new), `src/lib/calibration.ts` (new).
**Dependencies**: Proposal 11' (cần eval data để train).
**Effort**: M (~1 ngày).
**Priority**: P2.

---

### Proposal 3.6: 2-stage retrieval (bi-encoder + cross-encoder rerank)

**Problem** (ML issue M6)
- Pure bi-encoder (Qdrant search) → recall@5 suy giảm 5-15% so với 2-stage.

**Cách triển khai thực tế**

**Bước 3.6.1** — Tạo `src/lib/kb-routing/reranker.ts`:
```ts
import { fetch } from 'undici'

const RERANKER_ENDPOINT = process.env.RERANKER_ENDPOINT || 'http://localhost:8080/rerank'
const RERANKER_MODEL = process.env.RERANKER_MODEL || 'BAAI/bge-reranker-v2-m3'

interface RerankResult {
  index: number
  score: number
}

export async function rerankTopK(query: string, chunks: Array<{ id: string; text: string }>): Promise<Array<{ id: string; score: number }>> {
  if (chunks.length === 0) return []
  
  try {
    const response = await fetch(RERANKER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: RERANKER_MODEL,
        query,
        documents: chunks.map(c => c.text),
      }),
    })
    
    if (!response.ok) {
      console.warn('[Reranker] HTTP', response.status, '— returning bi-encoder order')
      return chunks.map((c, i) => ({ id: c.id, score: 1 - i * 0.1 }))
    }
    
    const data = await response.json() as { results: RerankResult[] }
    return data.results.map(r => ({
      id: chunks[r.index].id,
      score: r.score,
    }))
  } catch (err) {
    console.warn('[Reranker] failed:', err instanceof Error ? err.message : String(err))
    return chunks.map((c, i) => ({ id: c.id, score: 1 - i * 0.1 }))
  }
}
```

**Bước 3.6.2** — Host bge-reranker (mini-service):
```bash
# Tạo mini-service reranker
mkdir -p /home/z/tmo-app/mini-services/reranker
cat > /home/z/tmo-app/mini-services/reranker/index.ts << 'EOF'
import { serve } from 'bun'
import { pipeline } from '@xenova/transformers'

const reranker = await pipeline('text-classification', 'Xenova/bge-reranker-v2-m3')

serve({
  port: 8080,
  async fetch(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
    const { query, documents } = await req.json()
    const results = []
    for (let i = 0; i < documents.length; i++) {
      const score = await reranker([{ text: query }, { text: documents[i] }], { pooling: 'mean', normalize: true })
      results.push({ index: i, score: score.data[0] })
    }
    results.sort((a, b) => b.score - a.score)
    return Response.json({ results })
  }
})
EOF
```

**Bước 3.6.3** — Wire vào `kb-access.ts`:
```ts
// Trước:
const chunks = await searchChunks(query, topK)

// Sau (2-stage):
const candidateChunks = await searchChunks(query, topK * 4)  // top-20 từ bi-encoder
const reranked = await rerankTopK(query, candidateChunks)
const topKChunks = reranked.slice(0, topK).map(r => {
  const chunk = candidateChunks.find(c => c.id === r.id)!
  return { ...chunk, score: r.score }
})
```

**Bước 3.6.4** — Cache rerank results:
```ts
const rerankCache = new Map<string, Array<{ id: string; score: number }>>()
const cacheKey = hashText(query) + ':' + candidateChunks.map(c => c.id).join(',')
if (rerankCache.has(cacheKey)) return rerankCache.get(cacheKey)!
// ... rerank ...
rerankCache.set(cacheKey, result)
```

**Bước 3.6.5** — Verify (cần Proposal 11' để đo recall@5 improvement):
```bash
# Start reranker mini-service
cd /home/z/tmo-app/mini-services/reranker
bun install @xenova/transformers
bun run index.ts &

# Restart app
pm2 restart theopusflashlite

# Run eval
curl -sX POST http://localhost:3000/api/eval/run -H 'Content-Type: application/json' -d '{"caseLimit":50}'

# Compare recall@5 trước/sau rerank — phải tăng 5-15%
```

**Files to edit**: `src/lib/kb-routing/reranker.ts` (new), `src/lib/kb-routing/kb-access.ts`, `mini-services/reranker/index.ts` (new).
**Dependencies**: Proposal 11' (verify improvement).
**Effort**: M (~1 ngày).
**Priority**: P2.
**Risks**: bge-reranker-v2-m3 download ~560MB model file — first run slow. Cần pre-download.

---

### Proposal 3.7: Hybrid search (BM25 + dense, RRF fusion)

**Problem** (ML issue M7)
- Pure dense vector → yếu với exact match (tên entity, mã lỗi, code identifier).

**Cách triển khai thực tế**

**Bước 3.7.1** — Enable sparse vectors trong Qdrant collection:
```bash
# Recreate collection với sparse vectors config
curl -sX DELETE http://localhost:6333/collections/theopus_chunks
curl -sX PUT http://localhost:6333/collections/theopus_chunks \
  -H 'Content-Type: application/json' \
  -d '{
    "vectors": {
      "dense": { "size": 2048, "distance": "Cosine" }
    },
    "sparse_vectors": {
      "bm25": { "index": { "on_disk": false } }
    }
  }'
```

**Bước 3.7.2** — Generate sparse vectors khi insert:
```ts
// src/lib/embeddings.ts — thêm hàm generateSparseVector
import { BM25 } from 'bm25'  // hoặc dùng Qdrant native BM25

export async function generateSparseVector(text: string): Promise<{ indices: number[]; values: number[] }> {
  // Cách 1: dùng Qdrant native (auto-generate từ text field)
  // Cách 2: dùng SPLADE (heavy) 
  // Cách 3: simple TF-IDF
  
  // Recommend Cách 1 — Qdrant native BM25
  // → Set text field name trong collection config, Qdrant auto-tính BM25
  return null  // không cần generate, Qdrant lo
}

// Cách 1: trong Qdrant upsert, set field `text` → Qdrant auto BM25
await qdrant.upsert(COLLECTION_CHUNKS, {
  points: [{
    id: pointId,
    vector: {
      dense: vector,
      // sparse auto-generated từ 'text' field
    },
    payload: { text: chunkText, /* other fields */ }
  }]
})
```

**Bước 3.7.3** — Query với RRF fusion:
```ts
// src/lib/kb-routing/kb-access.ts
const searchResult = await qdrant.queryPoints(COLLECTION_CHUNKS, {
  query: { 
    inputs: [
      { name: 'dense', vector: queryVector },  // dense search
      // sparse auto-extract từ text query
    ]
  },
  limit: topK,
  with_payload: true,
  // RRF fusion:
  fusion: { mode: 'rrf' },  // reciprocal rank fusion
  // Hoặc weighted fusion:
  // fusion: { mode: 'weighted_sum', weights: { dense: 0.7, sparse: 0.3 } }
})
```

**Bước 3.7.4** — Verify (cần Proposal 11'):
```bash
# Recreate collection
curl -sX DELETE http://localhost:6333/collections/theopus_chunks
# (Re-create với config hybrid)
# Re-embed existing chunks (script reembed-all.ts from Proposal 4.1)

# Test query có exact match ("GPT-4", "npm install", "TypeError")
curl -sX POST http://localhost:3000/api/eval/run -H 'Content-Type: application/json' -d '{"category":"programming","caseLimit":20}'

# Recall@5 cho programming queries phải tăng (BM25 giỏi exact match cho code identifier)
```

**Files to edit**: `src/lib/qdrant.ts`, `src/lib/kb-routing/kb-access.ts`.
**Dependencies**: Pre-Phase 1 + Proposal 1 + Proposal 4.
**Effort**: M (~1 ngày).
**Priority**: P2.
**Risks**: Recreate collection = mất data. Cần backup trước (Proposal 10.5) hoặc re-embed mọi chunk hiện có.

---

### Proposal 3.8: MMR diversity trong top-K

**Problem** (ML issue M8)
- Top-K chunks có thể redundant (5 chunk đều từ cùng 1 paragraph).

**Cách triển khai thực tế**

**Bước 3.8.1** — Tạo `src/lib/kb-routing/mmr.ts`:
```ts
import { generateEmbedding } from '@/lib/embeddings'

/**
 * Maximal Marginal Relevance
 * score = λ × sim(query, chunk) - (1-λ) × max(sim(chunk, selected_so_far))
 * λ = 0.7 (default — prioritize relevance over diversity)
 */
export async function mmrRerank(
  query: string,
  chunks: Array<{ id: string; text: string; score: number }>,
  lambda: number = 0.7
): Promise<Array<{ id: string; score: number }>> {
  if (chunks.length <= 1) return chunks
  
  // Embed tất cả chunks (cache nếu đã có)
  const chunkEmbeddings = await Promise.all(
    chunks.map(c => generateEmbedding(c.text))
  )
  
  const selected: number[] = [0]  // start với top-1
  const remaining = chunks.map((_, i) => i).slice(1)
  
  while (remaining.length > 0 && selected.length < chunks.length) {
    let bestIdx = -1
    let bestScore = -Infinity
    
    for (const idx of remaining) {
      const relevance = cosineSim(queryEmbedding, chunkEmbeddings[idx].vector)
      const diversity = Math.max(...selected.map(s => cosineSim(chunkEmbeddings[idx].vector, chunkEmbeddings[s].vector)))
      const mmrScore = lambda * relevance - (1 - lambda) * diversity
      
      if (mmrScore > bestScore) {
        bestScore = mmrScore
        bestIdx = idx
      }
    }
    
    selected.push(bestIdx)
    remaining.splice(remaining.indexOf(bestIdx), 1)
  }
  
  return selected.map((idx, rank) => ({ id: chunks[idx].id, score: chunks[idx].score * (1 - rank * 0.05) }))
}
```

**Bước 3.8.2** — Wire vào `kb-access.ts`:
```ts
// Sau khi có top-K từ Qdrant (hoặc từ reranker nếu Phase 4 Proposal 3.6 đã xong)
const mmrReranked = await mmrRerank(query, topKChunks, 0.7)
```

**Bước 3.8.3** — Verify:
```bash
pm2 restart theopusflashlite

# Query với chủ đề rộng — check top-5 không redundant
curl -sX POST http://localhost:3000/api/openclaw/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Tell me about JavaScript","agentProfileId":"...","sessionId":"..."}'

# Check response.sources — 5 chunks phải cover: JS history + JS syntax + JS frameworks + JS ecosystem + JS limitations
# (Không 5 chunk cùng 1 paragraph)
```

**Files to edit**: `src/lib/kb-routing/mmr.ts` (new), `src/lib/kb-routing/kb-access.ts`.
**Dependencies**: Không.
**Effort**: S (~3 giờ).
**Priority**: P2.

---

### Proposal 3.9: Query rewriting + HyDE

**Problem** (ML issue M10)
- Conversational query ("Hm, what about its performance?" — "its" = React) → embedding thiếu context.
- Short query ("React?") → embedding kém.
- Cross-lingual query → kém.

**Cách triển khai thực tế**

**Bước 3.9.1** — Tạo `src/lib/kb-routing/query-rewriter.ts`:
```ts
import { callLLM } from '@/lib/llm'
import { generateEmbedding } from '@/lib/embeddings'

interface RewriteResult {
  rewrittenQuery: string
  hypotheticalAnswer: string  // HyDE
  expandedQueries: string[]  // 3 paraphrases
  finalEmbedding: number[]  // embed hypothetical answer (HyDE) hoặc average
}

export async function rewriteQuery(
  query: string,
  conversationHistory: Array<{ role: string; content: string }> = []
): Promise<RewriteResult> {
  // 1. Context injection
  const recentMessages = conversationHistory.slice(-3)
  const contextPrompt = recentMessages.map(m => `${m.role}: ${m.content}`).join('\n')
  
  // 2. LLM rewrite — resolve pronouns + expand
  const rewritePrompt = `Given the conversation history, rewrite the user's latest query to be self-contained and unambiguous.

Conversation history:
${contextPrompt || '(none)'}

Latest query: "${query}"

Rewritten query (concise, self-contained, no pronouns):`
  const rewriteResult = await callLLM(rewritePrompt, undefined, 'query-rewrite', {
    temperature: 0.3,
    maxTokens: 100,
  })
  const rewrittenQuery = rewriteResult.content.trim()
  
  // 3. HyDE — generate hypothetical answer
  const hyDEPrompt = `Imagine you are answering this query. Write 1 paragraph (3-5 sentences) hypothetical answer. Be specific.

Query: "${rewrittenQuery}"

Hypothetical answer:`
  const hyDEResult = await callLLM(hyDEPrompt, undefined, 'hyde', {
    temperature: 0.5,
    maxTokens: 300,
  })
  const hypotheticalAnswer = hyDEResult.content.trim()
  
  // 4. Query expansion — 3 paraphrases
  const expansionPrompt = `Generate 3 different paraphrases of this query, each asking the same thing in different words.

Query: "${rewrittenQuery}"

3 paraphrases (one per line, no numbering):`
  const expansionResult = await callLLM(expansionPrompt, undefined, 'query-expand', {
    temperature: 0.7,
    maxTokens: 200,
  })
  const expandedQueries = expansionResult.content.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 3)
  
  // 5. Final embedding — HyDE: embed hypothetical answer thay vì query
  // (HyDE recall@5 +10% trên nhiều benchmark)
  const embResult = await generateEmbedding(hypotheticalAnswer)
  
  return {
    rewrittenQuery,
    hypotheticalAnswer,
    expandedQueries,
    finalEmbedding: embResult.vector,
  }
}
```

**Bước 3.9.2** — Wire vào chat route:
```ts
// src/app/api/openclaw/chat/route.ts — trước khi gọi accessKnowledgeBase
const rewrite = await rewriteQuery(lastUserContent, conversationHistory)

// Dùng rewrite.finalEmbedding thay vì generateQueryEmbedding(query)
const step1 = await searchUserKBWithEmbedding(rewrite.finalEmbedding, agentId, { topK: 5 })
```

**Bước 3.9.3** — Caching rewrite results:
```ts
const rewriteCache = new Map<string, RewriteResult>()
const cacheKey = hashText(query + conversationHistory.map(m => m.content).join(''))
if (rewriteCache.has(cacheKey)) return rewriteCache.get(cacheKey)!
```

**Bước 3.9.4** — Verify (cần Proposal 11' cho conversational eval cases):
```bash
pm2 restart theopusflashlite

# Test conversational query
curl -sX POST http://localhost:3000/api/openclaw/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"What is React?","agentProfileId":"...","sessionId":"sess-1"}'

curl -sX POST http://localhost:3000/api/openclaw/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Tell me about its performance","agentProfileId":"...","sessionId":"sess-1"}'
# Session 1 — "its" = React
# Phải retrieve được React performance chunks, KHÔNG phải generic "performance"

# Check log
tail -50 /home/z/my-project/dev.log | grep -E 'rewrite|HyDE|expand'
```

**Files to edit**: `src/lib/kb-routing/query-rewriter.ts` (new), `src/app/api/openclaw/chat/route.ts`.
**Dependencies**: Không (chạy độc lập).
**Effort**: M (~1 ngày).
**Priority**: P2.
**Risks**: 3 LLM calls/query rewrite → tốn token + latency +1-2s. Cần cache aggressive.

---

### Proposal 3.10: Memory decay algorithm

**Problem** (ML issue M11)
- Memory tier (HOT/WARM/COLD) có nhưng decay algorithm không cụ thể.

**Cách triển khai thực tế**

**Bước 3.10.1** — Implement decay algorithm trong `src/lib/agent-memory.ts`:
```ts
/**
 * importance_decay(t) = importance_0 × exp(-λ × t_days) × (1 + log(1 + access_count))
 * λ = 0.1 (half-life ~7 ngày) — configurable
 */
const DECAY_LAMBDA = parseFloat(process.env.MEMORY_DECAY_LAMBDA || '0.1')
const COLD_THRESHOLD = 0.3  // importance < 0.3 → migrate to COLD
const HOT_THRESHOLD = 0.7  // importance > 0.7 + accessed 24h → migrate to HOT

export async function decayMemories(): Promise<void> {
  const now = new Date()
  const memories = await db.agentMemory.findMany({ where: { isActive: true } })
  
  for (const m of memories) {
    const ageDays = (now.getTime() - m.createdAt.getTime()) / (1000 * 60 * 60 * 24)
    const accessCount = m.accessCount || 0
    const originalImportance = m.importance
    
    // Decay formula
    const decayedImportance = originalImportance * Math.exp(-DECAY_LAMBDA * ageDays) * (1 + Math.log(1 + accessCount))
    
    // Tier migration
    let newTier = m.tier
    if (decayedImportance < COLD_THRESHOLD && m.tier !== 'cold') {
      newTier = 'cold'
    } else if (decayedImportance > HOT_THRESHOLD && m.lastAccessedAt && 
               (now.getTime() - m.lastAccessedAt.getTime()) < 24 * 60 * 60 * 1000 && m.tier !== 'warm') {
      newTier = 'warm'  // Note: HOT tier là WorkingMemory table, không phải AgentMemory
    }
    
    if (decayedImportance !== m.importance || newTier !== m.tier) {
      await db.agentMemory.update({
        where: { id: m.id },
        data: { importance: decayedImportance, tier: newTier },
      })
    }
  }
}

// Cron mỗi 6h
setInterval(() => {
  decayMemories().catch(err => console.warn('[Memory] decay failed', err))
}, 6 * 60 * 60 * 1000)
```

**Bước 3.10.2** — Migration script cho existing memories (1-time):
```ts
// scripts/migrate-memory-tiers.ts
import { db } from '../src/lib/db'

// Tất cả memory hiện có → recompute importance + tier
const memories = await db.agentMemory.findMany()
for (const m of memories) {
  // Apply decay formula
  // Update tier
}
```

**Bước 3.10.3** — Verify:
```bash
pm2 restart theopusflashlite

# Đợi 6h hoặc trigger manually
curl -sX POST http://localhost:3000/api/memory/decay -H 'Content-Type: application/json'

# Check memories có tier đã update
sqlite3 /home/z/my-project/db/custom.db \
  "SELECT tier, COUNT(*), AVG(importance) FROM AgentMemory GROUP BY tier;"
# Phải thấy: cold (importance thấp), warm (importance trung bình)
```

**Files to edit**: `src/lib/agent-memory.ts`, `scripts/migrate-memory-tiers.ts` (new), `src/app/api/memory/decay/route.ts` (new).
**Dependencies**: Không.
**Effort**: M (~1 ngày).
**Priority**: P1.

---

### Proposal 3.11: Semantic graph search

**Problem** (ML issue M12)
- `searchEntitiesForUser` gọi `searchEntities(query, {limit})` → Cypher `WHERE n.name CONTAINS $query`.
- Lexical only — không semantic.
- "Frontend library by Meta" → KHÔNG match "React" (không có chữ "React" trong query).

**Cách triển khai thực tế**

**Bước 3.11.1** — Đảm bảo Proposal 2.5 đã xong (entity có `embedding` property).

**Bước 3.11.2** — Sửa `src/lib/kb-routing/kb-access.ts` `searchEntitiesForUser`:
```ts
async function searchEntitiesForUser(agentId: string, query: string, topK: number): Promise<UserKBResult['entities']> {
  // Trước: lexical CONTAINS
  // const results = await searchEntities(query, { limit: topK })
  
  // Sau: semantic vector search
  const { vector: queryVector } = await generateQueryEmbedding(query)
  
  // Qdrant có thể đã có collection cho entity embeddings, hoặc query trực tiếp Neo4j vector index
  const cypher = `
    MATCH (n)
    WHERE n.embedding IS NOT NULL
    WITH n, vector.similarity(n.embedding, $queryVector) AS score
    WHERE score > 0.6
    RETURN n, score
    ORDER BY score DESC
    LIMIT $topK
  `
  const results = await neo4jExecute(cypher, { queryVector, topK })
  
  // Multi-hop traversal (1-2 hop) — trả related entities
  const entitiesWithRelated = []
  for (const r of results) {
    entitiesWithRelated.push({
      id: r.n.id,
      name: r.n.name,
      type: r.n.entity_type,
      description: r.n.description,
      domain: r.n.domain,
      score: r.score,
    })
    
    // 1-hop neighbors
    const hopCypher = `
      MATCH (n {id: $id})-[r:USES|IMPLEMENTED_IN|EXTENDS|DEPENDS_ON|ALTERNATIVE_TO*1..2]-(neighbor)
      RETURN neighbor, type(r) AS relType
      LIMIT 5
    `
    const related = await neo4jExecute(hopCypher, { id: r.n.id })
    for (const rel of related) {
      if (!entitiesWithRelated.find(e => e.id === rel.neighbor.id)) {
        entitiesWithRelated.push({
          id: rel.neighbor.id,
          name: rel.neighbor.name,
          type: rel.neighbor.entity_type,
          description: rel.neighbor.description,
          domain: rel.neighbor.domain,
          score: r.score * 0.5,  // decay score cho hop-2
        })
      }
    }
  }
  
  return entitiesWithRelated.slice(0, topK)
}
```

**Bước 3.11.3** — (Optional) Microsoft GraphRAG community detection:
```ts
// Tạo community structure qua Leiden algorithm
// (Cần neo4j GDS library hoặc external script)
// Sinh community summary → retrieval theo community (scalable cho graph lớn)
```

**Bước 3.11.4** — Verify (cần Proposal 11'):
```bash
pm2 restart theopusflashlite

# Query semantic không có entity name trong text
curl -sX POST http://localhost:3000/api/openclaw/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Frontend library by Meta for UI","agentProfileId":"...","sessionId":"..."}'

# Phải retrieve được React entity (KHÔNG có chữ "React" trong query)
# Check response.entities — phải có React
```

**Files to edit**: `src/lib/kb-routing/kb-access.ts`, `src/lib/neo4j.ts`.
**Dependencies**: Proposal 2.5 (entity embeddings).
**Effort**: L (~2 ngày).
**Priority**: P3.

---

## Phase 5 — ADVANCED ML (P3, 2-4 sessions)

**Mục tiêu**: Long-term health monitoring + advanced tuning. Chỉ làm khi Phase 1-4 đã xong và có traffic thật.

**Proposals**: 5.1, 5.2.

---

### Proposal 5.1: Concept drift detection

**Problem** (ML issue M15)
- Query distribution shift qua thời gian (vd: agent bắt đầu được dùng cho domain mới) → embedding distribution shift → cần detect + alert.

**Cách triển khai thực tế**

**Bước 5.1.1** — Thêm Prisma model:
```prisma
model QueryCentroid {
  id          String   @id @default(cuid())
  weekStart   DateTime  // Monday 00:00 UTC
  centroid    String   // JSON: number[] (2048-dim)
  queryCount  Int
  computedAt  DateTime @default(now())
  
  @@unique([weekStart])
}
```

**Bước 5.1.2** — Tạo `src/lib/drift-detector.ts`:
```ts
import { db } from '@/lib/db'
import { generateQueryEmbedding } from '@/lib/embeddings'

const DRIFT_THRESHOLD = 0.2

export async function detectDrift(): Promise<{ drifted: boolean; cosineDrift: number; thisWeek: number; lastWeek: number }> {
  // Lấy centroid tuần này + tuần trước
  const thisWeekStart = getWeekStart(new Date())
  const lastWeekStart = new Date(thisWeekStart.getTime() - 7 * 24 * 60 * 60 * 1000)
  
  const thisWeek = await db.queryCentroid.findUnique({ where: { weekStart: thisWeekStart } })
  const lastWeek = await db.queryCentroid.findUnique({ where: { weekStart: lastWeekStart } })
  
  if (!thisWeek || !lastWeek) {
    return { drifted: false, cosineDrift: 0, thisWeek: thisWeek?.queryCount || 0, lastWeek: lastWeek?.queryCount || 0 }
  }
  
  const thisCentroid = JSON.parse(thisWeek.centroid) as number[]
  const lastCentroid = JSON.parse(lastWeek.centroid) as number[]
  const cosineDrift = 1 - cosineSim(thisCentroid, lastCentroid)
  
  return {
    drifted: cosineDrift > DRIFT_THRESHOLD,
    cosineDrift,
    thisWeek: thisWeek.queryCount,
    lastWeek: lastWeek.queryCount,
  }
}

export async function recordQuery(query: string): Promise<void> {
  // Tính embedding
  const { vector } = await generateQueryEmbedding(query)
  
  // Update centroid tuần này (rolling average)
  const weekStart = getWeekStart(new Date())
  const existing = await db.queryCentroid.findUnique({ where: { weekStart } })
  
  if (existing) {
    const oldCentroid = JSON.parse(existing.centroid) as number[]
    const newCount = existing.queryCount + 1
    const newCentroid = oldCentroid.map((v, i) => (v * existing.queryCount + vector[i]) / newCount)
    
    await db.queryCentroid.update({
      where: { weekStart },
      data: {
        centroid: JSON.stringify(newCentroid),
        queryCount: newCount,
      },
    })
  } else {
    await db.queryCentroid.create({
      data: {
        weekStart,
        centroid: JSON.stringify(vector),
        queryCount: 1,
      },
    })
  }
}

function getWeekStart(d: Date): Date {
  const date = new Date(d)
  const day = date.getUTCDay()
  const diff = date.getUTCDate() - day + (day === 0 ? -6 : 1)  // Monday
  date.setUTCDate(diff)
  date.setUTCHours(0, 0, 0, 0)
  return date
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
```

**Bước 5.1.3** — Wire vào chat route:
```ts
// Trong POST /api/openclaw/chat sau khi xử lý xong
await recordQuery(lastUserContent).catch(() => {})
```

**Bước 5.1.4** — Drift report weekly:
```ts
// Cron Monday 9AM
const drift = await detectDrift()
if (drift.drifted) {
  // Alert qua learning dashboard + (optional) email
  console.warn(`[Drift] Concept drift detected: cosineDrift=${drift.cosineDrift.toFixed(3)} (thisWeek=${drift.thisWeek} queries, lastWeek=${drift.lastWeek})`)
}
```

**Bước 5.1.5** — UI panel trong Learning tab:
```tsx
<Card>
  <CardHeader><CardTitle className="text-sm">Concept Drift</CardTitle></CardHeader>
  <CardContent>
    <p>This week: {drift.thisWeek} queries</p>
    <p>Last week: {drift.lastWeek} queries</p>
    <p>Cosine drift: {drift.cosineDrift.toFixed(3)}</p>
    {drift.drifted && (
      <Badge variant="destructive">Drift detected — consider re-embed</Badge>
    )}
  </CardContent>
</Card>
```

**Bước 5.1.6** — Verify:
```bash
pm2 restart theopusflashlite

# Chat 10 câu đa dạng topic
# Đợi 1 tuần (hoặc insert fake centroids)
sqlite3 /home/z/my-project/db/custom.db "INSERT INTO QueryCentroid (id, weekStart, centroid, queryCount, computedAt) VALUES ('fake-last-week', datetime('now', '-7 days'), '[0.1, 0.2, ...]', 10, datetime('now', '-7 days'));"

curl -s http://localhost:3000/api/openclaw/learning/drift | jq
# Phải thấy drifted + cosineDrift
```

**Files to edit**: `prisma/schema.prisma` (QueryCentroid), `src/lib/drift-detector.ts` (new), `src/app/api/openclaw/chat/route.ts`, `src/app/api/openclaw/learning/drift/route.ts` (new), `src/app/page.tsx`.
**Dependencies**: Phase 1 (embedding work).
**Effort**: M (~1 ngày).
**Priority**: P3.

---

### Proposal 5.2: Hard negative mining cho entity threshold

**Problem** (ML issue M17)
- Entity resolution threshold 0.85 (Proposal 2.5) chọn tay, chưa validate trên data thực.

**Cách triển khai thực tế**

**Bước 5.2.1** — Mine hard negatives (cặp entity "gần nhưng khác"):
```ts
// scripts/hard-negative-mining.ts
import { db } from '../src/lib/db'
import { generateEmbedding } from '../src/lib/embeddings'

// Lấy tất cả entity pairs có cosine > 0.7 (nhưng KHÔNG cùng entity)
const entities = await db.localEntity.findMany({ where: { synced: true } })
const embeddings = await Promise.all(entities.map(e => generateEmbedding(`${e.entityName}: ${e.description}`)))

const hardPairs: Array<{ a: typeof entities[0], b: typeof entities[0], cosine: number }> = []
for (let i = 0; i < entities.length; i++) {
  for (let j = i + 1; j < entities.length; j++) {
    const cosine = cosineSim(embeddings[i].vector, embeddings[j].vector)
    if (cosine > 0.7) {
      hardPairs.push({ a: entities[i], b: entities[j], cosine })
    }
  }
}

// Với mỗi pair, hỏi LLM: "Are these the same entity? Y/N"
let truePositives = 0  // cosine > threshold AND same entity
let falsePositives = 0  // cosine > threshold AND different entity
let trueNegatives = 0   // cosine < threshold AND different entity
let falseNegatives = 0  // cosine < threshold AND same entity

for (const pair of hardPairs) {
  const isSame = await llmDisambiguate(pair.a.entityName, pair.b.entityName, pair.a.description, pair.b.description)
  
  // Test với threshold = 0.85
  if (pair.cosine > 0.85) {
    if (isSame) truePositives++
    else falsePositives++
  } else {
    if (isSame) falseNegatives++
    else trueNegatives++
  }
}

// Tìm threshold tối ưu — maximize F1
const thresholds = [0.7, 0.75, 0.8, 0.85, 0.9, 0.95]
for (const t of thresholds) {
  // Re-classify với threshold t
  // Compute precision, recall, F1
}

// Output: optimal threshold + F1
console.log(`Optimal threshold: ${optimalT}, F1: ${f1}`)
```

**Bước 5.2.2** — Apply learned threshold vào Proposal 2.5:
```ts
// src/lib/ingestion/entity-resolver.ts
const ENTITY_MATCH_THRESHOLD = parseFloat(process.env.ENTITY_MATCH_THRESHOLD || '0.85')
// Sau khi hard negative mining: set env ENTITY_MATCH_THRESHOLD=<learned value>
```

**Bước 5.2.3** — Re-run periodically (every 3 months hoặc khi có >1000 new entities):
```bash
bun run scripts/hard-negative-mining.ts
# Output: "Optimal threshold: 0.82, F1: 0.78"
# Update .env ENTITY_MATCH_THRESHOLD=0.82
# Restart app
```

**Bước 5.2.4** — Verify:
```bash
# Cần có >100 entities trong DB
sqlite3 /home/z/my-project/db/custom.db "SELECT COUNT(*) FROM LocalEntity WHERE synced=1;"

# Run mining
bun run scripts/hard-negative-mining.ts

# Check log output
# "Optimal threshold: X.XX, F1: 0.XX"

# Update env + restart
sed -i "s/ENTITY_MATCH_THRESHOLD=.*/ENTITY_MATCH_THRESHOLD=<learned>/" /home/z/tmo-app/.env
pm2 restart theopusflashlite
```

**Files to edit**: `scripts/hard-negative-mining.ts` (new), `src/lib/ingestion/entity-resolver.ts`, `.env`.
**Dependencies**: Proposal 2.5 (entity resolution có threshold).
**Effort**: L (~2 ngày).
**Priority**: P3.
**Risks**: LLM disambiguation cost: 1000 pairs × $0.001 = $1/run. Acceptable cho 3 tháng/lần.

---

## Bảng tổng hợp — tất cả proposals

### Pre-Phase 1 — STOP CONTAMINATION (ML P0)

| # | Title | Effort | Priority | Deps | Files chính |
|---|---|---|---|---|---|
| P0.1 | Loại bỏ pseudo-hash fallback embedding | S | P0 ML | — | `src/lib/embeddings.ts`, `src/lib/{auto-learn,kb-routing/*}.ts`, `src/lib/qdrant.ts` |
| P0.2 | Auto-learn verification gate | M | P0 ML | — | `prisma/schema.prisma`, `src/lib/{auto-learn,kb-routing/*,agent-memory}.ts`, `src/app/api/openclaw/{feedback,learning/teach}/route.ts`, `src/app/page.tsx` |
| P0.3 | Proper chunking strategy (recursive 400+50) | S | P0 ML | — | `src/lib/chunking.ts` (new), `src/lib/{auto-learn,kb-routing/writeback,ingestion/*}.ts`, `src/lib/qdrant.ts` |
| P0.4 | Cache key normalization | S | P0 ML | — | `src/lib/embeddings.ts` |

### Phase 1 — STABILIZE (engineering P0)

| # | Title | Effort | Priority | Deps | Files chính |
|---|---|---|---|---|---|
| 1 | Sửa NVIDIA embedding dim mismatch | S | P0 | P0.1 | `src/lib/embeddings.ts`, `.env` |
| 2 | Add 3 missing Prisma models for Layer 9 | S | P0 | — | `prisma/schema.prisma` |
| 3 | Fix writeback.ts Neo4j signatures + ChunkPayload | S | P0 | — | `src/lib/kb-routing/writeback.ts` |
| 4 | Fix kb-access.ts QdrantClient.search() | S | P0 | P0.1, 1, 3 | `src/lib/kb-routing/kb-access.ts` |
| 5 | Wire `runSmartKB` vào `/api/openclaw/chat` | M | P0 | P0.1, 3, 4 | `src/app/api/openclaw/chat/route.ts` |

### Phase 2 — STRENGTHEN + STOP CONTAMINATION (P1)

| # | Title | Effort | Priority | Deps | Files chính |
|---|---|---|---|---|---|
| 6 | Atomic multi-store writeback transaction | M | P1 | 3 | `prisma/schema.prisma`, `src/lib/kb-routing/{writeback,transactional-writeback}.ts`, `src/app/api/storage/{reconcile-writebacks,writebacks}/route.ts`, `src/app/page.tsx` |
| 7 | Hook Layer 9 vào code-team workflow | M | P1 | 2 | `src/lib/code-team/workflow-engine.ts` |
| 8 | Learning metrics dashboard | M | P1 | 7 | `src/app/api/openclaw/learning/layer9-metrics/route.ts` (new), `src/app/page.tsx` |
| **2.5** | **Embedding-based entity resolution** | **M** | **P1** | **P0.1, 1, 3** | `src/lib/ingestion/entity-resolver.ts`, `src/lib/kb-routing/writeback.ts`, `scripts/backfill-entity-embeddings.ts` (new) |
| **4.4** | **Cold start mode (no auto-learn first N)** | **S** | **P1** | **P0.2** | `src/lib/auto-learn.ts`, `.env` |

### Phase 3 — SCALE + OBSERVABILITY (P1-P2)

| # | Title | Effort | Priority | Deps | Files chính |
|---|---|---|---|---|---|
| 9 | Durable SQLite-backed Smolab task queue | M | P1 | — | `prisma/schema.prisma`, `src/lib/smolab/{background-task-worker,task-handlers,index}.ts`, `src/instrumentation.ts` |
| 10 | Supabase backup cho learning tables | S | P1 | — | `src/lib/supabase-sync.ts`, new migration SQL |
| **10.5** | **Full backup Qdrant snapshot + Neo4j dump → R2** | **M** | **P1** | **10** | `src/app/api/storage/{snapshot-full,restore-full}/route.ts` (new), `src/lib/r2-storage.ts` |
| **4.1** | **Embedding model versioning** | **S** | **P2** | **P0.1** | `prisma/schema.prisma`, `src/lib/{qdrant,kb-routing/kb-access}.ts`, `scripts/reembed-all.ts` (new) |

### Phase 4 — ML QUALITY (P2)

| # | Title | Effort | Priority | Deps | Files chính |
|---|---|---|---|---|---|
| 11' | Eval harness với cross-model judge (REPLACES 11) | L | P2 | P0.1, 1, 2.5, 4.4 | `prisma/schema.prisma`, `scripts/seed-eval.ts`, `src/lib/eval/judges.ts` (new), `src/app/api/eval/{run,results}/route.ts`, `src/app/page.tsx` |
| **3.5** | **Confidence calibration** | **M** | **P2** | **11'** | `prisma/schema.prisma`, `src/lib/kb-routing/kb-access.ts`, `src/lib/calibration.ts` (new), `scripts/train-calibration.ts` (new) |
| **3.6** | **2-stage retrieval (bi + cross-encoder rerank)** | **M** | **P2** | **11'** | `src/lib/kb-routing/{reranker,kb-access}.ts`, `mini-services/reranker/index.ts` (new) |
| **3.7** | **Hybrid search (BM25 + dense, RRF)** | **M** | **P2** | **P0.1, 1, 4** | `src/lib/{qdrant,kb-routing/kb-access}.ts` |
| **3.8** | **MMR diversity trong top-K** | **S** | **P2** | — | `src/lib/kb-routing/{mmr,kb-access}.ts` |
| **3.9** | **Query rewriting + HyDE** | **M** | **P2** | — | `src/lib/kb-routing/{query-rewriter}.ts` (new), `src/app/api/openclaw/chat/route.ts` |
| **3.10** | **Memory decay algorithm** | **M** | **P1** | — | `src/lib/agent-memory.ts`, `src/app/api/memory/decay/route.ts` (new) |
| **3.11** | **Semantic graph search** | **L** | **P3** | **2.5** | `src/lib/kb-routing/kb-access.ts`, `src/lib/neo4j.ts` |

### Phase 5 — ADVANCED ML (P3)

| # | Title | Effort | Priority | Deps | Files chính |
|---|---|---|---|---|---|
| **5.1** | **Concept drift detection** | **M** | **P3** | **1** | `prisma/schema.prisma`, `src/lib/drift-detector.ts` (new), `src/app/api/openclaw/{chat,learning/drift}/route.ts`, `src/app/page.tsx` |
| **5.2** | **Hard negative mining cho entity threshold** | **L** | **P3** | **2.5** | `scripts/hard-negative-mining.ts` (new), `src/lib/ingestion/entity-resolver.ts`, `.env` |

### Total stats

- **Tổng proposals**: 28 (4 Pre-Phase 1 ML + 5 Phase 1 engineering + 5 Phase 2 + 4 Phase 3 + 8 Phase 4 + 2 Phase 5)
- **Effort breakdown**: 12×S + 11×M + 5×L = ~40-55 ngày làm việc cho 1 dev full-time, hoặc **3-4 tuần cho 2 dev song song** (1 engineering track + 1 ML track).
- **Dependency graph highlights**:
  - Pre-Phase 1 phải làm TRƯỚC Phase 1 (ngắt contamination trước khi unlock pipeline)
  - Phase 4 có nhiều dependency trên Pre-Phase 1 + Phase 1 (cần pipeline đúng để eval đo đúng)
  - Phase 5 cần Phase 1-4 xong (cần traffic thật để observe)

---

## Tiêu chí thành công (Definition of Done) cho từng Phase

### Pre-Phase 1 — STOP CONTAMINATION
- [ ] `grep -r "pseudoHash\|generatePseudoHashEmbedding" /home/z/tmo-app/src` trả rỗng (P0.1 đã xóa)
- [ ] `sqlite3 ... "SELECT COUNT(*) FROM AgentInsight WHERE verified=0"` > 0 (P0.2 đã mark unverified cho existing)
- [ ] Qdrant points mới có field `chunking_strategy` và `vector_provider` (P0.3 + P0.1)
- [ ] Cache hit rate test: query 10 câu tương tự → hit rate > 50% (P0.4 normalized)

### Phase 1 — STABILIZE
- [ ] `bunx tsc --noEmit` không còn lỗi nào trong `src/lib/{learning,kb-routing,embeddings}.ts` và `src/app/api/openclaw/chat/route.ts`.
- [ ] `tail -50 /home/z/my-project/dev.log | grep Embedding` thấy NVIDIA embed success ở 2048-dim (không phải pseudo-hash).
- [ ] **Cosine sanity check** (ML): embed "machine learning" + "deep learning" → cosine > 0.7; "machine learning" + "weather forecast" → cosine < 0.3.
- [ ] 1 chat query → Neo4j node count tăng.
- [ ] 1 chat query → Qdrant chunk count tăng.
- [ ] 1 chat query → `/api/openclaw/learning/stats` trả `autoLearnCount` tăng.
- [ ] Response `/api/openclaw/chat` có field `sources` không rỗng và content có tag `[User KB]` hoặc `[Model Knowledge]`.

### Phase 2 — STRENGTHEN + STOP CONTAMINATION
- [ ] 1 chat query fail Neo4j cố ý → `PendingWriteback` có row `status='partial'` → sau 5 phút auto-reconcile thành `completed`.
- [ ] UI Learning tab có subpanel "Layer 9 — Adaptation Intelligence" + "ML Quality" hiển thị data thật.
- [ ] 1 code-team workflow run → `ExecutionMetrics` có 1 row mới.
- [ ] Force 3 lỗi cùng type → `FailurePattern` có row mới với `count >= 3`.
- [ ] Entity resolution: chat 2 câu cùng entity (khác casing) → Neo4j có 1 node duy nhất (KHÔNG 2 node collision).
- [ ] Cold start mode: fresh DB → 10 chat queries → 0 AgentInsight được tạo (cold start skip).

### Phase 3 — SCALE + OBSERVABILITY
- [ ] `pm2 restart theopusflashlite` giữa chừng có 5 pending tasks → sau restart toàn bộ được resume.
- [ ] Tắt app 15 phút → restart → `recoverStaleTasks()` log "Recovered N stale tasks".
- [ ] `curl -X POST /api/storage/supabase-sync` → 7 learning tables trên Supabase có row count đúng.
- [ ] `curl -X POST /api/storage/snapshot-full` → R2 bucket có 2 files: `qdrant/<date>.tar.gz` + `neo4j/<date>.tar.gz`.
- [ ] Test restore: xóa 1 SQLite table + drop Qdrant collection → `POST /api/storage/restore-full` → SQLite restore + Qdrant có points.

### Phase 4 — ML QUALITY
- [ ] `POST /api/eval/run` chạy xong trong <15 phút với 100 cases.
- [ ] EvalResult có 3 `faithfulnessScores` (3 judges), `faithfulnessMedian` populated.
- [ ] UI Learning tab hiển thị card "Evaluation Results" với 5 metrics.
- [ ] 2 eval runs liên tiếp → trend chart hiển thị 2 points, không có regression (>10% giảm).
- [ ] Calibrated confidence: `CalibrationModel` có row với `intercept` + `coef` (sau khi train).
- [ ] 2-stage retrieval: top-5 sau rerank khác order so với top-5 trước (rerank có effect).
- [ ] Hybrid search:BM25 recall trên programming queries tăng (vs pure dense).
- [ ] MMR: top-5 không redundant (cosine giữa các chunk < 0.95).
- [ ] Query rewriting: conversational query retrieve đúng entity ("its" resolve đúng).
- [ ] Memory decay: `decayMemories()` chạy, memories có `importance` decayed, tier migrated.
- [ ] Semantic graph search: query "Frontend library by Meta" retrieve được "React" (KHÔNG có chữ React trong query).

### Phase 5 — ADVANCED ML
- [ ] `QueryCentroid` có row cho tuần hiện tại.
- [ ] `/api/openclaw/learning/drift` trả `cosineDrift` + `drifted` boolean.
- [ ] Hard negative mining script output `Optimal threshold: X.XX, F1: 0.XX`.
- [ ] `ENTITY_MATCH_THRESHOLD` trong `.env` = learned value (không còn 0.85 hardcode).

---

## Verification checklist dùng được ngay

Sau khi hoàn thành mỗi proposal, chạy checklist sau (không cần đợi đến cuối Phase):

```bash
# 1. Lint check
cd /home/z/tmo-app && bun run lint 2>&1 | tail -20

# 2. Type check
cd /home/z/tmo-app && bunx tsc --noEmit 2>&1 | tail -20

# 3. Restart app
pm2 restart theopusflashlite && sleep 5

# 4. Health check
curl -s http://localhost:3000/api/health | jq '.services'

# 5. ML sanity check (Pre-Phase 1 P0.1 + Phase 1 Proposal 1 đã xong)
curl -sX POST http://localhost:3000/api/debug/embed \
  -H 'Content-Type: application/json' \
  -d '{"texts":["machine learning","deep learning","weather forecast"]}' | \
  jq '.vectors | {
    ml_vs_dl: cosine(.[0], .[1]),  # phải > 0.7
    ml_vs_weather: cosine(.[0], .[2])  # phải < 0.3
  }'

# 6. Pseudo-hash audit (Pre-Phase 1 P0.1 đã xong)
curl -sX POST http://localhost:6333/collections/theopus_chunks/points/scroll \
  -H 'Content-Type: application/json' \
  -d '{"limit":100,"with_payload":true}' | \
  jq '.result.points | map(.payload.vector_provider) | group_by(.) | map({provider: .[0], count: length})'
# Phải thấy: [{provider: "nvidia", count: N}] — KHÔNG có "pseudo-hash"

# 7. Unverified insight audit (Pre-Phase 1 P0.2)
sqlite3 /home/z/my-project/db/custom.db \
  "SELECT verified, COUNT(*) FROM AgentInsight GROUP BY verified;"
# Phải thấy: 0 (unverified) có nhiều, 1 (verified) chỉ khi có feedback/eval pass

# 8. Tail log check error mới
tail -100 /home/z/my-project/dev.log | grep -iE 'error|fail' | head -10

# 9. Agent Browser verify UI
# - Vào http://localhost:3000
# - Check status bar: ● HEALTHY
# - Vào tab Learning → check có data
# - Vào tab Chat → query 1 câu → check response có field mới
# - Check "✓ Verified" badge (Pre-Phase 1 P0.2)
# - Check "Layer 9 — Adaptation Intelligence" subpanel (Phase 2 Proposal 8)
# - Check "Evaluation Results" card (Phase 4 Proposal 11')
# - Check "Concept Drift" panel (Phase 5 Proposal 5.1)
```

Nếu bất kỳ step nào fail → quay lại debug proposal đó, không tiếp tục proposal tiếp theo.

---

**Hết tài liệu.** Cập nhật lần cuối: sau ML review (Task ID 5). File này đã được merge 17 ML proposals + reorder Phase (thêm Pre-Phase 1 + Phase 5 mới, mở rộng Phase 4 từ 1 → 8 proposals). Companion doc: `/home/z/tmo-app/docs/SMOLAB_LEARNING_PROPOSALS_ML_REVIEW.md`.
