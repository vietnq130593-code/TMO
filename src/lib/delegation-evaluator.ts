/**
 * DELEGATION EVALUATOR — trọng tài ĐỘC LẬP cho kết quả delegation
 * =====================================================
 * (user report 2026-09-14 #2: "hiện sub-agent tự verify, parent verify thủ
 * công theo prompt" — cần evaluator độc lập cho delegation)
 *
 * VẤN ĐỀ TRƯỚC FIX:
 *   - Sub-agent TỰ verify từng acceptance criterion trong prompt của chính nó
 *     (vòng cảm giác "học sinh tự chấm bài mình") — declare "ĐẠT" mà không ai soi.
 *   - Parent chỉ được NHẮC bằng prompt protocol ("tự KIỂM ĐỊNH LẠI bằng tool của
 *     bạn") — nếu parent quên/lười tin report thì lỗi delegation lọt qua.
 *
 * FIX:
 *   Sau khi sub-agent kết thúc, 1 LLM call với persona TRỌNG TÀI ĐỘC LẬP
 *   (system prompt riêng, không phải persona sub-agent, không phải persona
 *   parent) soi ĐỐI CHIẾU: task + acceptance criteria + báo cáo sub-agent +
 *   evidence tool thật → verdict JSON:
 *     { "pass": true|false, "confidence": 0-1, "gaps": ["..."], "note": "..." }
 *
 *   Verdict gắn vào SubAgentOutcome.evaluation → parent nhận KẾT QUẢ CHẤM
 *   ĐỘC LẬP ngay trong tool result (không tin lời tự chấm của sub-agent).
 *   delegate_task / dispatch_agent result đều có (cùng đường
 *   runSubAgentForProfile).
 *
 * Fail-open tuyệt đối: evaluator lỗi/timeout/parse fail → null (delegation
 * vẫn trả kết quả như cũ — đánh giá độc lập là TẰNG CƯỜNG, không phải điều
 * kiện tồn tại của delegation). 1 call, maxTokens 1200, temperature 0.2.
 *
 * IMP-1 (2026-09-30, Task G+H — delegation reinforcement-loop fix):
 *   - W1 (evidence đói): caller giờ truyền TOOL-RESULT TRANSCRIPT đầy đủ
 *     (các entry đã cap SUBAGENT_TOOL_RESULT_CHARS=4000 của sub-agent) thay
 *     vì preview 160 chars — evaluator tự tier mỗi entry ~600 chars (giữ
 *     đầu+đuôi), tổng ~12000 chars → trọng tài ĐỌC ĐƯỢC nội dung result thật
 *     (đếm, khớp file, pass/fail) để verify, không còn mù evidence.
 *   - W3 (truncate): maxTokens 700 → 1200 — 5 gaps×200 + note 300 tiếng
 *     Việt + JSON syntax ≈ 1400+ chars bị cắt cụt ở 700 → JSON hỏng → null.
 *   - W5 (calibration): parser KHÔNG tự chế confidence 0.8 cho verdict pass
 *     thiếu confidence (mâu thuẫn rule "thiếu bằng chứng ≤0.5") — mặc định
 *     0.5 trung thực cả 2 phía; pass thiếu/không hợp lệ → false (nghiêm).
 *   - Rule 3 (grace): endedBy=iteration_limit với phần CỐT LÕI đã có bằng
 *     chứng → pass theo PHẦN ĐÃ LÀM ĐƯỢC, phần còn lại vào "gaps" để parent
 *     re-delegate — không fail oan việc dở khi core đã xong (Task G: 52%
 *     sub-agent runs chết vì iteration_limit, 71% bị chấm CHƯA ĐẠT).
 */

import { callLLMForAgent } from '@/lib/llm'
import { findBalancedJson } from '@/lib/code-team/find-balanced-json'

