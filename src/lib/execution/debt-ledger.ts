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
// Kill-switch: DEBT_LEDGER=0 → sổ cái no-op, goal-loop vẫn nhặt nợ same-session
// (legacy block — buildLegacyPendingDebtBlock; global pickup TẮT cùng sổ cái
// vì cần bảng DebtLedger — R15-R1-05 auditor đính chính "+ global" sai).
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
  // FB-R13DEBT-R1-07: số đếm nhỏ (1-2 chữ số: lần thử, index, version, exit
  // code 1-2 chữ số) → 'n' (run 1 ≡ run 99); GIỮ nguyên run ≥3 chữ số (HTTP
  // 410/403/500, exit code 3+ chữ số) — đặc trưng lỗi. Match theo RUN chữ số
  // (\d+) rồi chấm độ dài — thay cho \b\d{1,2}\b cũ: \b ASCII không bắt
  // được số dính chữ unicode ("lỗi12lần" giữ "12" trong khi "lỗi 12 lần" → 'n'
  // — 2 văn phong khác nhau của cùng lỗi bị tách oan). Run-approach bắt cả 2.
  // ' n ' có space padding 2 bên: "lỗi12lần" → "lỗi n lần" ≡ "lỗi 12 lần"
  // (nếu thay bằng 'n' không space: "lỗinlần" ≠ "lỗi n lần" — lệch spacing).
  s = s.replace(/\d+/g, (run) => (run.length >= 3 ? run : ' n '))
  // Whitespace
  s = s.replace(/\s+/g, ' ').trim()
  // FB-R13DEBT-R1-07: KHÔNG cắt 160 ký tự — 2 issue chỉ khác nhau SAU ký tự
  // 160 sẽ trùng fingerprint → false-dedupe (recurrence đếm nhầm sang nợ khác).
  // Full-length: SQLite TEXT không giới hạn, unique constraint vẫn hoạt động.
  return s
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
 *
 * SEVERITY (R15 — hết "cột chết" ghi nhận R13): suy từ dữ liệu thật —
 *   'high' khi kind='infra' (agent không tự phục vụ được — thầy phải nhìn)
 *   HOẶC tái phát ≥ 2 lần (vấn đề dai dẳng, không phải ngẫu nhiên một lần);
 *   còn lại 'medium'. Định nghĩa hẹp có thể kiểm chứng, không gán bừa.
 * Kill-switch DEBT_LEDGER=0 → no-op. Fail-open tuyệt đối.
 */
function deriveDebtSeverity(kind: 'agent' | 'infra', recurrenceCount: number): 'high' | 'medium' {
  if (kind === 'infra') return 'high'
  if (recurrenceCount >= 2) return 'high'
  return 'medium'
}

/**
 * Ghi nợ vào sổ cái (gọi tại MỌI nơi tạo Todo follow-up).
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
          severity: deriveDebtSeverity(params.kind, 0),
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
      const nextRecurrence = existing.recurrenceCount + 1
      await db.debtLedger.update({
        where: { id: existing.id },
        data: {
          status: 'open',
          attempts: 0,
          recurrenceCount: { increment: 1 },
          severity: deriveDebtSeverity(existing.kind === 'infra' ? 'infra' : 'agent', nextRecurrence),
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
    // FB-R13DEBT-R1-05: increment phía DB (2 run song song ghi cùng debt —
    // read-then-write cũ mất update: 0→1 thay vì 0→2).
    // R15-R1-04 (auditor): re-derive severity theo recurrence MỚI — nợ chưa
    // từng resolved nhưng tái xuất hiện ≥2 lần (mỗi lần recordDebtIssue nhánh
    // bump) cũng phải lên 'high' đúng docblock "tái phát ≥ 2 lần" (trước đây
    // chỉ create/reopen derive → bump mãi 'medium' — badge UI không bao giờ hiện).
    const nextRecurrenceBump = existing.recurrenceCount + 1
    await db.debtLedger.update({
      where: { id: existing.id },
      data: { lastSeenAt: now, recurrenceCount: { increment: 1 }, severity: deriveDebtSeverity(existing.kind === 'infra' ? 'infra' : 'agent', nextRecurrenceBump) },
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
 * FORMAT KHỐI DIRECTIVE NỢ — ĐÚNG 1 NGUỒN cho MỌI đường (R15-R1-01 auditor:
 * trước đây production path (a) dựng inline riêng thiếu mục 4 + vùng bảo vệ
 * trong khi fallback đủ 4 mục — "1 nguồn" chưa trọn; nghịch lý chế độ
 * kill-switch hiếm khi ĐẦY ĐỦ hơn chế độ chính). 4 mục nguyên văn bản gốc
 * user directive 2026-10-27:
 *   1-2. ưu tiên xử lý nợ trước việc mới + đóng đúng id
 *   3. vùng bảo vệ + checklist tự phục vụ + ĐIỀU KIỆN CẦN
 *   4. hết nợ mới làm việc mới
 * Caller: buildLegacyPendingDebtBlock (kill-switch + tests) VÀ
 * pickupDebtForRun path (a) (production — danh sách actionable đã lọc
 * parked/resolved theo DebtLedger). Fail-open không áp dụng đây (thuần format).
 */
