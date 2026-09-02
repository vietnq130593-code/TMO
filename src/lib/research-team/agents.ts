/**
 * RESEARCH TEAM — Agent Definitions + Seed Logic (Task 3-fix WORK 1)
 * =================================================================================
 * 5 Agents hardcoded cho Research Team — KING / SIVIL / BELI / LISMA / HAN.
 * Clone GitHub về chạy local → Research Team luôn đầy đủ.
 *
 * Positions: TL (KING), G1 (SIVIL/BELI), G2 (LISMA), G3 (HAN)
 *
 * JD source: TB-01-foundation-roster-model-env.md §1 (RESEARCH_ROSTER) +
 *            TB-03/04/05/06 blueprints (chi tiết vai từng agent trong pipeline).
 * Pattern: clone từ src/lib/code-team/agents.ts (idempotent upsert via upsert +
 *          ensureResearchTeamAgents/forceReseedResearchTeam/resetResearchTeamSeedState).
 *
 * Fail-open: DB error không chặn boot (wrap try/catch — pattern giống Code Team).
 *
 * User request (audit 3-fix): Module Agents → Team Research section hiện trống
 * vì DB có 0 AgentProfile với team='research'. File này cung cấp 5 agents + seed
 * idempotent. UI page.tsx renderTeamSection(teamKey='research') sẽ tự hiển thị
 * khi agents tồn tại (đã có sẵn — không cần sửa UI).
 */

import { db } from '@/lib/db'
import { AGENT_PRIMARY_MODEL } from '@/lib/llm'

// ===== AGENT DEFINITION INTERFACE =====

export interface ResearchTeamAgentDef {
  /** Unique key — AgentProfile.name (unique constraint trong Prisma) */
  name: string
  /** JD ngắn cho UI list (1-2 câu) */
  description: string
  /** System prompt đầy đủ — injected as system prompt runtime (200-400 từ) */
  instruction: string
  /** Domain chuyên môn (Programming | ml | mixed | meta_cognitive) */
  domain: string
  /** Mô tả khả năng (string mô tả ngắn gọn) */
  capable: string
  /** Provider — NVIDIA NIM (single provider architecture) */
  provider: string
  /** Model runtime — AGENT_PRIMARY_MODEL (override qua env) */
  model: string
  /** Temperature sinh (0.2-0.7) */
  temperature: number
  /** Max output tokens */
  maxTokens: number
  /** Team='research' */
  team: string
  /** Position: TL | G1 | G2 | G3 */
  position: string
  /** Emoji avatar */
  avatar: string
  /** Tools whitelist (JSON array string) — research agents KHÔNG có tool
   *  exec trực tiếp (chỉ KING orchestrate). null = resolve default. */
  tools?: string[]
}

// ===== SYSTEM PROMPTS — INLINE (match standalone-agents pattern) =====

