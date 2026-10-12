/**
 * ROUND-91 TESTS — BRAIN-UX §9.6 (UX-5) · THEME HI-TECH: CONTRAST + SCOPING
 * (blueprint v0.10 §9.6 — theme "màn hình kính viền sáng" CSS-driven qua cờ
 * data-hitech trên <html>; các cặp màu UX-5 kiểm soát + regression-guard
 * scoping: theme KHÔNG áp khi data-hitech vắng mặt)
 *
 * Đo lường:
 *   A. contrastRatio (util thuần src/lib/ui/contrast.ts — công thức WCAG
 *      2.x): #000 vs #fff = 21 · #767676 vs #fff ≈ 4.54 (xám tối nhất đạt
 *      AA trên trắng) · cùng màu = 1 · ĐỐI XỨNG thứ tự tham số.
 *   B. Quét cặp chữ/nền HI-TECH (UX-5): 8 màu chữ chính vs nền sâu
 *      #05070D — MỖI cặp ≥ 4.5 (WCAG AA) với tên rõ; bề mặt kính (trắng
 *      8% trên nền sâu ≈ #16181e): stone-300/stone-400 ≥ 4.5.
 *   C. GHI NHẬN TRUNG THỰC nợ tiền tồn tại: stone-500/stone-600 (chữ phụ/
 *      caption có SẴN trước UX-5) vs #05070D — đo giá trị thật, comment rõ
 *      ranh giới AA large-text 3.0 (stone-600 thậm chí dưới 3.0 — Bug_v2
 *      đề xuất đợt sau, KHÔNG sửa màu theo phạm vi UX-5).
 *   D. Scoping CSS (đọc src/app/globals.css bằng node:fs): mọi rule
 *      .nc-panel::before nằm TRONG block scoped [data-hitech='on'] ·
 *      [data-hitech='on'] [data-slot='button'] + [data-hitech='on'] body
 *      tồn tại · @media (prefers-reduced-motion: reduce) tắt bs-flow + vành
 *      ht-spin (animation: none) · @property --ht-angle tồn tại — theme
 *      hoàn toàn vô hại khi data-hitech="off"/vắng.
 *   E. Chuỗi hiệu lực ui_hitech: default 'off' → set 'on' → reset 'off' →
 *      ENV 'on' → xóa env về 'off' (mặc định TẮT = fail-open trình bày).
 *
 * Nguyên tắc test (bài học r83 — 1 process, thứ tự file tùy ý):
 * - setTuningValue/process.env dọn SẠCH finally/afterAll.
 * - DB-cô-lập (preload); chỉ đụng TuningParam/TuningChangeLog của key
 *   ui_hitech (log append-only — không xóa rows).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contrastRatio } from '@/lib/ui/contrast'
import {
  getTuningEnum,
  setTuningValue,
  resetTuningValue,
  refreshTuningSnapshot,
} from '@/lib/learning/tuning-store'

/** Nền sâu theme hi-tech (token --ht-bg, globals.css [data-hitech='on'] body). */
const DEEP_BG = '#05070d'
/** Nền hiệu dụng bề mặt kính: trắng 8% trên nền sâu (xấp xỉ màu trộn — §9.6). */
const GLASS_BG = '#16181e'

// ==================== A. contrastRatio — chuẩn WCAG 2.x ====================

describe('r91 · A contrastRatio — công thức WCAG 2.x (util thuần)', () => {
  test('#000000 vs #ffffff = 21 (tuyệt đối); cùng màu = 1', () => {
    // L(#fff)=1, L(#000)=0 → (1+0.05)/(0+0.05) = 21 — đúng giá trị max WCAG
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 2)
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 2)
    expect(contrastRatio('#767676', '#767676')).toBe(1)
  })

  test('#767676 vs #ffffff ≈ 4.54 (±0.02) — xám tối nhất đạt AA 4.5:1 trên trắng', () => {
    // Giá trị tham chiếu phổ biến của cộng đồng accessibility (webaim): 4.54
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2)
  })

  test('ĐỐI XỨNG: contrastRatio(a,b) === contrastRatio(b,a) — mọi cặp', () => {
    const pairs: Array<[string, string]> = [
      ['#000000', '#ffffff'],
      ['#767676', '#ffffff'],
      ['#000000', '#767676'],
      [DEEP_BG, '#a8a29e'],
      [GLASS_BG, '#d6d3d1'],
    ]
    for (const [a, b] of pairs) {
      expect(contrastRatio(a, b)).toBe(contrastRatio(b, a))
    }
    // Pin trung thực cặp #000 vs #767676: ĐO THẬT 4.62 (L=0.1812 → 0.2312/0.05)
    // — KHÁC con số 4.54 (4.54 là của cặp #767676-vs-#ffffff); đối xứng giữ
    // nguyên. Ghi chú quyết định: spec task ghi "≈4.54" cho cặp này — đo lại
    // bằng công thức WCAG ra 4.623, pin theo giá trị đo.
    expect(contrastRatio('#000000', '#767676')).toBeCloseTo(4.62, 2)
  })
})