function formatDebtDirectiveBlock(debts: Array<{ id: string; content: string }>, note?: string): string {
  const lines = debts.map(t => `- [id ${t.id}] ${t.content.replace(/^🔁 Follow-up \([^)]*\):\s*/, '')}`)
  return `[📋 NỢ KỸ THUẬT CÒN TREO — ƯU TIÊN XỬ LÝ TRƯỚC VIỆC MỚI (user directive 2026-10-27${note ? `; ${note}` : ''})]
Các run trước trong phiên này còn ${debts.length} nợ kỹ thuật chưa xử lý (trọng tài đã ghi Todo follow-up). Thứ tự ưu tiên SẮT của run này:
1. XỬ LÝ TOÀN BỘ nợ dưới đây TRƯỚC TIÊN (đưa từng mục vào todo_write kế hoạch, đặt TRƯỚC các việc mới).
2. Xử lý xong mục nào → gọi todo_write với ĐÚNG "id" của mục đó + status "completed" (đóng row cũ — KHÔNG tạo row trùng nội dung).
3. Mục nào vẫn nằm ngoài quyền sửa (phần hạ tầng VẪN ĐƯỢC BẢO VỆ: .env/keys, file data db/, opencode.json, .opencode/, mini-services/ — hoặc chờ phê duyệt / vendor bên thứ 3) → trước khi kết luận ngoài quyền, HÃY KIỂM TRA đã thử đủ đường tự phục vụ chưa: cài package (manage_packages), sửa schema (file_edit prisma/schema.prisma + bun run db:push), tự xây tool thiếu (create_custom_tool), gọi agent đúng chức trách (dispatch_agent), escalate Omega tạo agent mới (escalate_problem). Chỉ khi THẬT SỰ thiếu điều kiện ngoài tầm với → nêu rõ trạng thái + ĐIỀU KIỆN CẦN trong báo cáo, KHÔNG xóa bỏ.
4. Hết nợ mới làm việc mới của yêu cầu hiện tại.
${lines.join('\n')}`
}

/**
 * Build khối nợ LEGACY same-session (P-R13-1 — R15 dồn về 1 hàm).
 * Lịch sử: đây CHÍNH LÀ buildPendingDebtBlock cũ của agent-goal-loop.ts
 * (user directive 2026-10-27 — thời điểm xử lý nợ = đầu run mới trong cùng
 * session) — R13 chuyển production path sang pickupDebtForRun (thêm
 * DebtLedger + global pickup) nhưng để lại bản gốc làm dead-code chỉ vì 2
 * file test import. R15: dồn về HÀM DUY NHẤT này trong debt-ledger (nơi logic
 * nợ sống); agent-goal-loop + tests cùng dùng một nguồn.
 *
 * ĐỦ 4 MỤC nguyên văn bản gốc (BUG2-253 — biên bản R14 vòng R3 ghi "đã fix"
 * nhưng code commit THỰC TẾ vẫn thiếu mục 3-4 ở fallback kill-switch; phát
 * hiện lại khi dồn hàm R15 — giờ 1 nguồn duy nhất nên không thể lệch).
 *
 * @param note ghi chú thêm vào header (kill-switch truyền 'sổ cái DebtLedger
 *        OFF — chế độ legacy' để agent biết đang chạy mode nào)
 * Fail-open tuyệt đối: lỗi bất kỳ → '' (nợ không được phép làm hỏng run mới).
 */
export async function buildLegacyPendingDebtBlock(
  sessionId: string | null | undefined,
  currentRunId: string | null,
  note?: string,
): Promise<string> {
  if (!sessionId) return ''
  try {
    const { db } = await import('@/lib/db')
    const pending = await db.todo.findMany({
      where: {
        sessionId,
        // nhặt cả nợ đang 'in_progress'/'blocked' — run trước chết giữa lúc
        // xử lý nợ thì nợ kẹt ở trạng thái đó, không được bỏ lại ngủ vĩnh viễn
        status: { in: ['pending', 'in_progress', 'blocked'] },
        content: { startsWith: '🔁 Follow-up' },
      },
      orderBy: { createdAt: 'asc' },
      take: 10,
    })
    // Chỉ nợ từ các run KHÁC (run hiện tại chưa tồn tại nợ — filter JS cho
    // an toàn với runId null của data cũ)
    const debt = pending.filter(t => t.runId !== currentRunId)
    if (debt.length === 0) return ''
    console.log(`[DebtLedger] NỢ KỸ THUẬT (legacy block): nhặt ${debt.length} Todo follow-up còn treo từ các run trước trong session ${sessionId} → ưu tiên xử lý đầu run`)
    return formatDebtDirectiveBlock(debt, note)
  } catch { return '' /* fail-open — nợ kỹ thuật không được phép làm hỏng run mới */ }
}

