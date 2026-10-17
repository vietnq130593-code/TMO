/**
 * R25-b live-verify — gọi NIM qua ĐÚNG đường server của app:
 * 1. callLLMForAgent với glm-5.3-flash (14 AgentProfile giờ dùng model này)
 *    + tool_calls (đường agent thật)
 * 2. callLLMForAgent với moonshotai/kimi-k3 → phải trả lỗi EOL rõ ràng
 * 3. callLLMSlot (extraction) → glm-5.3-flash
 * Chạy: bun scratch/r25-nim-verify.ts
 */
import { callLLMForAgent, callLLMSlot } from '../src/lib/llm'

async function main() {
  console.log('═══ [1] callLLMForAgent · z-ai/glm-5.3-flash (kèm tools)')
  const t1 = Date.now()
  const r1 = await callLLMForAgent(
    'Trả lời ngắn 1 câu: bạn là model gì? Kèm gọi tool list_files để liệt kê thư mục gốc workspace.',
    { provider: 'nvidia', model: 'z-ai/glm-5.3-flash' },
    'Bạn là trợ lý trong The Magnum Opus. Trả lời tiếng Việt ngắn gọn.',
    {
      agentId: 'r25-verify', agentName: 'R25-Verify',
      tools: [{
        type: 'function' as const,
        function: {
          name: 'list_files',
          description: 'Liệt kê file trong một thư mục',
          parameters: { type: 'object', properties: { path: { type: 'string', description: 'Đường dẫn thư mục' } }, required: ['path'] },
        },
      }],
    },
  )
  console.log(`[${Date.now() - t1}ms] content: ${r1.content.slice(0, 160) || '(rỗng)'}`)
  console.log(`tool_calls: ${r1.tool_calls?.length ?? 0}${r1.tool_calls?.length ? ' → ' + r1.tool_calls.map(t => t.function.name).join(',') : ''}`)
  console.log(`tokens: ${r1.tokensUsed ?? 0} · error: ${r1.error ?? 'không'}`)

  console.log('\n═══ [2] callLLMForAgent · moonshotai/kimi-k3 (EOL — phải lỗi rõ ràng)')
  const r2 = await callLLMForAgent(
    'test',
    { provider: 'nvidia', model: 'moonshotai/kimi-k3' },
    undefined,
    { agentId: 'r25-verify', agentName: 'R25-Verify' },
  )
  console.log(`error: ${r2.error?.slice(0, 220) ?? 'KHÔNG có lỗi (SAI — kimi-k3 đã EOL)'}`)

  console.log('\n═══ [3] callLLMSlot · extraction (glm-5.3-flash)')
  const t3 = Date.now()
  const r3 = await callLLMSlot(0, 'Trích xuất thực thể từ câu sau, trả JSON {entities: [{name, type}]}: "Nhà máy điện mặt trời Đắk Nông công suất 1GW do Tập đoàn Hoà Phát xây năm 2025."', 'Trích xuất thực thể, chỉ trả JSON thuần.')
  console.log(`[${Date.now() - t3}ms] content: ${r3.content.slice(0, 220) || '(rỗng)'}`)
  console.log(`model: ${r3.model} · tokens: ${r3.tokensUsed ?? 0} · error: ${r3.error ?? 'không'}`)
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })
