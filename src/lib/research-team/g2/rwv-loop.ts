/**
 * RESEARCH TEAM — G2 RWV LOOP (TB-09 §1-§3 RWV + DR-C5 trần 2 vòng + TC-10/TC-12)
 * =================================================================================
 * Spec:
 *  - TB-09 §1-§3 — Read-Write-Verify (RWV) loop: LISMA + BELI cùng viết code
 *    trong workspace, LISMA review → fix → re-test. Trần 2 vòng REVISED (DR-C5).
 *  - DR-C5 — Proposal pending + trần REVISED: 2 vòng fix trong RWV; quá 2 →
 *    ESCALATE KING (P5 — Proposal với human-in-loop).
 *  - TB-09 §10 E1/E2/E3 — Diagnostic Report (DR): LISMA root cause + evidence.
 *  - TB-12 §3.2 TC-10 — Workspace read-only Live: LISMA KHÔNG ghi ngoài
 *    workspace path = `workspace/research/${missionId}/`. Mọi file LISMA touch
 *    phải bắt đầu bằng workspaceRoot — violation → block + flag.
 *  - TB-12 §3.2 TC-12 — Model switch no reset: chuyển model giữa vòng KHÔNG
 *    reset task. State nằm trong DB (ResearchWorklog), KHÔNG trong memory.
 *
 * Bất biến:
 *  - KHÔNG auto-apply (DR-C1) — mọi fix nằm workspace, Live không bao giờ ghi.
 *  - Workspace path chuẩn: `workspace/research/${missionId}/` (TB-01 §3).
 *  - Trần 2 vòng REVISED (DR-C5) — quá 2 vòng → ESCALATE.
 *  - TC-04: nếu fix gây regression → thêm RegressionEntry + re-test bug gốc.
 *  - TC-12: model switch push vào state.modelSwitched (persist worklog).
 *
 * Fail-open: LLM error trong runRwvRound → status ESCALATE + note 'LLM unavailable'
 * (KHÔNG crash pipeline). Persist ResearchWorklog row mỗi round.
 */

import { promises as fs } from 'fs'
import { join, resolve, relative, isAbsolute } from 'path'
import { db } from '@/lib/db'
import {
  encodeJson,
  type WorklogEntry,
  type EvidenceItem,
  type ModelSwitchEntry,
} from '../types'
import { recordModelSwitch } from '../model-switch'
import { AGENT_ID, G2_MAX_FIX_ROUNDS } from '../constants'

// ============================================================
// §1. TYPES — RwvState + RegressionEntry
// ============================================================

/** Trần 2 vòng REVISED (DR-C5) — quá 2 → ESCALATE KING (P5). */
export const RWV_MAX_ROUNDS = 2

export type RwvStatus =
  | 'READ' // đang đọc spec + existing code
  | 'WRITE' // đang code fix trong workspace
  | 'VERIFY' // đang review + test
  | 'REVISED' // verify fail, round < maxRounds → loop lại
  | 'DONE' // verify pass → task done
  | 'ESCALATE' // round ≥ maxRounds + REVISED → KING P5

export interface RegressionEntry {
  /** Vòng nào phát hiện regression (TC-04: fix gây regression) */
  round: number
  /** Bug gốc bị regression tác động */
  bug: string
  /** Đã re-test bug gốc chưa? */
  reTested: boolean
  /** Bug gốc còn pass sau fix mới không? (re-test result) */
  fixed: boolean
}

export interface RwvState {
  round: number
  status: RwvStatus
  /** Trần 2 vòng REVISED (DR-C5) */
  maxRounds: number
  /** Worklog row đã persist vòng gần nhất (TC-12: state nằm DB, không memory) */
  worklogId?: string
  /** Git branch workspace — format `P-POC-${taskId}` (TB-01 §3: 1 Proposal = 1 branch) */
  branchName?: string
  /** Workspace root path — TC-10: mọi file LISMA touch phải nằm trong đây */
  workspaceRoot: string
  /** Spec text cho vòng này (BELI spec hoặc bug description) */
  spec: string
  /** Files LISMA đã touch trong workspace (TC-10 verify) */
  filesChanged: string[]
  /** Model switch entries giữa vòng (TC-12: push vào đây, KHÔNG reset task) */
  modelSwitched: ModelSwitchEntry[]
  /** Regression entries (TC-04: fix gây regression → thêm entry + re-test bug gốc) */
  regressionEntries: RegressionEntry[]
  /** Note nếu LLM unavailable (fail-open — KHÔNG crash) */
  note?: string
  /** Reason nếu ESCALATE */
  escalateReason?: string
  /** Mission ID (TC-12: persist qua DB, không memory) */
  missionId: string
  /** Task ID */
  taskId: string
}

