/**
 * EVO × GIAO THỨC QUAN SÁT (task 31-e — 2026-10-18)
 * ============================================================================
 *
 * Builder THUẦN cho payload + summary sự kiện quan sát của vòng evolve —
 * khép mục HyperNAS §9 (kinds `search.*` reserved từ OBS-P1, đến 31-e mới có
 * call-site đầu tiên; EVO-P4 phục vụ vai trò đó sau khi HN-P2 bị SUPERSEDED
 * — audit 31-a). Kind-name single-source: src/lib/observation/kinds.ts
 * (doctrine #9) — `search.session` + `search.candidate` (group 'search').
 *
 * `proposal.apply` CỐ TÌNH KHÔNG phát ở đây (31-e ngoài phạm vi): đường áp
 * dụng đề xuất sống trong client components (evolve-tab.tsx → brain-tab
 * applyEvoHiddenToDraft / deployEvoArchitecture) do main session sở hữu.
 *
 * Convention payload (theo precedent observeBrainTrain — kinds.ts không pin
 * payload từng kind, chuẩn của codebase là emitter tự ghi shape + field
 * `phase` phân giai đoạn cho cùng kind):
 *  - `search.session` phase 'start' lúc vòng bắt đầu · phase 'end' lúc
 *    done/failed/cancelled (kèm summary kết quả).
 *  - `search.candidate` mỗi ứng viên ĐÃ CHẤM hoặc BỎ CHẤM theo Q2
 *    (cvScore null khi bỏ chấm / lỗi chấm — trung thực, không giả 0).
 *
 * THUẦN — KHÔNG import ledger/db: evolve.ts tự bọc fail-open khi emit (lỗi
 * quan sát KHÔNG BAO GIỜ làm hỏng vòng evolve — RO-3); module này giữ thuần
 * để bun:test (r118) pin shape không đụng DB.
 *
 * Lưu ý FK: `ObserveEventInput.runId` là kim tuyến AgentRunRecord — runId của
 * EVO là id BrainSearchRun (không phải AgentRunRecord) nên KHÔNG đặt
 * evt.runId; runId evolve nằm trong payload + rowKey.
 */

// ==================== SESSION START ====================

// (type alias — KHÔNG interface — để assignable sang Record<string, unknown>
// của ObserveEventInput.payload: interface không có implicit index signature.)
export type EvoSessionStartPayload = {
  phase: 'start'
  brain: string
  /** id BrainSearchRun (không phải AgentRunRecord — xem header). */
  runId: string
  nCandidates: number
  seed: number
  budgetMs: number
}

/** Shape chung mỗi builder trả về — mỗi builder trả payload CHÍNH XÁC kiểu của nó (test truy cập field không cần narrowing). */
export interface EvoObsEvent<P> {
  /** 1 dòng tóm tắt hiển thị timeline (KHÔNG JSON — C.2 ledger). */
  summary: string
  payload: P
}

export function buildEvoSessionStart(input: {
  brain: string
  runId: string
  nCandidates: number
  seed: number
  budgetMs: number
}): EvoObsEvent<EvoSessionStartPayload> {
  const minutes = Math.round(input.budgetMs / 60_000)
  return {
    summary:
      `Tiến hoá ${input.brain} bắt đầu — ${input.nCandidates} ứng viên · seed ${input.seed} · ngân sách ${minutes} phút`,
    payload: {
      phase: 'start',
      brain: input.brain,
      runId: input.runId,
      nCandidates: input.nCandidates,
      seed: input.seed,
      budgetMs: input.budgetMs,
    },
  }
}

// ==================== CANDIDATE (CHẤM hoặc BỎ CHẤM Q2) ====================

export type EvoCandidatePayload = {
  brain: string
  runId: string
  idx: number
  /** Tóm tắt kiến trúc (formatArchSummary — single-source blocks.ts). */
  archSummary: string
  /** null khi BỎ CHẤM theo Q2 (candidate_budget_exceeded) hoặc lỗi chấm. */
  cvScore: number | null
  beatActive: boolean
  blockedH7: boolean
  moeSkipped: boolean
  /** true = bỏ chấm theo Q2 (vượt ngân sách wall trước khi train). */
  abandoned: boolean
  /** null khi bỏ chấm / lỗi (không đo được). */
  params: number | null
  p95LatencyMs: number | null
  note?: string
}

