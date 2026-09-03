/**
 * RESEARCH TEAM — TYPES (TS types cho mọi Prisma model research)
 * ================================================================
 * Spec: TB-13-implementation-build-plan.md §3 (data layer) +
 * TB-09 §4.2 (worklog 8 trường) + Phụ lục Z2 v1.5 (scoring payloads).
 *
 * Quy ước bắt buộc (TB-13 §3): Prisma SQLite KHÔNG dùng list primitive —
 * mọi mảng/object encode JSON String trong DB, decode qua helper của file này.
 * Domain type = bản decode an toàn; Prisma type = bản raw (JSON còn chuỗi).
 */

import type {
  ResearchMission,
  ResearchTask,
  ResearchWorklog,
  ResearchKBEntry,
  ResearchProposal,
  ModelSwitchEvent,
  CouncilTranscript,
  HypothesisRecord,
  ExperimentRecord,
} from '@prisma/client'

// ============================================================
// §1. PRISMA RAW TYPES (re-export để store/engine import 1 chỗ)
// ============================================================

export type {
  ResearchMission,
  ResearchTask,
  ResearchWorklog,
  ResearchKBEntry,
  ResearchProposal,
  ModelSwitchEvent,
  CouncilTranscript,
  HypothesisRecord,
  ExperimentRecord,
}

// ============================================================
// §2. STATUS UNIONS (giá trị chuỗi Prisma — union để type-safe)
// ============================================================

/** ResearchMission.missionType — M1 verify | M2 change | M3 grand (TB-13 §3) */
export type MissionTypeValue = 'M1' | 'M2' | 'M3'
/** ResearchMission.tier — T1 | T2 | T3 (TB-02) */
export type MissionTierValue = 'T1' | 'T2' | 'T3'
/**
 * ResearchMission.status — flow TB-02 §7: CLASSIFY → RESEARCHING → … → FINALIZED.
 * CHÚ THÍCH P0: các trạng thái giữa đóng băng khi đọc sâu TB-02 §7 tại P1 —
 * đây là anchor đã biết chắc từ TB-13 §3; union sẽ mở rộng, không thu hẹp.
 */
export type MissionStatusValue = string

/** ResearchTask.status — DRAFT → APPROVED → ASSIGNED → … (TB-07) */
export type TaskStatusValue = string

/** ResearchProposal.status (TB-11 §1 lifecycle) */
export type ProposalStatusValue = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'APPLIED'

/** HypothesisRecord.status (Phụ lục Z2.3) */
export type HypothesisStatusValue =
  | 'GENERATED'
  | 'SCORING'
  | 'FALSIFYING'
  | 'CONFIRMED'
  | 'REJECTED'
  | 'KILLED'

/** ExperimentRecord.status (Z2.2/Z2.3) */
export type ExperimentStatusValue = 'DRAFT' | 'SPEC' | 'POC' | 'MEASURED' | 'SCORED'

/** CouncilTranscript.round — ①..⑤ (TB-06 + TB-14 council ⑤) */
export const COUNCIL_ROUNDS = {
  postDecompose: 1, // ① sau DECOMPOSE
  preCode: 2, // ② pre-code (blocking)
  escalation: 3, // ③ khi G1 ESCALATE
  final: 4, // ④ tại FINALIZE
  solution: 5, // ⑤ solution council (TB-14)
} as const
export type CouncilRoundValue = (typeof COUNCIL_ROUNDS)[keyof typeof COUNCIL_ROUNDS]

/** CouncilTranscript.verdict — PASS|REVISE|VETO (②③) · CONTINUE-ITERATE|CONVERGE|PIVOT|DROP (⑤) */
export type CouncilVerdictValue =
  | 'PASS'
  | 'REVISE'
  | 'VETO'
  | 'CONTINUE-ITERATE'
  | 'CONVERGE'
  | 'PIVOT'
  | 'DROP'

/** ResearchWorklog.phase (TB-09 §4.2 Current Phase + pipeline TB-02) */
export type WorklogPhaseValue =
  | 'TRIAGE'
  | 'RESEARCH'
  | 'VERIFY'
  | 'MONITOR'
  | 'FINALIZE'
  | 'DECOMPOSE'
  | 'ESCALATE'
  | (string & {})

