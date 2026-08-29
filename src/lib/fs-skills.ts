/**
 * FS Skills — Task 21-c: đọc/ghi nội dung skills/<slug>/SKILL.md trên đĩa
 * (67 filesystem skills — trước 21-c KHÔNG có API xem/sửa nội dung).
 *
 * Dùng chung bởi:
 *   - GET /api/openclaw/skills?action=content (fallback filesystem)
 *   - PUT /api/openclaw/skills/fs (sửa nội dung — có backup)
 *   - Omega tool manage_tools (action read_skill / write_skill)
 *
 * Bảo mật:
 *   - Slug chỉ được chứa [a-z0-9-] (chống path traversal — chặn '..')
 *   - Content ≤ 512KB
 *   - KHÔNG có API xóa skill (chỉ ghi đè + backup)
 *
 * Backup fail-safe: lần đầu sửa mỗi file, nếu SKILL.md.bak CHƯA có → copy nội
 * dung hiện tại sang .bak (snapshot trước lần sửa đầu tiên — user luôn khôi
 * phục được bản gốc).
 */

import { promises as fs } from 'fs'
import { join } from 'path'

/** Slug hợp lệ: chữ thường/số/gạch ngang, 1-100 ký tự — chặn path traversal */
const VALID_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/

export const MAX_SKILL_CONTENT_BYTES = 512 * 1024 // 512KB

export function isValidSkillSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && VALID_SLUG.test(slug)
}

function skillsRoot(): string {
  return join(process.cwd(), 'skills')
}

export interface FsSkillContent {
  slug: string
  content: string
  size: number
  /** true nếu đã có file backup .bak (đã từng được sửa qua Tools Manager) */
  hasBackup: boolean
}

/** Đọc skills/<slug>/SKILL.md. Trả null nếu slug sai định dạng / không tồn tại. */
export async function readFsSkill(slug: string): Promise<FsSkillContent | null> {
  if (!isValidSkillSlug(slug)) return null
  try {
    const skillMdPath = join(skillsRoot(), slug, 'SKILL.md')
    const content = await fs.readFile(skillMdPath, 'utf-8')
    let hasBackup = false
    try {
      await fs.access(skillMdPath + '.bak')
      hasBackup = true
    } catch {
      hasBackup = false
    }
    return { slug, content, size: Buffer.byteLength(content, 'utf-8'), hasBackup }
  } catch {
    return null
  }
}

/**
 * Ghi đè skills/<slug>/SKILL.md (atomic temp+rename). Tự tạo backup .bak lần
 * đầu (nếu chưa có). Trả kết quả có thông tin backup.
 */
export async function writeFsSkill(
  slug: string,
  content: string,
): Promise<{ ok: true; slug: string; size: number; backupCreated: boolean } | { ok: false; error: string }> {
  if (!isValidSkillSlug(slug)) return { ok: false, error: `Tên skill không hợp lệ: "${slug}" (chỉ [a-z0-9-])` }
  if (typeof content !== 'string' || content.length === 0) return { ok: false, error: 'content không được rỗng' }
  const bytes = Buffer.byteLength(content, 'utf-8')
  if (bytes > MAX_SKILL_CONTENT_BYTES) {
    return { ok: false, error: `content quá lớn (${Math.round(bytes / 1024)}KB > giới hạn ${Math.round(MAX_SKILL_CONTENT_BYTES / 1024)}KB)` }
  }

  const skillMdPath = join(skillsRoot(), slug, 'SKILL.md')

  // Phải có SKILL.md sẵn (chỉ SỬA — không sinh skill mới qua API này)
  let existed = true
  try {
    await fs.access(skillMdPath)
  } catch {
    existed = false
  }
  if (!existed) return { ok: false, error: `Skill "${slug}" không có SKILL.md trên đĩa — không thể sửa` }

  // Backup lần đầu sửa (nếu .bak chưa có)
  let backupCreated = false
  const bakPath = skillMdPath + '.bak'
  try {
    await fs.access(bakPath)
  } catch {
    try {
      await fs.copyFile(skillMdPath, bakPath)
      backupCreated = true
    } catch {
      // Backup fail → vẫn ghi (nội dung mới do user/Omega chủ động gửi) nhưng báo
    }
  }

  // Atomic write: temp + rename
  const tmpPath = skillMdPath + `.tmp_${Date.now()}`
  await fs.writeFile(tmpPath, content, 'utf-8')
  await fs.rename(tmpPath, skillMdPath)

  return { ok: true, slug, size: bytes, backupCreated }
}