// ============================================================
// §2. START RWV LOOP — init state + workspace
// ============================================================

/**
 * Start RWV loop cho 1 task:
 *  - Init state round=1, status=READ, maxRounds=2 (DR-C5).
 *  - branchName = `P-POC-${taskId}` (TB-01 §3: 1 Proposal = 1 branch).
 *  - workspaceRoot = `workspace/research/${missionId}/` (TC-10: KHÔNG ghi ngoài).
 *  - Tạo workspace dir recursive nếu thiếu (fs.mkdir — recursive=true).
 *
 * TC-10 invariant: workspace path được capture vào state — mọi file LISMA touch
 * SAU đó phải bắt đầu workspaceRoot (checkWorkspaceReadOnly).
 *
 * Fail-open: fs.mkdir error → KHÔNG throw, chỉ note (state vẫn trả, caller có
 * thể retry hoặc escalate).
 */
export async function startRwvLoop(
  missionId: string,
  taskId: string,
  workspaceRoot?: string,
  spec = '',
): Promise<RwvState> {
  // Workspace path chuẩn: workspace/research/${missionId}/ (TB-01 §3)
  const wsRoot =
    workspaceRoot && workspaceRoot.trim().length > 0
      ? resolve(workspaceRoot)
      : resolve(join(process.cwd(), 'workspace', 'research', missionId))

  // Tạo dir recursive (TC-10: workspace phải tồn tại trước khi LISMA ghi)
  try {
    await fs.mkdir(wsRoot, { recursive: true })
  } catch (err) {
    console.warn(
      '[RwvLoop] fs.mkdir workspace failed (non-blocking — caller may retry):',
      err instanceof Error ? err.message : String(err),
    )
  }

  // branchName format `P-POC-${taskId}` (TB-01 §3: 1 Proposal = 1 branch)
  const safeTaskId = taskId.replace(/[^A-Za-z0-9-_]/g, '').slice(0, 32) || 'X'
  const branchName = `P-POC-${safeTaskId}`

  const state: RwvState = {
    round: 1,
    status: 'READ',
    maxRounds: Math.min(RWV_MAX_ROUNDS, G2_MAX_FIX_ROUNDS), // DR-C5 trần 2; G2_MAX_FIX_ROUNDS=3 hard cap
    worklogId: undefined,
    branchName,
    workspaceRoot: wsRoot,
    spec,
    filesChanged: [],
    modelSwitched: [],
    regressionEntries: [],
    missionId,
    taskId,
  }

  return state
}

// ============================================================
// §3. RUN ONE RWV ROUND — READ → WRITE → VERIFY
// ============================================================

/**
 * Run 1 vòng RWV (READ → WRITE → VERIFY) cho state hiện tại:
 *
 *  READ:
 *    - lismaCall với prompt đọc spec + existing code.
 *    - Parse filesChanged từ output (TC-10: phải nằm workspaceRoot).
 *
 *  WRITE:
 *    - lismaCall với prompt code fix trong workspace.
 *    - checkWorkspaceReadOnly — TC-10: violations → ESCALATE.
 *
 *  VERIFY:
 *    - lismaCall review + test.
 *    - Nếu regression (TC-04: fix mới phá bug gốc) → RegressionEntry + re-test.
 *    - status: VERIFY pass → DONE; fail → REVISED (round < maxRounds) hoặc
 *      ESCALATE (round ≥ maxRounds → KING P5).
 *
 *  Model switch giữa vòng (TC-12): nếu caller inject recordModelSwitch giữa các
 *    vòng → state.modelSwitched push. TC-12: task KHÔNG reset (state nằm DB).
 *
 *  Persist ResearchWorklog row mỗi round (TC-12: state nằm DB, không memory).
 *
 *  LLM error (lismaCall fail) → fail-open: status ESCALATE + note 'LLM unavailable'.
 */
