/**
 * CONTEXT COMPRESSION — module dùng chung (CI-3 B1, Task 13-a)
 * =============================================================
 *
 * Tách logic nén rolling-digest từ agent-goal-loop.ts thành module độc lập
 * để Code Team workflow-engine tái dùng cùng một pattern (roadmap CI-3
 * "Lỗ hổng 1": workflow push tool result THÔ không giới hạn → task code dài
 * phình đến 80k tokens rồi pause).
 *
 * 2 tầng nén (nguyên vẹn pattern đã verify GĐ1/GĐ2 của goal-loop):
 *   1. capToolResult — cap tool result ~4k chars TRƯỚC khi push vào messages
 *      (giữ đầu + cuối vì lỗi/tổng kết lệnh thường nằm CUỐI output).
 *   2. compressConversation — rolling digest: khi segment cũ vượt ngưỡng
 *      50k chars → LLM digest (callUtilityLLM — lõi utility rẻ, không đụng
 *      provider chính của agent) → 1 digest message ~2.5k chars; LLM hỏng thì
 *      fallback heuristic deterministic; mọi lỗi fail-open (return null,
 *      messages giữ nguyên — loop KHÔNG BAO GIỜ bị làm hỏng vì nén).
 *
 * Quy tắc bảo toàn:
 *   - KHÔNG đụng mọi message có index <= protectedStartIndex (system prompt,
 *     chat history, goal/step instruction).
 *   - GIỮ NGUYÊN `keepRecent` message gần nhất (agent đang làm việc với chúng).
 *   - Splice THEO CẶP: assistant-with-tool_calls + các tool reply liền sau nó
 *     là 1 khối nguyên vẹn — không bao giờ cắt một nửa gây orphan tool_call_id
 *     (API "tool_call_id not found" với provider native function calling).
 *
 * FAIL-OPEN TUYỆT ĐỐI — nén là tối ưu, không phải chức năng bắt buộc.
 */

import { createHash } from 'node:crypto'

import { callUtilityLLM } from '@/lib/llm'
import { recordDigestGateEvent } from '@/lib/digest-gate-events'

// ==================== CONSTANTS (giá trị exact như goal-loop trước tách) ====================

/**
 * Biến thể CHỈ NHẬN số dương (giữ nguyên ngữ nghĩa intEnvPositive của
 * goal-loop): ngưỡng nén 0 = nén mỗi vòng → vô nghĩa/nguy hiểm, không áp
 * "0 = unlimited" cho các hằng nén.
 */
function intEnvPositive(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
}

/** Ngưỡng tổng ký tự của segment nén được — vượt quá thì nén (goal-loop cũ: 50k) */
export const COMPRESS_THRESHOLD_CHARS = intEnvPositive('GOAL_LOOP_COMPRESS_THRESHOLD_CHARS', 50_000)
/** Số message gần nhất GIỮ NGUYÊN khi nén (goal-loop cũ: 8) */
export const KEEP_RECENT_MESSAGES = intEnvPositive('GOAL_LOOP_KEEP_RECENT_MESSAGES', 8)
/** Cap ký tự của digest message sau nén — r60: 2500 → 4000 (user directive
 * 2026-10-07 "token không là ràng buộc": digest rộng hơn giữ được NHIỀU HƠN dòng
 * bằng chứng nguyên văn — bằng chứng r59 mission …9k3kp8: digest 2500 nuốt mất
 * 3 dòng version của package.json → trọng tài đòi nguyên văn không tồn tại
 * nữa → chu kỳ 3-5 bế tắc 1%/2%/3%). Env GOAL_LOOP_DIGEST_MAX_CHARS giữ nguyên. */
export const DIGEST_MAX_CHARS = intEnvPositive('GOAL_LOOP_DIGEST_MAX_CHARS', 4_000)
/** Cap ký tự transcript đưa vào LLM nén (đầu vào) — r60: 30k → 40k + env
 * GOAL_LOOP_COMPRESS_INPUT_CHARS (trước đây hard-code không env). Đầu vào rộng
 * hơn = LLM digest thấy ĐỦ phần đầu file (nơi dependency/version nằm) để trích
 * nguyên văn thay vì bỏ. */
export const COMPRESS_INPUT_CHARS = intEnvPositive('GOAL_LOOP_COMPRESS_INPUT_CHARS', 40_000)
/** Ngưỡng tối thiểu số message nén được (dưới đây thì không đáng nén) — goal-loop cũ: 4 */
export const MIN_COMPRESSIBLE_MESSAGES = 4
/**
 * Cap ký tự tool result khi đẩy vào messages (goal-loop cũ: MAX_TOOL_RESULT_CHARS = 4000).
 *
 * 2026-09-30 (round-10 audit root-cause): 4000 ký tự làm agent audit KHÔNG THỂ
 * đọc trọn output shell baseline / file_list / protected-hash của chính mình →
 * báo cáo cuối thành "chưa kiểm định được" dù artifact tồn tại (mission
 * run_1790755954444_1 — 100% các mục "KHÔNG KIỂM ĐỊNH ĐƯỢC" đều do cắt giữa).
 * Nâng mặc định 4000 → 12000 + env-configurable (TOOL_RESULT_MAX_CHARS) để
 * điều chỉnh theo loại nhiệm vụ mà không cần sửa code. smartTruncate ở
 * pushToolMessage (giữ đầu+cuối) vẫn bảo vệ context tổng.
 */
export const TOOL_RESULT_MAX_CHARS = intEnvPositive('TOOL_RESULT_MAX_CHARS', 12_000)