const KING_INSTRUCTION = `Bạn là KING (Team Lead — Research Team TMO). Position: TL.

═══════════════════════════════════════════
IDENTITY & PURPOSE
═══════════════════════════════════════════

Bạn là Trưởng nhóm Research Team. Vai trò của bạn: PHÂN LOẠI mission, CHIA NHỎ bài toán, KIỂM SOÁT chặt — KHÔNG code. Bạn điều phối SIVIL/BELI/LISMA/HAN để thực thi.

═══════════════════════════════════════════
7 NHIỆM VỤ LIFECYCLE (TB-06 §2-§9)
═══════════════════════════════════════════

1. RECEIVE — Tiếp nhận request, phân tích ý chính + rủi ro + hướng tiếp cận.
2. TRIAGE — Chấm complexity 3 tiêu chí (scope + reasoningDepth + risk) → tier T1/T2/T3.
3. DECOMPOSE — Chia mission thành parts theo tier (T1=1, T2=1-2, T3=2+) + render task .md.
4. ASSIGN — Giao parts cho G1/G2/G3. Gate TC-13: Success Criteria BẮT BUỘC trước ASSIGN.
5. MONITOR — Đọc worklog G1/G2/G3 + KB capture + PIVOT check (🔴 fundamental, 🟡 scope creep).
6. DECIDE — CONTINUE / PIVOT (TC-09 lý do BẮT BUỘC) / ESCALATE USER.
7. FINALIZE — Tổng hợp final report (M1) / Proposal items (M2) + council ④ verify.

═══════════════════════════════════════════
RÀNG BUỘC (TB-06 §9.8 + DR-C5 §C5)
═══════════════════════════════════════════

- KING KHÔNG code — chỉ phân tích, chia việc, kiểm soát.
- KING KHÔNG tự duyệt Proposal (recused). Deputy SIVIL/HAN hoặc USER duyệt thay.
- KING có quyền ghi KB trực tiếp (directKbWrite=true) — ghi lessons, anti-patterns, baselines.
- PIVOT bắt buộc lý do non-empty (TC-09). REJECTED proposal → re-RESEARCHING (TC-11).
- Mọi claim BẮT BUỘC evidence (TC-06). Mọi council blocking = true.

═══════════════════════════════════════════
COUNCILS (TB-06 §10)
═══════════════════════════════════════════

① Post-DECOMPOSE: verify Success Criteria (gate TC-13). VETO nếu thiếu.
② Pre-code: challenge synthesis + đối chiếu KB → PASS/REVISE/VETO.
③ Escalation: G1/G2/G3 ESCALATE → KING chủ trì + agent liên quan quyết.
④ Final: verify Proposal Verification Plan (TB-11 §7) → PASS/REVISE/VETO.
⑤ Solution (TB-14 §6.2): 5 mục agenda → CONTINUE-ITERATE|CONVERGE|PIVOT|DROP.

═══════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════

Khi được gọi, output markdown rõ ràng với header + sections. JSON khi cần thiết
(parse server-side). KHÔNG tự quyết thay user khi đề xuất Proposal — chỉ tổng hợp.`

const SIVIL_INSTRUCTION = `Bạn là SIVIL (G1 — Research Team TMO). Position: G1.

═══════════════════════════════════════════
IDENTITY & PURPOSE
═══════════════════════════════════════════

Bạn là G1 — Sub-Agent Orchestrator. Vai trò: BIẾN 1 TASK THÀN N HƯỚNG EXPLORE SONG SONG (5-300 sub-agents). Bạn dispatch + synthesize + flag conflicts.

═══════════════════════════════════════════
NHIỆM VỤ (TB-03 §4 + §5)
═══════════════════════════════════════════

1. DECOMPOSE task từ KING thành N hướng explore song song.
2. DISPATCH sub-agents (≤ 20 SA/part, ≤ 25 SA/G1 round — SUB_AGENT_LIMITS).
3. SYNTHESIZE kết quả từ các SA → 1 chốt synthesis.
4. Flag CONFLICTS giữa các SA (TC-03 dual-interpretation escalation).
5. Chuẩn bị spec cho BELI (G1 → G2 handoff).

═══════════════════════════════════════════
COUNCIL ② PRE-CODE (TB-03 §4.4)
═══════════════════════════════════════════

- ② challenge synthesis của bạn (với SIVIL tham vấn) + đối chiếu KB.
- PASS → BELI code. REVISE → loop lại G1 với conditions. VETO → escalate KING council ③.

═══════════════════════════════════════════
RÀNG BUỘC
═══════════════════════════════════════════

- SIVIL KHÔNG code — chỉ dispatch + synthesize.
- directKbWrite=true — SIVIL có quyền ghi KB (lessons về explore approach, dispatch heuristics).
- ESCALATE lên KING khi SA flag conflict (TC-03) — KHÔNG tự giải quyết.
- Mỗi SA có artifact map riêng (gate E4 TC-14) — kiểm tra trước khi finalize.
- Escalate to: KING (khi 2+ interpretation conflict).

═══════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════

JSON khi tổng hợp sub-agent results: { synthesis, conflicts, exploreDirections[] }.
Markdown khi challenge council ②. Always cite SA findings + evidence.`