export async function runRwvRound(
  state: RwvState,
  lismaCall: (prompt: string) => Promise<string>,
): Promise<RwvState> {
  const next: RwvState = {
    ...state,
    filesChanged: [...state.filesChanged],
    modelSwitched: [...state.modelSwitched],
    regressionEntries: [...state.regressionEntries],
  }

  // ---------- READ ----------
  next.status = 'READ'
  const readPrompt = buildReadPrompt(next)
  let readOutput = ''
  try {
    readOutput = await lismaCall(readPrompt)
  } catch (err) {
    return failOpenEscalate(next, `READ failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!readOutput || readOutput.trim().length === 0) {
    return failOpenEscalate(next, 'READ returned empty — LLM unavailable')
  }

  // Parse filesChanged từ READ output (heuristic: lines bắt đầu bằng path)
  const readFiles = parseFilesFromOutput(readOutput, next.workspaceRoot)
  next.filesChanged.push(...readFiles)

  // ---------- WRITE ----------
  next.status = 'WRITE'
  const writePrompt = buildWritePrompt(next, readOutput)
  let writeOutput = ''
  try {
    writeOutput = await lismaCall(writePrompt)
  } catch (err) {
    return failOpenEscalate(next, `WRITE failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!writeOutput || writeOutput.trim().length === 0) {
    return failOpenEscalate(next, 'WRITE returned empty — LLM unavailable')
  }

  // Parse filesChanged từ WRITE output
  const writeFiles = parseFilesFromOutput(writeOutput, next.workspaceRoot)
  next.filesChanged.push(...writeFiles)

  // TC-10: workspace read-only check — mọi file phải nằm workspaceRoot
  const allFiles = next.filesChanged
  const wsCheck = await checkWorkspaceReadOnly(allFiles, next.workspaceRoot)
  if (!wsCheck.clean) {
    next.status = 'ESCALATE'
    next.escalateReason = `TC-10 workspace violation: ${wsCheck.violations.length} files outside workspace — ${wsCheck.violations.slice(0, 3).join('; ')}`
    next.note = 'Workspace read-only Live (TC-10) — LISMA KHÔNG ghi ngoài workspace'
    await persistRoundWorklog(next, 'WRITE')
    return next
  }

  // ---------- VERIFY ----------
  next.status = 'VERIFY'
  const verifyPrompt = buildVerifyPrompt(next, writeOutput)
  let verifyOutput = ''
  try {
    verifyOutput = await lismaCall(verifyPrompt)
  } catch (err) {
    return failOpenEscalate(next, `VERIFY failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!verifyOutput || verifyOutput.trim().length === 0) {
    return failOpenEscalate(next, 'VERIFY returned empty — LLM unavailable')
  }

  // Parse verify result — heuristic: "PASS" hoặc "FAIL" trong output
  const lowerVerify = verifyOutput.toLowerCase()
  const isPass = lowerVerify.includes('pass') && !lowerVerify.includes('fail')
  const isRegression = lowerVerify.includes('regression') || lowerVerify.includes('broke')

  // TC-04: regression → thêm RegressionEntry + re-test bug gốc
  if (isRegression) {
    next.regressionEntries.push({
      round: next.round,
      bug: state.spec || '(original bug)',
      reTested: true,
      fixed: !isPass, // regression => bug gốc bị phá → fixed=false
    })
  }

  if (isPass) {
    next.status = 'DONE'
  } else {
    // VERIFY fail → REVISED (round < maxRounds) hoặc ESCALATE (round ≥ maxRounds)
    if (next.round < next.maxRounds) {
      next.status = 'REVISED'
      next.round = next.round + 1
    } else {
      next.status = 'ESCALATE'
      next.escalateReason = `DR-C5: ${next.maxRounds} REVISED rounds exhausted — escalate to KING (P5)`
    }
  }

  // Persist ResearchWorklog row mỗi round (TC-12: state nằm DB, không memory)
  await persistRoundWorklog(next, 'VERIFY')

  return next
}

// ============================================================
// §4. CHECK WORKSPACE READ-ONLY (TC-10)
// ============================================================

/**
 * TC-10 (TB-12 §3.2): verify mọi file trong lismaFiles bắt đầu workspaceRoot.
 *  - Resolve mỗi file (relative → absolute, treat relative as relative to workspaceRoot).
 *  - Compute relative path từ workspaceRoot → file.
 *  - Nếu relative path bắt đầu bằng `..` hoặc là absolute path khác root → violation.
 *  - Violations = files ngoài workspace. KHÔNG bao giờ ghi Live.
 *
 * Pure-ish (path resolution only — no DB, no LLM). Async cho future extension
 * (e.g., fs.stat checks) — hiện tại sync logic trong Promise.
 */
export async function checkWorkspaceReadOnly(
  lismaFiles: string[],
  workspaceRoot: string,
): Promise<{ violations: string[]; clean: boolean }> {
  const violations: string[] = []
  const wsRootAbs = resolve(workspaceRoot)

  for (const f of lismaFiles || []) {
    if (!f || typeof f !== 'string') continue
    // Resolve file path: nếu absolute → dùng luôn; nếu relative → relative to workspaceRoot
    const fileAbs = isAbsolute(f) ? resolve(f) : resolve(join(wsRootAbs, f))
    const rel = relative(wsRootAbs, fileAbs)
    // rel bắt đầu bằng `..` hoặc là absolute (Windows drive letter) → ngoài workspace
    if (rel.startsWith('..') || isAbsolute(rel)) {
      violations.push(f)
    }
  }

  return { violations, clean: violations.length === 0 }
}

// ============================================================
// §5. SHOULD ESCALATE — round ≥ maxRounds + vẫn REVISED
// ============================================================

/**
 * Check xem state có cần escalate KING không:
 *  - round ≥ maxRounds + status REVISED → ESCALATE.
 *  - status đã ESCALATE → vẫn true (idempotent).
 *  - DR-C5 trần 2 vòng REVISED.
 */
export function shouldEscalate(state: RwvState): boolean {
  if (state.status === 'ESCALATE') return true
  if (state.status === 'REVISED' && state.round >= state.maxRounds) return true
  return false
}

// ============================================================
// §6. MODEL SWITCH BETWEEN ROUNDS (TC-12 — no task reset)
// ============================================================

/**
 * TC-12 (TB-12 §3.2): record model switch giữa các vòng RWV.
 *  - Push ModelSwitchEntry vào state.modelSwitched.
 *  - KHÔNG reset task (state nằm DB, không memory) — DR-C7 role-based.
 *  - Persist ModelSwitchEvent (recordModelSwitch đã persist — fail-open).
 *
 * Caller gọi hàm này giữa vòng khi phát hiện model fallback. State update local
 * + persist row mới khi runRwvRound tiếp theo persist worklog.
 */
export async function recordRwvModelSwitch(
  state: RwvState,
  fromModel: string,
  toModel: string,
  trigger: string,
  nextCheck: string,
): Promise<RwvState> {
  const entry = await recordModelSwitch({
    agentId: AGENT_ID.LISMA,
    fromModel,
    toModel,
    trigger,
    nextCheck,
  })

  const next: RwvState = {
    ...state,
    modelSwitched: [...state.modelSwitched, entry],
  }
  return next
}

// ============================================================
// §7. INTERNAL HELPERS
// ============================================================

function buildReadPrompt(state: RwvState): string {
  return [
    `# RWV ROUND ${state.round} — READ PHASE`,
    `Mission: ${state.missionId}`,
    `Task: ${state.taskId}`,
    `Workspace: ${state.workspaceRoot}`,
    `Branch: ${state.branchName || '(unset)'}`,
    '',
    '## Spec / Bug description',
    state.spec || '(no spec provided)',
    '',
    '## Instruction',
    'Read the spec + existing code in workspace. List files you need to touch (one path per line,',
    'paths MUST be within workspace root). Identify root cause. Output:',
    '- ROOT CAUSE: <one-paragraph>',
    '- FILES TO TOUCH:',
    '  <file1>',
    '  <file2>',
  ].join('\n')
}

function buildWritePrompt(state: RwvState, readOutput: string): string {
  return [
    `# RWV ROUND ${state.round} — WRITE PHASE`,
    `Workspace: ${state.workspaceRoot} (TC-10: KHÔNG ghi ngoài workspace)`,
    '',
    '## READ output (root cause analysis)',
    readOutput,
    '',
    '## Instruction',
    'Write code fix in workspace (paths MUST start with workspace root).',
    'Output the code + list of files written (one path per line).',
  ].join('\n')
}

function buildVerifyPrompt(state: RwvState, writeOutput: string): string {
  return [
    `# RWV ROUND ${state.round} — VERIFY PHASE`,
    `Workspace: ${state.workspaceRoot}`,
    '',
    '## WRITE output (code fix)',
    writeOutput,
    '',
    '## Instruction',
    'Review the code fix + run mental tests. Check:',
    '- Does the fix address the original bug?',
    '- Does the fix introduce REGRESSION (breaks existing functionality)?',
    '- Output PASS / FAIL / REGRESSION with one-line reason.',
  ].join('\n')
}

/**
 * Parse filesChanged từ LLM output (heuristic):
 *  - Lines bắt đầu bằng path-like string (contains '/' or ends with .ts/.js/.py/.md).
 *  - Resolve relative paths to workspaceRoot.
 */
function parseFilesFromOutput(output: string, workspaceRoot: string): string[] {
  if (!output) return []
  const lines = output.split('\n')
  const files: string[] = []
  const wsRootAbs = resolve(workspaceRoot)
  const pathLikePattern = /^[\s-]*(?:FILES?\s*TO\s*TOUCH|FILES?\s*WRITT?EN|FILE:?)?\s*([A-Za-z0-9_./\-]+\.[A-Za-z0-9]+)/i

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // Match lines ending with extension
    const m = trimmed.match(pathLikePattern)
    if (m && m[1]) {
      const candidate = m[1]
      // If relative, prepend workspaceRoot (TC-10: mọi file phải trong workspace)
      const fileAbs = isAbsolute(candidate) ? candidate : join(wsRootAbs, candidate)
      files.push(fileAbs)
    }
  }

  // Dedupe
  return Array.from(new Set(files))
}

/**
 * Persist ResearchWorklog row cho vòng này (TC-12: state nằm DB, không memory).
 *  - entryJson = encodeJson(worklog entry 8 trường).
 *  - modelSwitchedJson = encodeJson(state.modelSwitched).
 *  - Save worklogId vào state.worklogId.
 *
 * Fail-open: DB error → warn, KHÔNG throw (state vẫn trả).
 */
async function persistRoundWorklog(state: RwvState, phase: string): Promise<void> {
  try {
    const entry: WorklogEntry = {
      mission: 'M1', // default — caller có thể mutate sau
      status: state.status === 'DONE' ? 'COMPLETED' : state.status === 'ESCALATE' ? 'ESCALATED' : 'IN_PROGRESS',
      currentPhase: 'G2',
      overallProgress: state.status === 'DONE' ? 100 : Math.min(state.round * 50, 90),
      tlReadBack: state.status === 'DONE' ? 'VERIFIED' : 'NEEDS-REVIEW',
      done: [
        `RWV round ${state.round} — ${state.status}`,
        ...(state.filesChanged.length > 0 ? [`Files touched: ${state.filesChanged.length}`] : []),
        ...(state.regressionEntries.length > 0
          ? [`Regressions: ${state.regressionEntries.length} (TC-04)`]
          : []),
      ],
      issuesFaced: state.note ? [state.note] : [],
      suggestionsNextGroup:
        state.status === 'ESCALATE'
          ? ['ESCALATE to KING — manual review needed (DR-C5 trần 2 vòng)']
          : [],
      filesChanged: state.filesChanged,
    }

    const row = await db.researchWorklog.create({
      data: {
        taskId: state.taskId,
        missionId: state.missionId,
        phase,
        entryJson: encodeJson(entry),
        evidenceJson: encodeJson([] as EvidenceItem[]),
        artifactMapJson: null,
        modelSwitchedJson: encodeJson(state.modelSwitched),
      },
    })

    state.worklogId = row.id
  } catch (err) {
    console.warn(
      '[RwvLoop] persistRoundWorklog failed (non-blocking — state vẫn trả):',
      err instanceof Error ? err.message : String(err),
    )
  }
}

/**
 * Fail-open helper: status ESCALATE + note. KHÔNG crash pipeline.
 */
function failOpenEscalate(state: RwvState, reason: string): RwvState {
  const next: RwvState = {
    ...state,
    status: 'ESCALATE',
    note: `LLM unavailable — ${reason}`,
    escalateReason: `LLM unavailable — manual review needed`,
  }
  // Best-effort persist (caller có thể check state.worklogId sau)
  void persistRoundWorklog(next, 'ESCALATE')
  return next
}
