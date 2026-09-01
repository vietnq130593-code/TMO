/**
 * RESEARCH TEAM — CONSTANTS (đơn nguồn truth runtime)
 * =====================================================
 * Spec: TB-01-foundation-roster-model-env.md (roster 5 agents, model stack 4 bậc,
 * môi trường M2) + TB-13-implementation-build-plan.md §4 (runtime NIM, timeout).
 *
 * Nguyên tắc (TB-01 §1): tên agent ≠ tên model — phân vai theo ROLE.
 * Model ID runtime lấy từ src/lib/llm.ts (SSOT hạ tầng có sẵn — TB-13 §4 tái dùng,
 * KHÔNG viết lại); file này nạp semantic research-team quanh chúng.
 */

// ============================================================
// §1. ROSTER — 5 AGENTS (TB-01 §1) — "same brain, different briefing"
// ============================================================

export const AGENT_ID = {
  KING: 'KING',
  SIVIL: 'SIVIL',
  BELI: 'BELI',
  LISMA: 'LISMA',
  HAN: 'HAN',
} as const

export type AgentId = (typeof AGENT_ID)[keyof typeof AGENT_ID]

export interface AgentRosterEntry {
  id: AgentId
  /** Vị trí trong pipeline: TL | G1 | G2 | G3 */
  position: 'TL' | 'G1' | 'G2' | 'G3'
  /** JD 1 câu (TB-01 §4 Runtime Identity Card) */
  jd: string
  /** Đường ESCALATE (TB-01 §4) */
  escalateTo: 'USER' | 'KING' | 'SIVIL'
  /** Ai được ghi trực tiếp KB (TB-08; BELI/LISMA chỉ đề xuất qua KB Candidates) */
  directKbWrite: boolean
}

export const RESEARCH_ROSTER: readonly AgentRosterEntry[] = [
  {
    id: 'KING',
    position: 'TL',
    jd: 'Phân loại mission, chia nhỏ bài toán, kiểm soát chặt — không code',
    escalateTo: 'USER',
    directKbWrite: true,
  },
  {
    id: 'SIVIL',
    position: 'G1',
    jd: 'Biến 1 task thành N hướng explore song song (5–300 sub-agents)',
    escalateTo: 'KING',
    directKbWrite: true,
  },
  {
    id: 'BELI',
    position: 'G1',
    jd: 'Code lượt đầu đúng spec (M1) / research report + POC trong Workspace (M2)',
    escalateTo: 'SIVIL',
    directKbWrite: false,
  },
  {
    id: 'LISMA',
    position: 'G2',
    jd: 'Review–tìm–fix lặp đến sạch bug (M1) / System Diagnostician root cause (M2)',
    escalateTo: 'KING',
    directKbWrite: false,
  },
  {
    id: 'HAN',
    position: 'G3',
    jd: 'Tối ưu + self-evolving qua KB (M1) / Architecture Proposer + tối ưu perf (M2) — kiêm KB Curator',
    escalateTo: 'KING',
    directKbWrite: true,
  },
] as const

// ============================================================
// §2. MODEL STACK — 1 bộ não, 5 định dạng (TB-01 §2)
// Model ID runtime: import từ '@/lib/llm' (AGENT_PRIMARY_MODEL,
// AGENT_FALLBACK_CHAIN) — llm.ts là SSOT hạ tầng. File này khai báo
// RANK + hành vi semantic của từng bậc.
// ============================================================

/** Bậc 0 = model chính; bậc 1–3 = fallback chain; quá bậc 3 → BLOCKED */
export const MODEL_STACK_RANKS = [
  'primary', // Kimi-k3 (moonshotai/kimi-k3)
  'fallback-1', // DeepSeek v4 Pro
  'fallback-2', // DeepSeek v4 Flash
  'fallback-3', // MiniMax-M3 (terminal)
] as const

export type ModelStackRank = (typeof MODEL_STACK_RANKS)[number]

/** Hành vi agent khi chuyển bậc (TB-01 §2): giữ nguyên vai trò + JD.
 * Mỗi TASK MỚI khởi động lại từ bậc 0. Chuyển bậc KHÔNG phải pivot. */
export const MODEL_SWITCH_BEHAVIOR = {
  keepRole: true,
  keepJd: true,
  resetPerTask: true,
  worklogLine: 'model switched', // dòng DR-C7 — format đầy đủ ở model-switch.ts
} as const

/** Hysteresis về model chính (TB-01 §7 Q1 dual-signal): 3 probe liên tiếp OK */
export const MODEL_RETURN_PROBES_OK = 3

// ============================================================
// §3. MISSION / TIER / TIMEOUT (TB-13 §4 + DR-C5)
// ============================================================

/** Loại mission (TB-13 §3 ResearchMission.missionType) */
export const MISSION_TYPES = ['M1', 'M2', 'M3'] as const
export type MissionType = (typeof MISSION_TYPES)[number]

/** Tier workflow (TB-02) */
export const MISSION_TIERS = ['T1', 'T2', 'T3'] as const
export type MissionTier = (typeof MISSION_TIERS)[number]

