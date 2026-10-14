/**
 * AUTO-EVAL KB — "xưởng nhãn" tự động cho Brain-A "V3" (R4-ĐIỀU TRA lượt 4)
 * ==========================================================================
 *
 * Bối cảnh (đo thật 2026-10-14): EvalResult = 0 · EvalRun = 0 · EvalCase = 0
 * — Brain-A calibration cần ≥ 30 nhãn faithfulness để thức tỉnh nhưng eval KB
 * CHỈ chạy khi user bấm tay (POST /api/eval/run) và còn yêu cầu seed case
 * trước (scripts/seed-eval.ts). Không ai chạy → Brain-A "trải qua nhiều lượt
 * xử lý tác vụ không hề thấy có gì tiến triển" (user report R4) — vì TÁC VỤ
 * AGENT không bao giờ đẻ nhãn cho Brain-A; nhãn của nó đến từ EVAL KB.
 *
 * maybeRunAutoKbEval() — gọi từ tick quan sát 10 phút (impact.ts worker):
 *   (1) cờ auto_eval_kb (TUNING_SPECS #31, default ON) off → no-op;
 *   (2) EvalCase active = 0 → no-op (chờ seed — quan sát rule 5 sẽ nhắc);
 *   (3) tổng EvalResult ≥ AUTO_EVAL_TARGET (60) → no-op (đủ nhãn — tắt xưởng);
 *   (4) EvalRun mới nhất trong vòng AUTO_EVAL_INTERVAL_MS (12h) → no-op;
 *   (5) single-flight globalThis (đang chạy → no-op);
 *   → tạo EvalRun + runEval({runId, caseLimit: 8}) fire-and-forget.
 * runEval (runner.ts) tự auto-train calibration V2 + Brain-A V3 MLP ngay sau
 * khi eval hoàn tất (đủ ≥ 10 nhãn usable — code sẵn từ Task 20-c + BRAIN-P2).
 *
 * Toàn bộ fail-open — KHÔNG bao giờ throw lên tick worker.
 */

import { db } from '@/lib/db'
import { getTuningEnum } from '@/lib/learning/tuning-store'

/** Ngưỡng "đủ nhãn, tắt xưởng" — 2× MIN_TRAIN_SAMPLES_V2 (30). */
export const AUTO_EVAL_TARGET = 60
/** Chu kỳ nghỉ giữa 2 đợt eval tự động (12h — nhãn tích lũy từ từ, không đốt LLM). */
export const AUTO_EVAL_INTERVAL_MS = 12 * 60 * 60_000
/** Số case mỗi đợt eval tự động — NHẸ (8 case ≈ 1-2 phút deepseek NIM). */
export const AUTO_EVAL_CASE_LIMIT = 8

/** Single-flight — chống 2 tick cùng bắn eval (tick 10' + HMR double-register). */
function autoEvalState(): { running: boolean } {
  const g = globalThis as unknown as { __tmoAutoEvalRunning?: { running: boolean } }
  g.__tmoAutoEvalRunning ??= { running: false }
  return g.__tmoAutoEvalRunning
}

/**
 * EvalRun mồ côi: 'running' quá 2h = đợt eval bị giết giữa chừng (app
 * restart/OOM — runEval sống trong process, không có worker resume). Đánh
 * failed để (a) UI không hiện "đang chạy" mãi mãi, (b) cooldown bên dưới
 * KHÔNG bị một đợt chết chặn xưởng nhãn 12h. 2h > worst-case thật (8 case ×
 * 4 call × kimi ~2min ≈ 64') — không giết đợt sống.
 */
async function sweepStaleEvalRuns(now: number): Promise<number> {
  try {
    const res = await db.evalRun.updateMany({
      where: { status: 'running', startedAt: { lt: new Date(now - 2 * 60 * 60_000) } },
      data: { status: 'failed', errorMessage: 'crashed — app restart giữa đợt eval (R4 auto-cleanup)' },
    })
    if (res.count > 0) {
      console.warn(`[AutoEval] Dọn ${res.count} EvalRun mồ côi (running >2h — bị giết giữa chừng bởi restart) → failed`)
    }
    return res.count
  } catch {
    return 0
  }
}

/** Cờ auto_eval_kb (STORE › ENV AUTO_EVAL_KB › default ON). */
function isAutoEvalEnabled(): boolean {
  try {
    return getTuningEnum('auto_eval_kb') === 'on'
  } catch {
    return true // fail-open: unknown key/DB lỗi → giữ mặc định ON (spec default)
  }
}

/**
 * Kiểm tra + kích hoạt eval tự động nếu đủ điều kiện. Trả về lý do no-op
 * (để test/quan sát) hoặc 'started'. KHÔNG throw.
 */
export async function maybeRunAutoKbEval(): Promise<
  'disabled' | 'no-cases' | 'enough-labels' | 'cooldown' | 'in-flight' | 'started' | 'error'
> {
  try {
    if (!isAutoEvalEnabled()) return 'disabled'
    const st = autoEvalState()
    if (st.running) return 'in-flight'

    // Dọn đợt eval mồ côi TRƯỚC (bị restart giết giữa chừng) — không thì
    // row kẹt 'running' + cooldown bị đợt chết chặn 12h.
    await sweepStaleEvalRuns(Date.now())

    const [activeCases, totalResults, latestRun] = await Promise.all([
      db.evalCase.count({ where: { active: true } }),
      db.evalResult.count(),
      // Cooldown chỉ tính đợt KHÔNG failed (đợt bị giết giữa chừng không chặn
      // xưởng nhãn — sweep vừa đánh failed phía trên).
      db.evalRun.findFirst({
        where: { status: { not: 'failed' } },
        orderBy: { startedAt: 'desc' },
        select: { id: true, startedAt: true, status: true },
      }),
    ])
    if (activeCases === 0) return 'no-cases'
    if (totalResults >= AUTO_EVAL_TARGET) return 'enough-labels'
    if (latestRun && Date.now() - latestRun.startedAt.getTime() < AUTO_EVAL_INTERVAL_MS) return 'cooldown'

    // Bắn đợt eval nhẹ — EvalRun row + runEval fire-and-forget (mirror route
    // POST /api/eval/run; caseCount đếm thật theo filter runner sẽ dùng).
    const selected = await db.evalCase.findMany({
      where: { active: true },
      orderBy: { createdAt: 'asc' },
      take: AUTO_EVAL_CASE_LIMIT,
      select: { id: true },
    })
    if (selected.length === 0) return 'no-cases'
    const run = await db.evalRun.create({ data: { status: 'running', caseCount: selected.length } })
    st.running = true
    console.log(
      `[AutoEval] Xưởng nhãn Brain-A: bắn đợt eval tự động ${selected.length} case (run ${run.id}) — EvalResult ${totalResults}/${AUTO_EVAL_TARGET}, lần gần nhất ${latestRun ? new Date(latestRun.startedAt).toISOString() : 'chưa có'}`,
    )
    void import('./runner')
      .then(m => m.runEval({ runId: run.id, caseLimit: AUTO_EVAL_CASE_LIMIT }))
      .catch(err => {
        console.error('[AutoEval] runEval crashed:', err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        st.running = false
      })
    return 'started'
  } catch (err) {
    // Log đầy đủ tên lỗi + message (err.message có thể rỗng với Prisma boot race)
    const errName = err instanceof Error ? err.constructor.name : typeof err
    console.error(`[AutoEval] maybeRunAutoKbEval thất bại (fail-open — ${errName}):`, err instanceof Error ? (err.message || '(empty message)') : String(err))
    return 'error'
  }
}