/** ResearchKBEntry.category (TB-05 KB + TB-14 calibration) */
export type KBEntryCategoryValue =
  | 'lesson'
  | 'anti-pattern'
  | 'baseline'
  | 'pattern'
  | 'calibration'
  | (string & {})

// ============================================================
// §3. JSON PAYLOAD TYPES (nội dung các cột *Json)
// ============================================================

// ---------- ResearchMission.confidenceJson — tín hiệu C2 (TB-02, DR-C2) ----------
export interface ConfidenceSignals {
  /** Số tín hiệu cùng chiều ủng hộ độ tin cậy request */
  signals: string[]
  /** Các tín hiệu mâu thuẫn nhau */
  conflicts: string[]
  /** HIGH | MEDIUM | LOW — theo confidence counting DR-C2 */
  level: 'HIGH' | 'MEDIUM' | 'LOW'
}

// ---------- ResearchMission.decisionLogJson — Decision Log NEMESIS ----------
export interface DecisionLogEntry {
  at: string // ISO timestamp
  agent: 'NEMESIS' | 'SIVIL' | 'BELI' | 'LISMA' | 'HAN' | string
  decision: 'CONTINUE' | 'PIVOT' | 'ESCALATE' | 'DECOMPOSE' | 'REJECT' | 'RESEARCH' | string
  reason: string
  /** Ref evidence/trigger (worklog id, council transcript id, ...) */
  ref?: string
}

// ---------- ResearchMission.changelogJson — amendment DR-C3 (append-only) ----------
export interface ChangelogEntry {
  at: string
  field: string
  from: string
  to: string
  reason: string
}

// ---------- ResearchTask.successCriteriaJson — gate TC-13 (TB-07) ----------
export interface SuccessCriterion {
  id: string
  criterion: string
  /** Cách đo/verify khi task hoàn thành */
  measure: string
  met?: boolean
}

// ---------- ResearchTask.amendmentsJson — append-only ----------
export interface TaskAmendment {
  at: string
  amendment: string
  reason: string
}

// ---------- ResearchWorklog.evidenceJson — TB-04 §5 claim bắt buộc evidence ----------
export interface EvidenceItem {
  claim: string
  file: string
  line: number | string
  excerpt: string
}

// ---------- ResearchWorklog.entryJson — schema 8 trường TB-09 §4.2 ----------
/**
 * 8 TRƯỜNG CHÍNH (bắt buộc M1 + M2 — TB-09 §4.2):
 * 1 Mission · 2 Status · 3 CurrentPhase + Progress · 4 TLReadBack
 * 5 Đã làm · 6 Vấn đề gặp phải · 7 Đề xuất cho group tiếp · 8 Files thay đổi.
 * Các khối mở rộng (Metrics/Findings/Hypothesis/Issues/...) — optional, mission-dependent.
 */
export interface WorklogEntry {
  // --- 8 trường bắt buộc ---
  mission: MissionTypeValue
  status: 'IN_PROGRESS' | 'COMPLETED' | 'BLOCKED' | 'ESCALATED'
  currentPhase: 'G1' | 'G2' | 'G3'
  overallProgress: number // 0–100 (%)
  tlReadBack: 'VERIFIED' | 'NEEDS-REVIEW' | 'PIVOT-NEEDED'
  done: string[] // Đã làm — kèm metric impact (M1) / finding ref (M2)
  issuesFaced: string[] // Vấn đề gặp phải — kể cả bottleneck có bằng chứng
  suggestionsNextGroup: string[] // Đề xuất cho group tiếp (handoff TB-09 §1.3)
  filesChanged: string[] // M2: chỉ file trong Workspace — không bao giờ Live
  // --- mở rộng optional (TB-09 §4.2) ---
  header?: string // "[Timestamp] — [Group] — [Task ID]" (TB-09 §1.4)
  taskId?: string // T-<MISSION>-<NNN>
  metrics?: WorklogMetric[] // M1 bắt buộc; M2 → §10 E3 qualitative
  findings?: WorklogFinding[] // M2 bắt buộc — mọi claim kèm citation
  hypothesisStatus?: WorklogHypothesisRow[]
  issuesFound?: WorklogIssue[]
  concernsForTl?: string[]
  artifactMap?: unknown // pointer — nội dung map do TB-10 định nghĩa (P6)
  nextSteps?: string[]
  kbEntries?: string[] // KB entries mới (NEMESIS/SIVIL/HAN) — id refs
  kbCandidates?: string[] // BELI/LISMA đề xuất (TB-08)
  modelNote?: string // dòng model switched DR-C7 (model-switch.ts sinh)
}

