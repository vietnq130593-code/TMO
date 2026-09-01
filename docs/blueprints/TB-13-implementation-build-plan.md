# TB-13 — IMPLEMENTATION BUILD PLAN: TEAM RESEARCH → CODE TMO APP

> **Phiên bản:** v1.5 (2026-09-01 — Task 23: bổ phase P2b + 2 model Prisma + 4 TC theo TB-14; Task 24: vá nhất quán đếm số) · **Trạng thái:** ✅ READY-TO-CODE — mọi quyết định đã chốt ở DECISION-RECORD v1.3 + Phụ lục Z2 v1.5
> **Vai trò:** Bản đồ triển khai — dịch 14 blueprint (TB-00→TB-12 + TB-14) + 71 quyết định v1.3 + Phụ lục Z2 v1.5 (solution scoring) thành **code cụ thể trong TMO app** (đường dẫn file, Prisma model, API route, build phase, acceptance).
> **Quy ước:** Toàn bộ nội dung file này là `[EXT]` (mở rộng triển khai), tham chiếu `[SRC]` = `ai-team-workflow.md` (Phụ lục Z v1.3) và `[DR-Cn]` = cụm quyết định C1–C7 trong `DECISION-RECORD-v1.3.md`.
> **Nguyên tắc vàng:** Đây là file **dẫn đường cho dev/agent code** — mọi thứ cần đọc đều nằm trong thư mục `docs/blueprints/` (tự chứa 100%).

---

## §0. MỤC ĐÍCH & PHẠM VI

**Mục đích:** Bất kỳ dev (người) hoặc agent (máy) cầm file này đều biết chính xác: code gì, đặt ở đâu, theo thứ tự nào, nghiệm thu bằng cách nào — **không phải tự suy đoán từ 14 blueprint**.

**Phạm vi IN:**
- Team research = 8 thành phần: Router/CLASSIFY, G1 (SIVIL+BELI), G2 (LISMA), G3 (HAN+KB), KING (TL engine), Councils ①–⑤, Solution Scoring & Selection (TB-14: Rubric A/B + Tournament + Context-Fit + DIRECT-APPLY), RWV/Handoff + Proposal/Self-Direction.
- Tích hợp vào TMO app hiện có (Next.js 16 App Router, Prisma SQLite, mini-services).

**Phạm vi OUT (việc riêng, chờ lệnh):**
- Viết code runtime thực tế (file này chỉ là plan).
- Re-ingest 52 PDF vào Qdrant `theopus_documents` (việc treo từ trước).
- Thêm NIM key mới (hiện có 4, cấu hình đã xong trong `.env`).

---

## §1. NGUYÊN TẮC TRIỂN KHAI (bất biến)

| # | Nguyên tắc | Nguồn |
|---|---|---|
| 1 | **SSOT chain:** `ai-team-workflow.md` (nguồn) → `DECISION-RECORD-v1.3.md` (quyết định) → TB-01..12 (spec) → **code**. Code mâu thuẫn spec = bug của code, không phải ngược lại. | TB-00 §5 |
| 2 | **Thorough-first:** mọi trade-off thời-thời-gian-nhanh thua thời-cẩn-thận-đầy-đủ. Không ràng buộc token (4 NIM key). | DR §0 |
| 3 | **Append-only audit trail:** mọi thay đổi mission/task/spec ghi amendment + CHANGELOG, không rewrite lịch sử. | DR C3 |
| 4 | **Live System read-only tuyệt đối:** agent research CHỈ đọc Live; mọi ghi nằm trong Workspace clone + diff kèm Proposal. | TB-01 §3, TC-10 |
| 5 | **Evidence bắt buộc:** claim không có evidence (file:line + log excerpt) → bị loại / EVIDENCE-GAP. | TB-04 §5, TC-06 |
| 6 | **Tái dùng hạ tầng có sẵn:** NIM client (`src/lib/llm.ts` — đã xoay vòng 4 key + fallback chain), `ServiceKeyPool`, cron-scheduler, Prisma `db`, workspace git — **không viết lại**. | §6 file này |
| 7 | **Mọi module mới có test đối chiếu TB-12:** 18 TC là acceptance duy nhất của toàn hệ (14 gốc + TC-15→TC-18 scoring v1.5). | TB-12 §3.2 |

---

## §2. BẢN ĐỒ MODULE — BLUEPRINT → CODE

Thư mục mới trung tâm: **`src/lib/research-team/`** (mọi file mới của team research nằm ở đây hoặc con của nó).

### 2.1 Bảng map tổng (mỗi TB → file code)

| Blueprint | Module code sẽ tạo | Ghi chú |
|---|---|---|
| TB-01 Foundation/Roster/Model/Env | `src/lib/research-team/constants.ts` · `types.ts` · `model-switch.ts` | Roster research (KING/SIVIL/BELI/LISMA/HAN + SA), env đọc từ `.env` sẵn. Model switch format DR-C7 |
| TB-02 Arch/Tier System | `src/lib/research-team/classify.ts` · `mission-store.ts` · `tier.ts` | CLASSIFY 3-tier, confidence counting DR-C2, tie-break UP |
| TB-03 G1 SIVIL+BELI | `src/lib/research-team/g1/` — `sivil.ts` · `beli.ts` · `engine.ts` · `sub-agents.ts` | SA round-robin 20/25, council ① ②, dual-interpretation escalation |
| TB-04 G2 LISMA | `src/lib/research-team/g2/` — `lisma.ts` · `rwv-loop.ts` · `evidence-log.ts` | RWV loop, Regression entry, KHÔNG auto-apply |
| TB-05 G3 HAN+KB | `src/lib/research-team/g3/` — `han.ts` · `kb-store.ts` | KB 3 tầng DR-C6, curate kép 3 mốc, trần 3 vòng, cold-start seed |
| TB-06 KING Engine | `src/lib/research-team/king/` — `engine.ts` · `councils.ts` · `decision-log.ts` · `escalation.ts` | VETO, PIVOT, timeout 48h/24h + nhắc 12h DR-C5, deputy SIVIL/HAN |
| TB-07 Decompose Playbook | `src/lib/research-team/king/decompose.ts` · `task-md.ts` | task .md template + Success Criteria gate (TC-13) |
| TB-08 Knowledge Capture | `src/lib/research-team/g3/capture.ts` | Capture tại MONITOR/FINALIZE cho T1 (TC-08), pre-approval retire |
| TB-09 RWV/Handoff | `src/lib/research-team/handoff.ts` · `worklog-schema.ts` | Gate Artifact Map E4 (TC-14), Confidence 8 trường, format model_switched |
| TB-10 Directed Reading | `src/lib/research-team/g1/reading-map.ts` · `artifact-map.ts` | 1 map G1 duy nhất, đọc có hướng |
| TB-11 Proposal/Self-Direction | `src/lib/research-team/proposal/` — `store.ts` · `git-branch.ts` + bridge sang `src/lib/self-direction/` (đã tồn tại) | P-YYYYMMDD-NNN, 1 Proposal = 1 branch, APPLY = merge sau APPROVED |
| TB-12 E2E Playbooks | `src/lib/research-team/__tests__/` + golden-run script | 18 TC — xem §8 |
| TB-14 Solution Scoring | `src/lib/research-team/scoring/` — `rubric-a.ts` · `rubric-b.ts` · `tournament.ts` · `context-fit.ts` + mở rộng `king/councils.ts` (kind=5) + `g2/experiment.ts` | Rubric A/B + tournament 5 vòng + Council ⑤ + DIRECT-APPLY rule — TC-15→TC-18 |
| TB-00/TB-13 (meta) | README này + index | không sinh code |

### 2.2 API layer — `src/app/api/research/`

