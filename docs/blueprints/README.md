# 📚 docs/blueprints — CODE KIT TEAM RESEARCH (v1.5)

> **Trạng thái: ✅ READY-TO-CODE** — 71/71 quyết định v1.3 + toàn bộ protocol chấm điểm v1.5 (Phụ lục Z2) đã chốt. Thư mục này **tự chứa 100%** mọi file cần để code team research vào TMO app.

## Inventory — 18 file

| # | File | Vai trò |
|---|---|---|
| 1 | `README.md` | File này — hướng dẫn đọc + quy tắc đồng bộ |
| 2 | `TB-00-master-index.md` | **Đọc đầu tiên** — index, quy ước toàn tập, status tracker |
| 3 | `TB-01-foundation-roster-model-env.md` | Roster · model · env · workspace |
| 4 | `TB-02-architecture-tier-system.md` | Kiến trúc 3-tier · CLASSIFY router |
| 5 | `TB-03-g1-engine-sivil-beli.md` | G1 — SIVIL (research) + BELI (spec) |
| 6 | `TB-04-g2-engine-lisma.md` | G2 — LISMA (implement, RWV) |
| 7 | `TB-05-g3-engine-han-knowledge-base.md` | G3 — HAN + Knowledge Base |
| 8 | `TB-06-tl-engine-king.md` | NEMESIS — TL engine + 4 councils |
| 9 | `TB-07-tl-decomposition-playbook.md` | Phân rã mission → parts/tasks |
| 10 | `TB-08-knowledge-capture-protocol.md` | Capture tri thức mọi tier |
| 11 | `TB-09-rwv-loop-handoff-protocol.md` | RWV loop + handoff gate |
| 12 | `TB-10-directed-reading-artifact-map.md` | Đọc có hướng + artifact map |
| 13 | `TB-11-proposal-schema-self-direction.md` | Proposal P-* + self-direction |
| 14 | `TB-12-e2e-playbooks-test-cases.md` | **18 TC acceptance toàn hệ** (14 + 4 TC scoring v1.5) |
| 15 | `TB-13-implementation-build-plan.md` | **⭐ Bắt đầu code từ đây** — bản đồ module → code TMO app |
| 16 | `TB-14-solution-scoring-selection-protocol.md` | **⭐ v1.5 mới** — Rubric A/B chấm điểm · Tournament giả thiết · Council ⑤ · Context-Fit · DIRECT-APPLY rule |
| 17 | `ai-team-workflow.md` | Bản sao NGUỒN SSOT (4.745 dòng, kèm Phụ lục Z v1.3 + Z2 v1.5) |
| 18 | `DECISION-RECORD-v1.3.md` | Bản sao canonical 71 quyết định (C1–C7 + 64) |

## Thứ tự đọc khi bắt đầu code

```
TB-00 (quy ước) → TB-13 (bản đồ code) → DECISION-RECORD-v1.3 (quyết định)
→ TB-01 + TB-02 (nền tảng) → engines TB-03/04/05/07/10 (theo phase P2-P4 ở TB-13 §5)
→ TB-14 (scoring/tournament — phase P2b) → TB-06 (NEMESIS) → TB-09 + TB-11 (handoff/proposal)
→ TB-12 (verify 18 TC) → tra cứu truy nguyên: ai-team-workflow.md (tìm [SRC] trong các TB)
```

## Quy ước annotation (TB-00 §5)

- `[SRC]` = trích nguồn `ai-team-workflow.md` (đúng dòng) · `[EXT]` = mở rộng blueprint · `[DECIDED v1.3]` = quyết định đã chốt · `[SRC Z2.x]` = trích Phụ lục Z2 (v1.5, dòng 4684–4745)
- **Quy tắc số 1:** sửa thiết kế → cập nhật NGUỒN trước (`upload/ai-team-workflow.md`, append-only) → blueprint sau → code cuối

## Quy tắc đồng bộ 3 bản sao

| Vị trí | Vai trò |
|---|---|
| `docs/blueprints/` | **Bản làm việc** (dev đọc tại sandbox my-project) |
| `upload/blueprints/` | **Bản persist** (sống qua sandbox reset — luôn mirror docs/) |
| `/home/z/tmo-app/docs/blueprints/` | **Bản GitHub** (repo `nguyenquocviety2c-code/TMO`, push sau mỗi đợt đổi) |

> Khi đổi bất kỳ file nào ở `docs/blueprints/`: copy sang `upload/blueprints/` + `/home/z/tmo-app/docs/blueprints/` → commit platform git (my-project, reset-survival) → push GitHub → ghi worklog `my-project/worklog.md`.

## Không được phép

- ❌ Sửa/rewrite nội dung dòng gốc nguồn `ai-team-workflow.md` (chỉ append Phụ lục)
- ❌ Mở lại quyết định đã `[DECIDED v1.3]` mà không qua Decision Log + lý do (append-only)
- ❌ Code mâu thuẫn spec (SSOT chain: nguồn → DR → TB → code)
- ❌ Ghi vào Live System ngoài workspace clone (Live = read-only)

---
*v1.5 — 2026-09-01 · Tạo Task 23 (Z.ai Code main): TB-14 + Phụ lục Z2 theo yêu cầu user. Muốn đảo bất kỳ quyết định nào: đọc `DECISION-RECORD-v1.3.md` §4 (quy ước sau chốt) — quyết định v1.5 đảo qua Decision Log NEMESIS + amend Phụ lục Z2.*
