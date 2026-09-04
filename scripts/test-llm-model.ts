/**
 * TEST MODEL NVIDIA NIM — test THẬT 2 PHASE (fix user feedback 2026-09-03:
 * "test cũ giống hình thức — chỉ 2 key đầu được dùng, nghi kịch bản lỗi").
 *
 *   Phase 1 (RAW)  : gọi TRỰC TIẾP integrate.api.nvidia.com bằng TỪNG key
 *                    (NVIDIA_API_KEY_1..4), bypass toàn bộ app — chứng minh
 *                    model + key ở tầng HTTP thuần. MỖI KEY 1 dòng kết quả
 *                    riêng (200 OK / 4xx / 5xx / timeout-hang).
 *   Phase 2 (STACK): gọi qua callLLM của app (ProviderKeyPool xoay key thật,
 *                    KHÔNG fallback chain) — chứng minh đường app end-to-end.
 *                    Lưu ý: TIMEOUT-BREAKER (Task 22) vẫn fail-fast sau 2
 *                    timeout — đó là hành vi production thật; việc "đủ 4 key"
 *                    đã được chứng minh ở Phase 1 (từng key test riêng).
 *
 * Chạy từ thư mục gốc repo (bun tự nạp .env):
 *   bun scripts/test-llm-model.ts moonshotai/kimi-k3
 *   bun scripts/test-llm-model.ts deepseek-ai/deepseek-v4-pro-0813
 *   bun scripts/test-llm-model.ts deepseek-ai/deepseek-v4-flash-0731
 *   bun scripts/test-llm-model.ts minimaxai/minimax-m3
 *
 * Alias ngắn: kimi-k3 | v4-pro | v4-flash | minimax-m3
 * (cũng nhận model-id NIM bất kỳ, vd openai/gpt-oss-120b)
 *
 * Env tùy chọn:
 *   RAW_TEST_TIMEOUT_MS  (default 45000) — timeout mỗi key ở Phase 1
 *   LLM_TEST_TIMEOUT_MS  (default 60000) — override LLM_TIMEOUT_MS ở Phase 2
 *                                         (không phải chờ 150s/attempt khi model hang)
 *
 * Exit code: 0 = PASS (stack trả lời được), 1 = FAIL, 2 = sai cú pháp.
 */

// ===== Env override TRƯỚC dynamic import llm.ts (module đọc env lúc init) =====
// 1. Tắt banner cấu hình "[LLM] NVIDIA: ... FALLBACK CHAIN ..." (user feedback
//    2026-09-03: dòng này trong output test không cần thiết)
process.env.LLM_QUIET_INIT = '1'
// 2. Timeout ngắn hơn cho test — model hang thì không phải chờ 150s/attempt
const TEST_TIMEOUT_MS = Math.max(10_000, parseInt(process.env.LLM_TEST_TIMEOUT_MS || '60000', 10) || 60_000)
process.env.LLM_TIMEOUT_MS = String(TEST_TIMEOUT_MS)

const NIM_CHAT_URL = 'https://integrate.api.nvidia.com/v1/chat/completions'
const RAW_TIMEOUT_MS = Math.max(5_000, parseInt(process.env.RAW_TEST_TIMEOUT_MS || '45000', 10) || 45_000)

const TEST_SYSTEM = 'Bạn là một endpoint LLM đang được kiểm thử sức khỏe. Trả lời cực ngắn.'
const TEST_PROMPT = 'Kiểm thử kết nối: trả lời đúng 1 câu ngắn gọn — model đang hoạt động tốt. Không giải thích thêm.'

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

interface RawKeyResult {
  keyIndex: number
  keyTail: string
  ok: boolean
  kind: 'ok' | 'empty' | 'http' | 'timeout' | 'network'
  ms: number
  detail: string
  tokens: number
}