| Route | Method | Chức năng |
|---|---|---|
| `/api/research/missions` | GET/POST | List/tạo mission (POST → CLASSIFY gán tier) |
| `/api/research/missions/[id]` | GET/PATCH | Chi tiết + state transition (append-only event) |
| `/api/research/missions/[id]/decompose` | POST | KING DECOMPOSE (gate council ①) |
| `/api/research/missions/[id]/monitor` | POST | Vòng MONITOR + KB capture + PIVOT check |
| `/api/research/missions/[id]/finalize` | POST | FINALIZE + KB capture + Council ④ |
| `/api/research/tasks/[id]` | GET/PATCH | task .md + amendment CHANGELOG |
| `/api/research/worklog` | GET/POST | worklog entry (zod-validated schema TB-09 §3) |
| `/api/research/kb` | GET/POST | KB query/seed/retire (3 tầng) |
| `/api/research/proposals` | GET/POST | P-* lifecycle: DRAFT→SUBMITTED→APPROVED/REJECTED→APPLIED |
| `/api/research/proposals/[id]/review` | POST | ESCALATED_USER review (kèm deputy khi timeout) |
| `/api/research/escalations` | GET/POST | queue timeout 48h/24h, nhắc 12h |
| `/api/research/health` | GET | tình trạng module + NIM pool + KB |

### 2.3 Cấu trúc thư mục đích (tạo mới)

```
src/lib/research-team/
├── constants.ts          # roster, tier, timeout, threshold (đơn nguồn truth runtime)
├── types.ts              # TS types cho mọi Prisma model research
├── classify.ts           # TB-02 router
├── mission-store.ts      # lifecycle mission (state machine)
├── tier.ts               # nâng/hạ tier append-only DR-C3
├── handoff.ts            # TB-09 gate
├── worklog-schema.ts     # zod schema worklog
├── model-switch.ts       # DR-C7 format
├── king/  (engine, councils, decision-log, escalation, decompose, task-md)
├── g1/    (sivil, beli, engine, sub-agents, reading-map, artifact-map)
├── g2/    (lisma, rwv-loop, evidence-log)
├── g3/    (han, kb-store, capture)
├── scoring/ (rubric-a, rubric-b, tournament, context-fit)   # TB-14 v1.5
├── proposal/ (store, git-branch)
└── __tests__/ (tc-01..tc-18 + golden-run)                    # 18 TC (v1.5)
```

---

## §3. DATA LAYER — PRISMA MODELS MỚI

Thêm vào `prisma/schema.prisma` (chú ý: **không dùng list primitive** — mọi mảng encode JSON `String`, decode bằng helper `types.ts`):