/**
 * ROUND-53 FIX A1 (bằng chứng mission r53 Linh Sickyx: chu kỳ 3 model trả
 * 150.305 ký tự THUẦN VĂN 0 tool call → push nguyên văn vào transcript →
 * prompt chu kỳ 4-5 phình 60k+ tokens → completion co rút 34-441 chars,
 * chết đói reasoning → stall brake 3/3 kết thúc mission). Cap nội dung
 * assistant đẩy vào transcript: giữ đầu 20k + đuôi 3k (cú pháp tool_call
 * thường nằm cuối) + ghi chú phần đã cắt. Digest chu kỳ sau vẫn nén tiếp —
 * cap này chỉ chặn ca bệnh lý context-bomb.
 *
 * AUDIT SAU r53: chuyển sang module dùng chung — vòng SUB-AGENT có 4 push
 * site assistant raw (subagent-delegate.ts) cùng provider/model, cùng nguy
 * cơ context-bomb (bằng chứng r53: sub-agent đốt 950k tokens) nhưng fix A1
 * gốc chỉ phủ goal-loop. Env-configurable theo pattern module này.
 */
export const ASSISTANT_PUSH_CAP_CHARS = intEnvPositive('ASSISTANT_PUSH_CAP_CHARS', 24_000)
export function capAssistantContentForTranscript(content: string): string {
  if (typeof content !== 'string' || content.length <= ASSISTANT_PUSH_CAP_CHARS) return content
  const head = content.slice(0, 20_000)
  const tail = content.slice(-3_000)
  return `${head}\n\n[…⚠ Nội dung dài ${content.length} ký tự — đã cắt giữ đầu 20k + đuôi 3k để bảo vệ context. KHÔNG lặp lại phần đã viết: nếu cần phần giữa, lưu vào work_data/file rồi trích dẫn ngắn.]\n\n${tail}`
}

/** Timeout LLM digest (goal-loop cũ: 90s — utility prompt nhỏ, không cần dài hơn) */
const DIGEST_LLM_TIMEOUT_MS = 90_000

// ==================== TYPES ====================

/**
 * Message tổng quát cho nén — tương thích cả 2 engine:
 *   - GoalMessage của goal-loop (role: user/assistant/tool, content string)
 *   - Workflow message của workflow-engine (role: system/user/assistant/tool,
 *     content string, tool_call_id?, tool_calls?)
 */
export interface CompressionMessage {
  role: string
  content: string
  tool_call_id?: string
  /** Có mặt trên assistant message native function calling (workflow-engine) */
  tool_calls?: unknown
}

/** Entry bằng chứng cho heuristic fallback — tương thích EvidenceEntry của goal-loop */
export interface CompressEvidenceEntry {
  kind: string
  tool?: string
  success?: boolean
  text: string
}

/** Kết quả nén — `digest` là nội dung digest thô (caller ghi preview vào memory nếu cần) */
export interface CompressionResult {
  digest: string
  digestChars: number
  savedChars: number
  method: 'llm' | 'heuristic'
  /**
   * SUMMARIZER RECEIPT (Task 42) — biên lai xác nhận nội dung đã được tóm tắt:
   * sha256 của transcript đầu vào + digest đầu ra (12 hex), số message đã nén,
   * range index gốc, số ký tự trước→sau, phương pháp. Gắn kèm cuối digest
   * message để agent + user đối chiếu được "đã nén gì, nén từ bao nhiêu".
   */
  receipt?: string
}

// ==================== HELPERS ====================

/** Timeout wrapper cho LLM call (Promise.race — pattern goal-loop/workflow-engine) */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

/** Assistant message có tool_calls (native function calling) → phải cắt nguyên khối cùng tool replies */
function hasToolCalls(m: CompressionMessage): boolean {
  return m.role === 'assistant' && Array.isArray(m.tool_calls) && (m.tool_calls as unknown[]).length > 0
}

/**
 * Prompt cho LLM nén context — chưng cất transcript cũ thành digest.
 * Ưu tiên giữ: file path + điểm chính, kết quả lệnh (pass/fail + SỐ LỖI),
 * quyết định đã chốt, việc đang dở. Bỏ: code trích dẫn, output chi tiết.
 * (Nguyên vẹn prompt tiếng Việt của goal-loop trước tách.)
 */
export function buildDigestPrompt(transcript: string): string {
  return `Bạn là hệ thống NÉN CONTEXT cho AI agent đang làm task dài hạn. Nén nhật ký làm việc dưới đây thành 1 DIGEST cô đọng (≤ ${DIGEST_MAX_CHARS} ký tự) để agent tiếp tục công việc mà KHÔNG mất thông tin cần thiết.

NHẬT KÝ (đã cắt bớt):
${transcript}

GIỮ LẠI (quan trọng giảm dần):
1. File đã đọc/sửa/tạo (đường dẫn) + điểm chính mỗi file (hàm/struct quan trọng, mục đích)
2. Lệnh/tool đã chạy + kết quả: pass/fail, exit code, SỐ LỖI cụ thể nếu có
3. Kết luận + quyết định kỹ thuật đã chốt; bug đã tìm thấy + nguyên nhân
4. Việc đang DỞ (làm đến đâu)
5. BẰNG CHỨNG NGUYÊN VĂN (r60 — TỐI QUAN TRỌNG): mọi DÒNG/GIÁ TRỊ CỤ THỂ đã được dùng làm bằng chứng đối chiếu tiêu chí nghiệm thu — dòng dependency/version trích từ file config (vd package.json), kết quả COUNT truy vấn SQL, tổng đếm file/entry, số đếm test pass/fail, đường dẫn artifact — giữ NGUYÊN VĂN từng dòng như vậy (kèm tên file/nguồn), KHÔNG diễn đạt lại, KHÔNG bỏ qua. Agent chu kỳ sau phải trích dẫn đúng nguyên văn các dòng này cho trọng tài — mất chúng là mất bằng chứng.
BỎ: nội dung file đầy đủ (ngoài các dòng bằng chứng mục 5), code trích dẫn dài, output lệnh chi tiết, suy nghĩ thừa.

Output CHỈ digest (không preamble, không markdown fence), tiếng Việt, gọn theo bullet.`
}

