/**
 * VERIFY NIM RESCUE (Task 28 — 2026-10-13, live-probe sau khi thêm tier):
 * gọi callLLMForAgent ĐÚNG như agent thật (provider 'zen' + model
 * 'space-bunny-free' — cấu hình PHIÊN 7 của toàn bộ 13 agents) → chuỗi Zen
 * chết (free-tier 403 toàn cục cho oc_sk key, verified live-probe cùng ngày:
 * HTTP + CLI custom opencode-k* + CLI native đều 403 FreeTierError) → tier
 * NIM RESCUE deepseek-v4.1-flash phải đỡ lấy → "agent không chết".
 *
 * Chạy: bun scratch/r28-nim-rescue-verify.ts
 * Exit: 0 = PASS (agent sống qua rescue) · 1 = FAIL (toàn chuỗi chết) · 2 = crash.
 */
process.env.LLM_QUIET_INIT = '1'

// FIX 2026-10-14 (TS2393 — Duplicate function implementation `main`): script
// global-scope va chạm với r47-cleanup-test-data.ts. `export {}` → module scope.
export {}

async function main(): Promise<void> {
  const { callLLMForAgent } = await import('../src/lib/llm')
  const t0 = Date.now()
  const result = await callLLMForAgent(
    'Kiểm thử chuỗi failover: trả lời đúng 1 câu ngắn gọn — endpoint đang sống.',
    { provider: 'zen', model: 'space-bunny-free' },
    'Bạn là một endpoint LLM đang được kiểm thử sức khỏe. Trả lời cực ngắn.',
    { agentName: 'rescue-verify' },
  )
  const ms = Date.now() - t0
  console.log('─'.repeat(64))
  console.log(`⏱ ${ms}ms | provider=${result.provider} | model=${result.model}`)
  console.log(`content: ${JSON.stringify((result.content || '').slice(0, 200))}`)
  if (result.error) console.log(`error: ${String(result.error).slice(0, 300)}`)
  const ok = Boolean(result.content && result.content.length > 0)
  console.log(ok ? '✅ PASS — agent sống (NIM RESCUE đỡ)' : '❌ FAIL — toàn chuỗi chết')
  process.exit(ok ? 0 : 1)
}

main().catch(e => {
  console.error('❌ script crash:', e)
  process.exit(2)
})