// Task 20 (2026-09-03): outer timeout của evaluator — phải ≥ worst-case chuỗi
// fallback NVIDIA (~460s khi 3 lõi đầu hang; prober sẽ trip breaker cho lõi
// hang nên thường call về trong ~giây). Env-overridable.
const DELEGATION_EVAL_TIMEOUT_MS = Math.max(30_000, parseInt(process.env.DELEGATION_EVAL_TIMEOUT_MS || '600000', 10) || 600_000)

/** IMP-1 (W1): tier mỗi entry evidence ~600 chars (đầu 60% + đuôi ~40% —
 * JSON tool result mang tên tool + success ở đầu, phần kết luận ở đuôi) */
const EVAL_EVIDENCE_ENTRY_CHARS = 600
/** IMP-1 (W1): tổng ngân sách evidence cho prompt trọng tài ~12000 chars
 * (~20 entry tier 600 — đủ dày để verify, đủ gọn để không phình prompt) */
const EVAL_EVIDENCE_TOTAL_CHARS = 12_000

/** Verdict của trọng tài delegation độc lập */
export interface DelegationEvaluation {
  /** true = kết quả delegation ĐẠT theo task + acceptance criteria */
  pass: boolean
  /** 0-1 — calibrated như EVALUATOR của goal-loop */
  confidence: number
  /** Các khoảng trống / điều kiện chưa đạt (parent đọc để khắc phục) */
  gaps: string[]
  /** Ghi chú 1 dòng của trọng tài */
  note: string
}

const DELEGATION_EVALUATOR_SYSTEM_PROMPT = `Bạn là DELEGATION EVALUATOR — trọng tài ĐỘC LẬP đánh giá kết quả 1 nhiệm vụ được giao (delegation) cho một AI sub-agent.

Nguyên tắc SẮT:
1. Bạn KHÔNG tin báo cáo tự viết của sub-agent ("đã hoàn thành", "đã ĐẠT"...). Bạn CHỈ tin BẰNG CHỨNG TOOL trong evidence log: output lệnh, nội dung file đọc lại, kết quả test/lint.
2. Nhiệm vụ yêu cầu hành động (đọc/sửa/tạo/chạy) mà evidence KHÔNG có tool call tương ứng → "pass": false, gaps nêu thiếu bằng chứng gì.
3. GRACE CHO VIỆC DỞ: sub-agent kết thúc bởi "iteration_limit" (hết vòng lặp) mà phần CỐT LÕI nhiệm vụ ĐÃ có bằng chứng tool đầy đủ → hãy pass=true theo PHẦN ĐÃ LÀM ĐƯỢC — KHÔNG fail chỉ vì phần còn lại chưa xong; liệt kê phần chưa xong vào "gaps" để agent cha giao lại (re-delegate). Timeout/hết token: cùng nguyên tắc — đánh giá phần đã làm được, đừng trừng phạt việc dở nếu phần cốt lõi đã có bằng chứng. Chỉ khi phần CỐT LÕI thiếu bằng chứng → pass=false.
4. "gaps" = từng mục cụ thể còn thiếu so với task + acceptance criteria (tối đa 5). "note" = 1 câu tổng kết cho agent cha.
5. "confidence" = XÁC SUẤT NHIỆM VỤ ĐÃ ĐẠT ĐÚNG (P(pass=true)) — KHÔNG PHẢI độ chắc chắn của bạn về bản thân verdict (lỗi semantics: output 0.99 khi pass=false nghĩa là "tôi 99% chắc CHƯA đạt" — SAI semantics, hệ thống ghi KB học nhám run thất bại). Thang quy đổi BẮT BUỘC: pass=true + bằng chứng tool trực tiếp khớp hoàn toàn acceptance criteria → 0.85-0.98; pass=true + bằng chứng một phần → 0.5-0.75; pass=false → 0.0-0.3 (bằng chứng rõ chưa đạt) hoặc 0.3-0.5 (chưa chắc). NGHIÊM CẤM ≥0.5 khi "pass": false — hệ thống tự clamp về 0.3 nếu vi phạm.
6. Nếu sub-agent KHÔNG chạy tool nào (evidence rỗng + report thuần text) → pass chỉ khi nhiệm vụ là Q&A/thông tin thuần.

Output DUY NHẤT một dòng JSON hợp lệ (KHÔNG markdown fence, KHÔNG giải thích thêm):
{"pass": true|false, "confidence": 0.0-1.0, "gaps": ["..."], "note": "..."}`

