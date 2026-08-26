// ============================================
// src/lib/tmo-token.ts — TMO_API_TOKEN auto-provisioning
// ============================================
// VẤN ĐỀ (2026-08-28, báo cáo từ máy local user):
//   "Workspace register failed: {\"error\":\"TMO_API_TOKEN not configured\"}"
//   TMO_API_TOKEN chỉ tồn tại trong .env.example — file .env trên máy user là
//   gitignored nên `git pull` KHÔNG BAO GIỜ cập nhật nó. Middleware fail-closed
//   503 → /api/auth/setup không set được cookie → toàn bộ module Code
//   (/api/workspace/*, /api/opencode/*) chết hoàn toàn.
//
// GIẢI PHÁP — self-healing, zero-config:
//   1. Env TMO_API_TOKEN (nếu đặt) luôn ĐƯỢC ƯU TIÊN — không đổi behavior hiện có.
//   2. Nếu thiếu → TỰ SINH token ngẫu nhiên (48 hex chars) và persist vào file
//      .tmo-api-token ở project root (gitignored, mode 0600).
//   3. Mọi consumer (middleware, /api/auth/setup, opencodeFetch,
//      service-manager health probe, tool-executor, mini-service
//      opencode-server qua env inheritance) dùng CHUNG một token.
//
// AN TOÀN:
//   - Tạo file atomic bằng flag 'wx' (O_EXCL) → nhiều process khởi động cùng lúc
//     không ghi đè nhau: bên thắng tạo file, bên thua đọc lại token của winner.
//   - Placeholder "change-me-to-a-random-token" (từ .env.example) bị coi là
//     chưa cấu hình → tự provision token thật thay vì dùng giá trị yếu.
//   - File bị lỗi (read-only FS…) → fallback in-memory token cho process hiện tại
//     + log khuyến nghị set .env thủ công.
//
// LƯU Ý RUNTIME: Next 16 middleware chạy Node.js runtime (option `runtime`
// đã bị xoá khỏi middleware config) → import node:fs / node:crypto an toàn.
// ============================================

import { randomBytes } from 'crypto'
import { closeSync, openSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const TOKEN_FILE_NAME = '.tmo-api-token'
/** Giá trị placeholder trong .env.example — coi như chưa cấu hình */
const PLACEHOLDER_TOKEN = 'change-me-to-a-random-token'

/** Cache module-level — sau lần đầu không tốn fs thêm nữa */
let cachedToken: string | null = null

function tokenFilePath(): string {
  // Cho phép override vị trí file (VD: môi trường project dir read-only)
  if (process.env.TMO_API_TOKEN_FILE) return process.env.TMO_API_TOKEN_FILE
  return join(process.cwd(), TOKEN_FILE_NAME)
}

function isValidToken(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length >= 16
}

function readTokenFile(): string | null {
  try {
    const raw = readFileSync(tokenFilePath(), 'utf8').trim()
    return isValidToken(raw) ? raw : null
  } catch {
    return null
  }
}

/** Tạo file atomic: 'wx' = O_EXCL → fail với EEXIST nếu file đã có */
function writeTokenFileExclusive(token: string): 'created' | 'exists' | 'failed' {
  try {
    const fd = openSync(tokenFilePath(), 'wx', 0o600)
    try {
      writeFileSync(fd, token, 'utf8')
    } finally {
      closeSync(fd)
    }
    return 'created'
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return 'exists'
    return 'failed'
  }
}

/**
 * Trả về TMO_API_TOKEN hiệu dụng, tự sinh + persist nếu chưa cấu hình.
 *
 * Thứ tự ưu tiên:
 *   1. process.env.TMO_API_TOKEN (trừ placeholder của .env.example)
 *   2. File .tmo-api-token đã persist từ lần khởi động trước (token ổn định
 *      qua các lần restart → cookie 30 ngày của /api/auth/setup không mất)
 *   3. Sinh mới + ghi file atomic
 *
 * @returns token hợp lệ, hoặc null nếu mọi đường đều fail (rất hiếm).
 */
export function ensureTmoApiToken(): string | null {
  if (cachedToken) return cachedToken

  // 1) Env ưu tiên — KHÔNG đụng file khi user đã cấu hình rõ ràng
  const envToken = process.env.TMO_API_TOKEN?.trim()
  if (isValidToken(envToken) && envToken !== PLACEHOLDER_TOKEN) {
    cachedToken = envToken
    return cachedToken
  }

  // 2) Token đã persist từ lần chạy trước
  const fromFile = readTokenFile()
  if (fromFile) {
    cachedToken = fromFile
    process.env.TMO_API_TOKEN = fromFile
    return cachedToken
  }

  // 3) Sinh token mới
  const generated = randomBytes(24).toString('hex')
  const result = writeTokenFileExclusive(generated)

  if (result === 'created') {
    cachedToken = generated
    console.warn(
      `[tmo-token] TMO_API_TOKEN chưa cấu hình trong .env — đã TỰ SINH token ` +
        `ngẫu nhiên và lưu vào ${TOKEN_FILE_NAME} (gitignored). ` +
        `Module Code (workspace/opencode) sẵn sàng dùng. ` +
        `Muốn kiểm soát riêng: thêm TMO_API_TOKEN=$(openssl rand -hex 24) vào .env rồi restart.`
    )
  } else if (result === 'exists') {
    // Process khác thắng race khi cùng khởi động — dùng token của winner
    const winner = readTokenFile()
    cachedToken = winner ?? generated
  } else {
    // FS lỗi (read-only, EACCES…) — token in-memory cho process này.
    // Cookie vẫn set được + các request cùng process OK; sau restart token đổi.
    cachedToken = generated
    console.warn(
      `[tmo-token] Không ghi được file ${TOKEN_FILE_NAME} (FS lỗi?) — dùng token ` +
        `tạm in-memory, token sẽ ĐỔI sau mỗi lần restart. ` +
        `Khuyến nghị: thêm TMO_API_TOKEN=<random hex> vào .env`
    )
  }

  process.env.TMO_API_TOKEN = cachedToken
  return cachedToken
}