/** Phase 1 — 1 HTTP call trực tiếp NIM bằng 1 key (bypass toàn bộ app). */
async function rawCallOneKey(keyIndex: number, key: string, model: string): Promise<RawKeyResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RAW_TIMEOUT_MS)
  const t0 = Date.now()
  try {
    const res = await fetch(NIM_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: TEST_SYSTEM },
          { role: 'user', content: TEST_PROMPT },
        ],
        max_tokens: 512,
        temperature: 0,
      }),
      signal: controller.signal,
    })
    const ms = Date.now() - t0
    if (res.ok) {
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
        usage?: { total_tokens?: number }
      }
      const content = (data.choices?.[0]?.message?.content ?? '').trim()
      const tokens = data.usage?.total_tokens ?? 0
      if (content.length > 0) {
        return {
          keyIndex, keyTail: key.slice(-6), ok: true, kind: 'ok', ms, tokens,
          detail: `trả lời: "${content.slice(0, 80)}"`,
        }
      }
      return {
        keyIndex, keyTail: key.slice(-6), ok: false, kind: 'empty', ms, tokens,
        detail: `200 OK nhưng content rỗng (${tokens} tokens)`,
      }
    }
    const bodyText = await res.text().catch(() => '')
    return {
      keyIndex, keyTail: key.slice(-6), ok: false, kind: 'http', ms, tokens: 0,
      detail: `HTTP ${res.status} — ${bodyText.slice(0, 140).replace(/\n/g, ' ')}`,
    }
  } catch (e) {
    const ms = Date.now() - t0
    const isAbort = e instanceof Error && e.name === 'AbortError'
    return {
      keyIndex, keyTail: key.slice(-6), ok: false,
      kind: isAbort ? 'timeout' : 'network',
      ms: isAbort ? RAW_TIMEOUT_MS : ms,
      tokens: 0,
      detail: isAbort
        ? `TIMEOUT ${Math.round(RAW_TIMEOUT_MS / 1000)}s — 0 bytes (server nhận request nhưng không trả gì)`
        : `LỖI MẠNG: ${e instanceof Error ? e.message : String(e)}`,
    }
  } finally {
    clearTimeout(timer)
  }
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
  console.log('Phase 1 (RAW)  : gọi TRỰC TIẾP NIM từng key — bypass toàn bộ app')
  console.log('Phase 2 (STACK): qua callLLM của app — xoay key thật, KHÔNG fallback chain')
  console.log(`Timeout: RAW ${Math.round(RAW_TIMEOUT_MS / 1000)}s/key · STACK ${Math.round(TEST_TIMEOUT_MS / 1000)}s/attempt`)
  console.log('──────────────────────────────────────────────────────')

  // ============ PHASE 1 — RAW: từng key một, kết quả riêng từng key ============
  const rawResults: RawKeyResult[] = []
  for (let i = 1; i <= 4; i++) {
    const key = process.env[`NVIDIA_API_KEY_${i}`] || ''
    if (!key) {
      console.log(`  key#${i}        — BỎ QUA (NVIDIA_API_KEY_${i} trống trong .env)`)
      continue
    }
    const r = await rawCallOneKey(i, key, model)
    rawResults.push(r)
    const icon = r.ok ? '✓' : '✗'
    console.log(`  key#${i} ...${r.keyTail} ${icon} ${(r.ms / 1000).toFixed(1)}s — ${r.detail}`)
  }

  const tested = rawResults.length
  const rawOk = rawResults.filter((r) => r.ok).length
  const rawTimeouts = rawResults.filter((r) => r.kind === 'timeout').length
  const rawHttpErr = rawResults.filter((r) => r.kind === 'http').length
  console.log(`  → RAW: ${rawOk}/${tested} key OK${rawTimeouts === tested && tested > 0 ? ' — TẤT CẢ TIMEOUT (0 bytes)' : ''}`)
  if (rawTimeouts === tested && tested > 0) {
    console.log('    KẾT LUẬN Phase 1: model HANG phía NVIDIA NIM (server-side) — KHÔNG phải lỗi')
    console.log('    key (mỗi key đã được test riêng ở trên) và KHÔNG THỂ là lỗi app (đã bypass app).')
  } else if (rawHttpErr === tested && tested > 0) {
    console.log('    KẾT LUẬN Phase 1: mọi key đều HTTP error — 401/403 = key sai, 404 = model')
    console.log('    không khả dụng cho account này.')
  } else if (rawOk > 0 && rawOk < tested) {
    console.log('    LƯU Ý: kết quả LỆCH NHAU giữa các key — key ✗ có thể bị rate-limit/quota riêng.')
  }

  // ============ PHASE 2 — STACK: qua stack app thật (callLLM + key pool) ============
  console.log('──────────────────────────────────────────────────────')
  console.log('[TEST-MODEL] Phase 2 — qua stack app thật (callLLM + ProviderKeyPool xoay key)')
  const { callLLM } = await import('@/lib/llm')
  const t0 = Date.now()
  const result = await callLLM(TEST_PROMPT, TEST_SYSTEM, 'model-test', {
    model,
    temperature: 0,
    maxTokens: 512,
  })
  const ms = Date.now() - t0

  console.log('──────────────────────────────────────────────────────')
  if (result.content && result.content.trim().length > 0) {
    const tokens = result.tokensUsed ?? 0
    const preview = result.content.trim().slice(0, 160).replace(/\n/g, ' ')
    console.log(`✅ PASS — ${model}`)
    console.log(`   Phase 2   : ${(ms / 1000).toFixed(1)}s · ${tokens} tokens`)
    console.log(`   Trả lời   : "${preview}${result.content.trim().length > 160 ? '...' : ''}"`)
    if (rawOk < tested) {
      console.log(`   Lưu ý     : Phase 1 chỉ ${rawOk}/${tested} key OK — model hoạt động nhưng vài key lỗi riêng.`)
    }
    console.log('──────────────────────────────────────────────────────')
    process.exit(0)
  } else {
    console.log(`❌ FAIL — ${model}`)
    console.log(`   Phase 1   : ${rawOk}/${tested} key OK trực tiếp NIM`)
    console.log(`   Phase 2   : ${(ms / 1000).toFixed(1)}s — ${(result.error || 'không rõ (response rỗng)').slice(0, 220)}`)
    if (rawOk === tested && tested > 0) {
      console.log('   Chẩn đoán : RAW OK nhưng STACK FAIL → vấn đề nằm trong đường app (llm.ts key')
      console.log('                pool / breaker) — cần audit thêm, KHÔNG phải NIM/key.')
    } else if (rawOk === 0 && rawTimeouts === tested && tested > 0) {
      console.log('   Chẩn đoán : model HANG phía NVIDIA NIM (server nhận request, 0 bytes trả')
      console.log('                về) — KHÔNG phải key, KHÔNG phải app. Kệ NVIDIA, thử lại sau.')
      console.log('   Xác minh  : lệnh curl trực tiếp (không qua app):')
      console.log(`                curl -m 45 ${NIM_CHAT_URL} \\`)
      console.log('                  -H "Authorization: Bearer $NVIDIA_API_KEY_1" -H "Content-Type: application/json" \\')
      console.log(`                  -d '{"model":"${model}","messages":[{"role":"user","content":"Say OK"}],"max_tokens":32}'`)
    } else if (rawOk === 0 && rawHttpErr === tested && tested > 0) {
      console.log('   Chẩn đoán : HTTP error ở mọi key — xem chi tiết Phase 1 (401/403=key, 404=model).')
    } else {
      console.log('   Gợi ý     : xem chi tiết từng key ở Phase 1 + /api/health (modelCircuitBreakers).')
    }
    console.log('──────────────────────────────────────────────────────')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[TEST-MODEL] Lỗi không mong đợi:', err)
  process.exit(1)
})

// Lượt quan sát 5 (2026-09-04): file này là global script (không top-level
// import/export — dynamic import bên trong hàm) → \`main\` top-level dính
// TS2393 "Duplicate function implementation" khi program tsc gộp global scope
// với ambient declaration khác. \`export {}\` biến file thành module — vô hại
// với `bun scripts/test-llm-model.ts` (chỉ đánh dấu module scope).
export {}
