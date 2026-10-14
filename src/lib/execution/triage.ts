/**
 * TRIAGE — PHÂN LOẠI YÊU CẦU TẦNG API (GIAO THỨC THẦY TRUYỀN LẠI — Bước 1)
 * ==========================================================================
 * R11 (2026-10-14 — lượt quan sát thứ 5): mọi tin nhắn chat đang đi nguyên vào
 * goal loop đa chu kỳ (PLAN→EXECUTE→VERIFY→EVALUATE + trọng tài + nợ kỹ thuật
 * + khai thác bài học + subagent). Bằng chứng: "1+1=?" mất 36s; "bạn là model
 * gì" 500.891 tokens / 4.5 phút; câu hỏi Brain 646.338 tokens + 2 subagent +
 * crash bộ nhớ (PM2 restart 8 lần). Bộ máy nặng cho việc nhẹ là thất bại của
 * TẦNG ĐIỀU PHỐI, không phải sự cần mẫn của agent.
 *
 * Giáo thức Thầy — Bước 1 (NGHE & PHÂN LOẠI):
 *   Loại A — Câu hỏi/hội thoại: trả lời trực tiếp 1 lượt gọi, KHÔNG goal loop,
 *            KHÔNG todo, KHÔNG trọng tài, KHÔNG khai thác bài học.
 *   Loại C — Việc thật (khảo sát hệ thống / đọc sửa file / nhiều bước / tạo
 *            sản phẩm): mở ĐẦY ĐỦ bộ máy goal loop như cũ.
 *
 * Thiết kế 2 tầng — rẻ trước đắt sau:
 *   1. HEURISTIC (0 chi phí): tin nhắn trivia/chào hỏi/đố tính/nhận diện
 *      câu hỏi thuần túy không đụng hệ thống → quyết định ngay.
 *   2. LLM CLASSIFIER (1 call rẻ, utility-core ~200 tokens): ca mơ hồ —
 *      model nhỏ phán question|task bằng JSON. Lỗi/timeout → mặc định
 *      'task' (AN TOÀN: giữ nguyên hành vi goal loop cũ — fast path không
 *      bao giờ làm hỏng việc thật, chỉ có thể bỏ lỡ cơ hội rẻ hoá).
 *
 * Env gate: ENABLE_CHAT_TRIAGE (mặc định BẬT; '0' → tắt, mọi tin nhắn về
 * goal loop như trước R11 — rollback 1 biến môi trường, không cần revert code).
 */

export type ChatRequestKind = 'simple_question' | 'task'

export interface TriageResult {
  kind: ChatRequestKind
  via: 'heuristic' | 'llm'
  reason: string
}

export const TRIAGE_ENABLED = (process.env.ENABLE_CHAT_TRIAGE ?? '1').trim() !== '0'

/** Tin nhắn trivia — chào hỏi, xác nhận, cảm ơn, test 1 từ (bằng chứng R11:
 *  4 phiên test "Trả lời 1 từ: OK" vẫn nạp toàn bộ goal loop mỗi phiên). */
const TRIVIAL_RE = /^(ok|okay|okey|ok\.|yes|no|ừ|ừm|ok rồi|được rồi|xong|cảm ơn|cảm ơn bạn|thanks|thank you|hello|hi|hey|xin chào|chào bạn|chào|test|tes?t\.?)\s*[!.]?$/i

/** Đố tính / tính toán thuần túy — "1+1=?", "2*3" (chỉ toàn số + toán tử) */
const ARITH_RE = /^[\d\s+\-*/().^,%=?]+$/

/** Hình thái CÂU HỎI đơn thuần (không mệnh lệnh hành động) */
const SIMPLE_Q_RE = /^(cho tôi biết|cho tôi hỏi|nói cho tôi biết|cho em hỏi|bạn là|bạn đang|bạn có|bạn làm được gì|bạn tên gì|bạn hiểu gì|what|who|why|how|tại sao|vì sao|như thế nào|thế nào|là gì|nghĩa là là gì|giải thích|khi nào|bao giờ|ai |có phải)/i

/** Động từ MỆNH LỆNH HÀNH ĐỘNG — dấu hiệu việc thật (Loại C) */
const TASK_VERB_RE = /(tiến hành|thực hiện|triển khai|tạo ra|tạo mới|tạo cho|tạo một|viết|sửa|fix|cài đặt|cài |build|xây dựng|thêm |xóa |gỡ |cập nhật|update |deploy|khảo sát|kiểm tra|kiểm chứng|xác định|phân tích|trích xuất|đếm giúp|đếm số|liệt kê|tìm trong|tìm kiếm|mở file|đọc file|đọc giúp|chạy giúp|chạy |run |execute|tối ưu|refactor|migrate|dọn dẹp|dọn |setup|cấu hình|so sánh|đánh giá|rà soát|audit|quét)/i

/** Chủ ngữ ĐỐI TƯỢNG HỆ THỐNG — câu hỏi chạm vào dữ liệu thật của hệ thống
 *  (chỉ áp cho ca "hình thái câu hỏi" — quyết định có cần classifier không).
 *  LƯU Ý: không liệt kê "model" — câu "bạn là model gì" trả lời được từ ngữ
 *  cảnh phiên (fast-path prompt có model cấu hình + servedModel metadata). */
const SYSTEM_DATA_RE = /(hệ thống|system|workspace|database|cơ sở dữ liệu|\bdb\b|schema|bảng |table|api|endpoint|server|log|file|thư mục|folder|mã nguồn|source code|repo|git|brain|não|neo4j|qdrant|agent |agents|kpi|metrics|token đã dùng|lượng token|vận hành|kiến trúc)/i

