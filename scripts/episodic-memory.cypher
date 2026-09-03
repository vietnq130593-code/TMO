// ═══════════════════════════════════════════════════════════════════════
// EPISODIC MEMORY — SCHEMA & 5 CYPHER QUERIES LÕI (A6 · Bước 1 lộ trình)
// ═══════════════════════════════════════════════════════════════════════
// Nguồn sự thật THAM CHIẾU — bản chạy thật nằm trong
// src/lib/episodic-memory/episodic-neo4j.ts (ensureEpisodicSchema + các hàm
// Q1-Q5) — file này dùng để: (a) chạy tay trên Neo4j Browser/AuraDB Studio,
// (b) review schema không cần đọc TS, (c) khôi phục nếu graph bị reset.
//
// Kiến trúc: Qdrant = semantic index (tìm episode giống, collection
// `theopus_episodes`); Neo4j = cấu trúc & quan hệ (pattern lỗi, lesson,
// chuỗi thời gian). Đúng pattern GraphRAG hiện có của TMO.
// ═══════════════════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────────────────────
// CONSTRAINTS & INDEXES (idempotent — chạy nhiều lần an toàn)
// ────────────────────────────────────────────────────────────────────────

CREATE CONSTRAINT episode_id_unique IF NOT EXISTS FOR (e:Episode) REQUIRE e.id IS UNIQUE;
CREATE CONSTRAINT action_id_unique IF NOT EXISTS FOR (a:Action) REQUIRE a.id IS UNIQUE;
CREATE CONSTRAINT errorocc_id_unique IF NOT EXISTS FOR (e:ErrorOccurrence) REQUIRE e.id IS UNIQUE;
CREATE CONSTRAINT lesson_id_unique IF NOT EXISTS FOR (l:Lesson) REQUIRE l.id IS UNIQUE;
CREATE CONSTRAINT strategy_id_unique IF NOT EXISTS FOR (s:Strategy) REQUIRE s.id IS UNIQUE;
CREATE CONSTRAINT session_id_unique IF NOT EXISTS FOR (s:Session) REQUIRE s.id IS UNIQUE;

CREATE INDEX episode_importance IF NOT EXISTS FOR (e:Episode) ON (e.importance);
CREATE INDEX episode_last_accessed IF NOT EXISTS FOR (e:Episode) ON (e.last_accessed);
CREATE INDEX episode_agent IF NOT EXISTS FOR (e:Episode) ON (e.agent);
CREATE INDEX episode_outcome IF NOT EXISTS FOR (e:Episode) ON (e.outcome);
CREATE INDEX lesson_confidence IF NOT EXISTS FOR (l:Lesson) ON (l.confidence);
CREATE INDEX lesson_needs_review IF NOT EXISTS FOR (l:Lesson) ON (l.needs_review);
CREATE INDEX errorocc_category IF NOT EXISTS FOR (e:ErrorOccurrence) ON (e.category);
CREATE INDEX errorocc_root_cause IF NOT EXISTS FOR (e:ErrorOccurrence) ON (e.root_cause);
CREATE INDEX errorocc_resolved IF NOT EXISTS FOR (e:ErrorOccurrence) ON (e.resolved);

