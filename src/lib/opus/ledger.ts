/**
 * OPUS (Task 13-b) — ISSUE LEDGER SERVICE
 * ============================================
 *
 * Sổ công nợ vấn đề của từng session — nguồn sự thật cho predicate 4 điều kiện
 * dừng của auto mode (§VII OPUS_INSTRUCTION): "Issue Ledger của session
 * KHÔNG còn issue blocking/major ở trạng thái open" là điều kiện (1).
 *
 * Vòng đời issue:
 *   - MỞ    : verdict Opus liệt kê issue → upsert (dedupe theo title + open
 *             cùng session: trùng title → update severity/evidence, mới → create)
 *   - ĐÓNG  :
 *     (a) TỰ ĐỘNG — Opus instruction dạy "liệt kê lại MỖI issue chưa sửa mỗi
 *         vòng review" → issue đang open mà KHÔNG tái xuất hiện trong verdict
 *         mới = đã được xử lý (status='fixed', resolvedBy=opusReviewId).
 *     (b) THỦ CÔNG — user đóng tay qua resolveIssue (resolvedBy='user').
 *   - Trạng thái: open | fixed | wont_fix | superseded (lược đồ DB 13-a).
 */

import type { IssueLedger } from '@prisma/client'
import { db } from '@/lib/db'
import type { OpusIssue, OpusIssueSeverity } from './types'
import { OPUS_ISSUE_SEVERITIES } from './types'

// ==================== HELPERS ====================

/** Normalize severity về 4 mức hợp lệ — sai/default → 'minor' (an toàn, không đẩy noise thành blocking) */
export function normalizeSeverity(raw: unknown): OpusIssueSeverity {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return (OPUS_ISSUE_SEVERITIES as readonly string[]).includes(s)
    ? (s as OpusIssueSeverity)
    : 'minor'
}

/** Chuẩn hóa title để dedupe: trim + collapse khoảng trắng (không lower-case toàn phần — giữ nghĩa hiển thị) */
function normalizeTitle(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : ''
}

/** Parse metadata JSON an toàn (null khi rỗng/hỏng) — dùng chung cho các route */
export function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

// ==================== QUERIES ====================

/** Các issue đang open của session (orderBy: blocking/major trước, mở sớm trước) */
export async function getOpenIssues(sessionId: string): Promise<IssueLedger[]> {
  const rows = await db.issueLedger.findMany({
    where: { sessionId, status: 'open' },
    orderBy: [{ openedAt: 'asc' }],
  })
  const rank: Record<string, number> = { blocking: 0, major: 1, minor: 2, nit: 3 }
  return rows.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9))
}

/** Đếm issue theo severity cho 1 danh sách */
function countBySeverity(rows: IssueLedger[]): Record<string, number> {
  const counts: Record<string, number> = { blocking: 0, major: 0, minor: 0, nit: 0 }
  for (const r of rows) {
    if (counts[r.severity] !== undefined) counts[r.severity]++
  }
  return counts
}

export interface OpusLedgerView {
  open: IssueLedger[]
  resolved: IssueLedger[]
  counts: {
    open: Record<string, number> & { total: number }
    resolved: Record<string, number> & { total: number }
  }
  /** true khi KHÔNG còn blocking/major open — điều kiện (1) của predicate STOP */
  clean: boolean
}

/** Toàn bộ sổ của session: open + resolved (50 gần nhất) + counts theo severity */
export async function getLedger(sessionId: string): Promise<OpusLedgerView> {
  const [open, resolved] = await Promise.all([
    getOpenIssues(sessionId),
    db.issueLedger.findMany({
      where: { sessionId, status: { not: 'open' } },
      orderBy: [{ resolvedAt: 'desc' }],
      take: 50,
    }),
  ])
  const openCounts = countBySeverity(open)
  const resolvedCounts = countBySeverity(resolved)
  return {
    open,
    resolved,
    counts: {
      open: { ...openCounts, total: open.length },
      resolved: { ...resolvedCounts, total: resolved.length },
    },
    clean: openCounts.blocking === 0 && openCounts.major === 0,
  }
}

// ==================== SYNC TỪ VERDICT ====================

