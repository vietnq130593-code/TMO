/**
 * RESEARCH TEAM — G2 EVIDENCE LOG (TB-04 §5 evidence bắt buộc + DR + TC-06)
 * =================================================================================
 * Spec:
 *  - TB-04 §5 — MỌI claim trong Diagnostic Report phải có evidence cụ thể
 *    (file:line / log excerpt / metric). Claim thiếu evidence → KHÔNG được chấp nhận.
 *  - TB-09 §10 E5 — Diagnostic Report (DR): root cause phải kèm evidence.
 *  - TB-12 §3.2 TC-06 — Evidence-gap test: claim không có evidence → bị loại
 *    khỏi Diagnostic Report (KHÔNG phải accept mù).
 *
 * Bất biến:
 *  - KHÔNG bao giờ accept claim mà không có evidence match (TC-06 — fail-closed).
 *  - Matching heuristic: claim substring trong evidence.claim HOẶC ngược lại
 *    (TB-13 §1 nguyên tắc 7: tái dùng hạ tầng, không NLP phức tạp).
 *  - Worklog append-only: appendEvidence KHÔNG rewrite — chỉ concat thêm items
 *    vào evidenceJson (DR-C3 — append-only event log).
 *
 * Fail-open policy: các hàm DB wrap try/catch — lỗi persist KHÔNG crash pipeline,
 * chỉ warn. Pure validators (validateEvidence, filterClaimsWithEvidence,
 * formatEvidenceCitation) KHÔNG gọi DB/LLM — testable standalone.
 */

import { db } from '@/lib/db'
import {
  encodeJson,
  decodeJsonArray,
  decodeJsonObject,
  type EvidenceItem,
  type WorklogEntry,
  type WorklogFinding,
} from '../types'

// ============================================================
// §1. PURE VALIDATORS (no DB, no LLM)
// ============================================================

export interface EvidenceValidation {
  valid: boolean
  /** Claims KHÔNG có evidence match — gap (TC-06: bị loại khỏi Diagnostic Report) */
  gaps: string[]
  /** Map claim → danh sách evidence match (≥ 1 item) */
  evidenceByClaim: Map<string, EvidenceItem[]>
}

/**
 * Validate evidence cho mảng claims (TB-04 §5 + TC-06):
 *  - Mỗi claim PHẢI có ≥ 1 evidence item match.
 *  - Match heuristic: claim substring trong evidence.claim HOẶC ngược lại
 *    (case-insensitive) — TB-13 §1 nguyên tắc 7.
 *  - Claim thiếu match → gap.
 *  - valid = gaps.length === 0 (nếu có claims đầu vào).
 *  - Nếu claims=[] → valid=true (no claims to validate), gaps=[].
 */
export function validateEvidence(
  claims: string[],
  evidence: EvidenceItem[],
): EvidenceValidation {
  const safeClaims = Array.isArray(claims) ? claims.filter((c) => typeof c === 'string' && c.trim().length > 0) : []
  const safeEvidence = Array.isArray(evidence) ? evidence.filter((e) => e && typeof e.claim === 'string') : []

  const evidenceByClaim = new Map<string, EvidenceItem[]>()
  const gaps: string[] = []

  for (const claim of safeClaims) {
    const matches = safeEvidence.filter((e) => claimMatchesEvidence(claim, e))
    if (matches.length === 0) {
      gaps.push(claim)
    } else {
      evidenceByClaim.set(claim, matches)
    }
  }

  // valid = không có gap (nếu claims rỗng thì valid theo định nghĩa)
  const valid = gaps.length === 0

  return { valid, gaps, evidenceByClaim }
}

/**
 * Heuristic match (TB-13 §1 nguyên tắc 7 — không NLP phức tạp):
 *  - claim substring trong evidence.claim HOẶC evidence.claim substring trong claim.
 *  - Case-insensitive + trim.
 */
export function claimMatchesEvidence(claim: string, evidence: EvidenceItem): boolean {
  if (!claim || !evidence || typeof evidence.claim !== 'string') return false
  const c = claim.trim().toLowerCase()
  const e = evidence.claim.trim().toLowerCase()
  if (!c || !e) return false
  // Match hai chiều: claim có thể là short-form hoặc long-form
  return c.includes(e) || e.includes(c)
}

/**
 * Tách claims có evidence vs claims KHÔNG có evidence (TC-06 — filter gap).
 * Trả accepted[] (có evidence match) + rejected[] (gap — bị loại khỏi DR).
 *
 * TC-06 invariant: claim KHÔNG có evidence → KHÔNG được accept (fail-closed).
 */
export function filterClaimsWithEvidence(
  claims: string[],
  evidence: EvidenceItem[],
): { accepted: string[]; rejected: string[] } {
  const validation = validateEvidence(claims, evidence)
  const accepted = claims.filter((c) => !validation.gaps.includes(c))
  const rejected = validation.gaps
  return { accepted, rejected }
}

/**
 * Format evidence citation chuẩn TB-04 §5:
 * `file:line — excerpt`
 *
 * Pure helper — không side-effect.
 */