// ────────────────────────────────────────────────────────────────────────
// NODE TYPES (A.2) — tham khảo shape; ghi thật qua writeEpisodeGraph()
// ────────────────────────────────────────────────────────────────────────
//
// (:Episode {
//   id: "ep_20260214_a1b2c3",            // uuid
//   title: "Fix type error trong chunking pipeline",
//   goal: "Sửa lỗi TS2322 trong src/lib/chunking.ts",
//   context_summary: "Đang refactor pipeline embedding, gặp lỗi type mismatch",
//   started_at: datetime(), ended_at: datetime(),
//   outcome: "SUCCESS|FAILURE|PARTIAL|ABANDONED",
//   confidence: 0.95,                     // độ tin đánh giá outcome
//   agent: "OMEGA|RAMPAGE|SENTINEL...",
//   session_id: "sess_xyz",
//   importance: 0.8,                      // 0-1, decay & retrieval ranking
//   access_count: 3,                      // càng retrieve càng sống
//   last_accessed: datetime(),
//   embedding_id: "qdrant_point_id"       // link sang collection episodes
// })
//
// (:Action {
//   id: "act_...", sequence: 2,           // thứ tự trong episode
//   tool: "file_edit|shell|delegate_task|...",
//   input_summary: "sửa type của Chunk từ string sang ChunkMeta",
//   reasoning: "vì interface mới yêu cầu metadata",
//   result: "SUCCESS|FAIL",
//   error_ref: "err_..."                  // link tới Error node nếu fail
// })
//
// (:ErrorOccurrence {
//   id: "err_...",
//   raw_message: "TS2322: Type 'string' is not assignable...",
//   category: "M2.1",                     // manifestation — taxonomy phần B
//   root_cause: "ASSUMPTION_WRONG",       // R1-R6 taxonomy phần B
//   occurred_at: datetime(),
//   resolved: true,
//   fix_summary: "thêm type guard trước khi cast"
// })
//
// (:Lesson {                              // TỒN TẠI VĨNH VIỄN — không decay
//   id: "lesson_...",
//   statement: "Khi refactor interface, luôn grep toàn bộ nơi import trước khi đổi type",
//   trigger_condition: "khi sắp sửa interface/type được nhiều file dùng",
//   applies_to: ["refactor", "typescript", "interface-change"],
//   confidence: 0.9,                      // tăng mỗi lần validate đúng
//   times_applied: 5, times_validated: 4, times_failed: 1,
//   created_at: datetime(),
//   source: "SELF_DERIVED|USER_TAUGHT|SUBAGENT_REPORT"
// })
//
// (:Strategy {
//   id: "strat_...", problem_type: "debug_type_error",
//   approach: "đọc error → xác định file → grep usage → sửa root type",
//   success_rate: 0.85, avg_steps: 4, last_used: datetime()
// })

// ────────────────────────────────────────────────────────────────────────
// RELATIONSHIPS (A.3)
// ────────────────────────────────────────────────────────────────────────
//
// Cấu trúc nội tại episode:
//   (Episode)-[:CONTAINS {order: 1}]->(Action)
//   (Action)-[:PRODUCED]->(ErrorOccurrence)
//   (Action)-[:FOLLOWED_STRATEGY]->(Strategy)
//
// Học tập:
//   (Episode)-[:YIELDED]->(Lesson)
//   (ErrorOccurrence)-[:TAUGHT]->(Lesson)
//   (ErrorOccurrence)-[:RESOLVED_BY]->(Action)
//
// Liên kết tương tự — chìa khóa của retrieval:
//   (Episode)-[:SIMILAR_TO {score: 0.87}]->(Episode)   // tính từ Qdrant embedding
//   (ErrorOccurrence)-[:SAME_PATTERN_AS]->(ErrorOccurrence)
//
// Cầu nối sang SEMANTIC KB hiện có ⭐:
//   (Episode)-[:INVOLVES]->(Concept|Technology|Tool)
//   (Lesson)-[:ABOUT]->(Concept|Technology)
//   (ErrorOccurrence)-[:RELATES_TO]->(Technology)
//
// Chuỗi thời gian & phiên:
//   (Episode)-[:NEXT_EPISODE]->(Episode)
//   (Episode)-[:PART_OF_SESSION]->(:Session {id, user_goal})

// ────────────────────────────────────────────────────────────────────────
// Q1 — GHI EPISODE MỚI (sau khi hoàn thành 1 task)
// Bản chạy thật: writeEpisodeGraph() — MERGE theo id + UNWIND actions/errors
// ────────────────────────────────────────────────────────────────────────

// CREATE (e:Episode {
//   id: $id, title: $title, goal: $goal, outcome: $outcome,
//   agent: $agent, started_at: datetime(), importance: $importance,
//   access_count: 0, embedding_id: $qdrant_id
// })

