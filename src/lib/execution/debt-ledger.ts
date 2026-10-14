// ============================================
// DEBT LEDGER — R13 (vòng đời nợ khép kín, 2026-10-31)
// ============================================
//
// BỐI CẢNH (user chẩn đoán sau R12 — nguyên văn): "Việc phát sinh nợ kỹ thuật
// giữa tác vụ, chu kỳ khiến agent chạy đi xử lý thật ra không sai nhưng vấn đề
// là thiếu sót trong cách triển khai khiến cho nợ chỉ có thêm mà không giảm,
// tìm ra vấn đề và giải quyết nhưng không giải quyết được, đây mới là vấn đề."
//
// CHẨN ĐOÁN 4 NGUYÊN NHÂN (bằng chứng DB 2026-10-31):
//   N1 — NỢ CHẾT THEO SESSION: buildPendingDebtBlock chỉ nhặt Todo follow-up
//        trong CÙNG sessionId → session mới không bao giờ thừa kế nợ cũ
//        (bằng chứng: ~12 todo pending session 3cqdwr từ 28/9, ~10 todo
//        session 'default' 14/10 — zombie vĩnh viễn; 3 nợ được đóng duy nhất
//        đều trong cùng session ejzmer).
//   N2 — KHÔNG DEDUPE XUYÊN RUN: cùng 1 lỗi gốc ghi thành nhiều row (dedupe
//        R12 chỉ trong 1 run) → tăng trưởng ảo.
//   N3 — KHÔNG VÒNG ĐÓNG: không đếm attempts, không có trạng thái parked →
//        agent lặp "tìm ra nhưng không giải quyết được" mãi, đốt chu kỳ.
//   N4 — KHÔNG ĐO LƯỜNG: không ai biết tổng nợ mở/đã đóng/tỷ lệ giải quyết.
//
// GIẢI PHÁP — SỔ NỢ THỐNG NHẤT DebtLedger (model Prisma R13):
//   GHI  : mọi nơi ghi Todo follow-up → upsert theo fingerprint (N2): lỗi
//          cũ → recurrenceCount++/lastSeenAt; resolved mà tái phát → reopen.
//   NHẶT : đầu run — (a) nợ same-session (Todo, như cũ) + (b) nợ GLOBAL open
//          từ session khác (N1) tạo Todo mirror trong session hiện tại để
//          agent đóng được bằng id + CI-2 auto-complete hoạt động.
//   ĐÓNG : cuối run — debt được pickup mà (todo mirror completed) VÀ (trọng
//          tài KHÔNG re-list trong unresolvedDebt) → resolved + bằng chứng.
//   PARK : attempts ≥ DEBT_MAX_PICKUP_ATTEMPTS mà vẫn unresolved → parked
//          + parkReason (N3) — DỪNG thử vô ích, chờ thầy/user quyết định
//          (cấp điều kiện → reopen, hoặc wont_fix). Parked không vào pickup.
//   DỌN  : sweeper todo zombie (pending/in_progress 7 ngày không ai đụng →
//          archived) — giảm nợ ảo từ session chết (N1 phần đuôi).
//   ĐO   : summary counts mọi lúc (boot log + final report + API) (N4).
//
// Kill-switch: DEBT_LEDGER=0 → mọi hàm no-op, hành vi y hệt trước R13
// (goal-loop vẫn chạy buildPendingDebtBlock same-session như cũ).
// Fail-open tuyệt đối: lỗi DebtLedger KHÔNG BAO GIỜ làm hỏng run chat.

