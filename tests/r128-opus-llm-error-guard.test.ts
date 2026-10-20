/**
 * r128 — OPUS-VERDICT-1: guard lỗi hạ tầng LLM trong reviewer + model Opus sống
 * =====================================================================================
 * Bối cảnh (user report 2026-10-20): "Opus không đọc được verdict JSON từ model".
 * Chẩn đoán từ 2 OpusReview row + dev.log:
 *   - Profile Opus trỏ zen/space-bunny-free — model bị Zen khai tử (410
 *     ModelDeprecated) từ ~2026-10-15; key oc_sk còn bị 403 FreeTierError với
 *     model thay thế → toà.n bộ LLM call của review Opus soft-fail
 *     { content: '', error } (chính sách R19 không fallback).
 *   - reviewer.ts KHÔNG kiểm tra llm.error → parse chuỗi rỗng →
 *     "Không tìm thấy JSON object trong output model" → retry "chỉ JSON thuần"
 *     với model đã chết (thuốc sai bệnh) → fallback ESCALATE thông báo chung
 *     chung, nguyên nhân thật chỉ nằm trong dev.log.
 * Fix (commit này):
 *   A. Guard llm.error: call thất bại tầng hạ tầng → KHÔNG parse, KHÔNG retry,
 *      reason thật (nguyên văn llm.ts) vào verdict fallback kind='infra'.
 *   B. Retry guard: retry chết hạ tầng → throw với lỗi thật (không phải
 *      "Không tìm thấy JSON object" gây hiểu nhầm lỗi prompt).
 *   C. buildSafeEscalateVerdict(kind): phân biệt infra/parse trong mọi trường
 *      hiển thị (summary/directive/rationale).
 *   D. Model sống: profile DB + fallback code = nvidia/nemotron-3-ultra-550b-a55b
 *      (probe live 2026-10-20: NIM 200 OK 0.7s; Zen 403/410 chết với key oc_sk).
 *
 * Phong cách test: source-scan (tiền lệ r124/r126/r127) + guard DB trực tiếp —
 * KHÔNG import reviewer.ts (kéo llm.ts side-effect: key pool + DB init).
 */

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TMO = join(import.meta.dir, '..')
const reviewerSrc = readFileSync(join(TMO, 'src/lib/opus/reviewer.ts'), 'utf-8')

describe('r128 A — source-scan reviewer.ts (OPUS-VERDICT-1)', () => {
  test('A1. Guard llm.error tồn tại và đặt trước nhánh parse', () => {
    expect(reviewerSrc).toContain('if (llm?.error && !llm.content)')
    expect(reviewerSrc).toContain('bỏ qua parse/retry')
    // Guard phải nằm TRƯỚC nhánh "4. Parse" trong file
    const guardIdx = reviewerSrc.indexOf('if (llm?.error && !llm.content)')
    const parseIdx = reviewerSrc.indexOf('// 4. Parse + retry 1 lần')
    expect(guardIdx).toBeGreaterThan(0)
    expect(parseIdx).toBeGreaterThan(guardIdx)
  })

  test('A2. Guard dùng kind=infra — phân biệt với lỗi định dạng', () => {
    // Assert thật (kỹ càng, không phụ thuộc whitespace):
    expect(reviewerSrc).toMatch(/buildSafeEscalateVerdict\(\s*`LỖI HẠ TẦNG LLM[^`]*`,\s*'infra'/)
    expect(reviewerSrc).toMatch(/console\.error\(`\[Opus\]\[reviewer\] LLM call thất bại \(hạ tầng\)/)
  })

  test('A3. Retry guard: lỗi hạ tầng ở lần retry → throw với lỗi thật', () => {
    expect(reviewerSrc).toContain('if (retry?.error && !retry.content)')
    expect(reviewerSrc).toMatch(/throw new Error\(`LLM lỗi ở lần retry \(hạ tầng\): \$\{retry\.error\}`\)/)
  })

  test('A4. buildSafeEscalateVerdict có kind param + nhánh infra đầy đủ', () => {
    expect(reviewerSrc).toMatch(/buildSafeEscalateVerdict\(reason: string, kind: 'parse' \| 'infra' = 'parse'\)/)
    expect(reviewerSrc).toContain("summary: infra ? 'Opus không gọi được LLM (lỗi hạ tầng model/provider)'")
    expect(reviewerSrc).toContain("'Opus không đọc được verdict JSON từ model'")
    // directive.rationale infra phải nhúng reason (nguyên nhân thật đến được người đọc)
    expect(reviewerSrc).toContain('`LLM call thất bại (${reason}) — cần cấu hình model đang sống cho Opus')
    // acceptanceCriteria infra
    expect(reviewerSrc).toContain("'LLM call của Opus trả content không rỗng (error unset) ngay lần thử đầu'")
  })

  test('A5. Fallback config khi getOpusProfile null = model fleet NIM đang sống', () => {
    expect(reviewerSrc).toContain("{ provider: 'nvidia', model: 'nvidia/nemotron-3-ultra-550b-a55b' }")
    // Không còn string literal model chết nào trong code (chỉ cho phép trong comment — không có dấu nháy)
    const deadLiteral = reviewerSrc.match(/['"]space-bunny-free['"]/)
    expect(deadLiteral).toBeNull()
  })

  test('A6. Các guard an toàn cũ giữ nguyên (không phó tay mặc định)', () => {
    expect(reviewerSrc).toContain('usedFallback = true')
    expect(reviewerSrc).toContain('Bỏ qua sync Issue Ledger — verdict fallback không đáng tin')
    expect(reviewerSrc).toContain('parseOpusVerdict(llm.content ??')
  })
})

describe('r128 B — guard DB: profile Opus phải dùng model đang sống', () => {
  test('B1. AgentProfile Opus ≠ zen/space-bunny-free (model 410 ModelDeprecated)', async () => {
    const { Database } = await import('bun:sqlite')
    const db = new Database(join(TMO, 'db/custom.db'), { readonly: true })
    try {
      const row = db.query(`SELECT provider, model FROM AgentProfile WHERE name='Opus'`).get() as { provider: string; model: string } | undefined
      expect(row).toBeDefined()
      expect(`${row!.provider}/${row!.model}`).not.toBe('zen/space-bunny-free')
      // Model hiện tại phải nằm trong danh sách NIM được duyệt (NVIDIA_AGENT_MODELS R25)
      // — guard này chỉ chặn model chết, không chặn người dùng đổi sang model khác hợp lệ.
      const NIM = ['z-ai/glm-5.3-flash', 'deepseek-ai/deepseek-v4.1-flash', 'z-ai/glm-5.3', 'nvidia/nemotron-3-ultra-550b-a55b']
      expect(NIM).toContain(row!.model)
    } finally {
      db.close()
    }
  })
})
