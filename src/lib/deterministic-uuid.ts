/**
 * DETERMINISTIC UUID — sinh UUID v5-style ổn định từ seed string.
 *
 * WHY THIS EXISTS (ràng buộc Qdrant + tiền lệ đã trả giá 2 lần):
 * Qdrant chỉ chấp nhận point ID là UUID hoặc unsigned integer. Chuỗi tự do
 * ("al-...", "ep_...") bị Qdrant từ chối với 400 Bad Request MỌI lần upsert —
 * lỗi im lặng theo đúng lớp đó từng xảy ra thật:
 *   - episodes: "ep_..." bị 400 → FIX E2E 2026-08-29 (episode-store.ts:130)
 *   - auto-learn: "al-..." bị 400 → FIX round-32 P0-3 (auto-learn.ts)
 * Đặt hàm ở module chung để mọi nơi cần point ID Qdrant dùng CÙNG một nguồn —
 * chống việc copy-paste lệch chuẩn về sau.
 *
 * Deterministic: cùng seed → cùng UUID → re-upsert đè cùng point, không nhân
 * bản (khác randomUUID tạo point mới mỗi lần). KHÔNG dùng cho crypto/mục đích
 * bảo mật — chỉ cần độ phân tán ổn cho sandbox.
 */
export function deterministicUuid(seed: string): string {
  // 4 hex đầu từ hash — đủ độ phân tán cho sandbox; KHÔNG dùng cho crypto
  let hash = ''
  for (let i = 0; i < 5; i++) {
    // FNV-1a 32-bit lặp — đơn giản, không dependency
    let h = 0x811c9dc5
    const s = `${seed}#${i}`
    for (let j = 0; j < s.length; j++) {
      h ^= s.charCodeAt(j)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    hash += h.toString(16).padStart(8, '0')
  }
  const hex = hash.slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