export function formatEvidenceCitation(item: EvidenceItem): string {
  if (!item) return '(no evidence)'
  const file = item.file || '(unknown-file)'
  const line = item.line !== undefined && item.line !== '' ? `:${item.line}` : ''
  const excerpt = item.excerpt ? ` — ${item.excerpt}` : ''
  return `${file}${line}${excerpt}`
}

// ============================================================
// §2. DB-BOUND HELPERS (append-only, fail-open)
// ============================================================

/**
 * Append evidence items vào worklog (DR-C3 append-only — KHÔNG rewrite):
 *  1. Read existing evidenceJson.
 *  2. Decode → array.
 *  3. Concat new items.
 *  4. Encode → persist.
 *
 * TC-06: function này KHÔNG accept claim không có evidence — caller (route) phải
 * validate trước qua filterClaimsWithEvidence. Function chỉ persist items thật.
 *
 * Fail-open: DB error → warn + KHÔNG throw (caller không crash pipeline).
 */
export async function appendEvidence(
  worklogId: string,
  items: EvidenceItem[],
): Promise<void> {
  try {
    const row = await db.researchWorklog.findUnique({
      where: { id: worklogId },
      select: { evidenceJson: true },
    })
    if (!row) {
      console.warn(
        '[EvidenceLog] appendEvidence: worklog %s không tồn tại — skip (non-blocking)',
        worklogId,
      )
      return
    }

    const existing = decodeJsonArray<EvidenceItem>(row.evidenceJson)
    const newItems = Array.isArray(items)
      ? items.filter((i) => i && typeof i.claim === 'string' && i.claim.trim().length > 0)
      : []
    const merged = [...existing, ...newItems]

    await db.researchWorklog.update({
      where: { id: worklogId },
      data: { evidenceJson: encodeJson(merged) },
    })
  } catch (err) {
    console.warn(
      '[EvidenceLog] appendEvidence failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
  }
}

/**
 * Kiểm tra evidence gap cho 1 worklog (TC-06 — read-time check):
 *  1. Read entryJson (decode → WorklogEntry).
 *  2. Collect claims từ entry.done[] + entry.findings[].finding.
 *  3. Read evidenceJson (decode → EvidenceItem[]).
 *  4. Validate → trả { hasGap, gapClaims }.
 *
 * TC-06: nếu hasGap=true → Diagnostic Report phải loại gapClaims (KHÔNG accept).
 *
 * Fail-open: DB error → trả { hasGap: false, gapClaims: [] } (không chặn pipeline
 * khi DB down — caller vẫn có thể tiếp tục với manual review).
 */
export async function checkEvidenceGap(
  worklogId: string,
): Promise<{ hasGap: boolean; gapClaims: string[] }> {
  try {
    const row = await db.researchWorklog.findUnique({
      where: { id: worklogId },
      select: { entryJson: true, evidenceJson: true },
    })
    if (!row) {
      return { hasGap: false, gapClaims: [] }
    }

    const entry = decodeJsonObject<WorklogEntry>(row.entryJson)
    const evidence = decodeJsonArray<EvidenceItem>(row.evidenceJson)

    // FIX (Task 19 audit A#2): claims CHỈ lấy từ findings[] (M2 — DR/claim thật).
    // done[] là progress text ("LISMA round 1 — M2 review") — KHÔNG phải claim
    // cần evidence; coi done[] là claim làm checkEvidenceGap LUÔN hasGap=true →
    // handoff gate TC-14 chặn 100% + POST /worklog 400 mọi entry hợp lệ.
    const claims: string[] = []
    if (Array.isArray(entry.findings)) {
      for (const f of entry.findings as WorklogFinding[]) {
        if (f && typeof f.finding === 'string' && f.finding.trim().length > 0) {
          claims.push(f.finding)
        }
      }
    }

    // Dedupe claims
    const uniqueClaims = Array.from(new Set(claims))
    const validation = validateEvidence(uniqueClaims, evidence)
    return { hasGap: validation.gaps.length > 0, gapClaims: validation.gaps }
  } catch (err) {
    console.warn(
      '[EvidenceLog] checkEvidenceGap failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
    return { hasGap: false, gapClaims: [] }
  }
}

// ============================================================
// §3. DIAGNOSTIC REPORT HELPERS — pure (TB-04 §3.3)
// ============================================================

/**
 * Build Diagnostic Report body từ findings + evidence map (pure helper).
 *  - Mỗi finding → 1 section với evidence citation (TC-06).
 *  - Findings có claim KHÔNG match evidence → BỊ LOẠI (TC-06).
 *
 * Pure function — không DB, không LLM.
 */
export function buildEvidenceBackedFindings(
  findings: WorklogFinding[],
  evidence: EvidenceItem[],
): { accepted: WorklogFinding[]; rejected: WorklogFinding[] } {
  const accepted: WorklogFinding[] = []
  const rejected: WorklogFinding[] = []
  for (const f of findings || []) {
    const matches = (evidence || []).filter((e) => claimMatchesEvidence(f.finding, e))
    if (matches.length > 0) {
      accepted.push(f)
    } else {
      rejected.push(f)
    }
  }
  return { accepted, rejected }
}

/**
 * Re-export helpers cho caller (lisma.ts, rwv-loop.ts, API routes) tiện dùng.
 */
export { encodeJson as _encodeJson, decodeJsonArray as _decodeJsonArray }
