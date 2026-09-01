# TB-00 — MASTER INDEX & BLUEPRINT MAP

> 📐 **TECHNICAL BLUEPRINT — AI RESEARCH TEAM (DUAL MISSION)**
> Source of Truth: `upload/ai-team-workflow.md` (4.635 dòng gốc + Phụ lục Z — v1.3, tổng 4.682 dòng)
> Tập blueprint: 13 file (TB-00 → TB-12), tổng 7.649 dòng (đã qua review Task 9 + fix Task 10)
> Version: 1.3 | Ngày: 2026-09-01 (Decision Lock — user ủy quyền chốt toàn bộ [Q]) | Biên soạn: Mr. Robot (Z.ai Code)
> Quyết định canonical: `docs/DECISION-RECORD-v1.3.md` (71 quyết định — 7 cụm C1–C7 + 64 câu riêng)
>
> ⚠️ **QUY TẮC SỐ 1:** `ai-team-workflow.md` là Single Source of Truth. Blueprint MÔ RỘNG từ nó để triển khai được — KHÔNG thay thế nó. Mọi thay đổi thiết kế phải cập nhật nguồn trước, blueprint sau.

---

## §0. MỤC ĐÍCH & PHẠM VI

- **Mục đích:** biến tài liệu mô tả 4.635 dòng thành 13 blueprint triển khai được — mỗi file = 1 review unit = 1 milestone = 1 lần phê duyệt.
- **Đối tượng đọc:**
  1. Kỹ sư triển khai agents (khi cài đặt team research vào TMO)
  2. Chính các agents KING/SIVIL/BELI/LISMA/HAN (dùng làm JD + Instructions runtime)
  3. User (review thiết kế từng phần)
- **Không thay đổi thiết kế** — chỉ chi tiết hóa: interfaces, schemas, state machines, error handling, acceptance criteria.
- **Không bao gồm:** mã nguồn TMO, hạ tầng PM2/Qdrant — blueprint dừng ở ranh giới "runtime contract" của team research.

---

## §1. QUY ƯỚC TOÀN TẬP (bắt buộc mọi file TB)

### 1.1 Danh tính agents (tên agent ≠ tên model)

| Agent | Vị trí | Vai trò M1 — Kaggle | Nhiệm vụ M2 — System Research |
|---|---|---|---|
| **KING** | TL | Research Director — nhìn lớn, chia nhỏ, kiểm soát chặt | Phân loại mission M1/M2, điều phối audit, tổng hợp Proposal → SELF-DIRECTION |
| **SIVIL** | G1 Sub-Orchestrator | Điều phối sub-agents (5–300) explore song song | Dispatch SAs audit từng module TMO |
| **BELI** | G1 Coder | Code lượt đầu theo spec | Research report + POC (trong Workspace) |
| **LISMA** | G2 | Review, tìm bug, fix bug | System Diagnostician — root cause từ logs + code |
| **HAN** | G3 | Optimizer + self-evolving qua KB | Architecture Proposer + tối ưu performance |

### 1.2 Model Stack (mọi agent, mọi sub-agent)

- Model chính: **Kimi-k3**. Fallback: **DeepSeek v4 Pro → DeepSeek v4 Flash → MiniMax-M3**.
- Role-based: "same brain, different briefing" — chất lượng đến từ JD + Instructions, không từ model. Khi fallback, agent GIỮ NGUYÊN vai trò + JD.

### 1.3 Mission & Môi trường

- **M1 — Kaggle Research** → output: Submission / Dataset / Documentation → User.
- **M2 — System Research TMO** → output: PROPOSAL → SELF-DIRECTION (chờ user hoặc agent ủy quyền phê duyệt).
- **Live System** (TMO đang chạy local): agents CHỈ ĐỌC làm evidence. **Workspace** (thư mục clone do user mở): nghiên cứu + chỉnh sửa + POC + chạy thử. Áp lên Live System chỉ sau khi Proposal **APPROVED**.

### 1.4 Quy ước ID

| Loại | Format | Ví dụ |
|---|---|---|
| Task | `T-<MISSION>-<NNN>` | T-HP-002 |
| Proposal | `P-YYYYMMDD-NNN` | P-20250612-001 |
| KB Entry | `KB-YYYYMMDD-NNN` | KB-20250612-002 |
| Finding | `F-NNN` | F-03 |
| Sub-agent | `SA-NN` | SA-07 |
| Decision (TL Decision Log) | `D-NNN` | D-007 |
| Artifact M1 | `artifact:type:metric_impact` | `target_encoding:feature:CV -0.006` |
| Artifact M2 | `file:type:relevance:status` | `src/lib/memory.ts:source:core-target:audited` |