export interface WorklogMetric {
  metric: string
  before: string
  after: string
  delta: string
  status: 'IMPROVED' | 'STABLE' | 'REGRESSED' | 'MONITOR'
}

export interface WorklogFinding {
  no: number
  finding: string
  evidence: string // file:line / log excerpt
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
  proposal: string
}

export interface WorklogHypothesisRow {
  id: string // H1, H2...
  hypothesis: string
  status: 'CONFIRMED' | 'REJECTED' | 'PENDING' | 'TESTING'
  evidence: string
}

export interface WorklogIssue {
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
  description: string
  artifact?: string
}

// ---------- ResearchWorklog.modelSwitchedJson — DR-C7 ----------
export interface ModelSwitchEntry {
  at: string
  fromModel: string
  toModel: string
  trigger: string // 429 / 5xx / timeout / dual-signal (TB-01 §7 Q1)
  nextCheck: string // thời điểm check quay lại model chính
  /** Dòng worklog format chuẩn DR-C7 (TB-09 §4.3) */
  worklogLine: string
}

// ---------- ResearchProposal.schemaJson — schema TB-11 §1 (chi tiết tại P6) ----------
export interface ProposalSchema {
  code: string // P-YYYYMMDD-NNN
  title: string
  summary: string
  changes: string[]
  verificationPlan: string[]
  pocRef?: string
  diffSummary?: string
  [key: string]: unknown // P6 định nghĩa đầy đủ khi đọc sâu TB-11
}

// ---------- HypothesisRecord.scoreAJson — Rubric A (Phụ lục Z2.1) ----------
/** Rubric A 5 chiều 30/25/15/15/15 (Z2.1) — chi tiết chốt tại P2b khi code rubric-a.ts */
export interface ScoreAResult {
  D1: number // 30%
  D2: number // 25%
  D3: number // 15%
  D4: number // 15%
  D5: number // 15%
  score: number // tổng 0–100
  grade: string // A/B/C/D hoặc CONFIDENCE tier
}

// ---------- ExperimentRecord.scoreExpected/scoreMeasured — Rubric B (Z2.2) ----------
/** Rubric B 6 chiều — chi tiết chốt tại P2b khi code rubric-b.ts */
export interface ScorecardB {
  dimensions: Record<string, number>
  total: number
  [key: string]: unknown
}

// ---------- ExperimentRecord.deltaJson — calibration delta (TC-16) ----------
export interface ExperimentDelta {
  expectedTotal: number
  measuredTotal: number
  delta: number
  calibrationLessonRefs: string[]
}

// ============================================================
// §4. DECODED DOMAIN TYPES (Prisma raw + JSON đã decode)
// ============================================================

export interface DecodedResearchMission extends Omit<ResearchMission, 'confidenceJson' | 'decisionLogJson' | 'changelogJson'> {
  confidence: ConfidenceSignals
  decisionLog: DecisionLogEntry[]
  changelog: ChangelogEntry[]
}

export interface DecodedResearchTask extends Omit<ResearchTask, 'successCriteriaJson' | 'amendmentsJson'> {
  successCriteria: SuccessCriterion[]
  amendments: TaskAmendment[]
}

export interface DecodedResearchWorklog extends Omit<
  ResearchWorklog,
  'entryJson' | 'evidenceJson' | 'artifactMapJson' | 'modelSwitchedJson'
