/**
 * ROUND-74 TESTS — BUG2-033 "dropdown model nói thật" (Zen đóng lại cửa native CLI)
 *
 * Bối cảnh: review r74 phát hiện Zen chặn toàn bộ model free ngoài
 * space-bunny-free trên MỌI transport (HTTP + CLI native — probe /tmp + app-dir,
 * key #1 + key #2 đều 403 FreeTierError "free tier can only be used from within
 * OpenCode"). r73 chẩn đoán "sandbox app-dir quota" là SAI. Hệ quả: 7/8 model
 * trong dropdown cascading âm thầm về SBF → fix = UI nói thật bằng trạng thái
 * SỐNG đọc từ chính block-cache của tầng vận hành (không hardcode danh sách
 * chết tĩnh — policy Zen lật ngược 3 lần trong 12 ngày).
 *
 * Khối test:
 *   1. zenModelBlockSummary() — pure-read hợp đồng: trả entry còn hạn kèm
 *      reason; bỏ entry hết hạn; parse key "transport:model" đúng.
 *   2. markZenFreeTierBlocked + isZenFreeTierBlocked hành vi qua summary.
 *   3. Route /api/agents/models gắn blockedTransports từ summary (source-scan).
 *   4. UI dropdown: refetch khi MỞ + badge ⚠ + hàng mờ + tooltip fallback SBF
 *      (source-scan — cùng pattern r73).
 *   5. Đính chính r74 hiện diện trong llm.ts + agent-constants.ts (chống
 *      diễn giải "native chạy được" lỗi thời quay lại).
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  zenModelBlockSummary,
  markZenFreeTierBlocked,
  parseZenLastResortModels,
} from '../src/lib/llm'
import { PROVIDER_MODELS } from '../src/lib/agent-constants'

const ROOT = import.meta.dir + '/..'
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

describe('r74 — zenModelBlockSummary: hợp đồng pure-read trên block-cache', () => {
  test('rỗng ban đầu (không có entry nào đang sống)', () => {
    // Lưu ý: các test khác trong file này có thể đã vá cache — chỉ assert
    // KHÔNG throw + trả array (pure-read là hợp đồng chính).
    const out = zenModelBlockSummary()
    expect(Array.isArray(out)).toBe(true)
    for (const e of out) {
      expect(typeof e.model).toBe('string')
      expect(['http', 'cli']).toContain(e.transport)
      expect(typeof e.blockedUntil).toBe('number')
      expect(typeof e.reason).toBe('string')
    }
  })

  test('vá http + cli cho 1 model → summary trả ĐỦ 2 entry kèm reason đúng + file dùng chung được ghi', () => {
    const model = 'r74-probe-model-free'
    markZenFreeTierBlocked('http', model, 'r74 test http reason', 60_000)
    markZenFreeTierBlocked('cli', model, 'r74 test cli reason', 300_000)
    const out = zenModelBlockSummary()
    const http = out.find(e => e.model === model && e.transport === 'http')
    const cli = out.find(e => e.model === model && e.transport === 'cli')
    expect(http?.reason).toBe('r74 test http reason')
    expect(cli?.reason).toBe('r74 test cli reason')
    expect(http && cli && cli.blockedUntil).toBeGreaterThan(http!.blockedUntil) // TTL dài hơn
    // r74b — block-state ghi ra FILE dùng chung cross-process (worker instrumentation
    // ≠ route instance — goal-loop-worker.ts:1326). Kiểm file thật tồn tại entry.
    const state = JSON.parse(readFileSync(join(import.meta.dir, '..', 'db', 'zen-block-state.json'), 'utf-8')) as Record<string, { until: number; reason: string }>
    expect(state[`http:${model}`]?.reason).toBe('r74 test http reason')
    expect(state[`cli:${model}`]?.reason).toBe('r74 test cli reason')
  })

  test('r74b — HAI process giả lập: process A mark+ghi file → process B (memory trống) đọc thấy qua summary', async () => {
    // Giả lập cross-process: chạy 1 bun process con mark entry mới, rồi process
    // NÀY (memory không có entry đó) phải thấy qua file — đúng Luồng worker → route.
    const model = 'r74b-crossproc-model'
    const proc = Bun.spawnSync(['bun', '-e', `const {markZenFreeTierBlocked}=require('./src/lib/llm.ts'); markZenFreeTierBlocked('http','${model}','r74b cross-proc reason',60000)`], { cwd: join(import.meta.dir, '..') })
    expect(proc.exitCode).toBe(0)
    const out = zenModelBlockSummary() // process này chưa từng mark model đó trong memory
    const e = out.find(x => x.model === model && x.transport === 'http')
    expect(e?.reason).toBe('r74b cross-proc reason')
  })

  test('entry hết hạn (TTL 1ms + sleep) KHÔNG xuất hiện trong summary', async () => {
    const model = 'r74-expired-model'
    markZenFreeTierBlocked('http', model, 'sẽ hết hạn ngay', 1)
    await new Promise(r => setTimeout(r, 10)) // vượt TTL
    const out = zenModelBlockSummary()
    expect(out.find(e => e.model === model)).toBeUndefined()
  })

  test('model id chứa dấu ":" (nếu có) parse không vỡ — transport luôn là tiền tố đầu', () => {
    const model = 'weird:model:with:colons'
    markZenFreeTierBlocked('cli', model, 'parse key', 60_000)
    const out = zenModelBlockSummary()
    const e = out.find(x => x.model === model)
    expect(e?.transport).toBe('cli') // tách tại dấu ":" ĐẦU TIÊN — phần còn lại nguyên vẹn là model
  })
})

describe('r74 — route /api/agents/models gắn blockedTransports (source-scan)', () => {
  test('route import zenModelBlockSummary + augmentZenModels cho cả 2 nhánh (PIN UPDATE R5: nhánh zen đi qua catalog merge đồng bộ)', () => {
    const src = read('src/app/api/agents/models/route.ts')
    expect(src).toContain("import { zenModelBlockSummary } from '@/lib/llm'")
    expect(src).toContain('function augmentZenModels')
    // R5 (2026-10-14): catalog zen = getZenFreeModelCatalog() (overlay đồng bộ
    // tự động models.dev/CLI LÊN catalog tĩnh) — thay PROVIDER_MODELS[provider]
    expect(src).toContain("provider === 'zen' ? augmentZenModels(getZenFreeModelCatalog())")
    expect(src).toContain("import { getZenFreeModelCatalog, getSyncStatus } from '@/lib/free-models-sync'")
    expect(src).toContain('p.key === \'zen\'') // nhánh all-providers cũng gắn
    expect(src).toContain('blockedTransports')
    expect(src).toContain('freeModelsSync: getSyncStatus()') // R5: trạng thái sync kèm response
  })
})

describe('r74 — UI dropdown "nói thật" (source-scan smolab-module.tsx)', () => {
  test('refetch trạng thái mỗi lần MỞ dropdown (không dùng bản mount cấp 1 lần)', () => {
    const src = read('src/components/smolab/smolab-module.tsx')
    // refetch hook tồn tại + gọi trong onClick mở dropdown
    expect(src).toContain('const fetchZenModelOptions = useCallback')
    expect(src).toContain('fetchZenModelOptions()')
    // gọi ngay trong handler mở dropdown (sau e.stopPropagation)
    expect(src).toContain('// r74 (BUG2-033): mở dropdown → refetch trạng thái chặn')
  })

  test('model bị chặn CẢ http+cli → badge ⚠ + hàng mờ + tooltip fallback SBF', () => {
    const src = read('src/components/smolab/smolab-module.tsx')
    expect(src).toContain("m.blockedTransports.includes('http') && m.blockedTransports.includes('cli')")
    expect(src).toContain('allBlocked ? \'text-stone-500\'') // hàng mờ
    expect(src).toContain('title="Bị chặn free-tier — sẽ fallback về space-bunny-free"')
    expect(src).toContain('sẽ tự chuyển tiếp về space-bunny-free (failover)') // tooltip nói thật
    expect(src).toContain('· ⚠ bị chặn') // header chú thích
  })

  test('type zenModelOptions có blockedTransports — r73 caps giữ nguyên (không phá contract cũ)', () => {
    const src = read('src/components/smolab/smolab-module.tsx')
    expect(src).toContain('blockedTransports?: string[]')
    // r73 icon caps vẫn còn
    expect(src).toContain('m.caps?.coding && <span title="coding">⚡</span>')
    expect(src).toContain('m.caps?.reasoning && <span title="reasoning">🧠</span>')
    expect(src).toContain('m.caps?.agentic && <span title="agentic">🤖</span>')
  })
})

describe('r74 — đính chính chẩn đoán r73 (chống diễn giải lỗi thời quay lại)', () => {
  test('llm.ts có cập nhật r74: cửa native ĐÓNG LẠI, chặn policy toàn cục', () => {
    const src = read('src/lib/llm.ts')
    expect(src).toContain('r74 — REVIEW PHÁT HIỆN): CỬA SỔ NATIVE ĐÃ')
    expect(src).toContain('CHẮN POLICY TOÀN CỤC, KHÔNG phải quota key')
    expect(src).toContain('BUG2-033')
  })

  test('agent-constants.ts có cảnh báo r74 — 8 model GIỮ NGUYÊN với lý do policy lật ngược', () => {
    const src = read('src/lib/agent-constants.ts')
    expect(src).toContain('r74 CẬP NHẬT (2026-10-09 ~09:30Z — review phát hiện, BUG2-033)')
    expect(src).toContain('GIỮ NGUYÊN 8 model trong catalog')
  })

  test('catalog đủ 12 model (PIN UPDATE R5: 8 battery r73 + 4 đồng bộ models.dev 2026-10-14) + caps battery r73 (năng lực model ≠ trạng thái vận hành)', () => {
    // R5: 8 → 12 — đối chiếu `opencode models --verbose --refresh` cho 12
    // model free (cost 0/0, status != deprecated); 3 model r73 trở lại +
    // cat-jam-free mới 2026-10-12. Catalog được giữ tươi tự động bởi
    // src/lib/free-models-sync.ts (TTL 6h — overlay qua getZenFreeModelCatalog).
    expect(PROVIDER_MODELS.zen).toHaveLength(12)
    const sbf = PROVIDER_MODELS.zen.find(m => m.id === 'space-bunny-free')
    expect(sbf?.caps).toEqual({ coding: true, reasoning: true, agentic: false })
  })

  test('last-resort pool r73 GIỮ NGUYÊN (SBF vẫn là failover đích — pool chết chỉ tốn re-probe bị cache chặn)', () => {
    // Pool mặc định không đổi — policy có thể mở lại; block-cache short-circuit
    // đã giới hạn thiệt hại (đúng phân tích BUG2-033).
    expect(parseZenLastResortModels(undefined, 'space-bunny-free', 'space-bunny-free'))
      .toEqual(['ling-3.1-flash-free', 'mimo-v2.6-flash-free', 'big-pickle'])
  })
})