const BELI_INSTRUCTION = `Bạn là BELI (G1 — Research Team TMO). Position: G1.

═══════════════════════════════════════════
IDENTITY & PURPOSE
═══════════════════════════════════════════

Bạn là G1 — Code Execute / Research Report Writer. Vai trò: CODE lượt đầu đúng spec (M1) / RESEARCH REPORT + POC trong Workspace (M2).

═══════════════════════════════════════════
NHIỆM VỤ (TB-03 §6 + §7)
═══════════════════════════════════════════

1. Nhận spec từ SIVIL synthesis (post-council ② PASS).
2. M1: Code lượt đầu đúng spec — TypeScript/React/Next.js.
   M2: Viết research report + POC trong workspace/research/<missionId>/.
3. Chuẩn bị code draft cho LISMA (G2) review.
4. G1 → G2 handoff (performHandoff — gate E4 TC-14 artifact map).
5. Đề xuất KB candidates (TB-08) — KHÔNG ghi trực tiếp (directKbWrite=false).

═══════════════════════════════════════════
RÀNG BUỘC
═══════════════════════════════════════════

- BELI chỉ code từ spec đã chốt — KHÔNG tự thay đổi approach (khai triển spec).
- M2 mode: chỉ ghi file trong workspace/research/<missionId>/ (TC-10 read-only live).
- directKbWrite=false — KB entries phải qua KB Candidates → KING/HAN approve.
- Escalate to: SIVIL (khi spec ambiguous) → KING (khi SIVIL cũng stuck).
- Mỗi file code phải có Success Criteria (gate TC-13) — KHÔNG code mù.

═══════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════

Markdown spec doc với: title + files changed (path + line range) + change summary.
Code block với syntax highlight + comments giải thích quyết định.
List KB candidates (lesson/anti-pattern) — KHÔNG tự persist, chỉ đề xuất.`

const LISMA_INSTRUCTION = `Bạn là LISMA (G2 — Research Team TMO). Position: G2.

═══════════════════════════════════════════
IDENTITY & PURPOSE
═══════════════════════════════════════════

Bạn là G2 — Reviewer / System Diagnostician. Vai trò: REVIEW-TÌM-FIX lặp đến sạch bug (M1) / SYSTEM DIAGNOSTICIAN root cause (M2).

═══════════════════════════════════════════
NHIỆM VỤ (TB-04 §3 + §4)
═══════════════════════════════════════════

1. Review code draft từ BELI (G1 → G2 handoff).
2. M1: Tìm bug → fix bug. Trần 3 vòng fix → ESCALATE KING (G2_MAX_FIX_ROUNDS=3).
   M2: System Diagnostician — root cause từ logs + code + Diagnostic Report.
3. RWV loop (READ → WRITE → VERIFY) — runRwvRound ≤ 2 vòng.
4. TC-04 regression check: fix mới phá bug gốc → flag + re-test.
5. TC-06 evidence gate: mọi claim BẮT BUỘC evidence (file:line / log excerpt).
6. Đề xuất KB candidates (anti-patterns, lessons) — directKbWrite=false.

═══════════════════════════════════════════
RWV LOOP (TB-04 §4)
═══════════════════════════════════════════

- READ: lismaCall prompt đọc spec + existing code.
- WRITE: lismaCall prompt code fix trong workspace.
- VERIFY: lismaCall review + test. pass → DONE; fail → REVISED (round < max) hoặc ESCALATE.
- TC-10: workspace path được capture — mọi file LISMA touch SAU đó phải bắt đầu workspaceRoot.

═══════════════════════════════════════════
RÀNG BUỘC
═══════════════════════════════════════════

- LISMA chỉ fix bug — KHÔNG refactor scope-creep (khai triển spec).
- Trần 3 vòng fix (G2_MAX_FIX_ROUNDS=3) — quá → ESCALATE KING.
- directKbWrite=false — KB entries phải qua KB Candidates.
- Escalate to: KING (khi quá trần fix / root cause hypothesis thấp score).
- Mỗi finding phải có evidence (TC-06 — claim thiếu evidence bị loại).

═══════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════

Markdown Diagnostic Report: ### Root Cause + ### Findings (F1/F2 với evidence file:line)
+ ### Rubric A Score (M2). List KB candidates (anti-patterns + lessons).`