/** Wrapper của digest message khi chèn vào transcript (nguyên văn goal-loop cũ;
 * r60: dòng hướng dẫn cập nhật — digest giờ BẢO TOÀN dòng bằng chứng nguyên văn
 * (mục 5 prompt digest), phần còn lại mới được tóm tắt; re-read vẫn là đường dự
 * phòng khi cần nguyên văn ngoài các dòng đã giữ). */
function buildDigestMessageContent(digest: string): string {
  return `📦 [WORKSPACE DIGEST — các bước TRƯỚC ĐÂY đã được NÉN để giữ context gọn. Đây là TÓM TẮT công việc đã làm; các DÒNG BẰNG CHỨNG NGUYÊN VĂN (version/dependency, kết quả COUNT/đếm, test pass/fail, artifact path) ĐÃ ĐƯỢC GIỮ NGUYÊN VĂN trong digest. Nếu cần nguyên văn chính xác một file/lệnh ngoài các dòng đã giữ → gọi file_read/grep/shell LẠI (đọc lại để TRÍCH DẪN bằng chứng là hợp pháp — không phải lặp việc).]\n\n${digest}`
}

/**
 * Heuristic fallback khi thiếu evidence log (workflow-engine không giữ evidence
 * array như goal-loop): suy xuất pseudo-evidence từ chính transcript — tool
 * message có JSON shape {tool, success, result} thì trích tên tool + trạng thái
 * + preview result; assistant message lấy preview text thuần.
 */
function deriveEvidenceFromMessages(msgs: CompressionMessage[]): CompressEvidenceEntry[] {
  const out: CompressEvidenceEntry[] = []
  for (const m of msgs) {
    if (m.role === 'tool') {
      let tool = ''
      let success: boolean | undefined
      let text = ''
      try {
        const parsed = JSON.parse(m.content) as { tool?: unknown; success?: unknown; result?: unknown }
        if (typeof parsed.tool === 'string') tool = parsed.tool
        if (typeof parsed.success === 'boolean') success = parsed.success
        if (parsed.result !== undefined) text = JSON.stringify(parsed.result)
      } catch {
        /* không phải JSON — dùng content thô */
      }
      out.push({
        kind: 'tool',
        tool: tool || 'tool',
        success,
        text: (text || m.content).replace(/\s+/g, ' ').slice(0, 160),
      })
    } else if (m.role === 'assistant' && m.content.trim()) {
      out.push({ kind: 'directive', text: m.content.replace(/\s+/g, ' ').slice(0, 160) })
    }
  }
  return out.slice(-40)
}

// ==================== P3-M4 — DIGEST QUALITY GATE (thuần toán, 0 LLM) ====================

/**
 * Ngưỡng evidence-coverage tối thiểu của digest LLM (BLUEPRINT §P3-M4).
 * Rollback = set 0 (gate tắt hiệu quả — mọi digest LLM được chấp nhận).
 * Env DIGEST_EVIDENCE_COVERAGE_MIN cho phép điều chỉnh không deploy lại.
 */
export const DIGEST_EVIDENCE_COVERAGE_MIN = (() => {
  // FB-Đợt5-R2-01: env đặt nhưng RỖNG ('') → Number('')=0 → gate tắt ngầm.
  // Chuẩn hoá: trim + rỗng coi như KHÔNG đặt → default. Chỉ số 0 hợp lệ
  // (rollback chủ đích) khi env được đặt bằng "0".
  const raw = (process.env.DIGEST_EVIDENCE_COVERAGE_MIN ?? '').trim()
  if (raw === '') return 0.7
  const v = Number(raw)
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.7
})()

/** Số token dẫn chứng tối đa trích để tính coverage — chặn chi phí cho evidence dài */
const GATE_TOKEN_CAP = 60

/** Cạo dấu câu dính hai đầu token ("src/lib/db," → "src/lib/db") — giữ [A-Za-z0-9_./-] */
function stripEdgePunctuation(tok: string): string {
  return tok.replace(/^[^\w./-]+|[^\w./-]+$/g, '')
}

/**
 * Trích "danh từ kỹ thuật + số dẫn chứng" từ evidence log (ML.pdf §ROUGE —
 * kiểm tra mất thông tin khi nén ngữ cảnh bằng độ đo rẻ, không LLM):
 *   - camelCase/PascalCase ≥2 hump (parseEvalVerdict, WilsonCI — bao cả đuôi
 *     acronym hoa như ...CI/...JSON; từ 1 hump kiểu Monday/Tên riêng bị loại)
 *   - snake_case/kebab-case (raw_confidence, goal-loop)
 *   - đường dẫn (chứa '/')
 *   - SỐ dẫn chứng ≥2 chữ số hoặc thập phân (722, 0.55, 4000) — số 1 chữ số
 *     (0/1/2...) quá phổ biến ở mọi output, không mang tín hiệu "bằng chứng"
 *     riêng nên loại khỏi gate (chọn có chủ đích, ghi rõ ở đây).
 *   - Chuỗi hex dạng git hash ≥7 ký tự (839d494 — FB-Đợt5-R1-01).
 * Token ngắn <3 ký tự bỏ. Khử trùng theo key lowercase. Cap GATE_TOKEN_CAP
 * (check TRƯỚC khi push — vòng quét dừng sớm khi chạm cap).
 */