// ==================== B. CẶP CHỮ/NỀN HI-TECH (UX-5 kiểm soát) ====================

describe('r91 · B quét contrast cặp chữ/nền theme hi-tech (UX-5)', () => {
  test('8 màu chữ chính vs nền sâu #05070D — MỖI cặp ≥ 4.5 (WCAG AA)', () => {
    // Các cặp UX-5 dùng trên nền sâu (globals.css [data-hitech='on'] body —
    // màu chữ giữ nguyên theo spec §9.6 "không đổi tông sẵn có")
    const pairs: ReadonlyArray<{ name: string; fg: string }> = [
      { name: 'stone-100 (chữ chính sáng)', fg: '#f5f5f4' },
      { name: 'stone-200 (chính)', fg: '#e7e5e4' },
      { name: 'stone-300 (phổ biến)', fg: '#d6d3d1' },
      { name: 'stone-400 (chính mờ)', fg: '#a8a29e' },
      { name: 'amber-300 (accent sáng)', fg: '#fcd34d' },
      { name: 'amber-400 (accent amber)', fg: '#fbbf24' },
      { name: 'emerald-400 (xanh tín hiệu)', fg: '#34d399' },
      { name: 'rose-300 (đỏ cảnh báo)', fg: '#fda4af' },
    ]
    for (const { name, fg } of pairs) {
      const ratio = contrastRatio(fg, DEEP_BG)
      expect(ratio).toBeGreaterThanOrEqual(4.5)
    }
    // Chốt thêm biên hẹp nhất cho dễ đọc khi regress: stone-400 ≈ 7.99
    expect(contrastRatio('#a8a29e', DEEP_BG)).toBeCloseTo(7.99, 1)
  })

  test('bề mặt kính (trắng 8% trên nền sâu ≈ #16181e): stone-300/stone-400 ≥ 4.5', () => {
    // Kính .nc-panel: gradient trắng .035→.015 — tính nền hiệu dụng ở mức
    // đậm nhất 8% (pointer:coarse dùng .06→.03 — cùng bậc); đối với chữ
    // stone-300/stone-400 (dùng trong panel) vẫn phải đạt AA
    expect(contrastRatio('#d6d3d1', GLASS_BG)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio('#a8a29e', GLASS_BG)).toBeGreaterThanOrEqual(4.5)
  })
})

// ==================== C. NỢ TIỀN TỒN TẠI (ghi nhận trung thực — KHÔNG sửa) ====================

describe('r91 · C nợ contrast tiền tồn tại trước UX-5 (stone-500/600 caption)', () => {
  test('stone-500 #78716c vs nền sâu: đo ≈ 4.20 — đạt AA large-text 3.0, dưới AA 4.5', () => {
    // NỢ TIỀN TỒN TẠI: stone-500 là màu chữ phụ/caption có SẮN trong UI trước
    // UX-5 (không thuộc các cặp UX-5 kiểm soát — theme mới KHÔNG đổi màu chữ,
    // phạm vi §9.6 chỉ thêm nền/kính/vành). Trên nền sâu mới đo 4.20 < 4.5 —
    // xuống dưới AA chữ thường nhưng còn đạt AA large-text (≥ 3.0).
    const ratio = contrastRatio('#78716c', DEEP_BG)
    expect(ratio).toBeGreaterThanOrEqual(3.0) // WCAG AA large-text
    expect(ratio).toBeLessThan(4.5) // trung thực: chưa đạt AA chữ thường
    expect(ratio).toBeCloseTo(4.2, 1) // pin giá trị đo làm mốc đợt sau
  })

  test('stone-600 #57534e vs nền sâu: đo ≈ 2.64 — DƯỚI CẢ AA large-text 3.0', () => {
    // GHI NHẬN TRUNG THỰC (Bug_v2 — đề xuất xử lý đợt sau, KHÔNG sửa màu
    // trong phạm vi UX-5 theo chỉ thị): stone-600 (caption mờ nhất có sẵn)
    // trên nền sâu chỉ đạt 2.64:1 — dưới cả ngưỡng AA large-text 3.0. Đây là
    // giao thoa "màu chữ cũ × nền mới": nợ thuộc về palette chữ tiền UX-5,
    // không do theme mới gây ra. Pin khoảng đo thật làm regression-guard:
    // khi đợt sau nâng màu, pin này buộc cập nhật có chủ đích.
    const ratio = contrastRatio('#57534e', DEEP_BG)
    expect(ratio).toBeGreaterThan(2.5)
    expect(ratio).toBeLessThan(3.0) // THẤT BẠI AA large-text — nợ tồn tại
    expect(ratio).toBeCloseTo(2.64, 1) // giá trị đo thật
  })
})

// ==================== D. SCOPING CSS (regression-guard: off = vô hại) ====================