/** Đọc 1 lần lúc module load (env hot-reload không ảnh hưởng giữa chừng run). */
const intEnv = (name: string, fallback: number): number => {
  const raw = (process.env[name] ?? '').trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

export const DEBT_LEDGER_ENABLED = (process.env.DEBT_LEDGER ?? '1').trim() !== '0'
/** Số lần pickup tối đa trước khi park (mỗi lần đầu run nhặt nợ = 1 lần thử). */
export const DEBT_MAX_PICKUP_ATTEMPTS = intEnv('DEBT_MAX_PICKUP_ATTEMPTS', 3)
/** Số nợ global (session khác) tối đa nhặt vào 1 run — tránh ngập việc mới. */
export const DEBT_GLOBAL_PICKUP_LIMIT = intEnv('DEBT_GLOBAL_PICKUP_LIMIT', 2)
/** Nợ global phải cũ tối thiểu X phút mới được nhặt (tránh giành run song song). */
export const DEBT_GLOBAL_MIN_AGE_MIN = intEnv('DEBT_GLOBAL_MIN_AGE_MIN', 30)
/** Todo không được đụng sau X ngày → zombie của session chết → archive. */
export const DEBT_SWEEP_STALE_DAYS = intEnv('DEBT_SWEEP_STALE_DAYS', 7)

/** Rate-limit sweeper: 1 lần/giờ tiến trình (globalThis sống qua HMR). */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000
const g = globalThis as unknown as { __debtSweepLastAt?: number }

// ---------------------------------------------------------------------------
// FINGERPRINT — chuẩn hóa nội dung lỗi thành key dedupe xuyên run
// ---------------------------------------------------------------------------

/**
 * Chuẩn hóa 1 chuỗi side-issue/nội dung Follow-up thành fingerprint ổn định:
 * bỏ prefix "🔁 Follow-up (...)", lowercase, bỏ runId/subId/cuid, đường dẫn
 * file, số đếm, timestamp — chỉ giữ "họ lỗi" (vd "lint fail file x" của 2 run
 * khác nhau vẫn chung fingerprint nếu cùng lỗi gốc).
 */
export function fingerprintDebtIssue(raw: string): string {
  let s = String(raw || '')
  // Bỏ prefix Follow-up (mọi biến thể R11/R12): "🔁 Follow-up (...): nội dung"
  s = s.replace(/^🔁\s*Follow-up[^:]*:\s*/i, '')
  s = s.replace(/^🔁\s*Follow-up\s*$/i, '')
  // Bỏ condSuffix " — điều kiện xử lý: ..." (R11 phiên 4) — phần gốc mới là lỗi
  s = s.replace(/\s*—\s*điều kiện xử lý:.*$/i, '')
  s = s.toLowerCase()
  // runId/subId/cuid (run_xxxxxxxx, sub_xxxxxxxx, cuid 25 ký tự)
  s = s.replace(/\b(run|sub|job)_[a-z0-9]{6,}\b/g, '$1_id')
  s = s.replace(/\b[cjmk]([a-z0-9]){20,}\b/g, 'cid')
  // Đường dẫn file/thư mục (giữ tên đuôi file làm đặc trưng — bỏ phần prefix)
  s = s.replace(/(?:\/|\\)[\w.\-]+(?:\/|\\)[\w.\-/\\]*/g, ' path ')
  // Timestamp ISO + số đếm độc lập (giữ số trong từ ghép như "410", "e500")
  s = s.replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(:\d{2})?/g, 'ts')
  // Số đếm nhỏ (1-2 chữ số: lần thử, index, version) → 'n' (run 1 ≡ run 99);
  // GIỮ số ≥3 chữ số (HTTP 410/403/500, exit code) — chúng là đặc trưng lỗi.
  s = s.replace(/\b\d{1,2}\b/g, 'n')
  // Whitespace
  s = s.replace(/\s+/g, ' ').trim()
  return s.slice(0, 160)
}

/** Tách title hiển thị từ nội dung Follow-up (bỏ prefix, giữ condSuffix). */
export function debtTitleFrom(raw: string): string {
  return String(raw || '').replace(/^🔁\s*Follow-up[^:]*:\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 300)
}

// ---------------------------------------------------------------------------
// GHI NỢ — recordDebtIssue (gọi tại MỌI nơi tạo Todo follow-up)
// ---------------------------------------------------------------------------