> {
  entry: WorklogEntry
  evidence: EvidenceItem[]
  artifactMap: unknown
  modelSwitched: ModelSwitchEntry[]
}

export interface DecodedResearchProposal extends Omit<ResearchProposal, 'schemaJson'> {
  schema: ProposalSchema
}

export interface DecodedHypothesisRecord extends Omit<HypothesisRecord, 'scoreAJson'> {
  scoreA: ScoreAResult
}

export interface DecodedExperimentRecord
  extends Omit<ExperimentRecord, 'scoreExpected' | 'scoreMeasured' | 'deltaJson' | 'metricsJson'> {
  scoreExpected: ScorecardB | Record<string, never>
  scoreMeasured: ScorecardB | null
  delta: ExperimentDelta | null
  metrics: Record<string, unknown> | null
}

// ============================================================
// §5. JSON ENCODE/DECODE HELPERS (TB-13 §3: "decode bằng helper types.ts")
// ============================================================

/** Encode an toàn — KHÔNG throw; lỗi → fallback JSON "null-safe" */
export function encodeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return 'null'
  }
}

/** Decode an toàn — parse lỗi / null → fallback (không throw) */
export function decodeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '' || raw === 'null') return fallback
  try {
    const parsed = JSON.parse(raw)
    return (parsed ?? fallback) as T
  } catch {
    return fallback
  }
}

/** Decode với fallback tự suy từ kiểu mảng */
export function decodeJsonArray<T>(raw: string | null | undefined): T[] {
  const out = decodeJson<T[]>(raw, [])
  return Array.isArray(out) ? out : []
}

/** Decode object JSON — parse lỗi → fallback {} */
export function decodeJsonObject<T extends object>(raw: string | null | undefined): T {
  const out = decodeJson<T>(raw, {} as T)
  return typeof out === 'object' && out !== null && !Array.isArray(out) ? out : ({} as T)
}

// ---------- Per-model decode helpers ----------

export function decodeMission(m: ResearchMission): DecodedResearchMission {
  return {
    ...m,
    confidence: decodeJsonObject<ConfidenceSignals>(m.confidenceJson),
    decisionLog: decodeJsonArray<DecisionLogEntry>(m.decisionLogJson),
    changelog: decodeJsonArray<ChangelogEntry>(m.changelogJson),
  }
}

export function decodeTask(t: ResearchTask): DecodedResearchTask {
  return {
    ...t,
    successCriteria: decodeJsonArray<SuccessCriterion>(t.successCriteriaJson),
    amendments: decodeJsonArray<TaskAmendment>(t.amendmentsJson),
  }
}

export function decodeWorklog(w: ResearchWorklog): DecodedResearchWorklog {
  return {
    ...w,
    entry: decodeJsonObject<WorklogEntry>(w.entryJson),
    evidence: decodeJsonArray<EvidenceItem>(w.evidenceJson),
    artifactMap: decodeJson<unknown>(w.artifactMapJson, null),
    modelSwitched: decodeJsonArray<ModelSwitchEntry>(w.modelSwitchedJson),
  }
}

export function decodeProposal(p: ResearchProposal): DecodedResearchProposal {
  return {
    ...p,
    schema: decodeJsonObject<ProposalSchema>(p.schemaJson),
  }
}

export function decodeHypothesis(h: HypothesisRecord): DecodedHypothesisRecord {
  return {
    ...h,
    scoreA: decodeJsonObject<ScoreAResult>(h.scoreAJson),
  }
}

export function decodeExperiment(e: ExperimentRecord): DecodedExperimentRecord {
  return {
    ...e,
    scoreExpected: decodeJsonObject<ScorecardB>(e.scoreExpected),
    scoreMeasured: e.scoreMeasured ? decodeJsonObject<ScorecardB>(e.scoreMeasured) : null,
    delta: e.deltaJson ? decodeJson<ExperimentDelta | null>(e.deltaJson, null) : null,
    metrics: e.metricsJson ? decodeJson<Record<string, unknown> | null>(e.metricsJson, null) : null,
  }
}
