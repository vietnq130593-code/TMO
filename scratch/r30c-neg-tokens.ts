process.env.LLM_QUIET_INIT = '1'
export {}
async function main() {
  const { callLLMForAgent } = await import('../src/lib/llm')
  const t0 = Date.now()
  // TÁI HIỆN ĐÚNG LỖI CHAT: maxTokens = -1 (MEGATRON "unlimited")
  const result = await callLLMForAgent(
    'Trả lời đúng một từ: OK',
    { provider: 'zen', model: 'deepseek-ai/deepseek-v4.1-flash' },
    'Bạn là endpoint LLM kiểm thử sức khỏe. Trả lời cực ngắn.',
    { agentName: 'r30-neg-tokens', maxTokens: -1, temperature: 0.5 },
  )
  console.log(`⏱ ${((Date.now()-t0)/1000).toFixed(1)}s | provider=${result.provider} | model=${result.model}`)
  console.log(`content: ${JSON.stringify((result.content||'').slice(0,120))}`)
  if (result.error) console.log(`error: ${String(result.error).slice(0,200)}`)
  const ok = result.provider === 'nvidia' && !!(result.content && result.content.length > 0)
  console.log(ok ? '✅ FIX PASS: maxTokens=-1 không còn HTTP 400 — deepseek trả lời được' : '❌ STILL FAIL')
  process.exit(ok ? 0 : 1)
}
main().catch(e => { console.error('crash:', e); process.exit(2) })
