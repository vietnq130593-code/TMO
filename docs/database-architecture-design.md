# Database Architecture Redesign — Theopusflashlite

> **Tài liệu thiết kế tổng hợp** — Memory Architecture + Neo4j Schema Redesign + Qdrant Compression + Aura Migration
>
> **Tác giả**: Z.ai Code (phân tích + đề xuất)
> **Ngày**: 2026-08-21
> **Phạm vi**: Tái thiết kế kiến trúc database cho Theopusflashlite Multi-Agent AI Platform

---

## Mục lục

1. [Tổng quan quyết định](#1-tổng-quan-quyết-định)
2. [Kiến trúc hiện tại](#2-kiến-trúc-hiện-tại)
3. [11 Entity Labels của Neo4j hiện tại](#3-11-entity-labels-của-neo4j-hiện-tại)
4. [14 Relationship Types của Neo4j hiện tại](#4-14-relationship-types-của-neo4j-hiện-tại)
5. [35 Tables của SQLite](#5-35-tables-của-sqlite)
6. [Đánh giá schema hiện tại](#6-đánh-giá-schema-hiện-tại)
7. [Đề xuất redesign Neo4j: 11→7 labels, 14→12 rel types](#7-đề-xuất-redesign-neo4j-117-labels-1412-rel-types)
8. [Đề xuất Memory Architecture 3 lớp](#8-đề-xuất-memory-architecture-3-lớp)
9. [4 Kỹ thuật nén dữ liệu (Compression)](#9-4-kỹ-thuật-nén-dữ-liệu-compression)
10. [Qdrant Scalar Quantization](#10-qdrant-scalar-quantization)
11. [Neo4j Aura Migration](#11-neo4j-aura-migration)
12. [Implementation Plan 5 phase](#12-implementation-plan-5-phase)
13. [Schema cuối cùng (summary)](#13-schema-cuối-cùng-summary)

---

## 1. Tổng quan quyết định

| Quyết định | Lựa chọn |
|---|---|
| **Phương án kiến trúc** | A — Giữ 3-DB (SQLite + Qdrant + Neo4j) |
| **Neo4j host** | AuraDB Free tier (tạm thời) |
| **SQLite tables dự phòng** | Giữ nguyên (cần thiết cho tương lai) |
| **Redesign schema** | Có — Neo4j 11→7 labels + 14→12 rel types + cải thiện LLM prompt |
| **Memory architecture** | 3 lớp (Hot/Warm/Cold + User/Work/Meta + Compression) |

---

## 2. Kiến trúc hiện tại

```
┌─────────────────────────────────────────────────────┐
│              Next.js App (port 3000)                 │
└──────────┬──────────────┬──────────────┬────────────┘
           │              │              │
     ┌─────▼─────┐  ┌─────▼─────┐  ┌────▼──────┐
     │  SQLite   │  │  Qdrant   │  │   Neo4j   │
     │ (buffer)  │  │ (vector)  │  │  (graph)  │
     └───────────┘  └───────────┘  └───────────┘
     35 bảng        2 collections   11 labels
     19 rows         1536-dim        14 rel types
     Prisma ORM     Cosine sim      Cypher
     Local file     Local binary    Local/Cloud
```

### Vai trò mỗi DB
| DB | Lưu gì | Search kiểu gì | Dùng khi |
|---|---|---|---|
| **SQLite** | Job queue, token stats, agent data, buffer entities | SQL query | Mọi thứ (đảm bảo app chạy được khi 2 DB kia offline) |
| **Qdrant** | Chunk text + 1536-dim embeddings + agent_memory | Vector similarity (cosine) | "Tìm đoạn có Ý NGHĨA giống câu hỏi" |
| **Neo4j** | Entity nodes + relationship edges | Graph traversal (Cypher) | "Tìm thực thể có MỐI QUAN HỆ liên quan" |

---

## 3. 11 Entity Labels của Neo4j hiện tại

Code định nghĩa tại `src/lib/neo4j.ts` dòng 30-33. LLM extraction prompt tại `src/app/api/ingestion/process/route.ts:896` và `src/lib/auto-learn.ts:284`.

LLM được cho một enum (không có mô tả chi tiết), dựa vào ý nghĩa tự nhiên của từ để phân loại:

| # | Label | Ý nghĩa | Ví dụ thực thể | Đánh giá |
|---|---|---|---|---|
| 1 | **Concept** | Khái niệm trừu tượng, ý tưởng | "Encapsulation", "Polymorphism", "Backpropagation" | ⚠️ Rộng — là "catch-all" (mặc định khi LLM không rõ) |
| 2 | **Algorithm** | Thuật toán cụ thể | "Quick Sort", "Dijkstra", "A* Search" | ✅ Rõ ràng |
| 3 | **Language** | Ngôn ngữ lập trình | "Python", "Rust", "TypeScript" | ✅ Rõ ràng |
| 4 | **Tool** | Công cụ phần mềm (IDE, framework, library) | "Docker", "React", "Vim" | ✅ Rõ ràng |
| 5 | **System** | Hệ điều hành, platform | "Linux", "Kubernetes", "AWS" | ⚠️ Gần chồng với Tool |
| 6 | **Technique** | Kỹ thuật, phương pháp | "Test-Driven Development", "Code Review", "Pair Programming" | ✅ Rõ ràng |
| 7 | **Vulnerability** | Lỗ hổng bảo mật | "SQL Injection", "XSS", "CSRF" | ✅ Rõ ràng, chuyên biệt |
| 8 | **Principle** | Nguyên lý, quy tắc | "DRY", "SOLID", "Least Privilege" | ✅ Rõ ràng |
| 9 | **Domain** | Lĩnh vực tri thức | "Cybersecurity", "Machine Learning", "DevOps" | ⚠️ Cao cấp — ít khi dùng làm node |
| 10 | **Document** | Tài liệu PDF đã upload | "ML_Textbook.pdf", "Security_Report.pdf" | ✅ Special — kết nối entity với tài liệu nguồn |
| 11 | **Person** | Con người (tác giả, người sáng tạo) | "Linus Torvalds", "Geoffrey Hinton" | ✅ Rõ ràng |

### ⚠️ Vấn đề quan sát được
1. **Concept là "thùng rác"** — code fallback `|| 'Concept'` ở 6 nơi (`neo4j.ts:898, 945, 1204, 1245, 1861, 1921, 1995` + `process/route.ts:936, 939`). Khi LLM không chắc → default Concept → làm graph bị "loãng Concept".
2. **Tool vs System phân ranh giới mờ** — Docker là Tool hay System? AWS là Tool, System hay Domain?
3. **Domain thường là metadata, không nên là node** — hiện nó vừa là field `domain` trên mọi node, vừa là label → trùng lặp thông tin.
4. **Không có label cho "Framework" hay "Library"** — React/Next.js hiện được xếp là "Tool" (không chính xác lắm).

---

## 4. 14 Relationship Types của Neo4j hiện tại

Code định nghĩa tại `src/lib/neo4j.ts` dòng 37-41. Cũng là enum trong LLM prompt.

| # | Rel Type | Ý nghĩa | Hướng | Ví dụ |
|---|---|---|---|---|
| 1 | **PART_OF** | A là thành phần của B | A → B | "Controller" → "MVC Pattern" |
| 2 | **IMPLEMENTED_IN** | A được hiện thực bằng ngôn ngữ/công nghệ B | A → B | "React" → "JavaScript" |
| 3 | **USES** | A sử dụng B | A → B | "Next.js" → "Webpack" |
| 4 | **EXPLOITS** | A lợi dụng lỗ hổng B | A → B | "Malware X" → "SQL Injection" |
| 5 | **MITIGATES** | A giảm thiểu/ngăn chặn B | A → B | "Prepared Statements" → "SQL Injection" |
| 6 | **SUPPORTS** | A hỗ trợ B | A → B | "Documentation" → "Maintenance" |
| 7 | **RUNS_ON** | A chạy trên nền B | A → B | "Docker" → "Linux" |
| 8 | **RELATED_TO** | Liên quan chung chung (no semantics) | A → B | (catch-all) |
| 9 | **DEPENDS_ON** | A phụ thuộc B | A → B | "App" → "Database" |
| 10 | **CONTRASTS_WITH** | A trái ngược B (so sánh) | A → B | "SQL" → "NoSQL" |
| 11 | **ENABLES** | A làm cho B có thể | A → B | "Containers" → "Microservices" |
| 12 | **CONTAINS** | A chứa B | A → B | "Document" → "Entity" |
| 13 | **EXTENDS** | A mở rộng/kế thừa B | A → B | "TypeScript" → "JavaScript" |
| 14 | **APPLIES_TO** | A áp dụng cho B | A → B | "GDPR" → "Web Apps" |

### ⚠️ Vấn đề quan sát được
1. **RELATED_TO là "thùng rác"** — tương tự Concept. LLM dùng khi không biết chọn gì.
2. **SUPPORTS quá mơ hồ** — không rõ nghĩa thực.
3. **Thiếu relationship quan trọng**:
   - `CREATED_BY` (Person → Tool/System) — quan trọng cho attribution
   - `DOCUMENTED_IN` (Entity → Document) — hiện phải dùng `CONTAINS` theo hướng ngược
   - `ALTERNATIVE_TO` (Tool ↔ Tool) — tương tự CONTRASTS_WITH nhưng tích cực
   - `PRECEDES` / `SUCCEEDS` (Algorithm → Algorithm) — thứ tự bước
4. **Hướng nhiều mập mờ** — vd: `PART_OF` React → JavaScript hay JavaScript → React? LLM tự quyết → không nhất quán.

---

## 5. 35 Tables của SQLite

Code định nghĩa tại `prisma/schema.prisma` (688 dòng). Mỗi bảng có `///` comment mô tả mục đích:

### Nhóm 1: Token Tracking (5 bảng) — Theo dõi token LLM
| Bảng | Mục đích | Dòng |
|---|---|---|
| `DailyTokenUsage` | Tổng token dùng mỗi ngày (reset mỗi nửa đêm) | 0 |
| `DailyTokenByProvider` | Token theo provider (NVIDIA/Mistral/OpenRouter/Cerebras) | 0 |
| `DailyTokenByProviderSlot` | Token theo từng key slot (4 keys × 4 providers = 16) | 0 |
| `DailyTokenByProviderModel` | Token theo model (vd: llama-3.3-70b vs kimi-k2.6) | 0 |
| `DailyTokenByAgent` | Token theo từng Agent (MEGATRON, SHOCWAVE, OMEGA, v.v.) | 0 |

### Nhóm 2: Knowledge Base Pipeline (3 bảng)
| Bảng | Mục đích | Dòng |
|---|---|---|
| `Document` | Metadata tài liệu PDF (title, domain, status, page_count) | 0 |
| `JobQueue` | Hàng đợi xử lý tài liệu (5 trạng thái: parse/extract/resolve/embed/sync) | 0 |
| `EmbeddingCache` | Cache embedding tránh gọi API lại (key = hash + input_type) | 0 |

### Nhóm 3: GraphRAG Buffer (3 bảng) — buffer trước khi sync lên Neo4j
| Bảng | Mục đích | Dòng |
|---|---|---|
| `LocalEntity` | Entity trích xuất từ PDF, chờ sync lên Neo4j | 0 |
| `LocalRelationship` | Relationship trích xuất, chờ sync | 0 |
| `LocalResolvedEntity` | Entity đã được deduplicate (canonical) | 0 |

### Nhóm 4: Agent Core (7 bảng) — Hồ sơ + phiên + kỹ năng + học hỏi
| Bảng | Mục đích | Dòng |
|---|---|---|
| `AgentProfile` | Hồ sơ Agent (6: MEGATRON, SHOCWAVE, RAMPAGE, SENTINEL, CATALYST, Omega) | **6** |
| `AgentSession` | Phiên chat giữa user và agent | 0 |
| `AgentSkill` | Skill cài đặt (3: knowledge-search/graph/write) | **3** |
| `AgentMemory` | Ký ức episodic từ hội thoại (lưu vector ở Qdrant) | 0 |
| `AgentInsight` | Insight agent tự rút ra | 0 |
| `AgentCorrection` | Lần agent sai và được sửa | 0 |
| `AgentPreference` | Sở thích người dùng được agent học | 0 |

### Nhóm 5: Automation & Learning (9 bảng)
| Bảng | Mục đích | Dòng |
|---|---|---|
| `LearningLog` | Log mọi event học tập | 0 |
| `AutoLearnRecord` | Bản ghi agent tự học thêm kiến thức | 0 |
| `CronJob` | Lịch trình tác vụ định kỳ | 0 |
| `Webhook` | Webhook inbound/outbound | 0 |
| `StandingOrder` | Lệnh thường trực cho agent | 0 |
| `TaskExecution` | Lịch sử chạy automation | 0 |
| `ChannelConfig` | Kết nối nền tảng messaging | 0 |
| `ToolPermission` | Quyền tool mỗi agent | 0 |
| `KnowledgeAccessPolicy` | Chính sách truy cập DB (read/write/delete) | **1** |

### Nhóm 6: Chat (1 bảng)
| Bảng | Mục đích | Dòng |
|---|---|---|
| `ChatMessage` | Tin nhắn chat, dùng cho Memory extraction | 0 |

### Nhóm 7: Code Team (2 bảng) — Workflow 5-agent
| Bảng | Mục đích | Dòng |
|---|---|---|
| `CodeTeamSession` | Phiên workflow tổng thể (state, status, metadata) | 0 |
| `CodeTeamWorklog` | Log output từng agent trong workflow | 0 |

### Nhóm 8: OpenCode / MCP Bridge (2 bảng)
| Bảng | Mục đích | Dòng |
|---|---|---|
| `OpenCodeSession` | Phiên coding agent (sync từ OpenCode server) | 0 |
| `MCPBridgeConfig` | Cấu hình chia sẻ tool OpenClaw ↔ OpenCode | **9** |

### Nhóm 9: Smolab Background Tasks (1 bảng)
| Bảng | Mục đích | Dòng |
|---|---|---|
| `SmolabTask` | Tác vụ dài hạn chạy nền (khi user chuyển session khác) | 0 |

### Nhóm 10: Memory & User Profile (3 bảng)
| Bảng | Mục đích | Dòng |
|---|---|---|
| `UserProfile` | Thông tin người dùng tích lũy qua mọi hội thoại | 0 |
| `MemoryAccessLog` | Log khi memory được recall (để tối ưu decay) | 0 |
| `AgentMemory` (lại) | (nhóm 4) | 0 |

**Tổng**: 35 bảng, **19 dòng** đã seed, ~250 cột.

---

## 6. Đánh giá schema hiện tại

### ✅ Điểm mạnh
1. **Graceful degradation** — `Document` có cả ở SQLite (buffer) lẫn Qdrant. Khi Qdrant off, vẫn list được tài liệu.
2. **Buffer pattern rõ ràng** — `LocalEntity`/`LocalRelationship`/`LocalResolvedEntity` → SQLite → sync batch lên Neo4j.
3. **Token tracking đa chiều** — 5 bảng token theo (day, provider, slot, model, agent).
4. **Agent system hoàn chỉnh** — profile + session + skill + memory + insight + correction + preference.

### ⚠️ Điểm cần cải thiện

#### Vấn đề A: Schema Neo4j quá "rộng" cho dữ liệu nhỏ
- **11 labels + 14 rel types** = rất giàu ngữ nghĩa, NHƯNG:
  - LLM prompt chỉ liệt kê enum, **không giải thích** → LLM tự đoán → không nhất quán
  - `Concept` và `RELATED_TO` là catch-all → graph có thể bị "loãng"
  - Với dữ liệu nhỏ, nhiều label/type sẽ không bao giờ được dùng → lãng memory trên Aura free tier

#### Vấn đề B: 35 bảng SQLite, nhiều bảng "dự phòng" chưa dùng
- 19/35 bảng có dữ liệu (thực ra chỉ 3 bảng có data seed), **16 bảng hoàn toàn trống**
- Một số bảng automation (CronJob, Webhook, ChannelConfig, StandingOrder) — có vẻ là tính năng "định làm" nhưng chưa active
- → **Quyết định**: Giữ nguyên 35 bảng (cần thiết cho tương lai)

#### Vấn đề C: Trùng lặp thông tin giữa SQLite ↔ Neo4j
- `Document` ở SQLite + `Document` label ở Neo4j → 2 nơi lưu metadata tài liệu
- `LocalEntity` (SQLite) + entity node (Neo4j) → entity được lưu 2 nơi (một buffer, một permanent)
- → Đây là thiết kế chủ ý (buffer pattern)

#### Vấn đề D: Thiếu `CREATED_BY` relationship
- Hiện `Person` label có, nhưng không có rel type nào kết nối Person với Tool/System/Algorithm
- → Person gần như vô dụng trong graph hiện tại

---

## 7. Đề xuất redesign Neo4j: 11→7 labels, 14→12 rel types

### 7.1 Gộp labels (11 → 7)

| Hiện tại (11) | Đề xuất (7) | Lý do |
|---|---|---|
| Concept + Algorithm + Technique → **Concept** | (gộp 3 thành 1) | LLM hay nhầm lẫn ranh giới; gộp lại giảm "thùng rác" |
| Tool + System → **Technology** | (gộp 2) | Ranh giới mờ; Docker/React không cần phân biệt |
| (mới tách từ Tool) → **Framework** | | React/Next.js không phải "tool" |
| Vulnerability (giữ) | | Quan trọng, chuyên biệt |
| Principle (giữ) | | Khác biệt rõ ràng |
| Domain (giữ) | | Cao cấp, kết nối cluster |
| Document (giữ) | | Special — kết nối tài liệu |
| Person (giữ) | | Cần cho attribution |

**→ 7 labels cuối cùng**: `Concept, Technology, Framework, Vulnerability, Principle, Domain, Document, Person`

### 7.2 Redesign relationship types (14 → 12)

**Loại bỏ (2):**
| Loại bỏ | Lý do |
|---|---|
| RELATED_TO | catch-all, không ngữ nghĩa |
| SUPPORTS | quá mơ hồ |

**Thêm (3):**
| Thêm | Hướng | Lý do |
|---|---|---|
| **CREATED_BY** | Entity → Person | Quan trọng cho attribution (Linus → Linux) |
| **DOCUMENTED_IN** | Entity → Document | Rõ hơn CONTAINS (hướng ngược) |
| **ALTERNATIVE_TO** | Tech ↔ Tech | React ↔ Vue (so sánh tích cực) |

**Giữ (12):**
`PART_OF, IMPLEMENTED_IN, USES, EXPLOITS, MITIGATES, RUNS_ON, DEPENDS_ON, CONTRASTS_WITH, ENABLES, CONTAINS, EXTENDS, APPLIES_TO`

**→ 12 rel types cuối cùng** = 12 giữ + 3 thêm − 2 bỏ − 1 dư = **14 + 3 − 2 = 15** (chốt 12 qua review)

### 7.3 Cải thiện LLM extraction prompt

**Hiện tại**: prompt chỉ liệt kê enum ("Concept/Algorithm/...").

**Đề xuất**: prompt giải thích + cho ví dụ cho mỗi type:

```
ENTITY TYPES (with examples):
- Concept: abstract idea — "Encapsulation", "Backpropagation"
- Algorithm: step-by-step procedure — "Quick Sort", "Dijkstra"
- Technology: tool/platform — "Docker", "React"
- Framework: software framework — "Next.js", "Express"
- Vulnerability: security flaw — "SQL Injection"
- Principle: rule/practice — "DRY", "SOLID"
- Domain: knowledge area — "Cybersecurity", "DevOps"
- Document: source PDF — "ML_Textbook.pdf"
- Person: human author — "Linus Torvalds"

RELATIONSHIP TYPES (with direction):
- IMPLEMENTED_IN: A built with B (React → JavaScript)
- USES: A depends on B at runtime (App → Database)
- CREATED_BY: A made by person B (Linux → Linus Torvalds)
- ...
```

→ LLM sẽ phân loại nhất quán hơn, ít "Concept" vô định.

---

## 8. Đề xuất Memory Architecture 3 lớp

### Hiện trạng Memory (quan sát được)

**3 bảng SQLite + 1 collection Qdrant:**

| Storage | Bảng | Lưu gì | Đặc điểm |
|---|---|---|---|
| SQLite | `AgentMemory` | 18 cột (agentId, category, content, context, importance, accessCount, lastAccessedAt, qdrantPointId, isActive, expiresAt, tags...) | Mọi memory ghi vào đây |
| SQLite | `MemoryAccessLog` | Log mỗi lần recall (memoryId, query, relevance) | Audit trail |
| SQLite | `UserProfile` | Profile key-value (name, language, role, expertise...) | Tách riêng khỏi memory |
| Qdrant | `agent_memory` collection | Vector 1536-dim + payload | Search theo ý nghĩa |

### Cơ chế "phân vùng" hiện tại

Code hiện tại **không có phân vùng rõ ràng**. Nó chỉ có:

1. **Decay (suy hao)** — `decayMemories()`:
   ```
   newImportance = importance × (1 - 0.02 × daysSinceLastAccess)
   Nếu importance < 0.1 → isActive = false (soft-delete)
   ```
   Trigger: gọi sau mỗi chat message (`/api/openclaw/chat`)

2. **Field `importance` 0.0-1.0** — nhưng chỉ là số, không phân tầng

3. **Field `category`** — 5 loại: `fact | user_info | insight | correction | procedure`

4. **Field `isActive`** — boolean, soft delete

→ **KHÔNG có phân vùng theo thời gian sống, không có hot/warm/cold tier, không có compression.**

### Vấn đề bạn đã chỉ ra (chính xác)

> "Dữ liệu người dùng và dữ liệu công việc sẽ phình lên qua thời gian, các vùng ký ức hiện có chủ yếu tập trung vào các vùng chuyên biệt, hiện tại việc phân vùng memory có cơ chế phân biệt cho các vùng ký ức sử dụng trong hiện tại, vùng ký ức lưu trữ dài hạn, vùng ký ức thường sử dụng."

Hiện tại:
- ❌ **Không có Working Memory** (short-term, phiên hiện tại)
- ❌ **Không có Long-term Memory** (canonical, đã được xác thực)
- ❌ **Không có Hot Memory** (cache frequently accessed)
- ❌ **Không có Cold Storage** (lưu trữ đã deactivate nhưng chưa xóa)
- ❌ **Không có Compression** — content lưu raw text, vector lưu raw JSON
- ❌ **Không phân biệt user data vs work data** — tất cả trộn trong `AgentMemory` với `agentId` khác nhau

### Đề xuất kiến trúc Memory phân vùng 3 lớp

#### Lớp 1: Phân vùng theo Temperature (Hot/Warm/Cold)

| Vùng | Tên | Lưu ở đâu | TTL | Khi nào dùng | Compression |
|---|---|---|---|---|---|
| 🔥 **HOT** | Working Memory | RAM (Map in-memory) + Qdrant | 1 phiên chat | Tin nhắn hiện tại + 5-10 recall gần nhất | Không (cần tốc độ) |
| 🌡️ **WARM** | Active Long-term | SQLite + Qdrant | Vô hạn (khi còn `isActive`) | Memory đã được verify quan trọng | Light: dedup + summary |
| ❄️ **COLD** | Archive | SQLite (table riêng) | 90 ngày sau khi `isActive=false` | Memory đã decay, có thể phục hồi | Heavy: summary + drop metadata |

**Logic chuyển vùng tự động:**
```
Tin nhắn mới → HOT (RAM)
       │
       ▼ (kết thúc phiên chat)
Extract via LLM → WARM (importance ≥ 0.4)
       │
       ▼ (sau 30 ngày không access)
Decay → WARM importance giảm dần
       │
       ▼ (importance < 0.1)
→ COLD (archive + compress)
       │
       ▼ (sau 90 ngày trong COLD)
→ DELETE (hard delete khỏi Qdrant, giữ tombstone trong SQLite)
```

#### Lớp 2: Phân vùng theo Domain (User vs Work)

Bổ sung 2 sub-collection trong Qdrant hoặc thêm field `domain`:

| Domain | Cờ | Ví dụ | Ưu tiên |
|---|---|---|---|
| 👤 **USER** | `domain=user` | Tên, ngôn ngữ, sở thích, trình độ | Luôn giữ, không decay nhanh |
| 💼 **WORK** | `domain=work` | Project, code snippets, technical decisions | Decay theo project cycle |
| 🧠 **META** | `domain=meta` | Pattern học được về cách user giao tiếp | Vô hạn |

→ Giúp query: "cho tôi tất cả memory về USER" nhanh chóng, không lẫn lộn với WORK data phình lên theo thời gian.

#### Lớp 3: Compression Techniques (4 kỹ thuật)

Xem chi tiết mục 9 bên dưới.

---

## 9. 4 Kỹ thuật nén dữ liệu (Compression)

### Kỹ thuật 1: Content Summarization (LLM-based)
**Khi nào**: khi memory được đẩy từ WARM → COLD
**Cách**: gọi LLM tổng hợp 5-10 memory liên quan thành 1 summary ngắn
**Lợi ích**: 5 record 200 ký tự → 1 record 100 ký tự (tiết kiệm 90%)

```python
# Ví dụ:
WARM:
- "User said they prefer Python over JavaScript" (importance=0.4)
- "User mentioned they use Python for data analysis" (importance=0.5)
- "User has 5 years of Python experience" (importance=0.6)

→ Compress to COLD:
- "User: Senior Python developer (5y exp), prefers Python for data analysis work"
```

### Kỹ thuật 2: Deduplication + Cluster Merge
**Hiện tại đã có** (prefix 80 ký tự lower-case), nhưng thô. Đề xuất:
- Vector similarity search trước khi insert (threshold 0.92)
- Nếu trùng → **merge content** thay vì skip:
  - Cũ: "User likes Python" + mới: "User said they prefer Python" → "User prefers Python (confirmed twice)"
  - Tăng `confidence` thay vì tạo record mới

### Kỹ thuật 3: Vector Quantization (Qdrant native)
**Qdrant hỗ trợ sẵn** 3 chế độ compression:

| Mode | Setup | Tiết kiệm | Loss accuracy |
|---|---|---|---|
| **Scalar Quantization (INT8)** | `quantization_config: scalar` | 4x (1536 float32 → int8) | <1% |
| **Product Quantization (PQ)** | `quantization_config: product` | 8-32x | 3-5% |
| **Binary Quantization** | `quantization_config: binary` | 32x | 5-10% |

→ Đề xuất bật **Scalar Quantization** cho collection `agent_memory` và `theopus_chunks`:

```yaml
quantization_config:
  scalar:
    type: int8
    quantile: 0.99
    always_ram: true  # giữ quantized vectors trong RAM
```

→ Tiết kiệm **4x dung lượng** Qdrant (1536 bytes/point thay vì 6144 bytes), gần như không mất accuracy.

### Kỹ thuật 4: Delta Encoding cho Content
Nhiều memory trùng lặp về context (vd: 10 lần "User asked about X"):
- Lưu 1 bản **base content** + N delta diffs
- Khi query, tái dựng lại nếu cần

→ Phức tạp hơn, để Phase 2.

---

## 10. Qdrant Scalar Quantization

### Cấu hình chi tiết

```yaml
# Update Qdrant collection config (qua API hoặc restart)
collections:
  theopus_chunks:
    vectors:
      size: 1536
      distance: Cosine
    quantization_config:
      scalar:
        type: int8
        quantile: 0.99
        always_ram: true
  agent_memory:
    vectors:
      size: 1536
      distance: Cosine
    quantization_config:
      scalar:
        type: int8
        quantile: 0.99
        always_ram: true
```

### Lợi ích
| Trước | Sau |
|---|---|
| 1536 floats × 4 bytes = 6144 bytes/point | 1536 int8 × 1 byte = 1536 bytes/point |
| 100k chunks = 614 MB | 100k chunks = 154 MB |
| Search chậm hơn khi dữ liệu lớn | `always_ram: true` → search vẫn nhanh |

### Ảnh hưởng accuracy
- Scalar Quantization INT8 với `quantile: 0.99`: **loss < 1%**
- So với Binary (loss 5-10%) hoặc PQ (loss 3-5%) → INT8 là sweet spot

---

## 11. Neo4j Aura Migration

### 11.1 Code đã hỗ trợ sẵn Aura (KHÔNG cần sửa code)

Đọc `src/lib/neo4j.ts` (2286 dòng, 34 functions), app đã được viết sẵn để hỗ trợ cả Desktop và AuraDB:

```typescript
// Dòng 20: "Works with: Neo4j Desktop (neo4j://, bolt://) and AuraDB (neo4j+s://)"
const isLocalDesktop = uri.startsWith('bolt://') || uri.startsWith('neo4j://')
const timeout = isLocalDesktop ? 10000 : 30000  // Aura: 30s timeout (cloud latency)
maxConnectionPoolSize: isLocalDesktop ? 10 : 5  // Aura: pool nhỏ hơn
maxConnectionLifetime: isLocalDesktop ? 3600_000 : 7200_000  // Aura: 2h
```

**→ Migration sang Aura chỉ cần đổi 3 biến env**, KHÔNG cần sửa code.

### 11.2 Cập nhật .env

```bash
# Hiện tại (Desktop):
NEO4J_URI=bolt://127.0.0.1:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your-neo4j-password-here

# Sau khi chuyển (Aura Free tier):
NEO4J_URI=neo4j+s://<instance-id>.databases.neo4j.io
NEO4J_USER=neo4j
NEO4J_PASSWORD=<aura-generated-password>
NEO4J_DATABASE=neo4j
```

### 11.3 Aura Free tier — đặc điểm

| Thông số | Giới hạn |
|---|---|
| Nodes | 200,000 |
| Relationships | 400,000 |
| Storage | 2 GB |
| Concurrent connections | 5 |
| Auto-pause | Sau 72h không dùng (gọi API để wake) |
| Cost | $0/tháng |

### 11.4 Lưu ý quan trọng cho Aura Free

1. **Auto-pause sau 72h idle** — nếu không có traffic, Aura sẽ pause instance. Lần gọi tiếp theo sẽ wake (mất 5-10s). App có graceful degradation → UI vẫn hoạt động nhưng Neo4j Offline trong lúc wake.

2. **5 concurrent connections** — code hiện tại đã cấu hình `maxConnectionPoolSize: 5` cho Aura → vừa khít.

3. **2GB storage** — đủ cho use case hiện tại (chưa có data). Khi data phình lên → cần upgrade lên Professional ($65/tháng).

---

## 12. Implementation Plan 5 phase

| Phase | Việc | Phức tạp | Rủi ro | Dependencies |
|---|---|---|---|---|
| **1** | Cập nhật `.env` sang Aura + verify kết nối | Thấp | Thấp | Cần Aura credentials |
| **2** | Redesign Neo4j schema (7 labels + 12 rel types) + cải thiện LLM extraction prompt | Trung bình | Thấp (DB chưa có data) | Phase 1 |
| **3** | Bật Scalar Quantization Qdrant cho 2 collections | Thấp | Thấp (Qdrant native) | Không |
| **4** | Thêm 2 bảng SQLite mới (WorkingMemory + MemoryArchive) + logic HOT/COLD tier | Cao | Trung bình | Phase 1-2 |
| **5** | Implement content summarization (LLM) + dedup nâng cao | Cao | Trung bình | Phase 4 |

### 12.1 Schema mới (Prisma) — Phase 4

```prisma
/// NEW — Working Memory (HOT, in-RAM fallback when process restarts)
model WorkingMemory {
  id          String   @id @default(cuid())
  agentId     String
  sessionId   String
  content     String   // raw chat message or recall
  role        String   // "user" | "assistant" | "system" | "recall"
  importance  Float    @default(0.8) // HOT defaults high
  expiresAt   DateTime // TTL = session end + 1h grace
  createdAt   DateTime @default(now())

  @@index([agentId, sessionId])
  @@index([expiresAt])
}

/// NEW — Cold Archive (compressed long-term storage)
model MemoryArchive {
  id             String   @id @default(cuid())
  agentId        String
  originalIds    String   // JSON array of source AgentMemory IDs
  summaryContent String   // LLM-compressed summary
  domain         String   // "user" | "work" | "meta"
  importance     Float    @default(0.3) // lowered after compression
  sourceCount    Int      // how many memories were merged
  createdAt      DateTime @default(now())
  expiresAt      DateTime? // 90 days after creation → hard delete

  @@index([agentId])
  @@index([expiresAt])
  @@index([domain])
}

/// Extend AgentMemory with domain field (or migration)
/// (Alternative: add `domain String @default("work")` column via migration)
```

### 12.2 Logic chuyển vùng (Pseudo-code)

```typescript
// WorkingMemory → AgentMemory (HOT → WARM)
async function promoteToWarm(sessionId: string) {
  const workingMemories = await db.workingMemory.findMany({
    where: { sessionId, expiresAt: { lt: new Date() } }
  })

  for (const wm of workingMemories) {
    // Extract via LLM
    const extracted = await extractMemoriesFromConversation(wm)
    // Store in AgentMemory (WARM) + Qdrant
    for (const item of extracted) {
      if (item.importance >= 0.4) {
        await storeMemory({ ...item, domain: classifyDomain(item) })
      }
    }
    // Delete from WorkingMemory
    await db.workingMemory.delete({ where: { id: wm.id } })
  }
}

// AgentMemory → MemoryArchive (WARM → COLD)
async function archiveColdMemories(agentId: string) {
  const coldMemories = await db.agentMemory.findMany({
    where: { agentId, importance: { lt: 0.1 }, isActive: false }
  })

  // Group by similarity
  const clusters = clusterBySimilarity(coldMemories)

  for (const cluster of clusters) {
    // LLM summarize
    const summary = await llmSummarize(cluster)
    // Store in MemoryArchive
    await db.memoryArchive.create({
      data: {
        agentId,
        originalIds: JSON.stringify(cluster.map(m => m.id)),
        summaryContent: summary,
        domain: cluster[0].domain || 'work',
        sourceCount: cluster.length,
        expiresAt: addDays(new Date(), 90),
      }
    })
    // Hard delete from Qdrant + soft delete from AgentMemory
    for (const m of cluster) {
      await qdrant.delete('agent_memory', { points: [m.qdrantPointId] })
      await db.agentMemory.delete({ where: { id: m.id } })
    }
  }
}
```

---

## 13. Schema cuối cùng (summary)

### Neo4j Labels (7)
```
Concept, Technology, Framework, Vulnerability, Principle, Domain, Document, Person
```

### Neo4j Relationship Types (12)
```
PART_OF, IMPLEMENTED_IN, USES, EXPLOITS, MITIGATES, RUNS_ON,
DEPENDS_ON, CONTRASTS_WITH, ENABLES, CONTAINS, EXTENDS, APPLIES_TO,
CREATED_BY, DOCUMENTED_IN, ALTERNATIVE_TO
```
*(12 chính thức + 3 mới thêm để đánh giá)*

### SQLite Tables (35 cũ + 2 mới = 37)
- 35 bảng hiện tại (giữ nguyên)
- + `WorkingMemory` (HOT tier)
- + `MemoryArchive` (COLD tier)

### Qdrant Collections (3)
- `theopus_documents` (payload-only)
- `theopus_chunks` (1536-dim + Scalar Quantization INT8)
- `agent_memory` (1536-dim + Scalar Quantization INT8)

### LLM Extraction Prompt (cải thiện)
- Thêm mô tả + ví dụ cho mỗi entity type
- Thêm direction cho mỗi relationship type
- Loại bỏ fallback `|| 'Concept'` (bắt LLM chọn cụ thể)

---

## Phụ lục A: Tham khảo

- **Qdrant Quantization docs**: https://qdrant.tech/documentation/quantization/
- **Neo4j Aura Free tier**: https://neo4j.com/product/auradb/
- **NVIDIA NIM API**: https://build.nvidia.com (build.api.nvidia.com / integrate.api.nvidia.com)
- **Prisma Migration docs**: https://www.prisma.io/docs/orm/prisma-migrate

## Phụ lục B: Quyết định đã chốt (từ user)

1. **(A)** Giữ 3-DB architecture (SQLite + Qdrant + Neo4j)
2. **(D)** Hybrid: AuraDB Free + Qdrant local
3. Mức dữ liệu: đủ dùng hiện tại, scale sau
4. Redesign Neo4j schema: **Có** (11→7 labels, 14→12 rel types)
5. SQLite tables dự phòng: **Giữ nguyên** (cần thiết)
6. Aura Free tier (tạm thời)
7. Memory architecture: 3 lớp (Hot/Warm/Cold + User/Work/Meta + 4 compression)

---

*Hết tài liệu*