/** Hỏi về CHÍNH MÌNH (agent/model) — fast-path trả lời từ metadata phiên */
const SELF_META_RE = /(bạn là (gì|ai|model|agent) gì|đang là model|đang chạy (trên )?model|model gì|bạn dùng model|bạn đang dùng)/i

const MAX_FAST_MSG_CHARS = 600 // dài hơn = work order, vào goal loop

/**
 * Phân loại yêu cầu chat. FAIL-SAFE tuyệt đối theo 1 hướng: mọi ca không chắc
 * → 'task' (giữ hành vi cũ). Heuristic bắt các dạng rõ ràng; classifier LLM
 * chỉ chạy cho ca mơ hồ (tối đa 1 call, timeout 25s, lỗi → 'task').
 */
export async function classifyChatRequest(input: {
  userMessage: string
  hasAttachments?: boolean
  agentName?: string
}): Promise<TriageResult> {
  if (!TRIAGE_ENABLED) return { kind: 'task', via: 'heuristic', reason: 'triage disabled (ENABLE_CHAT_TRIAGE=0)' }

  const msg = (input.userMessage || '').trim()
  if (msg.length === 0) return { kind: 'simple_question', via: 'heuristic', reason: 'empty message' }
  if (input.hasAttachments) return { kind: 'task', via: 'heuristic', reason: 'has attachments — cần xử lý file' }
  if (msg.length > MAX_FAST_MSG_CHARS) return { kind: 'task', via: 'heuristic', reason: `dài ${msg.length} chars (> ${MAX_FAST_MSG_CHARS}) — work order` }

  if (TRIVIAL_RE.test(msg)) return { kind: 'simple_question', via: 'heuristic', reason: 'trivial/ack (chào hỏi, xác nhận, test 1 từ)' }
  if (ARITH_RE.test(msg)) return { kind: 'simple_question', via: 'heuristic', reason: 'đố tính/calculation thuần túy' }

  const isSelfMeta = SELF_META_RE.test(msg)
  const needsSystemData = SYSTEM_DATA_RE.test(msg)
  const hasTaskVerb = TASK_VERB_RE.test(msg)
  const isSimpleShape = SIMPLE_Q_RE.test(msg)

  // Hỏi về chính mình (model/agent/danh tính) → fast-path trả lời từ metadata
  // phiên (servedModel ghi trong response; prompt fast-path nêu model cấu hình)
  if (isSelfMeta && !hasTaskVerb) {
    return { kind: 'simple_question', via: 'heuristic', reason: 'câu hỏi meta về agent/model — trả lời từ metadata phiên' }
  }

  // Câu hỏi thuần túy, KHÔNG động từ hành động, KHÔNG chạm dữ liệu hệ thống
  if (isSimpleShape && !hasTaskVerb && !needsSystemData) {
    return { kind: 'simple_question', via: 'heuristic', reason: 'câu hỏi kiến thức/đối thoại thuần túy' }
  }

  // Có mệnh lệnh hành động + KHÔNG phải hình thái hỏi ngắn → việc thật
  if (hasTaskVerb && !isSimpleShape) {
    return { kind: 'task', via: 'heuristic', reason: 'mệnh lệnh hành động (từ khóa việc)' }
  }

  // ── Ca mơ hồ (hỏi mà chạm hệ thống / mệnh lệnh mà hình thái hỏi / không
  // khớp rule nào) → classifier LLM 1 call rẻ, quyết định cuối. ──
  const llm = await classifyViaLLM(msg, input.agentName)
  if (llm) return llm
  return { kind: 'task', via: 'heuristic', reason: 'default-safe (classifier không trả lời — giữ goal loop)' }
}

/** Classifier LLM — utility-core (chuỗi failover SBF sẵn có), JSON 1 dòng.
 *  Trả null khi lỗi/timeout/không parse được (caller mặc định 'task'). */
async function classifyViaLLM(msg: string, agentName?: string): Promise<TriageResult | null> {
  try {
    const { callUtilityLLM } = await import('@/lib/llm')
    const sys = 'Bạn là bộ phân loại yêu cầu cho hệ thống AI-agent. Chỉ xuất JSON đúng 1 dòng: {"type":"question"} hoặc {"type":"task"}. Không giải thích, không markdown.'
    const prompt = `Yêu cầu gửi tới agent ${agentName || 'trợ lý'}:\n"""${msg.slice(0, 500)}"""\n\nPhân loại:\n- "question": câu hỏi/hội thoại agent trả lời NGAY bằng kiến thức sẵn có hoặc thông tin về chính mình trong phiên — KHÔNG cần đọc file/DB/hệ thống, KHÔNG cần nhiều bước.\n- "task": việc đòi khảo sát hệ thống thật (đọc file, truy vấn DB, đếm/kiểm tra hiện trạng), sửa/tạo code, chạy lệnh, phân tích dữ liệu, hoặc thực hiện nhiều bước.\nChỉ xuất JSON:`
    const res = await Promise.race([
      callUtilityLLM(prompt, sys, 'triage:chat', { maxTokens: 200, temperature: 0 }),
      new Promise<null>(r => setTimeout(() => r(null), 25_000)),
    ])
    const content = res && typeof res.content === 'string' ? res.content : ''
    const m = content.match(/"(question|task)"/i)
    if (!m) return null
    return m[1].toLowerCase() === 'question'
      ? { kind: 'simple_question', via: 'llm', reason: 'classifier LLM phán question' }
      : { kind: 'task', via: 'llm', reason: 'classifier LLM phán task' }
  } catch {
    return null
  }
}
