# EPISODIC MEMORY — HỆ THỐNG HỌC TỪ TRẢI NGHIỆM (A6)

> Triển khai theo file thiết kế `A6.rtf` (upload 2026-08-29) — 3 phần:
> **(A) Schema Episodic Memory cho Neo4j**, **(B) Error Taxonomy**,
> **(C) Learning Loop**. Ngày hoàn thành: 2026-08-29.

## 1. Triết lý (A.1)

Episodic memory ≠ semantic memory:
- **KB hiện tại** (Neo4j entities + Qdrant chunks) = TRI THỨC — "biết cái gì"
- **Episodic memory** = TRẢI NGHIỆM — "đã xảy ra gì, tôi làm gì, kết quả ra sao, rút ra bài học gì"

4 nguyên tắc lõi:
1. **Mọi episode đều có outcome** — không lưu hành động vô nghĩa
2. **Lesson là node riêng** — bài học tái sử dụng được, độc lập episode sinh ra nó
3. **Episode liên kết semantic KB** — episode về "Neo4j query fail" nối node `Neo4j` → hỏi về Neo4j, tri thức LẪN kinh nghiệm cùng hiện ra (edge `INVOLVES`/`ABOUT`)
4. **Decay có chủ đích** — episode ×0.9/30 ngày không đụng; Lesson **vĩnh viễn**

## 2. Kiến trúc triển khai

