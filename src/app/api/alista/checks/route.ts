/**
 * ALISTA — GET /api/alista/checks?limit=20
 * =====================================================
 * Lịch sử hoạt động ALISTA từ TaskExecution (mới nhất trước):
 *   - type='alista-check'            — các lần chạy pipeline Kiểm tra toàn diện (7 bước)
 *   - type='alista-verify'           — (v1.2) các lần xác minh follow-up sau khi đề xuất
 *     Self-Direction hoàn tất: resolved? đề xuất mới? (jobId = proposalId gốc)
 *   - type='alista-verify-deferred'  — (v1.3) marker hoãn verify theo recheck window
 *     (metric cần thời gian phản ánh): dueAt, lý do, trạng thái pending/superseded
 *
 * Trả { rows: [{ id, kind: 'check' | 'verify' | 'defer', startedAt, completedAt, status,
 *   durationMs, proposalsCreated, deadlineMet, reason, perCheck[], verify {...}, defer {...} }] }.
 *
 * Source: SQLite TaskExecution (persistent qua restart) — KHÔNG đọc globalState
 * Map (chỉ sống trong process) để đảm bảo owner thấy lịch sử đầy đủ kể cả khi
 * app restart.
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

interface VerifyInfo {
  /** ID proposal gốc đã hoàn tất (đang được xác minh) */
  originalProposalId: string
  /** Title proposal gốc */
  originalTitle: string
  /** Key gốc `[ALISTA] <slug>:<target>:<yyyymm>[:vN]` */
  originalKey: string | null
  /** Check đã re-run (1-7) */
  checkId: number | null
  /** 'completion-hook' (ngay khi hoàn tất) | 'sweep' (lưới an toàn 60s) */
  trigger: string | null
  /** true = đã xử lý triệt để; false = còn vấn đề (đã gửi follow-up); null = không kết luận được */
  resolved: boolean | null
  /** Findings còn sót sau khi xử lý */
  findingsAfter: Array<{ key: string; target: string; priority: string }>
  /** true nếu finding CÙNG vấn đề gốc vẫn còn (chưa triệt để đúng vấn đề đó) */
  stillOriginalIssue: boolean | null
  /** Đề xuất follow-up mới đã gửi */
  newProposals: Array<{ id: string; title: string }>
  /** Findings bị dedupe chặn (đã có proposal sống) */
  skippedProposals: Array<{ title: string; reason: string }>
  /** Ghi chú (collector fail / không re-check được / trượt budget...) */
  note: string | null
}

/** (v1.3) Thông tin marker hoãn verify */
interface DeferInfo {
  originalProposalId: string
  originalTitle: string
  originalKey: string | null
  checkId: number | null
  trigger: string | null
  /** Thời điểm hẹn đo lại (epoch ms) */
  dueAt: number | null
  /** Cửa sổ recheck (ms) theo successCriteria của vấn đề */
  recheckAfterMs: number | null
  /** Lý do hoãn (tiếng Việt) */
  why: string | null
  /** 'deferred' (đang chờ) | 'superseded' (đã kích hoạt verify thật) */
  status: string
}

interface CheckHistoryRow {
  id: string
  /** 'check' = pipeline toàn diện | 'verify' = xác minh follow-up (v1.2) | 'defer' = hoãn verify (v1.3) */
  kind: 'check' | 'verify' | 'defer'
  startedAt: string
  completedAt: string | null
  status: string
  durationMs: number | null
  proposalsCreated: number
  deadlineMet: boolean
  reason: string
  perCheck: Array<{
    id: number
    label: string
    status: string
    collectMs?: number
    durationMs?: number
    findingsCount: number
    proposalsCreated: number
    error?: string
    skipReason?: string
  }>
  partialSteps: Array<{ step: number; label: string; reason: string }>
  verify: VerifyInfo | null
  defer: DeferInfo | null
  error: string | null
}

