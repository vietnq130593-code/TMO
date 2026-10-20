/**
 * r135 — F4 UTILITY CORE CHUYỂN SANG NIM (OBS P5)
 * =====================================================================================
 * User duyệt fix F1-F6 theo biên bản quan sát OBSERVE-PROTOCOL-1 (FINAL)
 * 2026-10-20. F4 (P2): callUtilityLLM/UTILITY_ZEN_MODEL trỏ space-bunny-free
 * — Zen chết toàn bộ (space-bunny-free 410 Gone / minimax-m3.1-flash 403,
 * probe 2026-10-20) → 100% utility call fail-open ÂM THẦM: memory-extraction
 * + writeback-extraction chết ngay sau terminal (episode FAILURE không trích
 * xuất được lesson — bằng chứng job Omega cmvghpzbv…kn6dj1), goal-loop-
 * context-compression 403 FreeTierError.
 *
 * Fix: lõi utility chuyển sang NIM nemotron-550b (khoẻ nhất đo thật
 * 0.7-1.4s, non-reasoning không starve budget nhỏ của caller); Zen HTTP →
 * CLI chỉ còn FALLBACK (nếu hồi sinh); callLLM utility path (decompose/
 * summarize/synthesize/classification legacy) dùng chung lõi. Env
 * UTILITY_NIM_MODEL. Chính sách 2026-11-30 "utility chỉ Zen" lỗi thời theo
 * phê duyệt user.
 * Phong cách: source-scan (tiền lệ r124-r131) + đọc .env (tiền lệ r130 B4).
 */

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TMO = join(import.meta.dir, '..')
const read = (p: string) => readFileSync(join(TMO, p), 'utf-8')
const llm = read('src/lib/llm.ts')

describe('r135 A — NIM primary trong callUtilityLLM', () => {
  test('A1. UTILITY_NIM_MODEL mặc định nemotron-550b (model khoẻ nhất, non-reasoning)', () => {
    expect(llm).toContain('const utilNimModel = process.env.UTILITY_NIM_MODEL || NEMOTRON_550B_NIM_ID')
  })

  test('A2. NIM PRIMARY chạy TRƯỚC Zen fallback (thứ tự trong source)', () => {
    const nimIdx = llm.indexOf('NIM UTILITY PRIMARY')
    const zenIdx = llm.indexOf('OPENCODE ZEN UTILITY FALLBACK')
    expect(nimIdx).toBeGreaterThan(0)
    expect(zenIdx).toBeGreaterThan(nimIdx)
  })

  test('A3. NIM qua callModelWithKeyRotation (xoay key + breaker-aware) + log thành công', () => {
    expect(llm).toContain('callModelWithKeyRotation(utilNimModel, prompt, systemPrompt, options, { taskLabel: `utility-nim:${taskLabel}` })')
    expect(llm).toContain('Utility-core dùng NIM ${utilNimModel} ✓')
  })

  test('A4. NIM thất bại → Zen fallback + lỗi cuối nêu đủ NIM + Zen (R19: không model thứ 3)', () => {
    expect(llm).toContain('thử Zen (fallback F4)')
    expect(llm).toContain('không fallback thêm R19')
  })

  test('A5. abortCheck kiểm tra NGAY đầu chuỗi (trước khi đốt NIM call)', () => {
    const fnStart = llm.indexOf('export async function callUtilityLLM')
    expect(fnStart).toBeGreaterThan(0)
    const abortIdx = llm.indexOf('options.abortCheck()', fnStart)
    const nimIdx = llm.indexOf('callModelWithKeyRotation(utilNimModel', fnStart)
    expect(abortIdx).toBeGreaterThan(fnStart)
    expect(nimIdx).toBeGreaterThan(abortIdx)
  })

  test('A6. Zen fail vẫn emit model.failover obs (OBS-V3 H7 giữ nguyên)', () => {
    expect(llm).toContain('emitModelFailoverObs({')
  })
})

describe('r135 B — callLLM dùng chung lõi (hết fail-open âm thầm trên đường legacy)', () => {
  test('B1. callLLM utility path ủy quyền callUtilityLLM (NIM-primary chung)', () => {
    expect(llm).toContain('return callUtilityLLM(prompt, systemPrompt, task, options)')
  })

  test('B2. Model override (eval judges không đổi model) vẫn ưu tiên TRƯỚC utility path', () => {
    const overrideIdx = llm.indexOf('if (options?.model) {')
    const delegateIdx = llm.indexOf('return callUtilityLLM(prompt, systemPrompt, task, options)')
    expect(overrideIdx).toBeGreaterThan(0)
    expect(delegateIdx).toBeGreaterThan(overrideIdx)
  })
})

describe('r135 C — .env + doc đồng bộ', () => {
  test('C1. .env khai UTILITY_NIM_MODEL (máy này)', () => {
    const env = readFileSync(join(TMO, '.env'), 'utf-8')
    expect(env).toMatch(/^UTILITY_NIM_MODEL=nvidia\/nemotron-3-ultra-550b-a55b$/m)
  })

  test('C2. Comment sub-agents.ts cập nhật (không còn "lõi utility zen space-bunny-free")', () => {
    const sub = read('src/lib/research-team/g1/sub-agents.ts')
    expect(sub).toContain('lõi utility NIM nemotron-550b — F4')
    expect(sub).not.toContain('lõi utility zen space-bunny-free')
  })
})