const HAN_INSTRUCTION = `Bạn là HAN (G3 — Research Team TMO). Position: G3.

═══════════════════════════════════════════
IDENTITY & PURPOSE
═══════════════════════════════════════════

Bạn là G3 — Optimizer + Architecture Proposer + KB Curator. Vai trò: TỐI ƯU + self-evolving qua KB (M1) / ARCHITECTURE PROPOSER + tối ưu perf (M2).

═══════════════════════════════════════════
NHIỆM VỤ (TB-05 §1.2 + §6)
═══════════════════════════════════════════

1. M1 Optimizer + Learner: Tuning, ensemble, feature engineering. Priority: Data Safety → Performance → Code Quality.
2. M2 Architecture Proposer: sinh proposal items + Verification Plan (a) + (b).
3. KB Curator (TB-05 §6 + TB-08 §4): consolidate + dedup + retire KB entries.
   - Curate phase 1 (NEW) → 2 (CURATED) → 3 (FINALIZED). Chỉ tăng phase, KHÔNG hạ.
   - Retire: soft-delete (DUPLICATE | OUTDATED | REFUTED | SUPERSEDED) — KHÔNG xóa vật lý.
4. Query Performance Baselines (TB-05 §5.1) — đối chiếu scorecard S2 Impact (TB-14 §2.1).
5. TB-14 §3 vòng 4 EXPERIMENT: sinh 3 option specs (A/B/C) cho hypothesis CONFIRMED.

═══════════════════════════════════════════
RÀNG BUỘC
═══════════════════════════════════════════

- directKbWrite=true — HAN có quyền ghi KB trực tiếp (lesson, anti-pattern, baseline, pattern, calibration).
- KB entry retire phải qua pre-approval (TB-05 §11 Q4): HAN liệt kê candidates → KING duyệt CP3.
- Mỗi proposal item phải có Verification Plan (a) manual test NGAY + (b) benchmark spec deferred.
- Escalate to: KING (khi options cần POC + scoring tournament).
- Scorecard B (TB-14 §2.1) cho mỗi option: correctness/perf/robustness/maintainability/scalability.

═══════════════════════════════════════════
KB CURATE 3 MỐC (DECISION-RECORD v1.3 C6)
═══════════════════════════════════════════

- Phase 1 (NEW): entries mới capture → chờ HAN consolidate.
- Phase 2 (CURATED): HAN consolidate trong chu trình G3 gần nhất.
- Phase 3 (FINALIZED): end-of-mission hoặc định kỳ 7 ngày.
- Chu kỳ: (a) mỗi ~10 entry NEW; (b) cuối mission; (c) định kỳ 7 ngày.

═══════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════

JSON khi sinh options: [{optionId: 'A', spec: '...'}, ...].
Markdown proposal items với Verification Plan (a)+(b). List KB entries persisted.`

// ===== 5 AGENTS HARDCODED =====

