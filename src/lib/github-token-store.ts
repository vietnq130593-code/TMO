/**
 * GitHub Token Store — lưu PAT (Personal Access Token) user nhập trong dialog
 * "Pull Code từ GitHub" để lần sau tự động điền sẵn.
 *
 * Storage: file JSON trong `db/.github-token.json` — thư mục `db/` nằm trong
 * PROTECTED_DIRS của git-pull route nên KHÔNG BAO GIỜ bị ghi đè khi pull code.
 * File perms 0600 (chỉ owner đọc được).
 *
 * Dùng chung bởi:
 *   - /api/git-pull (dialog Pull Code — pre-fill + authenticate fetch)
 *   - Agent tools git_push / git_pull (workspace remote ops)
 *
 * Security notes:
 *   - Token CHỈ nằm trong file này + bộ nhớ tiến trình — không ghi vào .git/config
 *     (khi push/fetch luôn dùng URL kèm token one-shot rồi vứt bỏ).
 *   - GET /api/git-pull trả về raw savedToken để pre-fill dialog (yêu cầu user
 *     2026-08-29: "nhập API Token thì tự động được lưu lại điền sẵn"). Token từ
 *     remote URL embedded thì KHÔNG bao giờ trả raw (giữ hành vi cũ).
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, chmodSync } from 'fs'
import { join } from 'path'

interface StoredGithubToken {
  token: string
  savedAt: string
}

/** Đường dẫn file lưu token — luôn theo app root (process.cwd()), trong db/ protected dir */
function tokenFilePath(): string {
  return join(process.cwd(), 'db', '.github-token.json')
}

/** Mask token cho log/display — hiện 4 ký tự đầu + 4 ký tự cuối */
export function maskGithubToken(token: string): string {
  if (!token) return ''
  if (token.length <= 8) return '****'
  return `${token.slice(0, 4)}****${token.slice(-4)}`
}

/** Lưu (ghi đè) GitHub PAT. Trả về preview của token vừa lưu. */
export function saveGithubToken(token: string): { preview: string } {
  const clean = token.trim()
  if (!clean) throw new Error('Token rỗng — không có gì để lưu')

  const dbDir = join(process.cwd(), 'db')
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true })

  const filePath = tokenFilePath()
  const payload: StoredGithubToken = { token: clean, savedAt: new Date().toISOString() }
  writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8')
  try { chmodSync(filePath, 0o600) } catch { /* non-fatal trên Windows */ }

  console.log(`[GithubTokenStore] Saved GitHub token (${maskGithubToken(clean)}) → ${filePath}`)
  return { preview: maskGithubToken(clean) }
}

/** Đọc token đã lưu. Trả về null nếu chưa từng lưu / file hỏng. */
export function getSavedGithubToken(): string | null {
  try {
    const filePath = tokenFilePath()
    if (!existsSync(filePath)) return null
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as StoredGithubToken
    if (!parsed || typeof parsed.token !== 'string' || !parsed.token.trim()) return null
    return parsed.token.trim()
  } catch (err) {
    console.warn('[GithubTokenStore] Failed to read saved token:', err instanceof Error ? err.message : String(err))
    return null
  }
}

/** Xóa token đã lưu (user bấm "Xóa token" trong dialog). */
export function clearSavedGithubToken(): boolean {
  try {
    const filePath = tokenFilePath()
    if (!existsSync(filePath)) return false
    unlinkSync(filePath)
    console.log('[GithubTokenStore] Cleared saved GitHub token')
    return true
  } catch {
    return false
  }
}

/** Trạng thái token cho GET /api/git-pull: raw (để pre-fill) + preview + savedAt. */
export function getSavedGithubTokenInfo(): {
  hasSavedToken: boolean
  savedToken: string | null
  savedTokenPreview: string | null
  savedAt: string | null
} {
  try {
    const filePath = tokenFilePath()
    if (!existsSync(filePath)) {
      return { hasSavedToken: false, savedToken: null, savedTokenPreview: null, savedAt: null }
    }
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as StoredGithubToken
    const token = parsed?.token?.trim()
    if (!token) {
      return { hasSavedToken: false, savedToken: null, savedTokenPreview: null, savedAt: null }
    }
    return {
      hasSavedToken: true,
      savedToken: token,
      savedTokenPreview: maskGithubToken(token),
      savedAt: parsed.savedAt || null,
    }
  } catch {
    return { hasSavedToken: false, savedToken: null, savedTokenPreview: null, savedAt: null }
  }
}
