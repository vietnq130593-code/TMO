/**
 * TODO-COVERAGE — kiểm tra phủ kế hoạch determinstic (2026-10-22, user-approved
 * hướng 1+2 sau thảo luận "nâng cấp khả năng lập todo list").
 *
 * Triết lý: giống λ-GROUNDED của SHR — KHÔNG tin lời tự khai của agent, harness
 * tự đối chiếu bằng dữ liệu có cấu trúc:
 *   (1) PHỦ NGHIỆM THU: mỗi tiêu chí nghiệm thu [Nghiệm thu n] của directive
 *       (RunContext.acceptanceCriteria — stash lúc run START) phải có ≥1 todo
 *       nhắm tới (tag "[Nghiệm thu n]" hoặc trùng nội dung fuzzy).
 *   (2) PHỦ BIÊN ĐỘ 📐: mỗi mục "cần đọc" trong khối 📐 BIÊN ĐỘ DỮ LIỆU
 *       (RunContext.dataScope — parse từ báo cáo/GĐ0 của agent) phải có ≥1 todo
 *       thu thập dữ liệu tương ứng (khớp đường dẫn file hoặc trùng token).
 *
 * Chạy NGAY trong todo_write → kết quả tool kèm ⚠️ block yêu cầu agent bổ sung
 * TRONG CÙNG CHU KỲ (agent thấy warning ở lượt LLM kế tiếp — cùng cơ chế phản
 * hồi lỗi parse tool call). Không chặn, không fail — chỉ cảnh báo (advisory).
 *
 * Phạm vi dữ liệu check:
 *   - Todos: TẤT CẢ todo của run (sessionId+runId), mọi trạng thái — todo
 *     completed VẪN phủ tiêu chí của nó (coverage = "kế hoạch có nhắm tới",
 *     không phải "việc còn mở").
 *   - Nghiệm thu: từ RunContext (rỗng khi user không có khối "Nghiệm thu:"
 *     trong directive → bỏ qua phần này, không nhiễu).
 *   - 📐: từ RunContext.dataScope. Giới hạn đường CLI spawn chu kỳ 1: 📐 được
 *     stash sau khi CLI trả về báo cáo → todo_write trong CÙNG spawn CLI đầu
 *     chỉ được check nghiệm thu (📐 áp dụng từ spawn/chu kỳ sau — đường ReAct
 *     TMO stash mid-cycle nên phủ ngay chu kỳ 1).
 *
 * Toàn bộ fail-open — coverage KHÔNG BAO GIỜ làm hỏng todo_write.
 */

// ==================== TYPES ====================

export interface CoverageGap {
  /** 'acceptance' = tiêu chí nghiệm thu n · 'data_scope' = mục cần đọc 📐 */
  kind: 'acceptance' | 'data_scope'
  /** số thứ tự 1-based (nghiệm thu n / mục thứ n trong phần cần đọc) */
  index: number
  /** text gốc của tiêu chí/mục (đã cắt gọn) */
  text: string
}

export interface CoverageReport {
  /** true khi không có gap nào (hoặc không có gì để check — xem note) */
  ok: boolean
  acceptanceTotal: number
  acceptanceCovered: number
  dataScopeTotal: number
  dataScopeCovered: number
  acceptanceGaps: CoverageGap[]
  dataScopeGaps: CoverageGap[]
  /** block text đính kèm kết quả todo_write (null = im lặng — không gì để báo) */
  warning: string | null
}

const EMPTY_OK: CoverageReport = {
  ok: true, acceptanceTotal: 0, acceptanceCovered: 0, dataScopeTotal: 0, dataScopeCovered: 0,
  acceptanceGaps: [], dataScopeGaps: [], warning: null,
}

// ==================== TEXT NORMALIZATION ====================

/** Stopword Việt/Anh — token phổ biến không mang nghĩa phân biệt */
const STOPWORDS = new Set([
  'các', 'của', 'và', 'hoặc', 'trong', 'cho', 'với', 'một', 'những', 'còn',
  'thì', 'là', 'bị', 'theo', 'từ', 'khi', 'để', 'bằng', 'các', 'về', 'này',
  'đó', 'mới', 'đã', 'chưa', 'phải', 'có', 'không', 'ra', 'lên', 'vào',
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'list',
])

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Token từ có nghĩa (≥3 ký tự, bỏ stopword) — hỗ trợ tiếng Việt có dấu */
function significantTokens(s: string): string[] {
  const raw = s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []
  return raw.filter(t => t.length >= 3 && !STOPWORDS.has(t))
}

/** Token đường dẫn file/thư mục — VD "src/lib/agent-goal-loop.ts", ".env", "schema.prisma" */
function pathTokens(s: string): string[] {
  const paths = s.match(/[\w.@-]+(?:\/[\w.@-]+)+/g) || [] // có separator /
  const files = s.match(/(?:\b[\w-]+\.(?:ts|tsx|js|jsx|json|md|prisma|env|py|yaml|yml|txt|sql|cjs|mjs|toml|cfg|conf)\b|\.env(?:\.[\w.]+)?\b)/gi) || []
  const envKeys = s.match(/\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+\b/g) || [] // GOAL_LOOP_MAX_CYCLES
  return [...paths, ...files, ...envKeys.map(k => k)]
}