```
┌─────────────────────────────────────────────────────────────┐
│  AGENT RUN (goal-loop)                                      │
│  ─────────────────────────────────────────────────────────  │
│  PRE-ACT (đầu run)          CONSOLIDATE (cuối run)          │
│  preact.ts ──┐              recorder.ts (pipeline A.5) ──┐  │
│              ▼                                           ▼  │
│  ┌────────────────────┐   ┌────────────────────────────────┐ │
│  │ Qdrant             │   │ Neo4j graph (PRIMARY)          │ │
│  │ theopus_episodes   │   │ Episode/Action/ErrorOccurrence │ │
│  │ (semantic index,   │◄──►│ Lesson/Strategy/Session        │ │
│  │  2048-dim cosine)  │   │ Q1 ghi · Q2 retrieval · Q3     │ │
│  └────────────────────┘   │ lessons · Q4 decay · Q5 dash   │ │
│                           └────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ SQLite mirror (fallback + dashboard):                    │ │
│  │ EpisodeRecord + LessonRecord (raw-SQL bridge)            │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Files
| File | Vai trò |
|---|---|
| `src/lib/episodic-memory/types.ts` | Node shapes (A.2), root causes R1-R6, ngưỡng C.2 |
| `src/lib/episodic-memory/taxonomy.ts` | Phần B: 6 root causes × manifestations M1.1-M6.3, playbook B.2, classifier B.3 |
| `src/lib/episodic-memory/episodic-neo4j.ts` | Graph layer: schema init + Q1-Q5 + KB bridge + insights |
| `src/lib/episodic-memory/episode-store.ts` | Qdrant: collection `theopus_episodes`, upsert/search (UUID point id) |
| `src/lib/episodic-memory/episodic-db.ts` | SQLite mirror qua raw-SQL bridge (stale-client-safe) |
| `src/lib/episodic-memory/recorder.ts` | Pipeline A.5 (7 bước) — gọi từ goal-loop cuối run |
| `src/lib/episodic-memory/lessons.ts` | Nhịp 3 EVALUATE (validate) + nhịp 4 CONSOLIDATE (sinh/merge lesson) |
| `src/lib/episodic-memory/preact.ts` | Nhịp 1 PRE-ACT — lessons + cảnh báo vào system prompt |
| `scripts/episodic-memory.cypher` | File tham chiếu constraints/indexes + Q1-Q5 (Bước 1 lộ trình) |
| API: `/api/episodic/{overview,lessons,episodes,decay,classify}` | Dashboard + quản lý (fail-open từng section) |
| UI: `src/components/analytics/episodic-memory-panel.tsx` | Tab Analytics — poll 15s |

## 3. Error Taxonomy (phần B)

### 2 tầng
- **Tầng 1 ROOT CAUSE** (tại sao sai): `INPUT_INVALID` · `ASSUMPTION_WRONG` · `KNOWLEDGE_GAP` · `TOOL_FAILURE` · `REASONING_ERROR` · `ENV_DRIFT`
- **Tầng 2 MANIFESTATION** (biểu hiện): M1.1-M6.3 — regex markers match raw message

### Playbook B.2 — mỗi root cause MỘT phản ứng chuẩn
| Root cause | Phản ứng ĐÚNG | Anti-pattern |
|---|---|---|
| R1 INPUT_INVALID | Đọc lại spec/schema, hỏi user | Retry nguyên vẹn |
| R2 ASSUMPTION_WRONG | file_read/grep TRƯỚC — verify bằng tool | Đoán lại lần nữa |
| R3 KNOWLEDGE_GAP | knowledge_search → web → escalate | Bịa dựa trên prior |
| R4 TOOL_FAILURE | Đổi tool tương đương, escalate nếu lặp | Retry vô hạn |
| R5 REASONING_ERROR | Dừng, re-plan, nhờ SENTINEL review | Vá cục bộ |
| R6 ENV_DRIFT | Diff config, rollback nếu cần | Sửa theo môi trường mù mờ |

### Classifier B.3 (`classifyRootCause`)
Heuristic deterministic (không tốn LLM): đánh giá B2→B6 theo thứ tự, marker khớp mạnh nhất thắng; không khớp gì → default R5 (lỗi của chính agent — trung thực). Endpoint test: `POST /api/episodic/classify {rawMessage, tool?}`.

## 4. Learning Loop 4 nhịp (phần C)

```
PRE-ACT (nhớ) → ACT (làm) → EVALUATE (chấm) → CONSOLIDATE (học) ↺
```

1. **PRE-ACT** (`buildPreActContext` — goal-loop đầu run, timeout 4s fail-open):
   - Q3 lessons theo context entities (Neo4j `ABOUT` + fallback)
   - Qdrant episodes tương tự (query-mode, minScore 0.7) → lỗi chưa resolve = cảnh báo
   - Lesson confidence ≥ 0.7 → auto-apply vào system prompt + track `appliedLessonIds`
2. **ACT**: goal-loop bình thường — evidence tool calls được log làm Action nodes
3. **EVALUATE** (`validateAppliedLessons`): SUCCESS + đã áp lesson → `times_validated++`, conf +0.05 (cap 0.99); FAILURE → `times_failed++`, conf −0.1; conf < 0.4 → `needsReview`
4. **CONSOLIDATE** (`recordEpisodeFromRun` — pipeline A.5):
   tóm tắt → embed Qdrant → tìm top-3 tương tự (passage-mode, cosine ≥ 0.8 → `SIMILAR_TO`) → ghi graph + mirror → lỗi đã resolve → sinh/merge lesson (check trùng Jaccard ≥ 0.55 + cùng root cause; mới = conf 0.6) → link KB (`INVOLVES`/`ABOUT`) → pattern ≥ 3 lần = escalation (input Goal Generator)

### Ngưỡng vận hành (C.2) — `EPISODIC_THRESHOLDS`
| Tham số | Giá trị |
|---|---|
| Lesson auto-apply | confidence ≥ 0.7 |
| Lesson cần review | confidence < 0.4 |
| Episode SIMILAR_TO | cosine ≥ 0.8 (passage↔passage) |
| Lesson merge | similarity ≥ 0.55 (word-overlap) + cùng root cause |
| Pattern escalation | ≥ 3 lần cùng root_cause |
| Episode decay | ×0.9 / 30 ngày (API `POST /api/episodic/decay`) |
| Lesson | không bao giờ decay |

## 5. Lộ trình 3 bước (phần D) — trạng thái

- ✅ **Bước 1**: constraints/indexes + Q1-Q5 (code chạy thật trong `episodic-neo4j.ts`, tham chiếu `scripts/episodic-memory.cypher`) + collection `theopus_episodes` (2048-dim Cosine)
- ✅ **Bước 2**: hook vào agent runtime — cuối MỖI run goal-loop ghi episode (fire-and-forget fail-open)
- ✅ **Bước 3**: PRE-ACT retrieval bật — vòng lặp KHÉP KÍN

## 6. E2E đã verify (2026-08-29, sandbox thật)

4 chat runs Omega thật qua `/api/openclaw/chat` (nvidia/moonshotai/kimi-k3):
- Run 1: file_read fail (ngoài workspace → M4.3/R4 TOOL_FAILURE, resolved bằng shell) → Episode `ep_mte84pnl` + 2 actions + 1 error (resolved) + **1 SELF_DERIVED lesson** + 7 KB links
- Run 2-4: PRE-ACT thấy **3 lessons, 2 auto-apply**; 2 USER_TAUGHT lessons lên **conf 0.99 sau 4 lần validated** (0.8 + 0.05×4 — đúng công thức)
- Run 4: **2 SIMILAR_TO** tự tạo (passage-mode cosine 0.89 ≥ 0.8) + 8 KB links
- UI tab Analytics: stats (4 episodes · 3→4 lessons · 3 Qdrant points), Q5 dashboard, lessons list (badge 99% auto-apply / user dạy), episode expand chi tiết actions/errors, form "Dạy bài học" (USER_TAUGHT conf 0.8), taxonomy R1-R6, nút decay — **0 console error**, responsive 400px OK

### Gotchas đã fix
1. **Neo4j LIMIT param**: driver JS gửi number là float trong Bolt → `LIMIT toInteger($limit)`
2. **Qdrant point id**: phải là UUID (không nhận `ep_...` string) → deterministic UUID từ FNV-1a hash episodeId (upsert đè khi re-record)
3. **Cross input-type score**: query↔passage embedding tụt ~5-8% dưới ngưỡng → recorder dùng passage-mode (đối xứng), PRE-ACT hạ minScore 0.7
4. **Prisma stale client**: EpisodeRecord/LessonRecord ghi qua raw-SQL bridge (pattern metrics-db.ts)

## 7. Hướng vận hành

- **Xem dữ liệu**: tab **Analytics → Episodic Memory** (poll 15s)
- **Dạy bài học**: nút "Dạy bài học" (conf 0.8, USER_TAUGHT) — tự động được PRE-ACT áp dụng + validate từ run kế tiếp
- **Chạy decay**: nút "Chạy decay" hoặc `POST /api/episodic/decay` (cron-able)
- **Test phân loại lỗi**: `POST /api/episodic/classify {"rawMessage": "..."}`
- Lesson confidence chỉ tăng khi run áp dụng lesson THÀNH CÔNG — hệ hiệu số trung thực theo thiết kế calibration (Msg 20)
