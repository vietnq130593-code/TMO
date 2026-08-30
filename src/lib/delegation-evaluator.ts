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
 * kiện tồn tại của delegation). 1 call, maxTokens 700, temperature 0.2.
 */

import { callLLMForAgent } from '@/lib/llm'
import { findBalancedJson } from '@/lib/code-team/find-balanced-json'

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
3. Sub-agent kết thúc bằng timeout/hết vòng/hết token → đánh giá theo phần ĐÃ LÀM ĐƯỢC (đừng trừng phạt việc dở nếu phần cốt lõi đã có bằng chứng).
4. "gaps" = từng mục cụ thể còn thiếu so với task + acceptance criteria (tối đa 5). "note" = 1 câu tổng kết cho agent cha.
5. "confidence" calibrated trung thực: chỉ ≥0.9 khi bằng chứng tool trực tiếp khớp hoàn toàn; thiếu bằng chứng → ≤0.5.
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
    const pass = obj.pass === true
    const confidence = typeof obj.confidence === 'number' ? Math.min(1, Math.max(0, obj.confidence)) : pass ? 0.8 : 0.5
    const gaps = Array.isArray(obj.gaps) ? obj.gaps.map(g => String(g).slice(0, 200)).filter(Boolean).slice(0, 5) : []
    const note = typeof obj.note === 'string' ? obj.note.slice(0, 300) : ''
    return { pass, confidence, gaps, note }
  } catch {
    return null
  }
}

/**
 * Đánh giá độc lập kết quả 1 delegation. Trả về null khi:
 *  - LLM fail / timeout (fail-open — caller giữ kết quả delegation như cũ)
 *  - Không có gì để đánh giá (task rỗng)
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

  const evidenceBlock = evidence.length > 0
    ? evidence.slice(-20).map(e => `- ${e}`).join('\n').slice(0, 6000)
    : '(KHÔNG có tool call nào — báo cáo dưới đây hoàn toàn từ kiến thức model)'

  const prompt = `NHIỆM VỤ ĐƯỢC GIAO (cho sub-agent ${agentName}):
${task.slice(0, 1500)}

ĐIỀU KIỆN HOÀN THÀNH (acceptance criteria — nếu có):
${acceptanceCriteria ? acceptanceCriteria.slice(0, 800) : '(không khai báo — đánh giá theo nhiệm vụ)'}

BÁO CÁO CỦA SUB-AGENT (chỉ là tuyên bố — cần đối chiếu bằng chứng):
${report.slice(0, 2500)}

NHẬT KÝ BẰNG CHỨNG TOOL THẬT (sự thật duy nhất đáng tin):
${evidenceBlock}

SUB-AGENT KẾT THÚC BỞI: ${endedBy}

ĐÁNH GIÁ: nhiệm vụ delegation này đã hoàn thành ĐẠT chưa? Output JSON.`

  try {
    const result = await Promise.race([
      callLLMForAgent(prompt, { provider, model }, DELEGATION_EVALUATOR_SYSTEM_PROMPT, {
        agentId: params.agentId || `delegation-evaluator:${agentName}`,
        agentName: `${agentName} (delegation-evaluator)`,
        temperature: 0.2,
        maxTokens: 700,
        abortCheck,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('DelegationEvaluator timed out after 90s')), 90_000),
      ),
    ])
    if (!result?.content) return null
    if (typeof result.tokensUsed === 'number' && result.tokensUsed > 0) onTokens?.(result.tokensUsed)
    return parseEvaluation(result.content)
  } catch {
    return null // fail-open — delegation không bị phụ thuộc evaluator
  }
}