export async function GET(request: NextRequest) {
  const limitParam = request.nextUrl.searchParams.get('limit')
  const limit = Math.min(Math.max(parseInt(limitParam || '20', 10) || 20, 1), 100)

  try {
    const rows = await db.taskExecution.findMany({
      where: { type: { in: ['alista-check', 'alista-verify', 'alista-verify-deferred'] } },
      orderBy: { startedAt: 'desc' },
      take: limit,
      select: { id: true, type: true, jobId: true, status: true, startedAt: true, completedAt: true, result: true, errorMessage: true },
    })

    const out: CheckHistoryRow[] = []
    for (const r of rows) {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = r.result ? JSON.parse(r.result) as Record<string, unknown> : {}
      } catch { /* ignore parse error */ }

      const perCheck = (Array.isArray(parsed.perCheck) ? parsed.perCheck : []) as CheckHistoryRow['perCheck']
      const partialSteps = (Array.isArray(parsed.partialSteps) ? parsed.partialSteps : []) as CheckHistoryRow['partialSteps']
      const proposalsCreated = Array.isArray(parsed.proposalsCreated) ? parsed.proposalsCreated : []

      // v1.2 — normalize verify info
      let verify: VerifyInfo | null = null
      if (r.type === 'alista-verify') {
        const findingsAfter = (Array.isArray(parsed.findingsAfter) ? parsed.findingsAfter : []) as VerifyInfo['findingsAfter']
        const newProposals = (Array.isArray(parsed.newProposals) ? parsed.newProposals : []) as VerifyInfo['newProposals']
        const skippedProposals = (Array.isArray(parsed.skippedProposals) ? parsed.skippedProposals : []) as VerifyInfo['skippedProposals']
        verify = {
          originalProposalId: r.jobId ?? (typeof parsed.originalProposalId === 'string' ? parsed.originalProposalId : ''),
          originalTitle: typeof parsed.originalTitle === 'string' ? parsed.originalTitle : '',
          originalKey: typeof parsed.originalKey === 'string' ? parsed.originalKey : null,
          checkId: typeof parsed.checkId === 'number' ? parsed.checkId : null,
          trigger: typeof parsed.trigger === 'string' ? parsed.trigger : null,
          resolved: typeof parsed.resolved === 'boolean' ? parsed.resolved : null,
          findingsAfter,
          stillOriginalIssue: typeof parsed.stillOriginalIssue === 'boolean' ? parsed.stillOriginalIssue : null,
          newProposals,
          skippedProposals,
          note: typeof parsed.note === 'string' ? parsed.note
            : (typeof parsed.collectionError === 'string' ? `collector fail: ${parsed.collectionError}`
              : (parsed.notVerifiable === true ? 'không xác minh được (key/check không map)'
                : (parsed.notRecheckable === true ? 'check ⑥ không re-run được'
                  : null))),
        }
      }

      // v1.3 — normalize defer info (marker hoãn verify)
      let defer: DeferInfo | null = null
      if (r.type === 'alista-verify-deferred') {
        const resultStatus = typeof parsed.status === 'string' ? parsed.status
          : (r.status === 'completed' ? 'superseded' : 'deferred')
        defer = {
          originalProposalId: r.jobId ?? (typeof parsed.originalProposalId === 'string' ? parsed.originalProposalId : ''),
          originalTitle: typeof parsed.originalTitle === 'string' ? parsed.originalTitle : '',
          originalKey: typeof parsed.originalKey === 'string' ? parsed.originalKey : null,
          checkId: typeof parsed.checkId === 'number' ? parsed.checkId : null,
          trigger: typeof parsed.trigger === 'string' ? parsed.trigger : null,
          dueAt: typeof parsed.dueAt === 'number' ? parsed.dueAt : null,
          recheckAfterMs: typeof parsed.recheckAfterMs === 'number' ? parsed.recheckAfterMs : null,
          why: typeof parsed.why === 'string' ? parsed.why : null,
          status: resultStatus,
        }
      }

      out.push({
        id: r.id,
        kind: r.type === 'alista-verify' ? 'verify' : (r.type === 'alista-verify-deferred' ? 'defer' : 'check'),
        startedAt: r.startedAt.toISOString(),
        completedAt: r.completedAt?.toISOString() ?? null,
        status: r.status,
        durationMs: typeof parsed.durationMs === 'number' ? parsed.durationMs : null,
        proposalsCreated: r.type === 'alista-verify'
          ? ((verify?.newProposals.length) ?? 0)
          : proposalsCreated.length,
        deadlineMet: parsed.deadlineMet === true,
        reason: typeof parsed.reason === 'string' ? parsed.reason : (r.status === 'completed' ? 'all_checks_done' : 'unknown'),
        perCheck,
        partialSteps,
        verify,
        defer,
        error: r.errorMessage,
      })
    }

    return NextResponse.json({ rows: out, count: out.length })
  } catch (err) {
    console.error('[ALISTA][route:checks] GET fail:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'Không đọc được lịch sử hoạt động ALISTA', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