/**
 * Đầu mỗi run mới (không resume): nhặt nợ để ưu tiên xử lý.
 * (a) Same-session: Todo follow-up pending/in_progress/blocked — GIỮ NGUYÊN
 *     logic legacy buildLegacyPendingDebtBlock (format directive cũ, agent đã quen) —
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
  if (!params.sessionId) return empty
  // FB-R13DEBT-R1-03: kill-switch DEBT_LEDGER=0 chỉ tắt SỔ CÁI (DebtLedger) —
  // KHÔNG được tắt same-session pickup (chức năng user directive 2026-10-27 có
  // từ TRƯỚC R13). R15 (P-R13-1): gọi buildLegacyPendingDebtBlock — HÀM DUY
  // NHẤT (trước đây dựng inline → BUG2-253 fallback thiếu mục 3-4 mà biên bản
  // ghi đã fix; 1 nguồn thì không thể lệch giữa các đường).
  if (!DEBT_LEDGER_ENABLED) {
    const legacyBlock = await buildLegacyPendingDebtBlock(params.sessionId, params.currentRunId, 'sổ cái DebtLedger OFF — chế độ legacy')
    if (!legacyBlock) return empty
    return {
      directiveBlock: `\n${legacyBlock}`,
      picked: [],
      openCountBefore: 0,
    }
  }
  try {
    const { db } = await import('@/lib/db')
    const now = new Date()
    void maybeSweepStaleTodos()

    const picked: PickedDebt[] = []
    const blocks: string[] = []

    // ---- (a) Same-session Todo follow-up (giữ query như buildLegacyPendingDebtBlock) ----
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
      // Đánh dấu DebtLedger tương ứng (nếu có row) — attempts++ mỗi lần nhặt.
      // FB-R13DEBT-R1-02b: nợ parked/resolved KHÔNG còn được đưa vào khối
      // "ƯU TIÊN XỬ LÝ TRƯỚC VIỆC MỚI" — hệ thống đã dừng thử (park) hoặc đã
      // xong (resolved); đốt chu kỳ cho chúng là lặp "giải quyết nhưng không
      // giải quyết được" mà R13 ra đời để chữa. Chuyển sang ghi-chú thông tin.
      const parkedNotes: string[] = []
      const actionable: typeof sameSession = []
      for (const t of sameSession) {
        const fp = fingerprintDebtIssue(t.content)
        try {
          const row = await db.debtLedger.findUnique({ where: { fingerprint: fp } })
          if (row && row.status !== 'resolved' && row.status !== 'parked') {
            // FB-R13DEBT-R1-05: claim có điều kiện cạnh tranh — updateMany đúng
            // trạng thái đang thấy; thua đua (run khác đã claim) → bỏ qua mục này.
            const claimed = await db.debtLedger.updateMany({
              where: { id: row.id, status: row.status },
              data: { status: 'in_progress', attempts: { increment: 1 }, lastAttemptRunId: params.currentRunId, lastAttemptAt: now },
            }).catch(() => null)
            if (!claimed || claimed.count !== 1) continue
            picked.push({ debtLedgerId: row.id, fingerprint: fp, title: row.title, mirrorTodoId: t.id, origin: 'session' })
            actionable.push(t)
          } else if (row) {
            parkedNotes.push(`- [id ${t.id}] ${debtTitleFrom(t.content)} — ${row.status === 'parked' ? 'ĐÃ PARK (hết lượt thử, chờ điều kiện/thầy reopen)' : 'ĐÃ RESOLVED'} — KHÔNG thử lại trong run này (xem /api/debt/status).`)
          } else {
            // Chưa có row DebtLedger (nợ tiền-R13) → xử lý như cũ
            actionable.push(t)
          }
        } catch { /* từng item fail-open */ }
      }
      if (actionable.length > 0) {
        // R15-R1-01 (auditor): dùng formatDebtDirectiveBlock CHUNG với legacy —
        // hết "2 nguồn" (bản inline cũ thiếu mục 4 "Hết nợ mới làm việc mới" +
        // vùng bảo vệ ở mục 3; kill-switch lại đủ 4 mục — nghịch lý chế độ hiếm
        // đầy đủ hơn chế độ chính). Danh sách actionable ĐÃ lọc parked/resolved
        // theo DebtLedger (bên trên) — chỉ format là dùng chung.
        blocks.push(formatDebtDirectiveBlock(actionable, 'sổ cái DebtLedger ON'))
      }
      if (parkedNotes.length > 0) {
        blocks.push(`[ℹ️ NỢ PHIÊN NÀY ĐÃ DỪNG THEO DÕI (DebtLedger R14) — KHÔNG đưa vào kế hoạch:
${parkedNotes.join('\n')}`)
      }
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
          // FB-R13DEBT-R1-05: claim có điều kiện cạnh tranh — 2 run song song
          // cùng đón 1 debt phải chỉ 1 bên thắng (count===1); thua → bỏ mirror
          // vừa tạo khỏi picked (mirror pending vô chủ sẽ bị same-session
          // pickup lần sau hoặc sweeper dọn).
          const claimed = await db.debtLedger.updateMany({
            where: { id: d.id, status: d.status },
            data: { status: 'in_progress', attempts: { increment: 1 }, lastAttemptRunId: params.currentRunId, lastAttemptAt: now },
          }).catch(() => null)
          if (!claimed || claimed.count !== 1) continue
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
      // Tìm mirror Todo (session hiện tại, taskMeta debtLedgerId) hoặc Todo GỐC
      // FB-R13DEBT-R1-01 (P1): lookup cũ chỉ match taskMetaJson contains d.id —
      // chỉ Todo mirror GLOBAL có debtLedgerId trong taskMeta; Todo GỐC
      // (same-session — 3 đường ghi agent-goal-loop 5446/5491/5973 không set)
      // KHÔNG BAO GIỜ match → nợ same-session không bao giờ resolved (kẹt open
      // → park oan dù agent đã hoàn thành + trọng tài không re-list). Fix:
      // OR thêm d.todoId (schema lưu id Todo gốc lúc recordDebtIssue).
      let mirrorStatus: string | null = null
      const mirror = await db.todo.findFirst({
        where: {
          sessionId: params.sessionId ?? undefined,
          OR: [
            { taskMetaJson: { contains: d.id } },
            ...(d.todoId ? [{ id: d.todoId }] : []),
          ],
        },
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
        // FB-R13DEBT-R1-02a: Todo GỐC (d.todoId — đường same-session) cũng đánh
        // 'failed' khi park — nếu không, same-session pickup vẫn re-list nợ đã
        // park trong directive "ƯU TIÊN XỬ LÝ" (agent đốt chu kỳ cho nợ mà hệ
        // thống đã công nhận không giải quyết được).
        if (d.todoId) {
          const orig = await db.todo.findUnique({ where: { id: d.todoId } }).catch(() => null)
          if (orig && ['pending', 'in_progress', 'blocked'].includes(orig.status)) {
            await db.todo.update({ where: { id: d.todoId }, data: { status: 'failed' } }).catch(() => { /* fail-open */ })
          }
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
  open: Array<{ id: string; title: string; kind: string; severity: string; status: string; attempts: number; recurrenceCount: number; lastSeenAt: string; originSessionId: string | null }>
  parked: Array<{ id: string; title: string; kind: string; severity: string; status: string; attempts: number; parkReason: string | null; lastSeenAt: string }>
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
    // R15-R1-02 (auditor): trả status để UI phân biệt open vs in_progress
    // (trước đây map thiếu field — badge trong list render rỗng)
    out.open = open.map(d => ({ id: d.id, title: d.title, kind: d.kind, severity: d.severity, status: d.status, attempts: d.attempts, recurrenceCount: d.recurrenceCount, lastSeenAt: d.lastSeenAt.toISOString(), originSessionId: d.originSessionId }))
    out.parked = parked.map(d => ({ id: d.id, title: d.title, kind: d.kind, severity: d.severity, status: d.status, attempts: d.attempts, parkReason: d.parkReason, lastSeenAt: d.lastSeenAt.toISOString() }))
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
  // FB-R13DEBT-R1-08: sweeper có đồng hồ riêng — trước đây chỉ chạy bên trong
  // pickupDebtForRun (hệ thống chỉ còn fast-path chat thì zombie không bao giờ
  // được dọn). Hẹn 5s sau module-load (tránh đơ boot / đụng next build),
  // fail-open im lặng; rate-limit 1h nội bộ vẫn áp.
  const sweepTimer = setTimeout(() => { void maybeSweepStaleTodos().catch(() => {}) }, 5_000)
  sweepTimer.unref?.()
}
