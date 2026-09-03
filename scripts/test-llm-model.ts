/**
 * TEST MODEL NVIDIA NIM — gọi ĐÚNG 1 model qua stack LLM THẬT của app
 * (ProviderKeyPool xoay 4 key × 3 sweep — KHÔNG fallback chain, chỉ model được chỉ định).
 *
 * Chạy từ thư mục gốc repo (nơi có file .env):
 *   bun scripts/test-llm-model.ts moonshotai/kimi-k3
 *   bun scripts/test-llm-model.ts deepseek-ai/deepseek-v4-pro-0813
 *   bun scripts/test-llm-model.ts deepseek-ai/deepseek-v4-flash-0731
 *   bun scripts/test-llm-model.ts minimaxai/minimax-m3
 *
 * Alias ngắn cũng được chấp nhận:
 *   kimi-k3 | v4-pro | v4-flash | minimax-m3
 *
 * Exit code: 0 = PASS (model trả lời được), 1 = FAIL, 2 = sai cú pháp.
 * Mỗi lần gọi tốn ~ vài trăm tokens của key NVIDIA (đi qua đúng key pool app đang dùng).
 */
import { callLLM } from '@/lib/llm'

const ALIASES: Record<string, string> = {
  'kimi-k3': 'moonshotai/kimi-k3',
  'kimi': 'moonshotai/kimi-k3',
  'v4-pro': 'deepseek-ai/deepseek-v4-pro-0813',
  'deepseek-v4-pro': 'deepseek-ai/deepseek-v4-pro-0813',
  'v4-flash': 'deepseek-ai/deepseek-v4-flash-0731',
  'deepseek-v4-flash': 'deepseek-ai/deepseek-v4-flash-0731',
  'minimax': 'minimaxai/minimax-m3',
  'minimax-m3': 'minimaxai/minimax-m3',
}

const KNOWN = [
  'moonshotai/kimi-k3',
  'deepseek-ai/deepseek-v4-pro-0813',
  'deepseek-ai/deepseek-v4-flash-0731',
  'minimaxai/minimax-m3',
]

function usage(): void {
  console.log('Cách dùng: bun scripts/test-llm-model.ts <model>')
  console.log('')
  console.log('  4 model của agent chain:')
  for (const m of KNOWN) console.log(`    bun scripts/test-llm-model.ts ${m}`)
  console.log('')
  console.log('  Alias ngắn: kimi-k3 | v4-pro | v4-flash | minimax-m3')
  console.log('  (cũng nhận model-id NIM bất kỳ, vd openai/gpt-oss-120b)')
}

async function main(): Promise<void> {
  const arg = process.argv[2]
  if (!arg) {
    usage()
    process.exit(2)
  }
  const model = ALIASES[arg.toLowerCase()] ?? arg
  const isKnown = KNOWN.includes(model)
  console.log('──────────────────────────────────────────────────────')
  console.log(`[TEST-MODEL] Model: ${model}${isKnown ? '' : ' (ngoài chuỗi chuẩn — test trực tiếp)'}`)
  console.log(`[TEST-MODEL] Đi qua stack app thật: key pool 4 key NVIDIA + xoay key, KHÔNG fallback chain`)
  console.log('──────────────────────────────────────────────────────')

  const t0 = Date.now()
  const result = await callLLM(
    'Kiểm thử kết nối: trả lời đúng 1 câu ngắn gọn — model đang hoạt động tốt. Không giải thích thêm.',
    'Bạn là một endpoint LLM đang được kiểm thử sức khỏe. Trả lời cực ngắn.',
    'model-test',
    { model, temperature: 0, maxTokens: 512 },
  )
  const ms = Date.now() - t0

  console.log('──────────────────────────────────────────────────────')
  if (result.content && result.content.trim().length > 0) {
    const tokens = result.tokensUsed ?? 0
    const preview = result.content.trim().slice(0, 160).replace(/\n/g, ' ')
    console.log(`✅ PASS — ${model}`)
    console.log(`   Thời gian : ${(ms / 1000).toFixed(1)}s`)
    console.log(`   Tokens    : ${tokens}`)
    console.log(`   Trả lời   : "${preview}${result.content.trim().length > 160 ? '...' : ''}"`)
    console.log('──────────────────────────────────────────────────────')
    process.exit(0)
  } else {
    console.log(`❌ FAIL — ${model}`)
    console.log(`   Thời gian : ${(ms / 1000).toFixed(1)}s`)
    console.log(`   Lỗi       : ${result.error || 'không rõ (response rỗng)'}`)
    console.log('   Gợi ý: kiểm tra NVIDIA_API_KEY_1..4 trong .env, mạng tới')
    console.log('          integrate.api.nvidia.com, và /api/health (modelCircuitBreakers).')
    console.log('──────────────────────────────────────────────────────')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[TEST-MODEL] Lỗi không mong đợi:', err)
  process.exit(1)
})