describe('r91 · D scoping CSS — theme chỉ áp khi [data-hitech] có mặt', () => {
  // Đường dẫn tương đối TỪ FILE TEST (import.meta.dir = tests/) — không phụ
  // thuộc cwd nơi bun test được gọi (bài học robustness)
  const css = readFileSync(join(import.meta.dir, '..', 'src', 'app', 'globals.css'), 'utf-8')

  /** Trích ĐẦY ĐỦ block @media (prefers-reduced-motion: reduce) bằng đếm ngoặc. */
  function reducedMotionBlocks(src: string): string[] {
    const blocks: string[] = []
    const marker = '@media (prefers-reduced-motion: reduce)'
    let at = src.indexOf(marker)
    while (at >= 0) {
      const open = src.indexOf('{', at)
      if (open < 0) break
      let depth = 1
      let i = open + 1
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++
        else if (src[i] === '}') depth--
        i++
      }
      blocks.push(src.slice(at, i))
      at = src.indexOf(marker, i)
    }
    return blocks
  }

  test("mọi rule .nc-panel::before đều scoped [data-hitech='on'] (KHÔNG có rule trần)", () => {
    // Đếm dòng chọn selector .nc-panel::before — mỗi dòng phải chứa prefix
    // [data-hitech (rule gốc + override @media pointer:coarse — cả 2 scoped)
    const lines = css.split('\n').map(l => l.trim()).filter(l => l.includes('.nc-panel::before'))
    expect(lines.length).toBeGreaterThanOrEqual(1)
    for (const l of lines) {
      expect(l.startsWith('[data-hitech')).toBe(true)
    }
  })

  test("chuỗi selector scoped tồn tại: [data-hitech='on'] [data-slot='button'] + [data-hitech='on'] body", () => {
    expect(css).toContain("[data-hitech='on'] [data-slot='button']")
    expect(css).toContain("[data-hitech='on'] body")
  })

  test('reduced-motion tắt bs-flow + vành ht-spin (animation: none) + transform nút', () => {
    const blocks = reducedMotionBlocks(css)
    expect(blocks.length).toBeGreaterThanOrEqual(1)
    const all = blocks.join('\n')
    // (a) bs-flow (nợ UX-3) bị tắt
    expect(all).toContain('.bs-flow')
    expect(all).toContain('animation: none')
    // (b) vành sáng ht-spin bị tắt: chính .nc-panel::before (phần tử mang
    // animation ht-spin — link chốt ở test dưới) → animation: none
    expect(all).toContain('.nc-panel::before')
    // (c) hover/active nút hi-tech cũng tắt transform
    expect(all).toContain('transform: none')
    // Liên kết ::before ↔ ht-spin: rule gốc khai báo animation ht-spin
    const scopedBefore = css.split('\n').filter(l => l.includes('.nc-panel::before') && l.includes('[data-hitech'))
    const beforeBlock = css.slice(css.indexOf("[data-hitech='on'] .nc-panel::before"))
    expect(beforeBlock).toContain('animation: ht-spin')
    expect(scopedBefore.length).toBeGreaterThanOrEqual(1)
  })

  test('@property --ht-angle đăng ký (nội suy mượt góc vành — fallback tĩnh)', () => {
    expect(css).toContain('@property --ht-angle')
    expect(css).toContain('initial-value: 0deg')
  })
})

// ==================== E. CHUỖI HIỆU LỰC ui_hitech (fail-open trình bày) ====================

describe('r91 · E cờ ui_hitech — mặc định TẮT (fail-open trình bày)', () => {
  beforeAll(async () => {
    await resetTuningValue('ui_hitech').catch(() => {})
    delete process.env.UI_HITECH
    await refreshTuningSnapshot()
  })
  afterAll(async () => {
    await resetTuningValue('ui_hitech').catch(() => {})
    delete process.env.UI_HITECH
    await refreshTuningSnapshot()
  })

  test("default 'off' → set 'on' → reset 'off' → ENV 'on' → dọn env về 'off'", async () => {
    // Mặc định TẮT: theme hi-tech chỉ áp khi user chủ động bật (localStorage
    // nút HiTechToggle / ENV) — thiếu cờ = giao diện hiện tại nguyên vẹn
    expect(getTuningEnum('ui_hitech')).toBe('off')
    try {
      await setTuningValue('ui_hitech', 'on')
      expect(getTuningEnum('ui_hitech')).toBe('on')
      await resetTuningValue('ui_hitech')
      expect(getTuningEnum('ui_hitech')).toBe('off')
      // ENV cũng bật được (đặt máy chủ) — chuỗi STORE › ENV › DEFAULT
      process.env.UI_HITECH = 'on'
      expect(getTuningEnum('ui_hitech')).toBe('on')
      delete process.env.UI_HITECH
      expect(getTuningEnum('ui_hitech')).toBe('off')
    } finally {
      // DỌN SẠCH (bài học r83): store + env + snapshot về default
      await resetTuningValue('ui_hitech').catch(() => {})
      delete process.env.UI_HITECH
      await refreshTuningSnapshot()
    }
    expect(getTuningEnum('ui_hitech')).toBe('off')
  })
})
