// ============================================
// src/lib/preview-ports.ts — Preview proxy port allowlist (user request 2026-09-10)
//
// VẤN ĐỀ: iframe Preview trỏ thẳng http://127.0.0.1:<port> — khi app được xem
// qua proxy HTTPS (preview panel) thì 127.0.0.1 là máy NGƯỜI DÙNG (không có
// dev server) + mixed-content → panel Preview lỗi trắng.
//
// GIẢI PHÁP: same-origin proxy route /api/opencode/preview/proxy/<port>/...
// (server-side fetch tới 127.0.0.1:<port> — chạy đúng máy với dev server).
// Vì proxy có thể trở thành lỗ hổng SSRF nếu cho phép port tuỳ ý, module này
// giữ ALLOWLIST các port dev server đã được start/detect — chỉ những port
// này mới được forward.
//
// Allowlist là in-memory (globalThis — an toàn Next dev multi-instance),
// được ghi bởi:
//   - /api/opencode/preview/start  (port dev server TMO khởi động)
//   - /api/opencode/preview/detect (port dev server đang chạy, scan phát hiện)
// Restart app → allowlist trống → user bấm Preview lại → detect re-scan →
// port được thêm lại (self-healing, không cần persist).
// ============================================

const globalForPorts = globalThis as unknown as {
  __tmoPreviewPorts?: Set<number>
}

export const previewPorts: Set<number> =
  globalForPorts.__tmoPreviewPorts ?? new Set<number>()
globalForPorts.__tmoPreviewPorts = previewPorts

/** Đăng ký 1 port hợp lệ cho preview proxy (idempotent). */
export function allowPreviewPort(port: number): void {
  if (Number.isInteger(port) && port > 0 && port < 65536) {
    previewPorts.add(port)
  }
}

/** Port có được phép forward qua proxy không? */
export function isPreviewPortAllowed(port: number): boolean {
  return previewPorts.has(port)
}

/** Debug — danh sách port đang allow. */
export function listPreviewPorts(): number[] {
  return Array.from(previewPorts).sort((a, b) => a - b)
}