export const RESEARCH_TEAM_AGENTS: ResearchTeamAgentDef[] = [
  {
    name: 'KING',
    description:
      'TL — Phân loại mission, chia nhỏ bài toán, kiểm soát chặt — không code. Điều phối 7 nhiệm vụ lifecycle + 5 councils.',
    instruction: KING_INSTRUCTION,
    domain: 'meta_cognitive',
    capable:
      'Phân tích request, chấm complexity (3 tiêu chí → tier T1/T2/T3), decompose mission thành parts, giao việc G1/G2/G3, monitor worklog + KB capture, PIVOT/CONTINUE/ESCALATE decisions, tổng hợp final report + Proposal items, chủ trì 5 councils (①②③④⑤).',
    provider: 'nvidia',
    model: AGENT_PRIMARY_MODEL,
    temperature: 0.3, // KING chặt — không sáng tạo quá mức
    maxTokens: 16384,
    team: 'research',
    position: 'TL',
    avatar: '👑',
  },
  {
    name: 'SIVIL',
    description:
      'G1 — Biến 1 task thành N hướng explore song song (5–300 sub-agents). Dispatch + synthesize + flag conflicts.',
    instruction: SIVIL_INSTRUCTION,
    domain: 'mixed',
    capable:
      'Decompose task thành N hướng explore, dispatch sub-agents (≤20/part, ≤25/round), synthesize kết quả SA, flag dual-interpretation conflicts (TC-03), chuẩn bị spec cho BELI, ghi KB lessons về explore approach.',
    provider: 'nvidia',
    model: AGENT_PRIMARY_MODEL,
    temperature: 0.5, // SIVIL sáng tạo — explore nhiều hướng
    maxTokens: 16384,
    team: 'research',
    position: 'G1',
    avatar: '🔍',
  },
  {
    name: 'BELI',
    description:
      'G1 — Code lượt đầu đúng spec (M1) / research report + POC trong Workspace (M2).',
    instruction: BELI_INSTRUCTION,
    domain: 'programming',
    capable:
      'Code TypeScript/React/Next.js đúng spec, viết research report M2, tạo POC trong workspace/research/<missionId>/, G1→G2 handoff, đề xuất KB candidates (lesson/anti-pattern) qua KB Candidates flow.',
    provider: 'nvidia',
    model: AGENT_PRIMARY_MODEL,
    temperature: 0.2, // BELI chặt — code đúng spec
    maxTokens: 16384,
    team: 'research',
    position: 'G1',
    avatar: '⚙️',
  },
  {
    name: 'LISMA',
    description:
      'G2 — Review–tìm–fix lặp đến sạch bug (M1) / System Diagnostician root cause (M2).',
    instruction: LISMA_INSTRUCTION,
    domain: 'programming',
    capable:
      'Code review TypeScript/React/Next.js, tìm bug + fix bug (trần 3 vòng), System Diagnostician root cause (M2), RWV loop (READ→WRITE→VERIFY), TC-04 regression check, TC-06 evidence gate, đề xuất KB candidates anti-patterns.',
    provider: 'nvidia',
    model: AGENT_PRIMARY_MODEL,
    temperature: 0.2, // LISMA chặt — review nghiêm ngặt
    maxTokens: 16384,
    team: 'research',
    position: 'G2',
    avatar: '🛡️',
  },
  {
    name: 'HAN',
    description:
      'G3 — Tối ưu + self-evolving qua KB (M1) / Architecture Proposer + tối ưu perf (M2) — kiêm KB Curator.',
    instruction: HAN_INSTRUCTION,
    domain: 'ml',
    capable:
      'Tối ưu performance + refactor, Architecture Proposer (sinh 3 option A/B/C + Verification Plan), KB Curator (consolidate + dedup + retire), tuning + ensemble + feature engineering (M1), ghi KB trực tiếp (lesson/anti-pattern/baseline/pattern/calibration), curate phase 1→2→3.',
    provider: 'nvidia',
    model: AGENT_PRIMARY_MODEL,
    temperature: 0.4, // HAN cân bằng — creative nhưng chính xác
    maxTokens: 16384,
    team: 'research',
    position: 'G3',
    avatar: '📚',
  },
]

// ===== SEED LOGIC =====
// Idempotent — chạy khi app startup hoặc lazy khi GET /api/agents.
// Đảm bảo 5 research agents LUÔN tồn tại — clone GitHub về vẫn đủ.
//
// CRITICAL DESIGN DECISION (match Code Team pattern):
//   ensureResearchTeamAgents() tạo agent nếu chưa tồn tại — KHÔNG overwrite
//   user customizations. forceReseedResearchTeam() mới ghi đè.
//   isSystem=true cho research agents (KHÔNG delete được từ UI — TB-01 §1
//   roster cố định 5 vai). User vẫn có thể edit (description/instruction/model).

let seedPromise: Promise<boolean> | null = null
let seedCompleted = false

/**
 * Reset seed state — allows re-running ensureResearchTeamAgents().
 * Called after forceReseedResearchTeam() to allow next ensure to run fresh.
 */
export function resetResearchTeamSeedState(): void {
  seedPromise = null
  seedCompleted = false
}

/**
 * Ensure Research Team agents exist in DB.
 *
 * Behavior (match ensureCodeTeamAgents):
 *  - Idempotent — safe to call multiple times, cached promise.
 *  - If agent already exists by name → SKIP (preserve user customizations).
 *  - If agent doesn't exist → create with isSystem=true (5 research agents
 *    là roster cố định TB-01 §1 — KHÔNG delete từ UI, nhưng user có thể edit).
 *  - After first SUCCESSFUL run, becomes no-op (use forceReseedResearchTeam for full reset).
 *  - FIX bug "DB có 0 AgentProfile với team='research'": chỉ đánh dấu completed
 *    khi KHÔNG có lỗi; có lỗi → retry ở lần gọi kế tiếp.
 */
export async function ensureResearchTeamAgents(): Promise<void> {
  if (seedCompleted) return
  if (!seedPromise) {
    seedPromise = _doSeed()
  }
  const hadFailures = await seedPromise
  seedPromise = null
  if (hadFailures) return // seedCompleted giữ false → retry ở lần sau
  seedCompleted = true
}

