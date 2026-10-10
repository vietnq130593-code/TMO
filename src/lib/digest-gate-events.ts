/**
 * P3-M4 (BLUEPRINT-STATS-LEARNING-P0-P6 §P3-M4, mục #7) — nhật ký sự kiện
 * digest/summary quality gate.
 *
 * Mỗi lần gate chạy (compression: evidence-coverage ≥ 0.7 · summarization:
 * ROUGE-L recall ≥ 0.3) ghi 1 row DigestGateEvent (pass/fallback + giá trị
 * gate). Nguồn duy nhất cho KPI digest_gate_fallback_rate (kpi/registry).
 *
 * Fire-and-forget fail-open tuyệt đối: lỗi ghi log KHÔNG BAO GIỜ được phép
 * làm hỏng flow nén/tóm tắt (nén là tối ưu — đúng doctrine "fail-open cho
 * đo lường" của blueprint).
 */

import { db } from '@/lib/db'

export interface DigestGateEventInput {
  /** compression (evidence-coverage gate) | summarization (ROUGE-L recall gate) */
  kind: 'compression' | 'summarization'
  /** pass | fallback */
  outcome: 'pass' | 'fallback'
  /** Giá trị gate compression (coverage 0-1) — null/undefined cho summarization */
  coverage?: number | null
  /** Giá trị gate summarization (ROUGE-L recall 0-1) — null/undefined cho compression */
  rougeRecall?: number | null
  /** digest method sau gate: llm | heuristic | fallback-first */
  method?: string | null
}

/** Ghi 1 sự kiện gate — void, không bao giờ throw, không bao giờ await ở caller */
export function recordDigestGateEvent(input: DigestGateEventInput): void {
  try {
    void db.digestGateEvent
      .create({
        data: {
          kind: input.kind,
          outcome: input.outcome,
          coverage:
            typeof input.coverage === 'number' && Number.isFinite(input.coverage)
              ? input.coverage
              : null,
          rougeRecall:
            typeof input.rougeRecall === 'number' && Number.isFinite(input.rougeRecall)
              ? input.rougeRecall
              : null,
          method: input.method ?? null,
        },
      })
      .catch(() => { /* fail-open — log sự kiện không bắt buộc */ })
  } catch {
    /* fail-open — tuyệt đối không làm hỏng flow gọi */
  }
}