```prisma
// ===== RESEARCH TEAM (TB-01..TB-12, DECISION-RECORD v1.3) =====
model ResearchMission {
  id            String   @id @default(cuid())
  code          String   @unique          // MS-YYYYMMDD-NNN
  title         String
  request       String
  missionType   String                     // M1 verify | M2 change | M3 grand
  tier          String                     // T1 | T2 | T3
  status        String                     // CLASSIFY→RESEARCHING→...→FINALIZED (bảng TB-02 §7)
  confidenceJson String   @default("{}")   // tín hiệu C2: {signals, conflicts, level}
  decisionLogJson String  @default("[]")   // Decision Log KING (mọi quyết định)
  changelogJson  String   @default("[]")   // CHANGELOG amendment DR-C3
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  tasks         ResearchTask[]
  worklogs      ResearchWorklog[]
  proposals     ResearchProposal[]
}

model ResearchTask {
  id               String  @id @default(cuid())
  missionId        String
  mission          ResearchMission @relation(...)
  partIdx          Int                      // part 1..N
  title            String
  taskMdPath       String                   // docs/research/<mission>/part-N.md
  successCriteriaJson String @default("[]")// BẮT BUỘC — gate TC-13
  assignedGroup    String?                  // G1|G2|G3
  status           String                   // DRAFT→APPROVED→ASSIGNED→...
  amendmentsJson   String  @default("[]")   // append-only
  createdAt        DateTime @default(now())
}

model ResearchWorklog {
  id              String  @id @default(cuid())
  taskId          String
  task            ResearchTask @relation(...)
  phase           String                    // TRIAGE|RESEARCH|VERIFY|MONITOR|FINALIZE...
  entryJson       String                    // schema 8 trường Confidence TB-09 §3
  evidenceJson    String  @default("[]")    // [{claim, file, line, excerpt}]
  artifactMapJson String?                   // 1 map G1 duy nhất — gate E4 TC-14
  modelSwitchedJson String @default("[]")   // DR-C7 format
  createdAt       DateTime @default(now())
}

model ResearchKBEntry {
  id            String   @id @default(cuid())
  category      String                     // lesson | anti-pattern | baseline |...
  title         String
  content       String
  sourceMission String?
  phase         Int      @default(1)       // mốc curate kép 1→2→3
  snapshotMdPath String?                   // tầng 2 DR-C6
  retiredAt     DateTime?
  createdAt     DateTime @default(now())
}

model ResearchProposal {
  id          String   @id @default(cuid())
  code        String   @unique              // P-YYYYMMDD-NNN
  missionId   String
  mission     ResearchMission @relation(...)
  status      String                        // DRAFT|SUBMITTED|APPROVED|REJECTED|APPLIED
  schemaJson  String                        // schema TB-11 §1
  branchName  String?                       // git branch trùng code
  diffSummary String?
  reviewedBy  String?                       // user | deputy:SIVIL | deputy:HAN
  timeoutAt   DateTime?                     // C5: 48h (T3) / 24h (T2)
  decidedAt   DateTime?
  createdAt   DateTime @default(now())
}

model ModelSwitchEvent {
  id          String   @id @default(cuid())
  agentId     String
  fromModel   String
  toModel     String
  trigger     String                      // DR-C7: lý do (429/5xx/timeout...)
  nextCheck   String                      // DR-C7: thời điểm check quay lại model chính
  at          DateTime @default(now())
}

model CouncilTranscript {
  id         String   @id @default(cuid())
  missionId  String
  round      Int                        // ① post-DECOMPOSE | ② pre-code | ③ escalation | ④ final | ⑤ solution council (TB-14)
  kind       Int
  verdict    String                     // PASS|REVISE|VETO (② ③) · CONTINUE-ITERATE|CONVERGE|PIVOT|DROP (⑤)
  blocking   Boolean  @default(true)    // council đồng bộ — chặn pipeline
  transcript String
  createdAt  DateTime @default(now())
}

// ===== TB-14 v1.5 — SOLUTION SCORING & SELECTION =====
model HypothesisRecord {
  id             String   @id @default(cuid())
  missionId      String
  problemStmt    String
  hypothesis     String
  scoreAJson     String   @default("{}")   // {D1..D5 điểm, score, grade}
  killCriteria   String?                  // evidence nào sẽ bác bỏ (bắt buộc khi CONFIRMED)
  killTestResult String?                  // PASS|FAIL + evidence
  status         String                     // GENERATED|SCORING|FALSIFYING|CONFIRMED|REJECTED|KILLED
  round          Int      @default(1)      // vòng tournament 1..3
  createdAt      DateTime @default(now())
}

model ExperimentRecord {
  id            String   @id @default(cuid())
  missionId     String
  optionId      String                     // A/B/C...
  hypothesisRef String?                    // HypothesisRecord id
  specPath      String?                    // spec BELI
  branchName    String?                    // P-POC-<option>
  scoreExpected String   @default("{}")   // scorecard B pre
  scoreMeasured String?                    // scorecard B post
  deltaJson     String?                    // delta + calibration lesson refs
  metricsJson   String?                    // số liệu đo (a)/(b)
  status        String                     // DRAFT|SPEC|POC|MEASURED|SCORED
  createdAt     DateTime @default(now())
}
```