export interface RecordDebtParams {
  /** Side-issue gốc (chuỗi arbiter) HOẶC nội dung Follow-up đầy đủ. */
  issue: string
  kind: 'agent' | 'infra'
  sessionId?: string | null
  runId?: string | null
  /** Bằng chứng gốc (tool output/error) — tùy chọn. */
  evidence?: string
  /** Todo follow-up row id vừa tạo (truy vết nguồn). */
  todoId?: string
}

/**
 * Upsert DebtLedger theo fingerprint:
 * - chưa có → tạo open (originSession/Run, todoId, evidence)
 * - có & open/in_progress/parked → recurrenceCount++ + lastSeenAt (N2: KHÔNG
 *   tạo row mới; parked vẫn giữ nguyên — đã biết không giải quyết được, chỉ
 *   tăng recurrence báo hiệu hệ thống cho thầy nhìn)
 * - có & resolved → REOPEN: lỗi tái phát sau khi từng đóng (attempts=0,
 *   recurrenceCount++, resolvedAt=null) — nợ tái phát phải thấy được.
 * Kill-switch DEBT_LEDGER=0 → no-op. Fail-open tuyệt đối.
 */
export async function recordDebtIssue(params: RecordDebtParams): Promise<void> {
  if (!DEBT_LEDGER_ENABLED) return
  const title = debtTitleFrom(params.issue)
  const fp = fingerprintDebtIssue(params.issue)
  if (!fp || fp.length < 8) return // quá ngắn → không đủ đặc trưng, bỏ qua
  try {
    const { db } = await import('@/lib/db')
    const now = new Date()
    const existing = await db.debtLedger.findUnique({ where: { fingerprint: fp } })
    if (!existing) {
      await db.debtLedger.create({
        data: {
          fingerprint: fp,
          title,
          kind: params.kind,
          status: 'open',
          originSessionId: params.sessionId ?? null,
          originRunId: params.runId ?? null,
          todoId: params.todoId ?? null,
          evidence: params.evidence?.slice(0, 480) ?? null,
          openedAt: now,
          lastSeenAt: now,
        },
      })
      console.log(`[DebtLedger] GHI NỢ ${params.kind}: ${title.slice(0, 100)}`)
      return
    }
    if (existing.status === 'resolved') {
      await db.debtLedger.update({
        where: { id: existing.id },
        data: {
          status: 'open',
          attempts: 0,
          recurrenceCount: existing.recurrenceCount + 1,
          lastSeenAt: now,
          resolvedAt: null,
          resolvedByRunId: null,
          resolutionEvidence: `REOPEN: tái phát sau khi resolved lúc ${existing.resolvedAt?.toISOString().slice(0, 16) ?? '?'} — run ${params.runId ?? '?'}`,
          parkReason: null,
        },
      })
      console.log(`[DebtLedger] NỢ TÁI PHÁT (reopen, recurrence=${existing.recurrenceCount + 1}): ${title.slice(0, 100)}`)
      return
    }
    // open / in_progress / parked → bump recurrence + lastSeenAt
    await db.debtLedger.update({
      where: { id: existing.id },
      data: { lastSeenAt: now, recurrenceCount: existing.recurrenceCount + 1 },
    })
  } catch (err) {
    // Fail-open — sổ nợ không được phép làm hỏng flow ghi nợ gốc
    console.warn(`[DebtLedger] recordDebtIssue fail-open: ${err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120)}`)
  }
}

// ---------------------------------------------------------------------------
// NHẶT NỢ ĐẦU RUN — pickupDebtForRun (same-session + GLOBAL xuyên session)
// ---------------------------------------------------------------------------

export interface PickedDebt {
  debtLedgerId: string
  fingerprint: string
  title: string
  /** Todo mirror row trong session hiện tại (agent đóng bằng id này). */
  mirrorTodoId: string
  origin: 'session' | 'global'
}

export interface DebtPickupResult {
  /** Directive block chèn trước user message ('' = không có nợ). */
  directiveBlock: string
  /** Các debt đã đánh dấu in_progress cho run này (finalize đối chiếu). */
  picked: PickedDebt[]
  /** Tổng nợ open+in_progress TRƯỚC run (đo hiệu quả N4). */
  openCountBefore: number
}

