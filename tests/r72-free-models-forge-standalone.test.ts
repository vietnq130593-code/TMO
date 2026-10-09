// ============================================================================
// r72 — TEST CHO CÁC FIX ROUND-72 (user request 2026-10-09 — 4 mục)
//
// 1. FORGE là agent ĐỘC LẬP — KHÔNG thuộc Team Code (user: "FORGE là agents
//    độc lập chứ có phải thuộc team code đâu") → tách def + migration DB.
// 2. "Nhiều model free thay vì chỉ 1 model SBF" — đường CLI native provider
//    (auth.json key oc_sk) chạy được model free; repo opencode.json phải
//    KHÔNG còn shadow provider "opencode" (custom HTTP tự chặn đường native).
// 3. Danh sách model = đúng thực nghiệm matrix 2026-10-09 (6 model PASS,
//    4 model chết bị loại — bằng chứng trong Bug_v2.md ROUND-72).
//
// Mọi test bắt từ bằng chứng quan sát thật (matrix test opencode CLI v1.18.35
// 04:13-05:30Z 2026-10-09: ling/mimo/step-5/longcat/big-pickle trả lời "OK"
// thật; nemotron-3.5-lightning-free treo 5/5 lần 0 byte; jev-1.13-free
// UnknownError; muse-spark-1.3 "not available in your country";
// nemotron-3-ultra-free đã rời catalog Zen).
// ============================================================================

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

import { PROVIDER_MODELS, EXTRACTION_MODELS } from '../src/lib/agent-constants'
import { POSITION_BY_NAME, resolveDelegationTarget, DELEGATABLE_AGENTS } from '../src/lib/subagent-delegate'
import { STANDALONE_AGENTS } from '../src/lib/standalone-agents'
import { CODE_TEAM_AGENTS, getPositionsInOrder } from '../src/lib/code-team/agents'

// ==================== MỤC 3 — FORGE ĐỘC LẬP ====================

describe('r72 — FORGE tách khỏi Code Team (user directive 2026-10-09)', () => {
  test('FORGE KHÔNG còn trong CODE_TEAM_AGENTS — đội code về đúng 5 vị trí SOP', () => {
    expect(CODE_TEAM_AGENTS.find(a => a.name === 'FORGE')).toBeUndefined()
    expect(CODE_TEAM_AGENTS.map(a => a.name).sort()).toEqual(['CATALYST', 'MEGATRON', 'RAMPAGE', 'SENTINEL', 'SHOCWAVE'])
  })

  test('FORGE sống ở STANDALONE_AGENTS: team=null + position=null + đủ tool DB r71', () => {
    const forge = STANDALONE_AGENTS.find(a => a.name === 'FORGE')
    expect(forge).toBeDefined()
    expect(forge?.team).toBeNull()
    expect(forge?.position).toBeNull()
    expect(forge?.tools).toContain('knowledge_write')
    expect(forge?.tools).toContain('data_map')
    expect(forge?.tools).toContain('lessons_search')
    // Toolset builder tổng lực giữ nguyên từ def code-team cũ (TASK 43)
    expect(forge?.tools).toContain('browser_screenshot')
    expect(forge?.tools).toContain('verify_and_push')
    expect(forge?.tools).toContain('start_preview')
  })

  test('persona mới không còn căn thân "của Code Team"', () => {
    const forge = STANDALONE_AGENTS.find(a => a.name === 'FORGE')
    expect(forge?.instruction).toContain('ĐỘC LẬP')
    expect(forge?.instruction).not.toContain('của Code Team')
  })

  test('POSITION_BY_NAME bỏ FORGE + resolveDelegationTarget không còn nhận position FS', () => {
    expect(POSITION_BY_NAME['FORGE']).toBeUndefined()
    expect(POSITION_BY_NAME['MEGATRON']).toBe('TL') // 5 vị trí cũ nguyên vẹn
    expect(resolveDelegationTarget('FORGE')).toBeNull() // → nhánh by-name DB-first
    expect(resolveDelegationTarget('FS')).toBeNull() // position FS đã gỡ
    expect(resolveDelegationTarget('G2-A')).toBe('G2-A') // position hợp lệ cũ vẫn chạy
  })

  test('FORGE vẫn là đích delegate hợp lệ (guidance list) — không mất đường giao việc', () => {
    const forge = DELEGATABLE_AGENTS.find(a => a.name === 'FORGE')
    expect(forge).toBeDefined()
    expect(forge?.role).toContain('độc lập')
  })

  test('pipeline SOP 5 vị trí nguyên vẹn — không có FS (workflow team không đổi)', () => {
    const positions = getPositionsInOrder()
    expect(positions).toEqual(['TL', 'G1', 'G2-A', 'G2-B', 'G3'])
    expect(positions).not.toContain('FS')
  })
})