### 1.5 Ngôn ngữ & format

Tiếng Việt · Markdown · bảng + ASCII box + emoji section headers (như nguồn) · quy tắc được **đậm**.

---

## §2. MASTER INDEX — 13 FILE

| TB | File | Tiêu đề | Nguồn (dòng) | Dòng (v1.2) | Effort | Nhóm | TT |
|---|---|---|---|---|---|---|---|
| TB-00 | `TB-00-master-index.md` | Master Index & Blueprint Map | — | 173 | S | A | ✅ |
| TB-01 | `TB-01-foundation-roster-model-env.md` | Foundation — Roster, Model Stack, Environments | 1–107 | 199 | S | A | ✅ |
| TB-02 | `TB-02-architecture-tier-system.md` | Team Architecture & Tier System | 108–169, 3174–3284, 4515–4560 | 318 | M | A | ✅ |
| TB-03 | `TB-03-g1-engine-sivil-beli.md` | G1 Engine — SIVIL & BELI | 170–678 | 926 | L | B | ✅ |
| TB-04 | `TB-04-g2-engine-lisma.md` | G2 Engine — LISMA | 679–1118 | 848 | L | B | ✅ |
| TB-05 | `TB-05-g3-engine-han-knowledge-base.md` | G3 Engine — HAN & Team Knowledge Base | 1119–1717 | 1.034 | L | B | ✅ |
| TB-06 | `TB-06-tl-engine-king.md` | TL Engine — KING (7 nhiệm vụ + Council) | 1827–2708 | 1.269 | L | B | ✅ |
| TB-07 | `TB-07-tl-decomposition-playbook.md` | TL Research Decomposition Playbook | 2709–3173 | 763 | M | B | ✅ |
| TB-08 | `TB-08-knowledge-capture-protocol.md` | Knowledge Capture Protocol | 1718–1826 | 225 | S | C | ✅ |
| TB-09 | `TB-09-rwv-loop-handoff-protocol.md` | RWV Loop & Handoff Protocol | 3285–3779 | 724 | M | C | ✅ |
| TB-10 | `TB-10-directed-reading-artifact-map.md` | Directed Reading & Research Artifact Map | 3780–4287 | 673 | M | C | ✅ |
| TB-11 | `TB-11-proposal-schema-self-direction.md` | Proposal Schema & SELF-DIRECTION Route | 4288–4345 | 172 | S | D | ✅ |
| TB-12 | `TB-12-e2e-playbooks-test-cases.md` | E2E Playbooks & Test Cases | 4346–4635 | 325 | M | D | ✅ |

---

## §3. DEPENDENCY GRAPH & BUILD ORDER

```
                    ┌──────────┐
                    │  TB-00   │ Master Index (chuẩn toàn tập)
                    └────┬─────┘
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
     ┌─────────┐   ┌─────────┐   ┌─────────┐
     │ TB-01   │──▶│ TB-02   │   │ TB-08   │  ← độc lập, build sớm
     │Foundation│   │Arch/Tier│   │KnowCap │
     └────┬────┘   └────┬────┘   └────┬────┘
          └──────┬───────┴─────────────┘
                 ▼  (engines — đọc Foundation trước)
   ┌─────────┬─────────┬─────────┬─────────┬─────────┐
   │  TB-03  │  TB-04  │  TB-05  │  TB-07  │  TB-10  │
   │  G1     │  G2     │ G3+KB   │Decompose│ ReadMap │
   └────┬────┴────┬────┴────┬────┴────┬────┴────┬────┘
        └─────────┴────┬────┴─────────┴─────────┘
                       ▼  (KING cần biết cả 3 engines)
                  ┌─────────┐
                  │  TB-06  │ KING Engine
                  └────┬────┘
                       ▼
                  ┌─────────┐         ┌──────────┐
                  │  TB-09  │────────▶│  TB-11   │
                  │ RWV/HFO │         │ Proposal │
                  └────┬────┘         └────┬─────┘
                       └───────┬───────────┘
                               ▼
                          ┌─────────┐
                          │  TB-12  │ E2E Playbooks (đối soát toàn tập)
                          └─────────┘
```

**Thứ tự build:** TB-00 → TB-01 → TB-02 → {TB-03, TB-04, TB-05, TB-07, TB-08, TB-10 — song song} → TB-06 → TB-09 → TB-11 → TB-12.

---

## §4. TEMPLATE CHUẨN MỖI FILE TB