// ────────────────────────────────────────────────────────────────────────
// Q2 — RETRIEVAL: "Tôi từng gặp lỗi tương tự chưa?"
// (chạy TRƯỚC khi hành động — trái tim của learning loop)
// Bản chạy thật: findSimilarResolvedErrors({rootCause, category})
// ────────────────────────────────────────────────────────────────────────

// MATCH (err:ErrorOccurrence)-[:SAME_PATTERN_AS*1..2]-(similar:ErrorOccurrence)
// WHERE err.root_cause = $rootCause
//   AND similar.resolved = true
// OPTIONAL MATCH (similar)-[:RESOLVED_BY]->(fix:Action)
// OPTIONAL MATCH (similar)-[:TAUGHT]->(lesson:Lesson)
// RETURN similar.raw_message, fix.input_summary, lesson.statement, lesson.confidence
// ORDER BY lesson.confidence DESC
// LIMIT 3

// ────────────────────────────────────────────────────────────────────────
// Q3 — LẤY LESSONS ÁP DỤNG CHO CONTEXT HIỆN TẠI
// Bản chạy thật: getLessonsForContext({contextEntities}) — 2 đường:
// qua ABOUT entity KB + fallback top-confidence
// ────────────────────────────────────────────────────────────────────────

// MATCH (l:Lesson)-[:ABOUT]->(t)
// WHERE t.name IN $current_context_entities
//   AND l.confidence > 0.6
// RETURN l.statement, l.trigger_condition, l.confidence
// ORDER BY l.confidence * (l.times_validated + 1) DESC
// LIMIT 5

// ────────────────────────────────────────────────────────────────────────
// Q4 — DECAY: giảm importance episode không được dùng tới 30 ngày
// (Lesson KHÔNG BAO GIỜ decay — bài học là vĩnh viễn)
// Bản chạy thật: decayEpisodes({days, factor})
// ────────────────────────────────────────────────────────────────────────

// MATCH (e:Episode)
// WHERE e.last_accessed < datetime() - duration('P30D')
// SET e.importance = e.importance * 0.9

// ────────────────────────────────────────────────────────────────────────
// Q5 — DASHBOARD: lỗi hay gặp nhất (input cho Goal Generator!)
// Bản chạy thật: getErrorDashboard(limit) + getEscalationCandidates(3)
// ────────────────────────────────────────────────────────────────────────

// MATCH (err:ErrorOccurrence)
// RETURN err.category, err.root_cause, count(*) AS occurrences,
//        sum(CASE WHEN err.resolved THEN 1 ELSE 0 END) AS resolved
// ORDER BY occurrences DESC
// LIMIT 10

// ────────────────────────────────────────────────────────────────────────
// QUERIES BỔ TRỢ (dashboard UI + kiểm tra sức khỏe)
// ────────────────────────────────────────────────────────────────────────

// Tổng quan episodic memory:
// MATCH (e:Episode) WITH count(e) AS episodes
// OPTIONAL MATCH (l:Lesson) WITH episodes, count(l) AS lessons
// OPTIONAL MATCH (err:ErrorOccurrence) WITH episodes, lessons, count(err) AS errors,
//   sum(CASE WHEN err.resolved THEN 1 ELSE 0 END) AS resolvedErrors
// RETURN episodes, lessons, errors, resolvedErrors;

// Lesson cần user review (confidence < 0.4):
// MATCH (l:Lesson) WHERE l.confidence < 0.4
// RETURN l.id, l.statement, l.confidence, l.times_failed
// ORDER BY l.confidence ASC;

// Top lessons theo sức mạnh (confidence × validated):
// MATCH (l:Lesson)
// RETURN l.statement, l.confidence, l.times_validated, l.times_failed
// ORDER BY l.confidence * (l.times_validated + 1) DESC
// LIMIT 10;

// Chuỗi episode liên quan nhau (SIMILAR_TO):
// MATCH (a:Episode)-[s:SIMILAR_TO]->(b:Episode)
// RETURN a.title, s.score, b.title
// ORDER BY s.score DESC LIMIT 10;