// ==================== MỤC 4 — MODEL FREE QUA CLI NATIVE ====================

describe('r72 — opencode.json gỡ shadow provider native (chìa khóa mở model free)', () => {
  test('repo opencode.json KHÔNG định nghĩa lại provider "opencode" (native phải sống)', () => {
    const cfg = JSON.parse(readFileSync(join(process.cwd(), 'opencode.json'), 'utf8')) as {
      provider: Record<string, unknown>
      model: string
      small_model: string
    }
    expect(cfg.provider['opencode']).toBeUndefined() // shadow custom HTTP = tự chặn đường native (bằng chứng 05:23Z: native providerID=opencode nhận 403 khi bị shadow)
    // 3 alias xoay key cho space-bunny-free giữ nguyên
    expect(cfg.provider['opencode-k1']).toBeDefined()
    expect(cfg.provider['opencode-k2']).toBeDefined()
    expect(cfg.provider['opencode-k3']).toBeDefined()
  })

  test('default model = space-bunny-free (không còn nemotron-3-ultra-free đã chết 404)', () => {
    const cfg = JSON.parse(readFileSync(join(process.cwd(), 'opencode.json'), 'utf8')) as { model: string; small_model: string }
    expect(cfg.model).toBe('opencode/space-bunny-free')
    expect(cfg.small_model).toBe('opencode/mimo-v2.6-flash-free') // native + free → title gen không còn "Insufficient funds"
  })
})

describe('r72 — danh sách model zen = đúng thực nghiệm matrix 2026-10-09', () => {
  test('6 model free VERIFIED có mặt (trả lời "OK" thật qua CLI native)', () => {
    const ids = PROVIDER_MODELS.zen.map(m => m.id)
    expect(ids).toContain('space-bunny-free')
    expect(ids).toContain('ling-3.1-flash-free')
    expect(ids).toContain('mimo-v2.6-flash-free')
    expect(ids).toContain('step-5-preview-free')
    expect(ids).toContain('longcat-2.5-preview-free')
    expect(ids).toContain('big-pickle')
  })

  test('4 model CHẾT bị loại — không cho agent chọn rồi treo/lỗi', () => {
    const ids = PROVIDER_MODELS.zen.map(m => m.id)
    expect(ids).not.toContain('nemotron-3.5-lightning-free') // treo 5/5 lần (0 byte sau 40-50s)
    expect(ids).not.toContain('jev-1.13-free') // UnknownError "Unexpected server error"
    expect(ids).not.toContain('muse-spark-1.3-contributor-free') // geo-block "not available in your country"
    expect(ids).not.toContain('nemotron-3-ultra-free') // Zen gỡ khỏi catalog — 404
  })

  test('label model free mới ghi rõ đường vận hành (CLI native)', () => {
    const ling = PROVIDER_MODELS.zen.find(m => m.id === 'ling-3.1-flash-free')
    expect(ling?.label).toContain('CLI native')
  })

  test('extraction model danh sách = space-bunny-free (default llm.ts đồng bộ)', () => {
    expect(EXTRACTION_MODELS.zen[0]?.id).toBe('space-bunny-free')
  })
})