/**
 * Đầu mỗi run mới (không resume): nhặt nợ để ưu tiên xử lý.
 * (a) Same-session: Todo follow-up pending/in_progress/blocked — GIỮ NGUYÊN
 *     logic buildPendingDebtBlock (format directive cũ, agent đã quen) —
 *     thêm đánh dấu DebtLedger in_progress + attempts++.
 * (b) Global (N1 — fix chính): DebtLedger status=open (hoặc in_progress kẹt
 *     từ run chết, cũ hơn DEBT_GLOBAL_MIN_AGE_MIN) từ session KHÁC → tạo Todo
 *     mirror trong session hiện tại (taskMetaJson debtLedgerId + globalPickup)
 *     → agent nhìn thấy id, todo_write update-by-id hoạt động xuyên run,
 *     CI-2 auto-complete khớp theo run hiện tại.
 * Giới hạn: global tối đa DEBT_GLOBAL_PICKUP_LIMIT mục/run — không ngập việc mới.
 * Fail-open: lỗi bất kỳ → trả rỗng, run chat KHÔNG BAO GIỜ bị hỏng vì nợ.
 */
export async function pickupDebtForRun(params: {
  sessionId: string | null | undefined
  currentRunId: string | null
  agentName?: string
}): Promise<DebtPickupResult> {
  const empty: DebtPickupResult = { directiveBlock: '', picked: [], openCountBefore: 0 }
  if (!DEBT_LEDGER_ENABLED || !params.sessionId) return empty
  try {
    const { db } = await import('@/lib/db')
    const now = new Date()
    void maybeSweepStaleTodos()

    const picked: PickedDebt[] = []
    const blocks: string[] = []

    // ---- (a) Same-session Todo follow-up (giữ query buildPendingDebtBlock) ----
    const pending = await db.todo.findMany({
      where: {
        sessionId: params.sessionId,
        status: { in: ['pending', 'in_progress', 'blocked'] },
        content: { startsWith: '🔁 Follow-up' },
      },
      orderBy: { createdAt: 'asc' },
      take: 10,
    })
    const sameSession = pending.filter(t => t.runId !== params.currentRunId)
    if (sameSession.length > 0) {
      console.log(`[DebtLedger] NHẶT NỢ same-session: ${sameSession.length} mục từ các run trước trong session ${params.sessionId}`)
      // Đánh dấu DebtLedger tương ứng (nếu có row) — attempts++ mỗi lần nhặt
      for (const t of sameSession) {
        const fp = fingerprintDebtIssue(t.content)
        try {
          const row = await db.debtLedger.findUnique({ where: { fingerprint: fp } })
          if (row && row.status !== 'resolved' && row.status !== 'parked') {
            await db.debtLedger.update({
              where: { id: row.id },
              data: { status: 'in_progress', attempts: row.attempts + 1, lastAttemptRunId: params.currentRunId, lastAttemptAt: now },
            })
            picked.push({ debtLedgerId: row.id, fingerprint: fp, title: row.title, mirrorTodoId: t.id, origin: 'session' })
          } else if (row) {
            // Debt parked/resolved nhưng Todo same-session vẫn mở — vẫn đưa cho
            // agent (format cũ) nhưng KHÔNG đếm attempt (parked đã hết lượt thử).
            picked.push({ debtLedgerId: row.id, fingerprint: fp, title: row.title, mirrorTodoId: t.id, origin: 'session' })
          }
        } catch { /* từng item fail-open */ }
      }
      const lines = sameSession.map(t => `- [id ${t.id}] ${t.content.replace(/^🔁 Follow-up \([^)]*\):\s*/, '')}`)
      blocks.push(`[📋 NỢ KỸ THUẬT CÒN TREO TRONG PHIÊN NÀY — ƯU TIÊN XỬ LÝ TRƯỚC VIỆC MỚI (user directive 2026-10-27)
Các run trước trong phiên còn ${sameSession.length} nợ chưa xử lý. Thứ tự:
1. XỬ LÝ nợ dưới đây TRƯỚC TIÊN (đưa vào todo_write kế hoạch, đặt TRƯỚC việc mới).
2. Xử lý xong mục nào → todo_write với ĐÚNG "id" + status "completed" (kèm bằng chứng verify) — KHÔNG tạo row trùng.
3. Mục ngoài quyền sửa → đã thử đủ đường tự phục vụ (manage_packages, sửa schema + db:push, create_custom_tool, dispatch_agent, escalate_problem) chưa? Thử hết rồi mới nêu "chờ phê duyệt" + ĐIỀU KIỆN CẦN.
${lines.join('\n')}`)
    }

    // ---- (b) Global cross-session pickup (N1 — vòng đời khép kín xuyên session) ----
    if (DEBT_GLOBAL_PICKUP_LIMIT > 0) {
      const minAgeMs = Math.max(0, DEBT_GLOBAL_MIN_AGE_MIN) * 60 * 1000
      const staleBefore = new Date(now.getTime() - minAgeMs)
      const sameFps = new Set(sameSession.map(t => fingerprintDebtIssue(t.content)))
      const globals = await db.debtLedger.findMany({
        where: {
          status: 'open',
          originSessionId: { not: params.sessionId },
          lastSeenAt: { lte: staleBefore },
        },
        orderBy: [{ lastSeenAt: 'asc' }],
        take: DEBT_GLOBAL_PICKUP_LIMIT * 2, // lọc thêm sau (bỏ fp trùng same-session)
      })
      const globalDebts = globals.filter(d => !sameFps.has(d.fingerprint)).slice(0, DEBT_GLOBAL_PICKUP_LIMIT)
      // Đón quyền nợ in_progress kẹt từ run chết (không finalize được — crash)
      if (globalDebts.length < DEBT_GLOBAL_PICKUP_LIMIT) {
        const stuck = await db.debtLedger.findMany({
          where: {
            status: 'in_progress',
            lastAttemptRunId: { not: params.currentRunId ?? '' },
            lastAttemptAt: { lte: staleBefore },
          },
          orderBy: [{ lastAttemptAt: 'asc' }],
          take: DEBT_GLOBAL_PICKUP_LIMIT - globalDebts.length,
        })
        for (const d of stuck) if (!globalDebts.some(x => x.id === d.id) && !sameFps.has(d.fingerprint)) globalDebts.push(d)
      }
      if (globalDebts.length > 0) {
        console.log(`[DebtLedger] NHẶT NỢ GLOBAL xuyên session: ${globalDebts.length} mục (nguồn session khác / run chết) → tạo mirror Todo trong session hiện tại`)
        const gLines: string[] = []
        for (const d of globalDebts) {
          // Tạo mirror Todo trong session hiện tại — agent đóng được bằng id,
          // CI-2 auto-complete khớp theo (sessionId, runId) hiện tại.
          const mirror = await db.todo.create({
            data: {
              sessionId: params.sessionId,
              content: `🔁 Follow-up (nợ kỹ thuật toàn hệ thống #${d.id.slice(-6)} — nguồn session khác): ${d.title}`.slice(0, 480),
              status: 'pending',
              priority: 'high',
              ...(params.currentRunId ? { runId: params.currentRunId } : {}),
              taskMetaJson: JSON.stringify({ source: 'arbiter_side_issue', debtLedgerId: d.id, globalPickup: true }),
            },
          }).catch(() => null)
          if (!mirror) continue
          await db.debtLedger.update({
            where: { id: d.id },
            data: { status: 'in_progress', attempts: d.attempts + 1, lastAttemptRunId: params.currentRunId, lastAttemptAt: now },
          }).catch(() => { /* item fail-open */ })
          picked.push({ debtLedgerId: d.id, fingerprint: d.fingerprint, title: d.title, mirrorTodoId: mirror.id, origin: 'global' })
          gLines.push(`- [id ${mirror.id}] ${d.title}`)
        }
        if (gLines.length > 0) {
          blocks.push(`[🌍 NỢ KỸ THUẬT TOÀN HỆ THỐNG CÒN TREO (DebtLedger R13 — các phiên trước để lại, KHÔNG session nào nhặt được tới giờ)
Hệ thống còn ${gLines.length} nợ cũ (đã ghi sổ DebtLedger, nguồn session khác). Xử lý sau nợ phiên này (nếu có) và trước việc mới — trừ khi việc hiện tại khẩn:
1. Mỗi mục là 1 todo mirror [id ...] trong phiên — xử lý xong → todo_write ĐÚNG id + status "completed" kèm bằng chứng verify (chạy lại lệnh kiểm tra / đọc lại file).
2. Nợ đã thử ${DEBT_MAX_PICKUP_ATTEMPTS} lần mà không giải quyết được sẽ được PARK (dừng thử) — nếu biết điều kiện thiếu (quyền, phê duyệt, package...) → nêu RÕ trong báo cáo thay vì thử lại.
${gLines.join('\n')}`)
        }
      }
    }

    const openCountBefore = await db.debtLedger.count({ where: { status: { in: ['open', 'in_progress'] } } }).catch(() => 0)
    return {
      directiveBlock: blocks.length > 0 ? `\n${blocks.join('\n\n')}` : '',
      picked,
      openCountBefore,
    }
  } catch (err) {
    console.warn(`[DebtLedger] pickupDebtForRun fail-open: ${err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120)}`)
    return empty
  }
}