export function buildEvoCandidate(input: {
  brain: string
  runId: string
  idx: number
  archSummary: string
  cvScore: number | null
  beatActive: boolean
  blockedH7: boolean
  moeSkipped: boolean
  abandoned: boolean
  params: number | null
  p95LatencyMs: number | null
  note?: string
}): EvoObsEvent<EvoCandidatePayload> {
  const cv =
    input.cvScore === null
      ? null
      : Math.round(input.cvScore * 1000) / 1000 // 3 chữ số lẻ — timeline ngắn gọn
  const tail =
    input.cvScore === null
      ? input.abandoned
        ? 'BỎ CHẤM (vượt ngân sách Q2)'
        : 'lỗi chấm'
      : `CV ${cv?.toFixed(3)}${input.beatActive ? ' · thắng active' : ''}${input.blockedH7 ? ' · chặn H7' : ''}`
  return {
    summary: `Ứng viên #${input.idx} (${input.brain}) — ${input.archSummary} · ${tail}`,
    payload: {
      brain: input.brain,
      runId: input.runId,
      idx: input.idx,
      archSummary: input.archSummary,
      cvScore: input.cvScore,
      beatActive: input.beatActive,
      blockedH7: input.blockedH7,
      moeSkipped: input.moeSkipped,
      abandoned: input.abandoned,
      params: input.params,
      p95LatencyMs: input.p95LatencyMs,
      ...(input.note ? { note: input.note } : {}),
    },
  }
}

// ==================== SESSION END (done / failed / cancelled) ====================

export type EvoSessionEndPayload = {
  phase: 'end'
  brain: string
  runId: string
  status: 'done' | 'failed' | 'cancelled'
  candidatesMax: number
  /** Số ứng viên có điểm thật. */
  nScored: number
  /** Số ứng viên bỏ chấm theo Q2 (candidate_budget_exceeded). */
  nAbandoned: number
  bestCandidateIdx: number | null
  nBeatActive: number
  nBlockedH7: number
  durationMs: number
  note?: string
}

// ==================== SESSION SWEPT (OBS-V3 H4b — R34) ====================

/**
 * Sweep mồ côi trên GET (evolve.ts — heartbeat stale > 60s đánh failed).
 * Trước R34 sweep im lặng: DB đổi status nhưng timeline KHÔNG có sự kiện
 * end → trợ lý vận hành không thấy "worker chết (restart?)". Payload tự
 * khai swept:true phân biệt với end thường của vòng chạy.
 */
export type EvoSessionSweptPayload = {
  phase: 'end'
  swept: true
  brain: string
  runId: string
  status: 'failed'
  staleMinutes: number
  reason: string
}

export function buildEvoSessionSwept(input: {
  brain: string
  runId: string
  staleMs: number
}): EvoObsEvent<EvoSessionSweptPayload> {
  const staleMinutes = Math.max(1, Math.round(input.staleMs / 60_000))
  return {
    summary:
      `Tiến hoá ${input.brain} session ${input.runId.slice(0, 8)} bị SWEEP đóng sổ` +
      ` — heartbeat stale ${staleMinutes} phút (worker chết/restart?) → đánh dấu failed`,
    payload: {
      phase: 'end',
      swept: true,
      brain: input.brain,
      runId: input.runId,
      status: 'failed',
      staleMinutes,
      reason: 'sweep heartbeat stale > 60s (HN §4.2-2b) — GET state phát hiện session mồ côi',
    },
  }
}

export function buildEvoSessionEnd(input: {
  brain: string
  runId: string
  status: EvoSessionEndPayload['status']
  candidatesMax: number
  nScored: number
  nAbandoned: number
  bestCandidateIdx: number | null
  nBeatActive: number
  nBlockedH7: number
  durationMs: number
  note?: string
}): EvoObsEvent<EvoSessionEndPayload> {
  const statusVi =
    input.status === 'done' ? 'xong' : input.status === 'cancelled' ? 'đã dừng' : 'LỖI'
  const seconds = Math.round(input.durationMs / 1000)
  return {
    summary:
      `Tiến hoá ${input.brain} ${statusVi} — ${input.nScored}/${input.candidatesMax} chấm` +
      (input.nAbandoned > 0 ? ` · ${input.nAbandoned} bỏ (Q2)` : '') +
      ` · ${seconds}s` +
      (input.note ? ` · ${input.note}` : ''),
    payload: {
      phase: 'end',
      brain: input.brain,
      runId: input.runId,
      status: input.status,
      candidatesMax: input.candidatesMax,
      nScored: input.nScored,
      nAbandoned: input.nAbandoned,
      bestCandidateIdx: input.bestCandidateIdx,
      nBeatActive: input.nBeatActive,
      nBlockedH7: input.nBlockedH7,
      durationMs: input.durationMs,
      ...(input.note ? { note: input.note } : {}),
    },
  }
}
