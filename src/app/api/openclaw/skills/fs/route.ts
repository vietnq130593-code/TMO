/**
 * FS Skills Edit API — Task 21-c
 *
 * PUT /api/openclaw/skills/fs — body { name, content }
 *   Ghi đè skills/<name>/SKILL.md (67 filesystem skills — trước 21-c chỉ sửa tay).
 *   - Validate name: chỉ [a-z0-9-] (chống path traversal)
 *   - Validate content: không rỗng, ≤ 512KB
 *   - Tự backup SKILL.md.bak lần đầu sửa mỗi file (nếu chưa có) — fail-safe
 *   - KHÔNG có API xóa (chỉ ghi đè) — KHÔNG đụng logic install ClawHub
 */

import { NextRequest, NextResponse } from 'next/server'
import { writeFsSkill } from '@/lib/fs-skills'

export const dynamic = 'force-dynamic'

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json()
    const { name, content } = body ?? {}

    if (typeof name !== 'string' || typeof content !== 'string') {
      return NextResponse.json(
        { ok: false, error: 'Thiếu name hoặc content (string)' },
        { status: 400 },
      )
    }

    const written = await writeFsSkill(name, content)
    if (!written.ok) {
      return NextResponse.json({ ok: false, error: written.error }, { status: 400 })
    }

    return NextResponse.json({
      ok: true,
      name: written.slug,
      size: written.size,
      backupCreated: written.backupCreated,
      backupNote: written.backupCreated
        ? 'Đã tạo backup SKILL.md.bak (snapshot trước lần sửa đầu tiên)'
        : 'Backup .bak đã có từ lần sửa trước (giữ nguyên bản gốc đầu)',
      message: `Đã lưu skills/${written.slug}/SKILL.md (${Math.round(written.size / 1024)}KB)`,
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
