/**
 * TUNING INPUT PARSER — helper thuần cho TuningParamDialog (BRAIN-LIVE)
 * ==================================================================
 *
 * Bối cảnh (chỉ thị user 2026-10-12): trước đây bấm mũi tên ở cột "Hành động"
 * của bảng Tham số runtime chỉ nhảy selection lên inspector phía trên — user
 * phải cuộn chuột lên để tìm ô chỉnh. TuningParamDialog cho phép chỉnh + đóng
 * ngay tại chỗ; module này là lõi validate của editor trong dialog đó.
 *
 * THUẦN — KHÔNG import React, KHÔNG import '@/lib/db' (Prisma): an toàn cho
 * client bundle lẫn bun:test (task 15-e pin trực tiếp, không cần mock gì).
 *
 * ĐỒNG BỘ NGỮ NGHĨA với `validateTuningInput(key, raw)` của tuning-store
 * (server, đường ghi thật qua API): number = parseFloat bắt buộc hữu hạn +
 * KIỂM tra phạm vi [min, max] (không tự kẹp — user phải thấy sai phạm vi rõ
 * ràng) + làm tròn 6 chữ số lẻ chống float-junk; enum = trim rồi phải nằm
 * trong enumValues. KHÔNG import tuning-store ở đây được (nó kéo Prisma vào
 * client bundle) nên logic được nhân bản có chủ đích — đổi quy tắc ở một nơi
 * PHẢI đổi cả hai (ghi chú này + JSDoc bên dưới là hợp đồng giữ đồng bộ).
 *
 * Khác biệt chấp nhận: validateTuningInput (server) lowercase thêm input enum
 * trước khi so; parseTuningInput so THẦN chữ vì dialog enum editor chỉ submit
 * giá trị lấy đúng từ enumValues (nút segmented) — hai bên không bao giờ lệch
 * qua đường UI này.
 */

import type { TuningSpec } from './neural-types'

/** Kết quả parse input user theo spec — ok kèm giá trị chuẩn hoá, lỗi kèm câu tiếng Việt. */
export type TuningParseResult =
  | { ok: true; value: number | string }
  | { ok: false; error: string }

/**
 * Parse + validate chuỗi user nhập theo spec (thuần, không throw):
 *
 *   type='number': trim → parseFloat → bắt buộc hữu hạn → kiểm tra
 *                 [min, max] (min/max thiếu coi như −∞/+∞, không kẹp) →
 *                 làm tròn 6 chữ số lẻ (0.30000000000000004 → 0.3).
 *   type='enum':  trim → phải thuộc spec.enumValues (nếu có) → giữ nguyên
 *                 chuỗi; ngoài danh sách → lỗi liệt kê giá trị hợp lệ.
 *
 * Dùng bởi TuningParamDialog (BRAIN-LIVE): hiện lỗi đỏ dưới input, disable
 * nút Lưu khi lỗi, và chuẩn hoá giá trị trước khi gọi onSet.
 */
export function parseTuningInput(spec: TuningSpec, raw: string): TuningParseResult {
  const trimmed = raw.trim()

  if (spec.type === 'number') {
    const n = parseFloat(trimmed)
    if (!Number.isFinite(n)) {
      return { ok: false, error: 'Giá trị phải là số hợp lệ' }
    }
    const min = spec.min ?? -Infinity
    const max = spec.max ?? Infinity
    if (n < min || n > max) {
      return { ok: false, error: `Ngoài phạm vi [${min}, ${max}]: ${n}` }
    }
    return { ok: true, value: Math.round(n * 1e6) / 1e6 }
  }

  // type='enum' (hoặc bất kỳ type tương lai nào có danh sách đóng)
  const values = spec.enumValues ?? []
  if (!values.includes(trimmed)) {
    return { ok: false, error: `Giá trị phải thuộc [${values.join(' | ')}] (nhận: "${trimmed}")` }
  }
  return { ok: true, value: trimmed }
}
