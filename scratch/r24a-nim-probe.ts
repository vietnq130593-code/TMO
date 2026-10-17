/**
 * R24-a — probe nhanh NIM extraction model (nemotron-3-ultra-550b) còn sống
 * không sau sóng 503. KHÔNG in key/secret — chỉ in trạng thái HTTP.
 * Chạy: cd /home/z/tmo-app && bun scratch/r24a-nim-probe.ts
 */
import { callLLMSlot } from '../src/lib/llm'

const t0 = Date.now()
try {
  const r = await callLLMSlot(-1, 'Reply with the single word: ok', 'You are a health probe. Reply with exactly: ok', 'extraction', { maxTokens: 8 })
  const content = (r?.content || '').trim()
  console.log(`[PROBE] ${content ? 'OK' : 'FAIL'} — content="${content.slice(0, 40)}" finish=${(r as { finish_reason?: string }).finish_reason ?? '?'} ${content ? '' : `error=${String(r?.error ?? '?').slice(0, 140)}`} (${Date.now() - t0}ms)`)
} catch (err) {
  console.log(`[PROBE] THROW — ${err instanceof Error ? err.message.slice(0, 140) : String(err)} (${Date.now() - t0}ms)`)
}