**Lệnh áp schema:** `bun run db:push` (không destructive — chỉ thêm bảng mới).

---

## §4. RUNTIME NIM — 4 KEY (đã sẵn, chỉ cấu hình lại)

| Việc | Chi tiết | Nguồn |
|---|---|---|
| Client | **Tái dùng `src/lib/llm.ts`** — đã hỗ trợ `NVIDIA_API_KEY_1..4` xoay vòng + fallback chain + `AGENT_PRIMARY_MODEL` | TB-01 §2 |
| Roster model | `moonshotai/kimi-k3` toàn bộ agents + SA (đồng bộ 7 agents app hiện có) | TB-01 §1 |
| SA round-robin | Sub-agent dispatch ≤20 SA/1 part, 25/vòng G1 — chia đều 4 key qua pool | DR TB-03 |
| Timeout | EDA 30m · Grand research 60m · Audit 30m (`AGENT_STEP_TIMEOUT_MS` đã có) | DR TB-03 |
| Model switch | Bắt qua `ModelSwitchEvent` + dòng worklog `model switched` format DR-C7: `model switched: <from> → <to> | trigger: <lý do> | next check: <thời điểm>` | DR-C7, TC-12 |

**Không cần mini-service mới** — engines chạy trong Next.js app (server-side `src/lib`), cron nhắc/timeout dùng mini-service `cron-scheduler` (:3004) + model `CronJob` có sẵn.

---

## §5. BUILD PHASES (theo dependency graph TB-00 §3)

> Mỗi phase có gate verify riêng; **không sang phase sau khi gate fail**.

| Phase | Nội dung | Gate |
|---|---|---|
| **P0 — Scaffold** | Tạo `src/lib/research-team/` khung + `constants.ts` + `types.ts` + Prisma models §3 + `db:push` | `/api/research/health` trả 200 + các bảng xuất hiện trong db |
| **P1 — Router** | `classify.ts` + `mission-store.ts` + route `/missions` · confidence counting C2 (HIGH ≥3 tín hiệu 0 mâu thuẫn / MEDIUM 1 mâu thuẫn → tie-break UP / LOW ≥2 → hỏi đúng 1 câu) | TC-01 pass |
| **P2 — G1** | `g1/*` — SIVIL dispatch SA + BELI spec + council ① ② (blocking) + dual-interpretation escalation | TC-03, TC-07 pass |
| **P2b — Scoring/Tournament (TB-14)** | `scoring/*` — Rubric A/B + tournament 5 vòng + context-fit + council ⑤ kind=5 + ExperimentRecord POC branch | TC-15, TC-16, TC-17 pass |
| **P3 — G2** | `g2/*` — RWV loop + evidence log + Regression entry + workspace clone (Live read-only) | TC-04, TC-06, TC-10 pass |
| **P4 — G3+KB** | `g3/*` — KB 3 tầng (SQLite canonical + snapshot md + index) + cold-start seed + curate kép 3 mốc + trần 3 vòng | TC-05 pass |
| **P5 — KING** | `king/*` — full lifecycle + councils ③ ④ + VETO + PIVOT + escalation deputy + timeout 48h/24h/12h | TC-09, TC-11 pass |
| **P6 — Handoff+Proposal** | `handoff.ts` gate Artifact Map + `proposal/*` P-YYYYMMDD-NNN git branch + self-direction bridge | TC-08, TC-13, TC-14 pass |
| **P7 — E2E** | `__tests__/` 18 TC + golden-run script + verify toàn tập | **18/18 TC pass** |

---

## §6. CHI TIẾT ĐIỂM TÍCH HỢP VỚI APP HIỆN CÓ

