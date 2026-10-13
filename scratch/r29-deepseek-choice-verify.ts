/**
 * VERIFY 2026-10-14 — deepseek-v4.1-flash là LỰA CHỌN dropdown chính thức
 * (user request "thêm deepseek-v4.1-flash vào danh sách lựa chọn"):
 * gọi callLLMForAgent đúng như agent thật với model 'deepseek-ai/deepseek-
 * v4.1-flash' → nhánh NIM mới trong callLLMForAgent phải route THẬT qua NIM
 * (provider='nvidia' trong result) và trả lời NHANH (~2s/call — live-probe
 * Task 28), không rơi xuống chuỗi Zen fallback.
 *
 * Chạy: bun scratch/r29-deepseek-choice-verify.ts
 * Exit: 0 = PASS · 1 = FAIL · 2 = crash.
 */
process.env.LLM_QUIET_INIT = '1'

export {}

async function main(): Promise<void> {
  const { callLLMForAgent } = await import('../src/lib/llm')
  const t0 = Date.now()
  const result = await callLLMForAgent(
    'Trả lời đúng một từ: OK',
    { provider: 'zen', model: 'deepseek-ai/deepseek-v4.1-flash' },
    'Bạn là một endpoint LLM đang được kiểm thử sức khỏe. Trả lời cực ngắn.',
    { agentName: 'deepseek-choice-verify' },
  )
  const ms = Date.now() - t0
  console.log('─'.repeat(64))
  console.log(`⏱ ${ms}ms | provider=${result.provider} | model=${result.model}`)
  console.log(`content: ${JSON.stringify((result.content || '').slice(0, 200))}`)
  if (result.error) console.log(`error: ${String(result.error).slice(0, 300)}`)
  // PASS: route NIM thật (provider nvidia + model đúng) + có content
  const ok = result.provider === 'nvidia' && result.model.includes('deepseek-v4.1-flash') && !!(result.content && result.content.length > 0)
  console.log(ok ? '✅ PASS — chọn deepseek-v4.1-flash route NIM thật' : '❌ FAIL — không route NIM hoặc không có content')
  process.exit(ok ? 0 : 1)
}

main().catch(e => {
  console.error('❌ script crash:', e)
  process.exit(2)
})