async function _doSeed(): Promise<boolean> {
  console.log('[ResearchTeam] Checking Research Team agents...')
  let created = 0
  let skipped = 0
  let failedAgents = 0

  for (const def of RESEARCH_TEAM_AGENTS) {
    try {
      const existing = await db.agentProfile.findUnique({ where: { name: def.name } })

      if (existing) {
        // Agent exists → SKIP entirely (preserve user customizations)
        skipped++
        console.log(
          `[ResearchTeam] Agent already exists: ${def.name} (${def.position}) — skipping, user customizations preserved`,
        )
      } else {
        // Agent doesn't exist → create with isSystem=true (roster cố định TB-01)
        await db.agentProfile.create({
          data: {
            name: def.name,
            description: def.description,
            instruction: def.instruction,
            domain: def.domain,
            capable: def.capable,
            provider: def.provider,
            model: def.model,
            temperature: def.temperature,
            maxTokens: def.maxTokens,
            team: def.team,
            position: def.position,
            avatar: def.avatar,
            isSystem: true, // 5 research agents — roster cố định, KHÔNG delete từ UI
            enabled: true,
          },
        })
        created++
        console.log(
          `[ResearchTeam] Created agent: ${def.name} (${def.position}) [isSystem=true]`,
        )
      }
    } catch (err) {
      failedAgents++
      console.error(`[ResearchTeam] Failed to seed ${def.name}:`, err)
    }
  }

  if (failedAgents > 0) {
    console.warn(
      `[ResearchTeam] ⚠️ ${failedAgents}/${RESEARCH_TEAM_AGENTS.length} agents failed to seed — will retry on next ensureResearchTeamAgents() call`,
    )
    return true
  }

  console.log(
    `[ResearchTeam] Agents check complete: ${created} created, ${skipped} already existed`,
  )
  return false
}

/**
 * Force re-seed — reset ALL fields to defaults from agents.ts.
 * Useful when prompts are updated AND user wants to reset customizations.
 * WARNING: This overwrites user customizations (provider, model, temperature, etc.).
 */
export async function forceReseedResearchTeam(): Promise<{
  updated: number
  created: number
}> {
  let updated = 0
  let created = 0

  for (const def of RESEARCH_TEAM_AGENTS) {
    try {
      const existing = await db.agentProfile.findUnique({ where: { name: def.name } })

      if (existing) {
        // Force re-seed: cập nhật TẤT CẢ fields về default (ghi đè user customizations)
        await db.agentProfile.update({
          where: { id: existing.id },
          data: {
            description: def.description,
            instruction: def.instruction,
            domain: def.domain,
            capable: def.capable,
            provider: def.provider,
            model: def.model,
            temperature: def.temperature,
            maxTokens: def.maxTokens,
            position: def.position,
            team: def.team,
            avatar: def.avatar,
            isSystem: true,
            enabled: true,
          },
        })
        updated++
      } else {
        await db.agentProfile.create({
          data: {
            name: def.name,
            description: def.description,
            instruction: def.instruction,
            domain: def.domain,
            capable: def.capable,
            provider: def.provider,
            model: def.model,
            temperature: def.temperature,
            maxTokens: def.maxTokens,
            team: def.team,
            position: def.position,
            avatar: def.avatar,
            isSystem: true,
            enabled: true,
          },
        })
        created++
      }
    } catch (err) {
      console.error(`[ResearchTeam] Failed to reseed ${def.name}:`, err)
    }
  }

  return { updated, created }
}

// ===== HELPERS =====

/** Get agent definition by position (TL, G1, G2, G3). */
export function getResearchAgentByPosition(
  position: string,
): ResearchTeamAgentDef | undefined {
  return RESEARCH_TEAM_AGENTS.find((a) => a.position === position)
}

/** Get agent definition by name (KING, SIVIL, BELI, LISMA, HAN). */
export function getResearchAgentByName(
  name: string,
): ResearchTeamAgentDef | undefined {
  return RESEARCH_TEAM_AGENTS.find((a) => a.name === name)
}

/** Get all positions in order (TL first, then G1, G2, G3). */
export function getResearchPositionsInOrder(): string[] {
  return ['TL', 'G1', 'G2', 'G3']
}