export function extractEvidenceTokens(evidence: CompressEvidenceEntry[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (tok: string) => {
    if (out.length >= GATE_TOKEN_CAP) return
    const t = stripEdgePunctuation(tok.trim())
    if (t.length < 3) return
    const key = t.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(t)
  }

  const text = evidence.map(e => e.text ?? '').join('\n')
  if (!text.trim()) return []

  // camelCase ≥2 hump: BẮT ĐẦU bằng chữ thường + (Hoa + chữ thường/số)* — rawConfidence
  const camelLower = text.match(/\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g) ?? []
  for (const t of camelLower) push(t)

  // PascalCase ≥2 hump: Hoa+thường/số + (Hoa + thường/số/đuôi hoa)* —
  // WilsonCI, ParseEvalVerdict (1 hump Monday bị loại — không phải định danh kỹ thuật)
  const pascal = text.match(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g) ?? []
  for (const t of pascal) push(t)

  // snake_case / kebab-case: có ÍT NHẤT 1 dấu _ hoặc - nối hai cụm chữ/số
  const snake = text.match(/\b[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+\b/g) ?? []
  for (const t of snake) push(t)

  // đường dẫn: chứa '/' (cạo dấu câu hai đầu sau match)
  const paths = text.match(/\S*\/\S+/g) ?? []
  for (const t of paths) push(t)

  // số dẫn chứng: ≥2 chữ số hoặc thập phân
  const numbers = text.match(/\b\d+(?:\.\d+)+\b|\b\d{2,}\b/g) ?? []
  for (const t of numbers) push(t)

  // FB-Đợt5-R1-01: chuỗi hex dạng hash git (839d494, 6b0b7e9) — commit hash
  // là bằng chứng đối chiếu QUAN TRỌNG trong quy trình dự án (worklog/báo cáo
  // trích dẫn liên tục) nhưng không match số (không có \b giữa 839-d494) hay
  // camel/snake. Pattern hex thuần ≥7 ký tự (độ dài git short-hash) — từ tiếng
  // Anh thuần ≥7 chữ chỉ gồm a-f rất hiếm (worst case "defaced" — hi sinh chấp
  // nhận, hướng bảo thủ: bắt buộc digest giữ).
  const hashes = text.match(/\b[0-9a-f]{7,40}\b/g) ?? []
  for (const t of hashes) push(t)

  return out
}

export interface DigestGateResult {
  /** true khi digest đủ giữ evidence (coverage ≥ ngưỡng) */
  passed: boolean
  /** Tỉ lệ token dẫn chứng còn sót trong digest (0-1); không token nào → 1 */
  coverage: number
  /** Tổng token trích được từ evidence */
  tokens: number
  /** Số token TÌM THẤY trong digest */
  found: number
  /** Token bị mất (tối đa 5 — chỉ để log diễn giải) */
  missing: string[]
}

/**
 * P3-M4 GATE (chính, cho compression): digest LLM có giữ lại "danh từ kỹ
 * thuật + số dẫn chứng" của evidence log không? Coverage = tỉ lệ token xuất
 * hiện (substring, case-insensitive) trong digest. Rớt ngưỡng → caller fallback
 * heuristic deterministic (evidence-preserving — đường an toàn có sẵn).
 * Export cho test (đúng precedent parseEvalVerdict export-for-test).
 */
export function checkDigestGate(digest: string, evidence: CompressEvidenceEntry[]): DigestGateResult {
  const tokens = extractEvidenceTokens(evidence)
  if (tokens.length === 0) {
    // Không có gì ĐO ĐẾN được để mất → gate tự qua (không có bằng chứng nào cả)
    return { passed: true, coverage: 1, tokens: 0, found: 0, missing: [] }
  }
  const lower = digest.toLowerCase()
  let found = 0
  const missing: string[] = []
  for (const tok of tokens) {
    if (lower.includes(tok.toLowerCase())) found++
    else if (missing.length < 5) missing.push(tok)
  }
  const coverage = found / tokens.length
  return { passed: coverage >= DIGEST_EVIDENCE_COVERAGE_MIN, coverage, tokens: tokens.length, found, missing }
}

/** Dựng digest heuristic từ evidence log (tách ra dùng chung 2 nhánh fallback) */
function buildHeuristicDigest(evidenceSource: CompressEvidenceEntry[]): string {
  return evidenceSource
    .map(e => (e.kind === 'tool' ? `- [${e.tool}] ${e.success ? '✓' : '✗'} ${e.text}` : `- ${e.text}`))
    .join('\n')
    .slice(0, DIGEST_MAX_CHARS)
}

// ==================== CAP TOOL RESULT (tầng 1) ====================

/**
 * Cap tool result (JSON string) ở ~maxChars (mặc định 4000 — pattern 4k của
 * goal-loop). Cắt GIỮ ĐẦU 60% + CUỐI 40% vì lỗi của tsc/lint/test và dòng
 * tổng kết ("X errors, Y passed") thường nằm CUỐI output; cuối content gắn
 * marker chỉ dẫn agent đọc lại phần bị cắt qua file_read offset.
 *
 * @returns content đã cap + cờ truncated + tổng ký tự gốc (để receipt/log)
 */
export function capToolResult(
  content: string,
  maxChars: number = TOOL_RESULT_MAX_CHARS,
): { content: string; truncated: boolean; totalChars: number } {
  const totalChars = content.length
  if (totalChars <= maxChars) {
    return { content, truncated: false, totalChars }
  }
  // Pattern goal-loop smartTruncate: head 60% / tail 40% — marker ngắn ở giữa
  // (giữ lỗi + tổng kết cuối output), sau đó marker TRUNCATED ở CUỐI content
  // (chỉ dẫn đọc lại bằng file_read offset).
  const head = Math.floor(maxChars * 0.6)
  const tail = Math.max(200, maxChars - head - 200)
  const keptChars = head + tail
  const marker = `…[TRUNCATED ${keptChars}/${totalChars} chars — dùng file_read offset để đọc tiếp]`
  const output =
    content.slice(0, head) +
    `\n…[truncated ${totalChars - keptChars} chars giữa — giữ đầu + cuối vì lỗi/tổng kết thường nằm cuối output]…\n` +
    content.slice(-tail) +
    `\n${marker}`
  return { content: output, truncated: true, totalChars }
}

/**
 * SMART TRUNCATION — cắt giữ ĐẦU + CUỐI (60%/40%) cho VĂN BẢN THÔ (không phải
 * JSON). Lỗi của tsc/lint/test và dòng tổng kết ("X errors, Y passed") thường
 * nằm CUỐI output — cắt head-only làm mất đúng phần quan trọng nhất.
 * ROUND-27: chuyển từ agent-goal-loop.ts sang module dùng chung — hiện chỉ còn
 * là FALLBACK của truncateToolMessageJson khi cap quá nhỏ / serialize lỗi.
 * KHÔNG dùng trực tiếp cho tool message JSON — marker chứa \n thô làm VỠ cú pháp.
 */
function smartTruncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s
  const head = Math.floor(maxChars * 0.6)
  const tail = Math.max(200, maxChars - head - 90)
  return (
    s.slice(0, head) +
    `\n…[truncated ${s.length - head - tail} chars giữa — giữ đầu + cuối vì lỗi/tổng kết thường nằm cuối output]…\n` +
    s.slice(-tail)
  )
}

/**
 * ROUND-28 W2 — CORE envelope builder dùng chung 2 tầng (tool-message của
 * truncateToolMessageJson + tool-output của truncateToolOutputObject):
 * trả về OBJECT {_truncated, _originalChars, _note, head, tail} khớp ngân sách
 * `budget` (length của envelope JSON ≤ budget), hoặc null khi budget quá nhỏ
 * cho skeleton — caller tự fallback (smartTruncate / substring text cũ).
 * head/tail là string field escape chuẩn từ `serialized` (payload gốc) →
 * tầng nào truyền payload tầng đó được mô tả đúng (_originalChars = đúng
 * payload, KHÔNG lẫn wrapper nội bộ).
 */
function buildEnvelopeObject(
  serialized: string,
  budget: number,
): { _truncated: true; _originalChars: number; _note: string; head: string; tail: string } | null {
  if (budget < 300) return null // skeleton + head/tail tối thiểu không vừa — fallback
  let head = Math.floor(budget * 0.55)
  let tail = Math.max(200, Math.floor(budget * 0.3))
  const build = (): string =>
    JSON.stringify({
      _truncated: true,
      _originalChars: serialized.length,
      _note: `Kết quả thật ${serialized.length} ký tự — giữ ~55% đầu + ~30% đuôi (lỗi/tổng kết thường nằm cuối). Cần phần giữa → gọi lại tool với phạm vi hẹp hơn (path/depth/pattern/glob/head_limit/ignore/offset...). LƯU Ý: kết quả file_read có sẵn nextOffset/totalLines ở ĐẦU JSON — đọc tiếp bằng offset thay vì đọc lại từ đầu.`,
      head: serialized.slice(0, head),
      tail: serialized.slice(-tail),
    })
  let out = build()
  // envelope vẫn vượt budget (edge: budget rất nhỏ) → co head/tail theo tỉ lệ
  // rồi thử đúng 1 lần
  if (out.length > budget) {
    const overflow = out.length - budget
    head = Math.max(200, head - Math.ceil(overflow * 0.65))
    tail = Math.max(120, tail - Math.ceil(overflow * 0.35))
    out = build()
  }
  if (out.length > budget) return null
  try {
    return JSON.parse(out) as { _truncated: true; _originalChars: number; _note: string; head: string; tail: string }
  } catch {
    return null
  }
}

/**
 * ROUND-26 FIX B (mission cmupl7uen — Omega báo cáo "file_list PASS nhưng
 * không có dữ liệu hữu ích"): splice text cũ cắt GIỮA chuỗi JSON của tool
 * message rồi chèn marker chứa \n thô → chuỗi đẩy về LLM KHÔNG còn parse được
 * (thực tế 13:53: file_list 125k chars → message 11999 chars VỠ, agent đọc
 * được mảnh rời nhưng không trích xuất cấu trúc, kết luận "không có dữ liệu
 * hữu ích về tên file" → chu kỳ sau mất định hướng). Giờ: vượt cap → đóng
 * envelope JSON HỢP LỆ {tool, success, result: {_truncated, _originalChars,
 * _note, head, tail}} — head/tail là string field được escape chuẩn → LLM
 * LUÔN nhận JSON parse được, thấy rõ ~55% đầu + ~30% đuôi (lỗi/tổng kết thường
 * nằm cuối) + biết kích thước thật để gọi lại hẹp hơn.
 * Fallback (serialize lỗi / cap quá nhỏ) → giữ splice text cũ (smartTruncate).
 *
 * ROUND-27 FIX V1 — chuyển từ agent-goal-loop.ts sang module DÙNG CHUNG để
 * cả BA vòng lặp cùng một envelope: goal-loop (pushToolMessage — đã dùng từ
 * round-26), SUB-AGENT (subagent-delegate — round-26 BỎ SÓT: truncateResult
 * splice thẳng làm vỡ JSON mọi tool result > 8k chars cho MEGATRON/sub-agents
 * + trọng tài delegation đọc toolResultLog), workflow-engine (code-team —
 * round-26 bỏ sót: result lớn thành STRING chứa mảnh JSON vỡ). Tại đây không
 * circular import (context-compression chỉ phụ thuộc llm + crypto).
 *
 * ROUND-28 W2 — sizing CHÍNH XÁC qua buildEnvelopeObject: overhead wrapper
 * ({"tool":...,"success":...,"result": + }) tính đúng theo prefix thực tế →
 * tổng message ≤ cap NGUYÊN VẸN (không còn co xấp xỉ + thử lại như cũ).
 */
export function truncateToolMessageJson(
  entry: { tool: string; success: boolean; result: unknown },
  serialized: string,
  cap: number,
): string {
  try {
    // Guard — payload nằm dưới cap: trả NGUYÊN VĂN (caller chỉ gọi khi vượt
    // cap, nhưng hàm public + test gọi trực tiếp cần hành vi đúng).
    if (serialized.length <= cap) return serialized
    const prefix = `{"tool":${JSON.stringify(entry.tool)},"success":${entry.success},"result":`
    const overhead = prefix.length + 1 // + '}' đóng
    const envelope = buildEnvelopeObject(serialized, cap - overhead)
    if (!envelope) return smartTruncate(serialized, cap)
    return prefix + JSON.stringify(envelope) + '}'
  } catch {
    return smartTruncate(serialized, cap) // fail-open — splice text cũ
  }
}

/**
 * ROUND-28 W2 — envelope cho TOOL OUTPUT OBJECT (tầng tool-output, khác tầng
 * tool-message của truncateToolMessageJson): custom tool (agent tự tạo qua
 * create_custom_tool) trả OBJECT quá lớn thì custom-tool-registry trước đây
 * `serialized.substring(0, maxOutputLength)` — cắt giữa chuỗi JSON + append
 * marker text → result value là JSON VỠ không parse được (cùng lớp bug FIX B
 * round-26, site thứ 3 tìm thấy round-28). Giờ: result value là OBJECT envelope
 * {_truncated, _originalChars, _note, head, tail} — parse được, thấy đầu+cuối;
 * _originalChars/_note mô tả ĐÚNG payload (value), head/tail là mảnh value
 * thuần (không lẫn wrapper nội bộ). Value nằm dưới cap → trả NGUYÊN reference.
 * Fail-open: mọi lỗi / budget quá nhỏ → substring + marker text cũ.
 */
export function truncateToolOutputObject(value: unknown, maxChars: number): unknown {
  try {
    const valueSerialized = JSON.stringify(value)
    if (valueSerialized === undefined) {
      // value là function/undefined — JSON.stringify trả undefined
      return String(value).slice(0, maxChars) + '... [truncated]'
    }
    if (valueSerialized.length <= maxChars) return value
    const envelope = buildEnvelopeObject(valueSerialized, maxChars)
    if (envelope) return envelope
    return String(value).slice(0, maxChars) + '... [truncated]'
  } catch {
    return String(value).slice(0, maxChars) + '... [truncated]'
  }
}

// ==================== ROLLING COMPRESSION (tầng 2) ====================

/**
 * ROLLING CONTEXT COMPRESSION — nén segment cũ của messages thành 1 digest
 * message (bản tổng quát của compressHistory goal-loop, dùng chung cho cả
 * goal-loop và code-team workflow-engine).
 *
 * Nguyên tắc BẢO TOÀN:
 *   - KHÔNG đụng: mọi message index <= protectedStartIndex (system prompt,
 *     chat history, goal message / step instruction).
 *   - GIỮ NGUYÊN: keepRecent message gần nhất.
 *   - NÉN: toàn bộ assistant/tool ở giữa → 1 digest message (role user).
 *   - SPLICE THEO CẶP: assistant-with-tool_calls + tool replies liền sau là
 *     1 khối nguyên vẹn — biên nén tự co để KHÔNG bao giờ cắt một nửa cặp
 *     (chống lỗi API "tool_call_id not found" khi provider yêu cầu pairing).
 *
 * 2 lớp digest:
 *   1. LLM digest qua callUtilityLLM (~700 maxTokens/lần — rẻ, không đụng
 *      provider chính của agent).
 *   2. Fallback heuristic deterministic từ evidence log (param) hoặc suy xuất
 *      từ chính transcript nếu thiếu — LLM hỏng vẫn nén được.
 *
 * CI-3 B2 (Task 13-b) — KHO CONTEXT "đọc lại khi cần": khi nén THÀNH CÔNG và
 * caller truyền `archive` → digest được lưu vào TaskContextArchive (Prisma —
 * source of truth) + Qdrant task_context (best-effort embed) qua
 * archiveContext(@/lib/context-store) — dynamic import tránh circular import;
 * fire-and-forget fail-open (KHÔNG đợi archive xong, KHÔNG bao giờ làm fail
 * nén vì lỗi archive). Bỏ qua hoàn toàn khi thiếu archive param.
 *
 * Fail-open: mọi lỗi → return null (giữ nguyên messages như cũ, loop vẫn chạy).
 * Mutates messages in-place (splice).
 */
export async function compressConversation(params: {
  /** Message array của engine — mutate in-place (splice) */
  messages: CompressionMessage[]
  /** Mọi message index <= protectedStartIndex KHÔNG đụng (system + goal/step instruction) */
  protectedStartIndex: number
  /** Số message gần nhất giữ nguyên */
  keepRecent: number
  /** Evidence log (goal-loop) cho heuristic fallback — thiếu thì suy xuất từ transcript */
  evidence?: CompressEvidenceEntry[]
  /** Token của LLM digest cũng phải vào kế toán budget của caller */
  onTokens?: (tokens: number) => void
  /** Label task cho callUtilityLLM (log) — goal-loop truyền 'goal-loop-context-compression' */
  llmContext?: string
  /** Ngưỡng tối thiểu số message nén được — mặc định MIN_COMPRESSIBLE_MESSAGES */
  minCompressibleMessages?: number
  /** CI-3 B2: lưu digest vào Kho Context sau khi nén thành công (bỏ qua nếu thiếu) */
  archive?: {
    runId?: string | null
    sessionId?: string | null
    agentName?: string | null
  }
}): Promise<CompressionResult | null> {
  const { messages, keepRecent, evidence, onTokens, llmContext } = params
  const minCompressible = params.minCompressibleMessages ?? MIN_COMPRESSIBLE_MESSAGES

  const workStartRaw = Math.max(0, params.protectedStartIndex + 1)
  let workStart = workStartRaw
  let compressEnd = messages.length - keepRecent
  if (compressEnd <= workStart) return null

  // ---- SPLICE THEO CẶP: co biên để không cắt nửa cặp tool_call ----
  // (1) Đuôi: nếu compressEnd rơi GIỮA khối [assistant-with-tool_calls + tool
  // replies liền sau] → co compressEnd về đầu khối (giữ nguyên cả khối ở tail).
  for (let i = workStart; i < compressEnd; i++) {
    if (hasToolCalls(messages[i])) {
      let unitEnd = i + 1
      while (unitEnd < messages.length && messages[unitEnd].role === 'tool') unitEnd++
      if (unitEnd > compressEnd) {
        compressEnd = i
        break
      }
      i = unitEnd - 1 // đã xét trọn khối — nhảy qua
    }
  }
  // (2) Đầu: tool reply mang tool_call_id đứng đầu segment → assistant cha nằm
  // TRƯỚC segment (vùng bảo vệ) — bỏ qua nhóm tool replies này (không nén) để
  // không mồ côi cặp. (Goal-loop tool message không có tool_call_id → khối này
  // không chạy, hành vi giữ nguyên như cũ.)
  while (
    workStart < compressEnd &&
    messages[workStart].role === 'tool' &&
    typeof messages[workStart].tool_call_id === 'string' &&
    messages[workStart].tool_call_id !== ''
  ) {
    workStart++
  }

  if (compressEnd - workStart < minCompressible) return null // segment quá nhỏ — không đáng nén

  const compressible = messages.slice(workStart, compressEnd)
  const removedChars = compressible.reduce((s, m) => s + m.content.length, 0)
  if (removedChars < COMPRESS_THRESHOLD_CHARS) return null // segment nén được chưa đủ lớn
  if (removedChars - DIGEST_MAX_CHARS < DIGEST_MAX_CHARS * 2) return null // tiết kiệm < 2× digest — không đáng tốn 1 LLM call

  // Transcript đầu vào cho LLM nén (cap COMPRESS_INPUT_CHARS)
  let transcript = ''
  for (const m of compressible) {
    const label = m.role === 'assistant' ? 'ASSISTANT' : m.role === 'tool' ? 'TOOL RESULT' : 'USER'
    transcript += `[${label}] ${m.content.slice(0, 1800)}\n`
    if (transcript.length >= COMPRESS_INPUT_CHARS) break
  }

  // ===== Lớp 1: LLM digest (utility core) =====
  let digest = ''
  let method: 'llm' | 'heuristic' = 'llm'
  try {
    const res = await withTimeout(
      callUtilityLLM(buildDigestPrompt(transcript), undefined, llmContext || 'context-compression', {
        temperature: 0.2,
        // TASK 55: 700 → 2000. Trước đây model utility là nemotron-lightning
        // (không reasoning) nên 700 đủ. Giờ space-bunny-free (reasoning model,
        // effort low) cần chừa headroom cho reasoning tokens + digest trọn vẹn
        // (verified: effort low + mt700 → finish=length, digest bị cắt giữa
        // chừng 1236 chars; mt2000 → dư dả, vẫn rẻ).
        maxTokens: 2000,
      }),
      DIGEST_LLM_TIMEOUT_MS,
      'Context compression LLM',
    )
    if (res?.content && res.content.trim().length > 50) {
      digest = res.content.trim()
      if (typeof res.tokensUsed === 'number' && res.tokensUsed > 0) onTokens?.(res.tokensUsed)
    }
  } catch {
    /* fall-through heuristic */
  }

  // Evidence cho heuristic fallback VÀ digest gate (P3-M4) — tính 1 lần:
  // caller truyền evidence (kể cả rỗng) → dùng nguyên; thiếu → suy xuất từ
  // chính transcript (workflow-engine không giữ evidence log).
  const evidenceSource = evidence ? evidence.slice(-40) : deriveEvidenceFromMessages(compressible)

  if (!digest) {
    method = 'heuristic'
    digest = buildHeuristicDigest(evidenceSource)
  } else {
    // ===== P3-M4 — DIGEST QUALITY GATE: LLM digest phải GIỮ dẫn chứng =====
    // ML.pdf §ROUGE: đo mất thông tin khi nén bằng độ rẻ (thuần toán, 0 LLM).
    // Digest bỏ mất danh từ kỹ thuật + số dẫn chứng → fallback heuristic
    // deterministic (evidence-preserving — đường an toàn thiết kế sẵn).
    const gate = checkDigestGate(digest, evidenceSource)
    if (!gate.passed) {
      console.warn(
        `[Compression] digest-gate-fallback: evidence coverage=${gate.coverage.toFixed(2)} < ${DIGEST_EVIDENCE_COVERAGE_MIN} ` +
        `(mất ${gate.tokens - gate.found}/${gate.tokens} token dẫn chứng` +
        `${gate.missing.length > 0 ? `: ${gate.missing.slice(0, 5).join(', ')}` : ''}) → fallback heuristic evidence-preserving`,
      )
      recordDigestGateEvent({ kind: 'compression', outcome: 'fallback', coverage: gate.coverage, method: 'heuristic' })
      method = 'heuristic'
      digest = buildHeuristicDigest(evidenceSource)
    } else {
      recordDigestGateEvent({ kind: 'compression', outcome: 'pass', coverage: gate.coverage, method: 'llm' })
      if (digest.length > DIGEST_MAX_CHARS) {
        digest = digest.slice(0, DIGEST_MAX_CHARS) + '…'
      }
    }
  }

  if (!digest) return null

  // ===== EXECUTION-EFFICIENCY S2.4 — ARTIFACT-REF SURVIVOR =====
  // Bất biến S2: tham chiếu 1 dòng tới artifact delegation ("📌 Báo cáo đầy đủ:
  // context_recall({runId:'sub_…'})") phải SỐNG SÓT mọi lần nén —digest (LLM
  // hay heuristic) có thể nuốt mất tool-result delegation, nhưng ĐỊA CHỈ truy
  // hồi nguyên vẹn không được mất (P2 tier 3: delegate report 9.000 chars bị
  // 4 lần nén tiêu hoá thành digest sau 1-2 chu kỳ). Trích deterministic mọi
  // dòng tham chiếu từ segment bị nén, append cuối digest (dedupe, cap 10).
  const ARTIFACT_REF_RE = /📌[^\n]*context_recall\(\{runId:'[^']{4,120}'\}\)[^\n]*/g
  const refSeen = new Set<string>()
  const artifactRefs: string[] = []
  for (const m of compressible) {
    const matches = m.content.match(ARTIFACT_REF_RE)
    if (!matches) continue
    for (const line of matches) {
      const key = line.trim()
      if (refSeen.has(key)) continue
      refSeen.add(key)
      artifactRefs.push(line.trim())
      if (artifactRefs.length >= 10) break
    }
    if (artifactRefs.length >= 10) break
  }
  if (artifactRefs.length > 0) {
    const refBlock = `\n\n📎 BÁO CÁO DELEGATION LƯU TRỮ (nguyên vẹn — truy hồi 1 bước, không bị nén):\n${artifactRefs.map(l => `- ${l}`).join('\n')}`
    digest = digest + refBlock
  }

  // ===== SUMMARIZER RECEIPT (Task 42) =====
  // Biên lai của lần tóm tắt: hash đầu vào (transcript đã nén) + hash đầu ra
  // (digest) + metadata phạm vi nén — giúp trace/audit được nội dung nào đã
  // được thay bằng digest (chống "nén xong mất dấu"). Fail-safe tuyệt đối:
  // createHash là thuần synchronous CPU, không thể fail theo ngữ cảnh thường.
  const sha12 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12)
  const receipt =
    `🧾 DIGEST RECEIPT sha256(in)=${sha12(transcript)} sha256(out)=${sha12(digest)}` +
    ` · nén ${compressible.length} messages (#${workStart}–#${compressEnd - 1})` +
    ` · ${removedChars}→${digest.length} chars · method=${method}`

  const digestMessage: CompressionMessage = {
    role: 'user',
    content: `${buildDigestMessageContent(digest)}\n\n${receipt}`,
  }

  messages.splice(workStart, compressEnd - workStart, digestMessage)

  // ===== CI-3 B2 — writer hook: lưu digest vào Kho Context (đọc lại khi cần) =====
  // Fire-and-forget: KHÔNG đợi archive xong (embed Qdrant có thể chậm/fail —
  // nén không được phép block vì layer tối ưu này); dynamic import tránh
  // circular import; fail-open tuyệt đối (archiveContext tự try/catch bên
  // trong, KHÔNG bao giờ throw). Bỏ qua hoàn toàn khi caller không truyền archive.
  if (params.archive) {
    try {
      void import('@/lib/context-store')
        .then(({ archiveContext }) => archiveContext({
          runId: params.archive?.runId ?? null,
          sessionId: params.archive?.sessionId ?? null,
          agentName: params.archive?.agentName ?? null,
          kind: 'digest',
          content: digest,
          tags: 'rolling-digest',
        }))
        .catch(() => { /* fail-open — archive là tối ưu, không bắt buộc */ })
    } catch { /* fail-open — dynamic import lỗi không được phép làm hỏng nén */ }
  }

  return {
    digest,
    digestChars: digestMessage.content.length,
    savedChars: removedChars - digestMessage.content.length,
    method,
    receipt,
  }
}