/** Timeout step (ms) — AGENT_STEP_TIMEOUT_MS đã có trong .env (480000 = 8 phút
 * mặc định app; TB-13 §4 ghi EDA 30m · Grand 60m · Audit 30m — dùng env trước) */
export const STEP_TIMEOUTS_MS = {
  eda: 30 * 60 * 1000, // 30 phút
  grandResearch: 60 * 60 * 1000, // 60 phút
  audit: 30 * 60 * 1000, // 30 phút
  council: 30 * 60 * 1000, // council blocking treo → timeout 30m + deputy
} as const

/** C5 — Proposal pending: timeout 48h (T3) / 24h (T2) + nhắc 12h (cron :3004) */
export const PROPOSAL_TIMEOUT_HOURS: Record<MissionTier, number> = {
  T1: 24, // T1 không sinh Proposal thường xuyên — mặc định an toàn
  T2: 24,
  T3: 48,
}
export const PROPOSAL_REMIND_HOURS = 12

/** Deputy khi timeout/thiếu người (TB-06, C5): SIVIL hoặc HAN */
export const DEPUTY_AGENTS: readonly AgentId[] = ['SIVIL', 'HAN'] as const

// ============================================================
// §4. SUB-AGENT & VÒNG LẶP (TB-03 / TB-04 — dùng từ P2/P3)
// ============================================================

/** SIVIL dispatch: ≤20 sub-agents / 1 part, tối đa 25 / vòng G1 */
export const SUB_AGENT_LIMITS = {
  perPart: 20,
  perG1Round: 25,
} as const

/** LISMA vòng fix: tối đa 3 — quá → ESCALATE KING (TB-01 §1 JD) */
export const G2_MAX_FIX_ROUNDS = 3

/** KB curate kép: 3 mốc phase 1→2→3 (DR-C6) */
export const KB_CURATE_PHASES = [1, 2, 3] as const

// ============================================================
// §5. FORMAT MÃ ĐỊNH DANH (TB-00 §1.4 + TB-13 §3)
// ============================================================

/** Mission: MS-YYYYMMDD-NNN · Proposal: P-YYYYMMDD-NNN · Task: T-<MISSION>-<NNN> */
export const IDENTITY_CODE = {
  missionPrefix: 'MS',
  proposalPrefix: 'P',
  taskPrefix: 'T',
} as const

// ============================================================
// §6. MODULE REGISTRY — bản đồ module theo build phase (TB-13 §2.3)
// Health route dùng registry này để "báo đủ module" (DoD #1).
// ============================================================

export interface ModuleRegistryEntry {
  /** Đường dẫn module (khớp cây thư mục TB-13 §2.3) */
  path: string
  /** Phase sở hữu (P0 → P7 + P2b) */
  phase: 'P0' | 'P1' | 'P2' | 'P2b' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7'
  /** Spec nguồn */
  spec: string
}

export const RESEARCH_MODULE_REGISTRY: readonly ModuleRegistryEntry[] = [
  // P0 — Scaffold (file này)
  { path: 'src/lib/research-team/constants.ts', phase: 'P0', spec: 'TB-01' },
  { path: 'src/lib/research-team/types.ts', phase: 'P0', spec: 'TB-13 §3' },
  { path: 'src/lib/research-team/model-switch.ts', phase: 'P0', spec: 'TB-01 §2 + DR-C7' },
  { path: 'src/app/api/research/health/route.ts', phase: 'P0', spec: 'TB-13 §5 P0 gate' },
  // P1 — Router
  { path: 'src/lib/research-team/classify.ts', phase: 'P1', spec: 'TB-02' },
  { path: 'src/lib/research-team/mission-store.ts', phase: 'P1', spec: 'TB-02' },
  { path: 'src/lib/research-team/tier.ts', phase: 'P1', spec: 'TB-02 + DR-C3' },
  // P2 — G1
  { path: 'src/lib/research-team/g1/', phase: 'P2', spec: 'TB-03 + TB-10' },
  // P2b — Scoring (TB-14)
  { path: 'src/lib/research-team/scoring/', phase: 'P2b', spec: 'TB-14' },
  // P3 — G2
  { path: 'src/lib/research-team/g2/', phase: 'P3', spec: 'TB-04' },
  // P4 — G3 + KB
  { path: 'src/lib/research-team/g3/', phase: 'P4', spec: 'TB-05 + TB-08' },
  // P5 — KING
  { path: 'src/lib/research-team/king/', phase: 'P5', spec: 'TB-06 + TB-07' },
  // P6 — Handoff + Proposal
  { path: 'src/lib/research-team/handoff.ts', phase: 'P6', spec: 'TB-09' },
  { path: 'src/lib/research-team/worklog-schema.ts', phase: 'P6', spec: 'TB-09 §4' },
  { path: 'src/lib/research-team/proposal/', phase: 'P6', spec: 'TB-11' },
  // P7 — E2E
  { path: 'src/lib/research-team/__tests__/', phase: 'P7', spec: 'TB-12 (18 TC)' },
] as const
