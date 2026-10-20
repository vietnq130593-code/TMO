/**
 * r141 — §7.10 COMPILE-RATCHET BOOT (round riêng 2026-10-21 — DEBT-R17BC giữ hoãn)
 * =====================================================================================
 * Bối cảnh: cold-compile Next dev lúc boot spike RSS 2.2-2.6GB THOÁNG QUA
 * (bằng chứng dev.log 2026-10-20: 15 boot chết ở HARD 2100 với RSS lần-check
 * đầu 2230-2632MB; 2 boot bắt kịp RSS 2047/2081MB thì SỐNG và RSS rơi về
 * 487/557MB sau ~40s) → blind HARD-RSS tier tự exit chính app lúc compile →
 * crash-loop ~29s/vòng. Biện pháp tạm pilot nới 2800/3000 (đã XOÁ — trả về
 * 1900/2100 S6-ops). Fix đúng tầng: HARD tier nhận BOOT-GRACE từ process
 * start (tha spike ≤ ceiling; runaway thật vẫn exit; ngoài grace y hệt cũ).
 *   A. Helper thuần resolveHardTierDecision — mọi nhánh quyết định (0 DB).
 *   B. Source-scan wiring: instrumentation gọi policy + tier áp-lực-thật
 *      (global guard) KHÔNG bị grace hóa; .env.example docs đúng trạng thái
 *      đã-fix (không còn hướng dẫn bật 2800/3000 pilot); OBS_KINDS có kind mới.
 * Tiền lệ: r126/r132/r139/r140 (source-scan + helper thuần).
 */

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  resolveHardTierDecision,
  MEM_WATCHDOG_BOOT_GRACE_MS_DEFAULT,
  MEM_WATCHDOG_BOOT_CEILING_HEADROOM_MB,
} from '@/lib/mem-watchdog-policy'

const TMO = join(import.meta.dir, '..')
const read = (p: string) => readFileSync(join(TMO, p), 'utf-8')