/** Match 1 mục 📐 (file/phrase) với nội dung 1 todo */
function matchesDataScopeItem(item: string, todoContent: string): boolean {
  const normItem = normalize(item)
  const normTodo = normalize(todoContent)
  if (normItem.length < 4 || normTodo.length < 3) return false

  // Ưu tiên KHỚP ĐƯỜNG DẪN — cụ thể + deterministic + khó khớp giả
  const pts = pathTokens(item)
  if (pts.length > 0) {
    return pts.some(p => {
      const np = normalize(p)
      if (np.length < 4) return false
      if (normTodo.includes(np)) return true
      // basename (đoạn sau / cuối) — todo hay ghi "đọc schema.prisma" thay vì full path
      const base = np.includes('/') ? np.split('/').pop()! : np
      return base.length >= 5 && normTodo.includes(base)
    })
  }

  // Fuzzy token: ≥50% từ có nghĩa của mục xuất hiện trong todo
  const itemTokens = significantTokens(item)
  if (itemTokens.length === 0) return false
  const todoTokenSet = new Set(significantTokens(todoContent))
  const hit = itemTokens.filter(t => todoTokenSet.has(t)).length
  return hit / itemTokens.length >= 0.5
}

/** Match tiêu chí nghiệm thu n với nội dung 1 todo */
function matchesAcceptanceCriterion(n: number, criterion: string, todoContent: string): boolean {
  // (1) TAG CHÍNH — protocol yêu cầu ghi "[Nghiệm thu n]" trong todo
  // (?![0-9]) chống "Nghiệm thu 1" khớp nhầm "Nghiệm thu 10"
  const tagRe = new RegExp(`\\[?\\s*nghiệm\\s*thu\\s*(?:số|#|thứ)?\\s*${n}(?![0-9])\\s*\\]?`, 'i')
  if (tagRe.test(todoContent)) return true

  // (2) FUZZY — agent diễn đạt lại tiêu chí (ngưỡng cao 0.7 chống khớp giả
  // tiếng Việt đơn âm tiết; cần ≥2 từ khớp)
  const critTokens = significantTokens(criterion)
  if (critTokens.length === 0) return false
  const todoTokenSet = new Set(significantTokens(todoContent))
  const hit = critTokens.filter(t => todoTokenSet.has(t)).length
  return hit >= 2 && hit / critTokens.length >= 0.7
}

// ==================== PARSE 📐 → DANH SÁCH MỤC CẦN ĐỌC ====================

/**
 * Trích các mục "cần đọc" từ chuỗi dataScope (nguyên văn khối 📐 đã normalize
 * 1 dòng bởi parseDataScopeBlock — VD: "cần đọc prisma/schema.prisma, .env
 * (GOAL_LOOP_*) · ngoài phạm vi docs/, UI").
 * Chỉ lấy phần TRƯỚC marker "ngoài phạm vi" — mục ngoài phạm vi KHÔNG cần
 * todo (chúng là thứ agent KHÔNG đụng tới).
 */
export function parseDataScopeNeedItems(dataScope: string | null | undefined): string[] {
  if (!dataScope) return []
  let s = dataScope
  // Cắt phần ngoài phạm vi (các biến thể marker agent hay viết)
  const outMarker = s.match(/·?\s*(ngoài phạm vi|ngoại phạm vi|out of scope|không đụng)\s*:?/i)
  if (outMarker && outMarker.index !== undefined) s = s.slice(0, outMarker.index)
  // Bỏ marker "cần đọc"
  s = s.replace(/^.*?(cần đọc|cần kiểm tra|need to read)\s*:?/i, '')
  // Tách mục theo · ; , xuống dòng và từ nối " và "
  const items = s
    .split(/[·;\n]|,\s|\svà\s/)
    .map(i => i.replace(/^[\s\-–—•*]+|[\s\-–—•*]+$/g, '').trim())
    .filter(i => i.length >= 4 && i.length <= 160)
    // Bỏ mục rác thường gặp sau split
    .filter(i => !/^(cần đọc|ngoài phạm vi|\.\.\.|…|các file|cấu hình)$/i.test(i))
  // Khử trùng (giữ thứ tự) + cap 12 mục
  const seen = new Set<string>()
  return items.filter(i => {
    const k = normalize(i)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  }).slice(0, 12)
}

/** Parse RunContext.acceptanceCriteria (JSON array string) → string[] — fail → [] */
export function parseAcceptanceCriteriaJson(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.map(c => String(c).slice(0, 200)).filter(c => c.trim().length > 3).slice(0, 8)
  } catch {
    return []
  }
}

// ==================== CORE CHECK ====================