| Hạ tầng có sẵn | Cách team research dùng |
|---|---|
| `src/lib/llm.ts` | Gọi model cho KING/SIVIL/BELI/LISMA/HAN + SA — truyền `taskLabel` để log đúng |
| `src/lib/service-key-pool.ts` | Mẫu cho pool key SA (nếu cần tách pool riêng khỏi LLM chính) |
| `src/lib/self-direction/orchestrator.ts` | Proposal APPROVED → bridge gọi orchestrator hiện có thực thi APPLY |
| `src/lib/github-token-store.ts` + workspace git | `git-branch.ts` tạo branch P-*, merge sau APPROVED |
| `mini-services/cron-scheduler` (:3004) | Đăng job timeout C5 + nhắc 12h cho Proposal pending |
| `src/lib/db.ts` | `import { db } from '@/lib/db'` — mọi store |
| `src/lib/qdrant.ts` | Tầng KB mở rộng (tùy chọn) — canonical vẫn SQLite DR-C6 |

---

## §7. WORKSPACE & GIT FLOW (TB-01 §3, TB-11)

```
Mission tạo → workspace clone (đường dẫn: workspace/research/<mission-code>/)
  → mọi ghi của LISMA/BELI nằm TRONG clone (Live = read-only)
  → Proposal SUBMITTED: branch P-YYYYMMDD-NNN + diff summary
  → APPROVED → merge branch → APPLY qua self-direction
  → REJECTED → KING Decision Log → re-DECOMPOSE phần liên quan (không re-submit nguyên trạng — TC-11)
```

---

## §8. ACCEPTANCE — MAP 18 TC → CÁCH VERIFY CODE

| TC | Verify bằng | File test |
|---|---|---|
| TC-01 | POST mission mơ hồ → API trả đúng 1 câu hỏi, KHÔNG guess | `tc-01-classify.ts` |
| TC-02 | Mission M2/T2 → output = Proposal 1-module (không final report) | `tc-02-m2-pipeline.ts` |
| TC-03 | 2 SA mâu thuận → worklog có khối điều tra + escalation | `tc-03-conflict.ts` |
| TC-04 | Fix gây regression → entry Type=Regression + re-test bug gốc | `tc-04-regression.ts` |
| TC-05 | KB trống → seed starter + không crash | `tc-05-kb-coldstart.ts` |
| TC-06 | Claim thiếu evidence → bị loại khỏi Diagnostic Report | `tc-06-evidence-gap.ts` |
| TC-07 | Thứ tự log: SYNTHESIZE → council ② → SPEC → BELI | `tc-07-council2-order.ts` |
| TC-08 | Task T1 → KB có entry từ MONITOR/FINALIZE | `tc-08-t1-capture.ts` |
| TC-09 | Trigger 🔴 → Decision log có lý do PIVOT | `tc-09-pivot.ts` |
| TC-10 | Mọi file sửa nằm trong clone; Live log không đổi | `tc-10-workspace.ts` |
| TC-11 | REJECTED → status RESEARCHING + Decision log lý do | `tc-11-rejected.ts` |
| TC-12 | Fallback giữa task → task KHÔNG reset + dòng model switched | `tc-12-model-switch.ts` |
| TC-13 | task .md thiếu Success Criteria → council ① chặn ASSIGN | `tc-13-decompose-gate.ts` |
| TC-14 | Worklog thiếu Artifact Map → gate chặn group kế | `tc-14-handoff-gate.ts` |
| TC-15 | Giả thiết không có kill-criteria → tối đa PROBABLE | `tc-15-kill-criteria.ts` |
| TC-16 | Scorecard kỳ vọng 4.2 thực đo 2.1 → calibration lesson + CONTINUE-ITERATE | `tc-16-calibration-delta.ts` |
| TC-17 | Pattern KB sai bối cảnh → chặn APPLICABLE → tournament | `tc-17-context-fit.ts` |
| TC-18 | CONVERGE: 5 điều kiện DIRECT-APPLY vs Proposal | `tc-18-deploy-route.ts` |

**Golden-run:** script chạy tuần tự 18 TC + 1 mission E2E mẫu (seed → classify → decompose → G1→G2→G3 → tournament (TB-14) → proposal → approve → apply) — lưu kết quả `tool-results/golden-run-v1.json`.

