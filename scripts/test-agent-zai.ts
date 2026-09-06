/**
 * TEST AGENT PATH QUA Z-AI SDK (2026-09-06 — user directive "tất cả các
 * agents đều sử dụng Z-ai-sdk")
 *
 * Gọi callLLMForAgent() — ĐÚNG đường đi của goal-loop / research-team /
 * code-team / smolab (agent config từ DB) — xác nhận route zai hoạt động
 * thật, không chỉ qua utility/chat.
 *
 * Chạy: cd /home/z/tmo-app && (unset DATABASE_URL; bun scripts/test-agent-zai.ts)
 * (unset DATABASE_URL như pm2 — shell env trỏ sai DB)
 */
import { callLLMForAgent, callLLM, callUtilityLLM } from '../src/lib/llm'

async function main() {
  const agentConfig = { provider: 'nvidia', model: 'moonshotai/kimi-k3' }

  console.log('=== [1] AGENT PATH — callLLMForAgent (goal-loop/team path) ===')
  const t1 = Date.now()
  const agent = await callLLMForAgent(
    'Bạn là một agent trong hệ thống TMO. Trả lời ngắn: 2+2 bằng mấy? Nêu tên 1 tool bạn muốn gọi nếu cần tra cứu.',
    agentConfig,
    'Bạn là agent kiểm thử hệ thống TMO. Luôn trả lời tiếng Việt, ngắn gọn.',
    { agentId: 'test-agent-zai', agentName: 'TEST-ZAI-AGENT' },
  )
  console.log(`→ ${(Date.now() - t1) / 1000}s | provider=${agent.provider} | model=${agent.model}`)
  console.log(`→ content: ${agent.content.slice(0, 160)}`)
  if (agent.error) console.log(`→ ERROR: ${agent.error}`)

  console.log('\n=== [2] CHAT PATH — callLLM (classification/health path) ===')
  const t2 = Date.now()
  const chat = await callLLM('Phân loại câu hỏi: "Thủ đô Nhật Bản?" → trả về JSON {"type":"factual"}', 'You are a classifier.', 'test-chat-zai', { temperature: 0.1, maxTokens: 200 })
  console.log(`→ ${(Date.now() - t2) / 1000}s | provider=${chat.provider} | model=${chat.model}`)
  console.log(`→ content: ${chat.content.slice(0, 160)}`)
  if (chat.error) console.log(`→ ERROR: ${chat.error}`)

  console.log('\n=== [3] UTILITY PATH — callUtilityLLM (memory/KB nền) ===')
  const t3 = Date.now()
  const util = await callUtilityLLM('Tóm tắt 1 câu: "Hệ thống TMO có 13 agents." (JSON {"summary":"..."})', undefined, 'test-utility-zai')
  console.log(`→ ${(Date.now() - t3) / 1000}s | provider=${util.provider} | model=${util.model}`)
  console.log(`→ content: ${util.content.slice(0, 160)}`)
  if (util.error) console.log(`→ ERROR: ${util.error}`)

  const allOk = [agent, chat, util].every(r => r.provider === 'zai-sdk' && (r.content || (r.tool_calls?.length ?? 0) > 0))
  console.log(`\n=== KẾT QUẢ: ${allOk ? '✓ TOÀN BỘ 3 LÕI ROUTE QUA Z-AI SDK' : '✗ CÓ LÕI KHÔNG QUA ZAI'} ===`)
  process.exit(allOk ? 0 : 1)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