```markdown
# TB-XX — [Tiêu đề]
> Technical Blueprint — AI Research Team (Dual Mission: M1 Kaggle + M2 System Research)
> Traceability: ai-team-workflow.md §[sections], dòng [a–b]
> Version: 1.0 | Ngày | Author

## §0. Mục đích & Phạm vi
   (ai đọc — dùng làm gì — KHÔNG bao gồm gì — file nào liên quan)

## §1..N. Nội dung spec (theo nguồn, mở rộng chi tiết)

## §N.   Data Schemas / Templates / Interfaces
## §N+1. Luồng xử lý & State (diagram + bảng transition)
## §N+2. Error Handling & Edge Cases
## §N+3. Acceptance Criteria (checklist verify ≥ 10 items)
## §N+4. Open Questions & Phụ thuộc
## Phụ lục A — Traceability Matrix (bảng: section nguồn → section blueprint)
```

> **Quy ước header (đồng bộ từ Version 1.1):** mọi section top-level dùng `## §N.` (đã chuẩn hóa toàn tập 13 file — tham chiếu chéo "TB-XX §n" viết theo định dạng này).

---

## §5. QUY TẮC TRACEABILITY

Mỗi section blueprint phải ghi nguồn dạng `[TB-XX §n ← nguồn dòng a–b]` và đánh dấu 1 trong 3 mức:

| Dấu | Ý nghĩa |
|---|---|
| `[SRC]` | Giữ nguyên ý nguồn — chỉ chi tiết hóa cách viết |
| `[EXT]` | Mở rộng thiết kế MỚI (interfaces, state, edge cases...) — không mâu thuẫn nguồn |
| `[Q]` | Câu hỏi mở — cần user/quyết định sau *(→ từ v1.3: đã toàn bộ chuyển `[DECIDED v1.3]` theo DECISION-RECORD-v1.3.md)* |
| `[DECIDED v1.3]` | Câu hỏi mở ĐÃ ĐƯỢC CHỐT (user ủy quyền Z.ai Code, 2026-09-01, chính sách thorough-first) — truy vết bằng số Q gốc + cụm C1–C7 |

**Cấm:** phát minh cơ chế mâu thuẫn nguồn. Nếu bắt buộc phải khác nguồn → dừng, ghi vào Open Questions, báo user. *(Từ v1.3: không còn [Q] chưa chốt — mọi thay đổi thiết kế mới phải ghi vào Phụ lục Z nguồn + cập nhật DECISION-RECORD.)*

---

## §6. STATUS TRACKER

| Đợt | Files | Trạng thái |
|---|---|---|
| A — Nền tảng | TB-00, TB-01, TB-02 | ✅ Hoàn tất |
| B — Engines | TB-03, TB-04, TB-05, TB-06, TB-07 | ✅ Hoàn tất |
| C — Protocols ngang | TB-08, TB-09, TB-10 | ✅ Hoàn tất |
| D — Output & E2E | TB-11, TB-12 | ✅ Hoàn tất |
| E — Decision Lock v1.3 | Toàn tập (nguồn Phụ lục Z + 13 TB) | ✅ Hoàn tất (2026-09-01) |

*Tập 13 blueprint HOÀN TẤT (Version 1.2 — đã qua 2 đợt đảm bảo chất lượng: **review Task 9** — 6 reviewer độc lập đối chiếu 67 findings với nguồn, phân loại P1×2 · P2×3 · P3×21 · P4×41; **fix Task 10** — 6 fixer + coordinator áp toàn bộ P1/P2/P3 và các P4 sửa được cục bộ: typo, citation sai dòng, state machine self-consistent, đồng bộ cross-ref tập, attribution [SRC]/[EXT], bổ edge POC-NEEDS-WORKSPACE ở TB-09/TB-10 — chi tiết worklog Task 9/10). Nguồn ai-team-workflow.md nguyên vẹn 4.635 dòng + Phụ lục Z (v1.3).*

*Đợt E — DECISION LOCK v1.3 (2026-09-01): user **ủy quyền Z.ai Code chốt toàn bộ 71 [Q]** với chính sách **thorough-first** (cẩn thận – chi tiết – đầy đủ, tránh hời hợt) + **không ràng buộc token** (NVIDIA NIM 4 keys, sẽ tăng). Quyết định canonical: `docs/DECISION-RECORD-v1.3.md`; nguồn đã cập nhật trước theo quy tắc TB-00 §5 (Phụ lục Z append-only, dòng gốc nguyên vẹn). Mọi [Q] → [DECIDED v1.3], mọi section Open Questions → Decisions. Triển khai runtime là thao tác riêng — chờ user khởi động.*