// ---------------------------------------------------------------------------
// SWEEPER — dọn todo zombie của session chết (rate-limit 1 lần/giờ)
// ---------------------------------------------------------------------------

/**
 * Todo pending/in_progress/blocked KHÔNG được đụng sau DEBT_SWEEP_STALE_DAYS
 * → session đó đã chết/bỏ rơi → archived (giữ trong DB, ẩn khỏi pickup —
 * nợ ảo không đếm nữa). KHÔNG đụng DebtLedger (nợ thật vẫn track riêng).
 */
async function maybeSweepStaleTodos(): Promise<void> {
  const last = g.__debtSweepLastAt ?? 0
  if (Date.now() - last < SWEEP_INTERVAL_MS) return
  g.__debtSweepLastAt = Date.now()
  try {
    const { db } = await import('@/lib/db')
    const cutoff = new Date(Date.now() - Math.max(1, DEBT_SWEEP_STALE_DAYS) * 24 * 60 * 60 * 1000)
    const res = await db.todo.updateMany({
      where: { status: { in: ['pending', 'in_progress', 'blocked'] }, updatedAt: { lt: cutoff } },
      data: { status: 'archived', archivedAt: new Date() },
    })
    if (res.count > 0) console.log(`[DebtLedger] SWEEPER: archived ${res.count} todo zombie (không được đụng > ${DEBT_SWEEP_STALE_DAYS} ngày — session chết)`)
  } catch { /* fail-open */ }
}