/** Parse verdict — chống markdown fence + text thừa (mirror parseEvalVerdict) */
function parseEvaluation(raw: string): DelegationEvaluation | null {
  try {
    const text = raw.replace(/```(?:json)?/g, '')
    const jsonStr = findBalancedJson(text, 'pass')
    if (!jsonStr) return null
    const obj = JSON.parse(jsonStr) as Record<string, unknown>
    // IMP-1 (W5): mặc định NGHIÊM theo rule 2/5 của prompt — pass thiếu hoặc
    // không hợp lệ → false (KHÔNG tự chế "đạt"); confidence thiếu → 0.5 trung
    // thực CẢ 2 PHÍA (bỏ default 0.8 cho verdict pass — tự chế độ tin cao
    // mâu thuẫn rule "thiếu bằng chứng → confidence ≤0.5"). JSON rác hoàn
    // toàn → null ở caller (fail-open giữ nguyên).
    const pass = obj.pass === true
    let confidence = typeof obj.confidence === 'number' ? Math.min(1, Math.max(0, obj.confidence)) : 0.5
    // ROUND-8 AUDIT (2026-09-30) — CALIBRATION GUARD (mirror parseEvalVerdict
    // của goal-loop): pass=false + confidence cao = LLM hiểu nhầm semantics
    // ("độ chắc chắn về verdict" thay vì P(pass)) → clamp 0.3 phòng thủ.
    if (!pass && confidence > 0.3) confidence = 0.3
    const gaps = Array.isArray(obj.gaps) ? obj.gaps.map(g => String(g).slice(0, 200)).filter(Boolean).slice(0, 5) : []
    const note = typeof obj.note === 'string' ? obj.note.slice(0, 300) : ''
    return { pass, confidence, gaps, note }
  } catch {
    return null
  }
}

/** Tier 1 entry evidence: giữ đầu 60% + đuôi ~40% (mirror truncateResult của
 * subagent-delegate — không import tránh circular) */
function tierEvidenceEntry(s: string, maxChars = EVAL_EVIDENCE_ENTRY_CHARS): string {
  if (s.length <= maxChars) return s
  const head = Math.floor(maxChars * 0.6)
  const tail = Math.max(80, maxChars - head - 60)
  return s.slice(0, head) + `…[cắt ${s.length - head - tail}]…` + s.slice(-tail)
}

/** IMP-1 (W1) — dựng evidence block từ TOOL-RESULT TRANSCRIPT thật của
 * sub-agent: đi từ CUỐI về đầu (entry mới nhất ưu tiên) trong ngân sách
 * ~EVAL_EVIDENCE_TOTAL_CHARS. Thay cho preview 160 chars cũ — trọng tài
 * giờ ĐỌC ĐƯỢC nội dung result để verify (đếm, khớp file, pass/fail). */
function buildEvidenceBlock(evidence: string[]): string {
  if (evidence.length === 0) return '(KHÔNG có tool call nào — báo cáo dưới đây hoàn toàn từ kiến thức model)'
  const kept: string[] = []
  let budget = EVAL_EVIDENCE_TOTAL_CHARS
  for (let i = evidence.length - 1; i >= 0; i--) {
    const tiered = tierEvidenceEntry(evidence[i])
    if (tiered.length + 3 > budget) break // "- " prefix + "\n"
    kept.push(tiered)
    budget -= tiered.length + 3
  }
  if (kept.length === 0) {
    // Entry cuối dài hơn toàn bộ ngân sách vẫn phải thấy ít nhất 1 entry tier
    return `- ${tierEvidenceEntry(evidence[evidence.length - 1])}`
  }
  return kept.reverse().map(e => `- ${e}`).join('\n')
}

/**
 * Đánh giá độc lập kết quả 1 delegation. Trả về null khi:
 *  - LLM fail / timeout (fail-open — caller giữ kết quả delegation như cũ)
 *  - Không có gì để đánh giá (task rỗng)
 *
 * IMP-1 (W1): `evidence` giờ nhận TOOL-RESULT TRANSCRIPT entry đầy đủ của
 * sub-agent (mỗi entry là JSON {tool, success, result} đã cap 4000 chars ở
 * caller) — KHÔNG còn là preview 160 chars. Tiering 600/entry + 12k tổng
 * diễn ra ở đây (buildEvidenceBlock).
 */
export async function evaluateDelegationOutcome(params: {
  agentName: string
  agentId?: string
  task: string
  acceptanceCriteria?: string
  report: string
  evidence: string[]
  endedBy: string
  provider: string
  model: string
  abortCheck?: () => boolean
  onTokens?: (tokens: number) => void
}): Promise<DelegationEvaluation | null> {
  const { agentName, task, acceptanceCriteria, report, evidence, endedBy, provider, model, abortCheck, onTokens } = params
  if (!task.trim()) return null

  const evidenceBlock = buildEvidenceBlock(evidence)

  const prompt = `NHIỆM VỤ ĐƯỢC GIAO (cho sub-agent ${agentName}):
${task.slice(0, 1500)}

ĐIỀU KIỆN HOÀN THÀNH (acceptance criteria — nếu có):
${acceptanceCriteria ? acceptanceCriteria.slice(0, 800) : '(không khai báo — đánh giá theo nhiệm vụ)'}

BÁO CÁO CỦA SUB-AGENT (chỉ là tuyên bố — cần đối chiếu bằng chứng):
${report.slice(0, 2500)}

NHẬT KÝ BẰNG CHỨNG TOOL THẬT (sự thật duy nhất đáng tin — mỗi dòng là JSON {tool, success, result} của 1 tool call THẬT; một số dòng bị cắt giữa chừng vì giới hạn dung lượng nhưng nội dung vẫn thật):
${evidenceBlock}

(ĐỌC KỸ nội dung "result" để đối chiếu: đếm số dòng/kết quả, khớp tên file/lệnh, pass/fail — KHÔNG chỉ nhìn tên tool + success.)

SUB-AGENT KẾT THÚC BỞI: ${endedBy}

ĐÁNH GIÁ: nhiệm vụ delegation này đã hoàn thành ĐẠT chưa? Output JSON.`

  try {
    const result = await Promise.race([
      callLLMForAgent(prompt, { provider, model }, DELEGATION_EVALUATOR_SYSTEM_PROMPT, {
        agentId: params.agentId || `delegation-evaluator:${agentName}`,
        agentName: `${agentName} (delegation-evaluator)`,
        temperature: 0.2,
        // IMP-1 (W3): 700 → 1200 — worst-case 5 gaps×200 + note 300 tiếng
        // Việt + JSON syntax ≈ 1400+ chars bị truncate ở 700 → JSON hỏng →
        // null (rơi fail-open W2). 1200 ≈ parity goal-loop evaluator.
        maxTokens: 1200,
        abortCheck,
      }),
      new Promise<never>((_, reject) =>
        // Task 20 (2026-09-03): 90s cũ giết chuỗi fallback trước khi tới minimax —
        // nâng 600s ≥ worst-case (~460s khi 3 lõi đầu hang NIM); prober trip
        // breaker cho lõi hang nên evaluation thường trở lại ~giây. Fail-open
        // giữ nguyên (timeout → null).
        setTimeout(() => reject(new Error(`DelegationEvaluator timed out after ${Math.round(DELEGATION_EVAL_TIMEOUT_MS / 1000)}s`)), DELEGATION_EVAL_TIMEOUT_MS),
      ),
    ])
    if (!result?.content) return null
    if (typeof result.tokensUsed === 'number' && result.tokensUsed > 0) onTokens?.(result.tokensUsed)
    return parseEvaluation(result.content)
  } catch {
    return null // fail-open — delegation không bị phụ thuộc evaluator
  }
}