describe('r141 — §7.10 boot-grace HARD-RSS (compile-ratchet)', () => {
  // ============ A. Helper thuần resolveHardTierDecision ============

  test('A1. tier tắt (hardMb=0) → ok — giữ ngữ nghĩa họ MEM_WATCHDOG_ (0 = tắt)', () => {
    const d = resolveHardTierDecision({ rssMb: 2600, hardMb: 0, uptimeMs: 5_000, graceMs: 180_000, ceilingMb: 2800 })
    expect(d.action).toBe('ok')
  })

  test('A2. RSS dưới HARD → ok (tier không việc gì — kể cả trong grace)', () => {
    const d = resolveHardTierDecision({ rssMb: 2099, hardMb: 2100, uptimeMs: 5_000, graceMs: 180_000, ceilingMb: 2800 })
    expect(d.action).toBe('ok')
  })

  test('A3. grace tắt (graceMs=0) + vượt HARD → exit hard-rss — hành vi cũ giữ nguyên khi tắt grace', () => {
    const d = resolveHardTierDecision({ rssMb: 2500, hardMb: 2100, uptimeMs: 5_000, graceMs: 0, ceilingMb: 2800 })
    expect(d).toEqual({ action: 'exit', reason: 'hard-rss', rssMb: 2500, hardMb: 2100 })
  })

  test('A4. ngoài grace (uptime ≥ graceMs) + vượt HARD → exit hard-rss — sau grace hành vi y hệt vòng 11c', () => {
    expect(
      resolveHardTierDecision({ rssMb: 2300, hardMb: 2100, uptimeMs: 180_000, graceMs: 180_000, ceilingMb: 2800 }),
    ).toEqual({ action: 'exit', reason: 'hard-rss', rssMb: 2300, hardMb: 2100 })
    expect(
      resolveHardTierDecision({ rssMb: 2300, hardMb: 2100, uptimeMs: 600_000, graceMs: 180_000, ceilingMb: 2800 }),
    ).toEqual({ action: 'exit', reason: 'hard-rss', rssMb: 2300, hardMb: 2100 })
  })

  test('A5. TRONG grace + vượt HARD nhưng dưới ceiling → grace-log (spike cold-compile được tha) + graceRemainingMs đúng', () => {
    const d = resolveHardTierDecision({ rssMb: 2632, hardMb: 2100, uptimeMs: 20_000, graceMs: 180_000, ceilingMb: 2800 })
    // 2632MB = peak quan sát cao nhất trong bằng chứng crash-loop
    expect(d.action).toBe('grace-log')
    if (d.action === 'grace-log') {
      expect(d.hardMb).toBe(2100)
      expect(d.ceilingMb).toBe(2800)
      expect(d.graceRemainingMs).toBe(160_000)
    }
  })

  test('A6. TRONG grace + vượt CEILING → exit grace-ceiling (runaway thật không được tha)', () => {
    const d = resolveHardTierDecision({ rssMb: 2800, hardMb: 2100, uptimeMs: 20_000, graceMs: 180_000, ceilingMb: 2800 })
    expect(d).toEqual({ action: 'exit', reason: 'grace-ceiling', rssMb: 2800, ceilingMb: 2800 })
  })

  test('A7. ceiling cấu hình thấp hơn HARD → bị kẹp lên HARD (grace không biến thành tha-tất-cả)', () => {
    const d = resolveHardTierDecision({ rssMb: 2150, hardMb: 2100, uptimeMs: 20_000, graceMs: 180_000, ceilingMb: 1500 })
    expect(d).toEqual({ action: 'exit', reason: 'grace-ceiling', rssMb: 2150, ceilingMb: 2100 })
  })

  test('A8. ceiling rác (NaN) → hiệu lực = HARD (bảo thủ như không có grace — fail về hành vi cũ)', () => {
    const d = resolveHardTierDecision({ rssMb: 2100, hardMb: 2100, uptimeMs: 20_000, graceMs: 180_000, ceilingMb: Number.NaN })
    expect(d).toEqual({ action: 'exit', reason: 'grace-ceiling', rssMb: 2100, ceilingMb: 2100 })
  })

  test('A9. uptime rác (NaN/âm) → exit hard-rss (fail về hành vi cũ — grace là khoan dung MỚI, fail-safe nghiêng bảo vệ)', () => {
    expect(
      resolveHardTierDecision({ rssMb: 2500, hardMb: 2100, uptimeMs: Number.NaN, graceMs: 180_000, ceilingMb: 2800 }),
    ).toEqual({ action: 'exit', reason: 'hard-rss', rssMb: 2500, hardMb: 2100 })
    expect(
      resolveHardTierDecision({ rssMb: 2500, hardMb: 2100, uptimeMs: -1, graceMs: 180_000, ceilingMb: 2800 }),
    ).toEqual({ action: 'exit', reason: 'hard-rss', rssMb: 2500, hardMb: 2100 })
  })

  test('A10. graceMs rác (NaN) → exit hard-rss (đồng bộ fail-safe A9)', () => {
    const d = resolveHardTierDecision({ rssMb: 2500, hardMb: 2100, uptimeMs: 20_000, graceMs: Number.NaN, ceilingMb: 2800 })
    expect(d).toEqual({ action: 'exit', reason: 'hard-rss', rssMb: 2500, hardMb: 2100 })
  })

  test('A11. rssMb/hardMb NaN → ok (không so sánh được — đồng bộ fail-open try/catch của watchdog gốc)', () => {
    expect(
      resolveHardTierDecision({ rssMb: Number.NaN, hardMb: 2100, uptimeMs: 5_000, graceMs: 180_000, ceilingMb: 2800 }),
    ).toEqual({ action: 'ok' })
    expect(
      resolveHardTierDecision({ rssMb: 2500, hardMb: Number.NaN, uptimeMs: 5_000, graceMs: 180_000, ceilingMb: 2800 }),
    ).toEqual({ action: 'ok' })
  })

  test('A12. hằng số mặc định: grace 180s (trùm cold-compile ~40s với dư biên) + headroom ceiling 700MB (HARD 2100 → 2800 = giá trị pilot đã sống)', () => {
    expect(MEM_WATCHDOG_BOOT_GRACE_MS_DEFAULT).toBe(180_000)
    expect(MEM_WATCHDOG_BOOT_CEILING_HEADROOM_MB).toBe(700)
  })

  // ============ B. Source-scan wiring instrumentation + docs ============

  test('B1. instrumentation import policy thuần + gọi resolveHardTierDecision cho HARD tier', () => {
    const src = read('src/instrumentation-node.ts')
    expect(src).toContain("from './lib/mem-watchdog-policy'")
    expect(src).toContain('resolveHardTierDecision({')
    // đường cũ (so sánh trực tiếp + exit không qua policy) phải KHÔNG còn
    expect(src).not.toContain('rssMb >= MEM_WATCHDOG_RSS_HARD_MB) {')
  })

  test('B2. instrumentation đọc 2 env mới (grace + ceiling) với default từ policy', () => {
    const src = read('src/instrumentation-node.ts')
    expect(src).toContain('MEM_WATCHDOG_BOOT_GRACE_MS ?? MEM_WATCHDOG_BOOT_GRACE_MS_DEFAULT')
    expect(src).toContain('MEM_WATCHDOG_BOOT_CEILING_MB ??')
    expect(src).toContain('MEM_WATCHDOG_RSS_HARD_MB + MEM_WATCHDOG_BOOT_CEILING_HEADROOM_MB')
  })

  test('B3. nhánh grace-log phát observation event mem.boot_grace (fail-open catch) + throttle 1 lần/cửa sổ', () => {
    const src = read('src/instrumentation-node.ts')
    expect(src).toContain("kind: 'mem.boot_grace'")
    expect(src).toContain('bootGraceEventEmitted')
    // fail-open: observation không được phá watchdog (đối chiếu khối mem.soft_tier precedent)
    const graceBlock = src.slice(src.indexOf('grace-log'), src.indexOf('grace-log') + 2000)
    expect(graceBlock).toContain('.catch(() => { /* fail-open — observation không được phá watchdog */ })')
  })

  test('B4. tier áp-lực-thật KHÔNG bị grace hóa: global guard (MemAvailable<450) + avail-aware ×2 vẫn chạy vô điều kiện grace', () => {
    const src = read('src/instrumentation-node.ts')
    // global guard đứng SAU khối policy, không bị bọc trong nhánh grace
    expect(src).toContain("if (MEM_WATCHDOG_GLOBAL_MIN_MB > 0 && rssMb > MEM_WATCHDOG_GLOBAL_RSS_MB) {")
    expect(src).toContain('if (rssMb > MEM_WATCHDOG_MB) {')
    // không có dấu hiệu grace can thiệp 2 tier trên
    const globalGuardIdx = src.indexOf('if (MEM_WATCHDOG_GLOBAL_MIN_MB > 0')
    const availTierIdx = src.indexOf('if (rssMb > MEM_WATCHDOG_MB) {')
    expect(globalGuardIdx).toBeGreaterThan(0)
    expect(availTierIdx).toBeGreaterThan(globalGuardIdx)
  })

  test('B5. .env.example docs trạng thái ĐÃ-FIX: 2 cờ mới có mặt, KHÔNG còn hướng dẫn bật pilot 2800/3000', () => {
    const envExample = read('.env.example')
    expect(envExample).toContain('# MEM_WATCHDOG_BOOT_GRACE_MS=180000')
    expect(envExample).toContain('# MEM_WATCHDOG_BOOT_CEILING_MB=2800')
    expect(envExample).toContain('ĐÃ FIX round riêng 2026-10-21')
    // dòng pilot cũ phải đã bị XOÁ (dù ở dạng comment cũng gây hiểu nhầm "biện pháp tạm ĐANG BẬT")
    expect(envExample).not.toContain('# MEM_WATCHDOG_MB=2800')
    expect(envExample).not.toContain('# MEM_WATCHDOG_RSS_HARD_MB=3000')
  })

  test('B6. OBS_KINDS khai báo mem.boot_grace + mem.soft_tier (single-source doctrine — kind phát ra phải có dòng)', () => {
    const kinds = read('src/lib/observation/kinds.ts')
    expect(kinds).toContain("kind: 'mem.boot_grace'")
    expect(kinds).toContain("kind: 'mem.soft_tier'")
  })

  test('B7. worker (scripts/worker.ts) KHÔNG nhận grace — watchdog worker là avail-aware ×2 (không blind tier), đúng thiết kế S3', () => {
    const worker = read('scripts/worker.ts')
    expect(worker).not.toContain('boot-grace')
    expect(worker).not.toContain('BOOT_GRACE')
    // worker vẫn là avail-aware ×2
    expect(worker).toContain('availMb < 900')
  })

  test('B8. module policy thuần 0 import (test trực tiếp không cần DB/process — tiền lệ r140)', () => {
    const policy = read('src/lib/mem-watchdog-policy.ts')
    expect(policy).not.toMatch(/^import /m)
    expect(policy).not.toMatch(/^const .*require\(/m)
  })
})