// ---------------------------------------------------------------------------
// ĐÓNG NỢ CUỐI RUN — finalizeDebtAfterRun
// ---------------------------------------------------------------------------

export interface DebtFinalizeSummary {
  /** Số nợ ĐÃ GIẢI QUYẾT trong run này (todo mirror completed + không re-list). */
  resolved: number
  /** Số nợ run này thử nhưng vẫn chưa xong (giữ open). */
  stillOpen: number
  /** Số nợ VƯỢT ngưỡng attempts → parked (dừng thử, chờ điều kiện). */
  parked: number
  /** Tổng nợ open+in_progress SAU run (đo hiệu quả N4). */
  openCountAfter: number
  resolvedTitles: string[]
  parkedTitles: string[]
}

/**
 * Cuối run: đối chiếu từng debt được pickup (lastAttemptRunId = run này):
 *   - fingerprint KHÔNG nằm trong unresolvedDebtTexts (trọng tài không re-list)
 *     VÀ Todo mirror completed → RESOLVED (+ bằng chứng: verdict + todo).
 *   - còn nằm trong unresolved (re-list) hoặc mirror chưa đóng → vẫn open;
 *     attempts ≥ DEBT_MAX_PICKUP_ATTEMPTS → PARKED + parkReason (N3).
 * Trả summary để final report + log hiển thị (N4). Fail-open tuyệt đối.
 */
