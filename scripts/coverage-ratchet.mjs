/**
 * COVERAGE RATCHET — logic thuần cho quality-gate stage tests (BLUEPRINT-BACKUP-GATE S2).
 *
 * Tách ra file riêng (không nằm trong quality-gate.mjs) để test import được mà
 * KHÔNG kích hoạt gate (quality-gate.mjs chạy toàn bộ pipeline ngay khi import).
 *
 * Nguyên tắc (blueprint §3-2): coverage là RATCHET, không phải bar — chỉ chặn
 * TỤT so baseline đo được (>1,0 điểm% dưới baseline → FAIL); nâng/hạ baseline
 * là hành vi chủ ý (--coverage-init lần đầu / --coverage-update-baseline kèm
 * entry Bug_v2 khi hạ), không tự động trượt.
 *
 * GIỚI HẠN ĐO LƯỜNG (bun 1.3.14, đối chiếu live blueprint §2-P2): bun --coverage
 * chỉ đếm file được IMPORT bởi ≥1 test → module hoàn toàn mới chưa-test không
 * làm tụt pct. Lớp 1 bảo vệ module mới vẫn là quy tắc fixbug "mọi fix kèm
 * regression test" (source-scan) — coverage là lớp 2, không thay thế lớp 1.
 */

export const COVERAGE_DIR = '.quality-gate-coverage'
export const LCOV_FILE = 'lcov.info'
export const BASELINE_PATH = 'tests/coverage-baseline.json'
export const RATCHET_TOLERANCE_PCT = 1.0

/**
 * Tổng hợp LF:/LH: toàn bộ file trong lcov text → { lf, lh }.
 * LF = lines found, LH = lines hit (chuẩn lcov — bun --coverage-reporter=lcov).
 */
export function parseLcovTotals(lcovText) {
  let lf = 0
  let lh = 0
  for (const line of String(lcovText).split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('LF:')) {
      const n = Number(trimmed.slice(3).trim())
      if (Number.isFinite(n)) lf += n
    } else if (trimmed.startsWith('LH:')) {
      const n = Number(trimmed.slice(3).trim())
      if (Number.isFinite(n)) lh += n
    }
  }
  return { lf, lh }
}

/** Tính % từ { lf, lh } — lf=0 → null (không đo được, không phán xét). */
export function coveragePct({ lf, lh }) {
  if (!Number.isFinite(lf) || lf <= 0) return null
  return Math.round((lh / lf) * 10000) / 100 // 2 chữ số thập phân
}

/**
 * Đánh giá ratchet (pure).
 *
 * @returns {{ status: 'pass'|'fail'|'no-baseline'|'no-data', message: string }}
 *   - no-baseline: chưa có baseline → KHÔNG phán xét (chạy --coverage-init).
 *   - no-data: lcov không có dòng nào đo được → KHÔNG phán xét (tránh fail giả).
 *   - fail: currentPct < baselinePct − tolerancePct.
 */
export function evaluateRatchet(currentPct, baselinePct, tolerancePct = RATCHET_TOLERANCE_PCT) {
  if (baselinePct === null || baselinePct === undefined || !Number.isFinite(baselinePct)) {
    return {
      status: 'no-baseline',
      message: 'chưa có baseline — chạy: bun scripts/quality-gate.mjs --stage=tests --coverage-init',
    }
  }
  if (currentPct === null || currentPct === undefined || !Number.isFinite(currentPct)) {
    return { status: 'no-data', message: 'lcov không đo được dòng nào (LF=0) — bỏ qua phán xét ratchet' }
  }
  const drop = baselinePct - currentPct
  if (drop > tolerancePct) {
    return {
      status: 'fail',
      message:
        `coverage TỤT ${drop.toFixed(2)}đ% (hiện ${currentPct.toFixed(2)}% < baseline ` +
        `${baselinePct.toFixed(2)}% − ${tolerancePct}đ%) — thêm test cho code mới bỏ qua, ` +
        `hoặc hạ baseline CHỦ Ý: --coverage-update-baseline + entry Bug_v2`,
    }
  }
  if (currentPct > baselinePct) {
    return {
      status: 'pass',
      message:
        `coverage TĂNG ${ (currentPct - baselinePct).toFixed(2) }đ% (baseline ${baselinePct.toFixed(2)}% → ${currentPct.toFixed(2)}%) — ` +
        `nâng baseline chủ ý: --coverage-update-baseline`,
    }
  }
  return {
    status: 'pass',
    message: `coverage ${currentPct.toFixed(2)}% ≥ baseline ${baselinePct.toFixed(2)}% − ${tolerancePct}đ% (ratchet giữ)`,
  }
}

/** Đọc baseline từ file → { pct, lh, lf, updatedAt } | null (chưa có). */
export function readBaseline(fs, baselineFile) {
  if (!fs.existsSync(baselineFile)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(baselineFile, 'utf-8'))
    const pct = Number(raw.pct)
    if (!Number.isFinite(pct)) return null
    return { pct, lh: Number(raw.lh) || 0, lf: Number(raw.lf) || 0, updatedAt: raw.updatedAt ?? null }
  } catch {
    return null
  }
}

/** Nội dung JSON baseline để ghi (chuẩn hoá). */
export function baselineJsonContent({ pct, lh, lf }) {
  return (
    JSON.stringify(
      {
        _note:
          'Coverage ratchet baseline (BLUEPRINT-BACKUP-GATE S2) — CHỈ cập nhật chủ ý qua ' +
          '--coverage-init / --coverage-update-baseline; hạ baseline bắt buộc entry Bug_v2. ' +
          'Giới hạn: bun coverage chỉ đếm file được import bởi test (import-only).',
        pct,
        lh,
        lf,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    ) + '\n'
  )
}
