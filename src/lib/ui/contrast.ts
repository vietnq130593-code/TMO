/**
 * BẢN-UX §9.6 (UX-5) — WCAG CONTRAST UTIL (thuần — test r91)
 * ============================================================================
 *
 * Công thức đo tương phản màu theo WCAG 2.x (r91 quét cặp chữ/nền theme
 * hi-tech). Nguồn công thức — W3C, "Understanding Success Criterion 1.4.3
 * Contrast (Minimum)" (WCAG 2.x, giữ nguyên qua 2.1/2.2):
 *
 *   1. Mỗi kênh sRGB c ∈ [0,1] tuyến tính hoá:
 *        c ≤ 0.03928  →  c / 12.92
 *        c > 0.03928  →  ((c + 0.055) / 1.055)^2.4
 *      (ngưỡng 0.03928 là chữ WCAG dùng — erratum đã biết của chuẩn: giá trị
 *      sRGB đúng là 0.04045; WCAG 2.x giữ 0.03928 để khớp các kết quả đo đã
 *      công bố. Với mọi màu dùng trong app, cả 2 ngưỡng cho cùng kết quả
 *      sau khi làm tròn 2 số lẻ.)
 *   2. Độ sáng tương đối: L = 0.2126·R + 0.7152·G + 0.0722·B.
 *   3. Tỉ lệ tương phản (kênh SÁNG trên kênh TỐI — đối xứng):
 *        ratio = (L1 + 0.05) / (L2 + 0.05)   ∈ [1, 21]
 *
 * Thuần — KHÔNG import gì (dùng cho cả client bundle lẫn bun:test).
 */

/** Chuỗi hoá 1 kênh sRGB ∈ [0,1] → kênh tuyến tính (công thức WCAG — xem header). */
function linearizeChannel(c: number): number {
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** Ép chuỗi hex (#rgb hoặc #rrggbb, case-insensitive) → [r,g,b] ∈ [0,255]. */
function parseHex(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) throw new Error(`relativeLuminance: hex "${hex}" không hợp lệ (#rgb | #rrggbb)`)
  const s = m[1]
  const full = s.length === 3
    ? s[0] + s[0] + s[1] + s[1] + s[2] + s[2]
    : s
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  }
}

/**
 * Độ sáng tương đối WCAG 2.x của 1 màu hex — L ∈ [0, 1]
 * (#000000 → 0 · #ffffff → 1 · #767676 ≈ 0.1807).
 */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex)
  return (
    0.2126 * linearizeChannel(r / 255)
    + 0.7152 * linearizeChannel(g / 255)
    + 0.0722 * linearizeChannel(b / 255)
  )
}

/**
 * Tỉ lệ tương phản WCAG 2.x giữa 2 màu — ∈ [1, 21], ĐỐI XỨNG
 * (contrastRatio(a, b) === contrastRatio(b, a)): mẫu số luôn lấy kênh TỐI
 * hơn, tử số kênh SÁNG hơn.
 *   #000000 vs #ffffff → 21 (max tuyệt đối) · cùng màu → 1.
 */
export function contrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexA)
  const lb = relativeLuminance(hexB)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}