export async function finalizeDebtAfterRun(params: {
  runId: string | null
  sessionId: string | null
  unresolvedDebtTexts: string[]
  agentName?: string
  cyclesAttempted?: number
}): Promise<DebtFinalizeSummary> {
  const empty: DebtFinalizeSummary = { resolved: 0, stillOpen: 0, parked: 0, openCountAfter: 0, resolvedTitles: [], parkedTitles: [] }
  if (!DEBT_LEDGER_ENABLED || !params.runId) return empty
  try {
    const { db } = await import('@/lib/db')
    const now = new Date()
    const unresolvedFps = new Set(params.unresolvedDebtTexts.map(t => fingerprintDebtIssue(t)))
    const mine = await db.debtLedger.findMany({ where: { lastAttemptRunId: params.runId } })
    const summary: DebtFinalizeSummary = { ...empty }
    for (const d of mine) {
      if (d.status === 'resolved' || d.status === 'parked') continue // đã xong ở bước khác
      // Tìm mirror Todo (session hiện tại, taskMeta debtLedgerId) hoặc Todo gốc
      let mirrorStatus: string | null = null
      const mirror = await db.todo.findFirst({
        where: { sessionId: params.sessionId ?? undefined, taskMetaJson: { contains: d.id } },
        orderBy: { createdAt: 'desc' },
      }).catch(() => null)
      if (mirror) mirrorStatus = mirror.status
      const isRelisted = unresolvedFps.has(d.fingerprint)
      const resolvedNow = !isRelisted && mirrorStatus === 'completed'
      if (resolvedNow) {
        await db.debtLedger.update({
          where: { id: d.id },
          data: {
            status: 'resolved',
            resolvedAt: now,
            resolvedByRunId: params.runId,
            resolutionEvidence: `Run ${params.runId} (${params.agentName ?? 'agent'}, ${params.cyclesAttempted ?? '?'} chu kỳ): todo mirror ${mirror?.id.slice(-8)} completed + trọng tài KHÔNG re-list trong verdict cuối`,
          },
        }).catch(() => { /* item fail-open */ })
        summary.resolved++
        summary.resolvedTitles.push(d.title.slice(0, 90))
        console.log(`[DebtLedger] ✅ ĐÓNG NỢ (lần thử ${d.attempts}): ${d.title.slice(0, 100)}`)
      } else if (d.attempts >= DEBT_MAX_PICKUP_ATTEMPTS) {
        await db.debtLedger.update({
          where: { id: d.id },
          data: {
            status: 'parked',
            parkReason: `đã thử ${d.attempts} lần (≥ ${DEBT_MAX_PICKUP_ATTEMPTS}) không giải quyết được${isRelisted ? ' — vẫn bị re-list' : ' — chưa có bằng chứng verify'} → chờ điều kiện/thầy quyết định (reopen khi đủ điều kiện, hoặc wont_fix)`,
          },
        }).catch(() => { /* item fail-open */ })
        // Mirror todo còn mở → 'failed' (không được same-session pickup lặp —
        // status failed không nằm trong pending/in_progress/blocked)
        if (mirror && ['pending', 'in_progress', 'blocked'].includes(mirror.status)) {
          await db.todo.update({ where: { id: mirror.id }, data: { status: 'failed' } }).catch(() => { /* fail-open */ })
        }
        summary.parked++
        summary.parkedTitles.push(d.title.slice(0, 90))
        console.log(`[DebtLedger] 🅿️ PARK NỢ (đã thử ${d.attempts} lần, dừng thử — chờ điều kiện): ${d.title.slice(0, 100)}`)
      } else {
        // Vẫn open — lần sau tiếp tục (attempts đã ++ lúc pickup)
        await db.debtLedger.update({
          where: { id: d.id },
          data: { status: 'open' },
        }).catch(() => { /* item fail-open */ })
        summary.stillOpen++
      }
    }
    summary.openCountAfter = await db.debtLedger.count({ where: { status: { in: ['open', 'in_progress'] } } }).catch(() => 0)
    if (summary.resolved + summary.parked + summary.stillOpen > 0) {
      console.log(`[DebtLedger] FINALIZE run ${params.runId.slice(-8)}: resolved=${summary.resolved} stillOpen=${summary.stillOpen} parked=${summary.parked} → tổng nợ mở ${summary.openCountAfter}`)
    }
    return summary
  } catch (err) {
    console.warn(`[DebtLedger] finalizeDebtAfterRun fail-open: ${err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120)}`)
    return empty
  }
}