---

## §9. RISK REGISTER

| Rủi ro | Mức | Giảm nhẹ |
|---|---|---|
| Rate-limit NIM khi dồn SA | TB | Pool 4 key + SA chia đều + cooldown có sẵn trong llm.ts; thêm key = chỉ sửa `.env` |
| Council blocking treo pipeline | TB | Timeout council 30m + deputy (SIVIL/HAN) — cùng cơ chế C5 |
| Drift schema worklog (8 trường) | TB | zod validate tại `worklog-schema.ts` — reject entry thiếu trường |
| Branch P-* trùng mã | T | NNN tăng dần theo ngày + unique constraint DB |
| Fallback giữa task mất state | TB | State nằm DB (Prisma) không nằm memory — TC-12 |
| KB phình to | T | phase 1→2→3 retire + snapshot md nén |

---

## §10. DEFINITION OF DONE (checklist verify ≥ 12 items)

- [ ] 1. `/api/research/health` 200 + báo đủ module
- [ ] 2. Prisma: 9 model research tồn tại (7 gốc + HypothesisRecord + ExperimentRecord của TB-14), `db:push` sạch
- [ ] 3. TC-01 → TC-18: 18/18 pass (bằng test tự động)
- [ ] 4. Golden-run E2E mission mẫu thành công
- [ ] 5. Council ① ② ③ ④ blocking đúng thứ tự (log thứ tự TC-07)
- [ ] 6. KB 3 tầng: SQLite canonical + snapshot md + index query được
- [ ] 7. Cold-start seed KB hoạt động (TC-05)
- [ ] 8. Proposal branch git + merge sau APPROVED
- [ ] 9. Timeout 48h/24h + nhắc 12h + deputy hoạt động (job cron đăng ký)
- [ ] 10. Model switch log đúng format DR-C7 + task không reset (TC-12)
- [ ] 11. Live System read-only: 0 thao tác ghi ngoài workspace (TC-10)
- [ ] 12. Evidence log: mọi claim có file:line + excerpt (TC-06)
- [ ] 13. Worklog zod-validate 8 trường Confidence
- [ ] 14. `bun run lint` sạch
- [ ] 15. Rubric A/B chấm đúng trọng số + ngưỡng; council ⑤ blocking; DIRECT-APPLY 5 điều kiện (TB-14 §11 AC1–AC10)

---

## Phụ lục A — TRACEABILITY MATRIX

| Nguồn quyết định | Section plan này |
|---|---|
| DR-C1 (verify-only 3 lớp) | §2.1 classify/mission-store + §8 TC-02 |
| DR-C2 (confidence counting) | §5 P1 |
| DR-C3 (append-only amendment) | §3 changelogJson/amendmentsJson |
| DR-C4 (T2 CP1 đủ sâu) | §5 P2 gate |
| DR-C5 (timeout + deputy) | §3 ResearchProposal.timeoutAt + §6 cron |
| DR-C6 (KB 3 tầng) | §3 ResearchKBEntry + §5 P4 |
| DR-C7 (model switched format) | §3 ModelSwitchEvent + §4 |
| TB-00 §3 build order | §5 phases |
| TB-12 §3.2 (18 TC — v1.5) | §8 |
| Phụ lục Z2 / TB-14 v1.5 (Rubric · Tournament · Council ⑤) | §2.1 hàng scoring + §3 HypothesisRecord/ExperimentRecord + §5 P2b + §8 TC-15→TC-18 + §10 DoD mục 15 |

---

*Tạo bởi Z.ai Code (main) — Task 21. Amend v1.5 (Task 23: +P2b +mapping TB-14 +2 model Prisma +4 TC) · vá nhất quán đếm số 14→18 TC & ký tự CJK (Task 24). File này thuộc tập `docs/blueprints/` (self-contained code kit). Khi sửa: tuân thủ append-only + cập nhật README.md của thư mục.*