export function checkTodoCoverage(params: {
  todos: Array<{ content: string }>
  acceptance: string[]
  dataScopeItems: string[]
}): CoverageReport {
  const { todos, acceptance, dataScopeItems } = params
  if (acceptance.length === 0 && dataScopeItems.length === 0) return { ...EMPTY_OK }

  const acceptanceGaps: CoverageGap[] = []
  let acceptanceCovered = 0
  acceptance.forEach((crit, idx) => {
    const n = idx + 1
    const hit = todos.some(t => matchesAcceptanceCriterion(n, crit, t.content))
    if (hit) acceptanceCovered++
    else acceptanceGaps.push({ kind: 'acceptance', index: n, text: crit.slice(0, 120) })
  })

  const dataScopeGaps: CoverageGap[] = []
  let dataScopeCovered = 0
  dataScopeItems.forEach((item, idx) => {
    const hit = todos.some(t => matchesDataScopeItem(item, t.content))
    if (hit) dataScopeCovered++
    else dataScopeGaps.push({ kind: 'data_scope', index: idx + 1, text: item.slice(0, 120) })
  })

  const ok = acceptanceGaps.length === 0 && dataScopeGaps.length === 0
  const report: CoverageReport = {
    ok,
    acceptanceTotal: acceptance.length,
    acceptanceCovered,
    dataScopeTotal: dataScopeItems.length,
    dataScopeCovered,
    acceptanceGaps,
    dataScopeGaps,
    warning: null,
  }
  report.warning = buildCoverageWarning(report)
  return report
}

/** Dựng block cảnh báo/khen ngắn gọn — null khi không có gì để báo */
export function buildCoverageWarning(r: CoverageReport): string | null {
  if (r.acceptanceTotal === 0 && r.dataScopeTotal === 0) return null
  if (r.ok) {
    return `✅ PHỦ KẾ HOẠCH ĐẦY ĐỦ (kiểm tra determinstic của hệ thống): ${r.acceptanceTotal > 0 ? `${r.acceptanceCovered}/${r.acceptanceTotal} tiêu chí nghiệm thu` : ''}${r.acceptanceTotal > 0 && r.dataScopeTotal > 0 ? ' · ' : ''}${r.dataScopeTotal > 0 ? `${r.dataScopeCovered}/${r.dataScopeTotal} mục 📐 cần đọc` : ''} đều có todo tương ứng.`
  }
  const lines: string[] = []
  const accMissing = r.acceptanceTotal - r.acceptanceCovered
  const dataMissing = r.dataScopeTotal - r.dataScopeCovered
  lines.push(`⚠️ KIỂM TRA PHỦ KẾ HOẠCH (harness đối chiếu determinstic — không tin tự khai, ${accMissing > 0 ? `${r.acceptanceCovered}/${r.acceptanceTotal} nghiệm thu được phủ` : ''}${accMissing > 0 && dataMissing > 0 ? ', ' : ''}${dataMissing > 0 ? `${r.dataScopeCovered}/${r.dataScopeTotal} mục 📐 được phủ` : ''}):`)
  for (const g of r.acceptanceGaps.slice(0, 4)) {
    lines.push(`- ❌ Nghiệm thu ${g.index} "${g.text}" CHƯA có todo nào nhắm tới → bổ sung todo chứa "[Nghiệm thu ${g.index}]"`)
  }
  for (const g of r.dataScopeGaps.slice(0, 4)) {
    lines.push(`- ❌ 📐 cần đọc "${g.text}" CHƯA có todo thu thập dữ liệu tương ứng → bổ sung todo đọc/kiểm tra mục này`)
  }
  const more = (r.acceptanceGaps.length + r.dataScopeGaps.length) - 4
  if (more > 0) lines.push(`- (còn ${more} mục thiếu nữa — xem danh sách trên)`)
  lines.push('→ Gọi todo_write BỔ SUNG các todo còn thiếu (KHÔNG viết lại danh sách từ đầu — chỉ thêm mục mới).')
  return lines.join('\n')
}

// ==================== DB-FACING WRAPPER (gọi từ todoWrite) ====================

/**
 * Load RunContext (nghiệm thu + 📐) + TOÀN BỘ todo của run → check phủ.
 * Trả null khi không có gì để check (không RunContext / không nghiệm thu /
 * không 📐) — caller im lặng, KHÔNG đính kèm coverage vào result (chống nhiễu).
 * Fail-open tuyệt đối: mọi lỗi → null.
 */
export async function checkRunTodoCoverage(params: {
  sessionId: string
  runId: string
}): Promise<CoverageReport | null> {
  try {
    const { sessionId, runId } = params
    if (!sessionId || !runId || sessionId === 'default') return null

    const { getRunContext } = await import('@/lib/structured-hypothesis')
    const rc = await getRunContext(runId)
    if (!rc) return null

    const acceptance = parseAcceptanceCriteriaJson(rc.acceptanceCriteria)
    const dataScopeItems = parseDataScopeNeedItems(rc.dataScope)
    if (acceptance.length === 0 && dataScopeItems.length === 0) return null

    const { db } = await import('@/lib/db')
    const todos = await db.todo.findMany({
      where: { sessionId, runId },
      select: { content: true },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      take: 200,
    })
    return checkTodoCoverage({ todos, acceptance, dataScopeItems })
  } catch {
    return null // fail-open — coverage không bao giờ làm hỏng todo_write
  }
}