/**
 * Đồng bộ sổ từ 1 verdict mới của Opus:
 *   1. UPSERT từng issue trong verdict — dedupe theo (title chuẩn hóa + status
 *      open + cùng session): đã có open trùng title → update severity/evidence
 *      (giữ openedAt gốc, cập nhật runRef/opusReviewId lần gặp gần nhất);
 *      chưa có → tạo mới.
 *   2. AUTO-RESOLVE — issue đang open của session mà KHÔNG tái xuất hiện trong
 *      verdict mới → status='fixed', resolvedAt=now, resolvedBy=reviewId.
 *      (Opus instruction §VII + §III-B5 yêu cầu liệt kê lại mọi issue chưa sửa
 *      mỗi vòng → biến mất khỏi verdict = đã xử lý xong.)
 *
 * Issue severity 'nit'/'minor' cũng theo cùng quy tắc — sổ là sổ, không phân biệt.
 */
export async function syncLedgerFromVerdict(params: {
  sessionId: string
  /** runId của run đang được review (run_xxx / sub_xxx) */
  runRef?: string | null
  /** OpusReview.id phát hiện các issue này */
  reviewId: string
  issues: OpusIssue[]
}): Promise<{ opened: number; updated: number; autoResolved: number }> {
  const { sessionId, reviewId } = params
  const runRef = params.runRef ?? null

  // Chuẩn hóa danh sách issue từ verdict (bỏ entry không có title)
  const verdictIssues = params.issues
    .map(i => ({
      title: normalizeTitle(i.title),
      severity: normalizeSeverity(i.severity),
      evidence: typeof i.evidence === 'string' ? i.evidence.trim() : '',
      suggestedFix: typeof i.suggestedFix === 'string' && i.suggestedFix.trim() ? i.suggestedFix.trim() : undefined,
    }))
    .filter(i => i.title.length > 0)

  const verdictTitles = new Set(verdictIssues.map(i => i.title))

  const existingOpen = await db.issueLedger.findMany({
    where: { sessionId, status: 'open' },
  })
  const openByTitle = new Map<string, IssueLedger>()
  for (const row of existingOpen) {
    openByTitle.set(normalizeTitle(row.title), row)
  }

  let opened = 0
  let updated = 0

  // 1. Upsert các issue trong verdict
  for (const issue of verdictIssues) {
    const existing = openByTitle.get(issue.title)
    if (existing) {
      // Đã có open trùng title → update severity/evidence (đánh dấu gặp lại)
      await db.issueLedger.update({
        where: { id: existing.id },
        data: {
          severity: issue.severity,
          evidence: issue.evidence || existing.evidence,
          runRef,
          opusReviewId: reviewId,
        },
      })
      updated++
    } else {
      await db.issueLedger.create({
        data: {
          sessionId,
          runRef,
          opusReviewId: reviewId,
          title: issue.title,
          severity: issue.severity,
          status: 'open',
          evidence: issue.evidence,
        },
      })
      opened++
    }
  }

  // 2. Auto-resolve: open của session không tái xuất hiện trong verdict
  let autoResolved = 0
  const now = new Date()
  for (const row of existingOpen) {
    if (verdictTitles.has(normalizeTitle(row.title))) continue
    await db.issueLedger.update({
      where: { id: row.id },
      data: { status: 'fixed', resolvedAt: now, resolvedBy: reviewId },
    })
    autoResolved++
  }

  if (opened + updated + autoResolved > 0) {
    console.log(
      `[Opus][ledger] session=${sessionId} sync verdict ${reviewId.slice(0, 12)}… — mở mới ${opened}, cập nhật ${updated}, auto-resolve ${autoResolved}`
    )
  }

  return { opened, updated, autoResolved }
}

// ==================== RESOLVE THỦ CÔNG ====================

/**
 * User đóng tay 1 issue (resolvedBy='user'). Chỉ đóng được issue đang open —
 * đã đóng rồi trả null (idempotent, không reopen).
 */
export async function resolveIssue(issueId: string, resolvedBy = 'user'): Promise<IssueLedger | null> {
  const updated = await db.issueLedger.updateMany({
    where: { id: issueId, status: 'open' },
    data: { status: 'fixed', resolvedAt: new Date(), resolvedBy },
  })
  if (updated.count === 0) return null
  return db.issueLedger.findUnique({ where: { id: issueId } })
}