// ---------------------------------------------------------------------------
// SUMMARY — đo lường (boot log / API / final report)
// ---------------------------------------------------------------------------

export interface DebtLedgerSummary {
  counts: Record<string, number>
  open: Array<{ id: string; title: string; kind: string; attempts: number; recurrenceCount: number; lastSeenAt: string; originSessionId: string | null }>
  parked: Array<{ id: string; title: string; kind: string; attempts: number; parkReason: string | null; lastSeenAt: string }>
  recentResolved: Array<{ id: string; title: string; resolvedAt: string; resolvedByRunId: string | null; attempts: number }>
}

export async function getDebtLedgerSummary(): Promise<DebtLedgerSummary> {
  const out: DebtLedgerSummary = { counts: {}, open: [], parked: [], recentResolved: [] }
  try {
    const { db } = await import('@/lib/db')
    const grouped = await db.debtLedger.groupBy({ by: ['status'], _count: { _all: true } })
    for (const r of grouped) out.counts[r.status] = r._count._all
    const [open, parked, resolved] = await Promise.all([
      db.debtLedger.findMany({ where: { status: { in: ['open', 'in_progress'] } }, orderBy: { lastSeenAt: 'desc' }, take: 20 }),
      db.debtLedger.findMany({ where: { status: 'parked' }, orderBy: { lastSeenAt: 'desc' }, take: 20 }),
      db.debtLedger.findMany({ where: { status: 'resolved' }, orderBy: { resolvedAt: 'desc' }, take: 10 }),
    ])
    out.open = open.map(d => ({ id: d.id, title: d.title, kind: d.kind, attempts: d.attempts, recurrenceCount: d.recurrenceCount, lastSeenAt: d.lastSeenAt.toISOString(), originSessionId: d.originSessionId }))
    out.parked = parked.map(d => ({ id: d.id, title: d.title, kind: d.kind, attempts: d.attempts, parkReason: d.parkReason, lastSeenAt: d.lastSeenAt.toISOString() }))
    out.recentResolved = resolved.map(d => ({ id: d.id, title: d.title, resolvedAt: (d.resolvedAt ?? d.lastSeenAt).toISOString(), resolvedByRunId: d.resolvedByRunId, attempts: d.attempts }))
  } catch { /* fail-open — trả phần đã có */ }
  return out
}

// Boot log phanh hiệu dụng 1 dòng (mirror F-R12-3 — mọi phanh phải hiện diện)
if (DEBT_LEDGER_ENABLED) {
  console.log(
    `[DebtLedger] Phanh hiệu dụng (R13): maxAttempts=${DEBT_MAX_PICKUP_ATTEMPTS} (park) globalPickup=${DEBT_GLOBAL_PICKUP_LIMIT}/run (age≥${DEBT_GLOBAL_MIN_AGE_MIN}') sweepStale=${DEBT_SWEEP_STALE_DAYS}ngày`
  )
  // Fire-and-forget: in hiện trạng sổ nợ lúc boot (fail-open im lặng)
  void getDebtLedgerSummary().then(s => {
    if (Object.keys(s.counts).length > 0) {
      const c = s.counts
      console.log(`[DebtLedger] Hiện trạng sổ nợ: open=${c.open ?? 0} in_progress=${c.in_progress ?? 0} resolved=${c.resolved ?? 0} parked=${c.parked ?? 0}`)
    }
  }).catch(() => { /* im lặng */ })
}
