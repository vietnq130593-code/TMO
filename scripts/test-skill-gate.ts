/**
 * E2E test (read-only verifikasi) — SKILL ACCESS enforcement 2 lớp
 * (2026-09-01): read_skill hard-gate + list_skills filter.
 *
 * Chạy: bun scripts/test-skill-gate.ts
 * Tự dọn dẹp (reset assignment) sau test. KHÔNG dùng trong CI — script dev.
 */
import { executeTool } from '@/lib/code-team/tool-executor'
import { setSkillAssignment, getAllSkillAssignments } from '@/lib/skill-access'

async function main() {
  const SLUG = 'pdf' // FS skill thật (skills/pdf/SKILL.md)
  const AGENT = 'CORTEX'

  // 0. Baseline — chưa có assignment
  const before = await getAllSkillAssignments()
  const hadRow = before.some(a => a.agentKey === 'CORTEX' && a.slug === SLUG)
  console.log(`[0] Baseline: ${before.length} assignments (hadRow=${hadRow})`)

  // 1. Chặn skill pdf cho CORTEX
  await setSkillAssignment(AGENT, SLUG, false, 'e2e-test')
  console.log(`[1] Đã set assignment: CORTEX × ${SLUG} = disabled`)

  // 2. read_skill với agentName=CORTEX → PHẢI bị chặn (hard-gate)
  const blocked = await executeTool('read_skill', { slug: SLUG }, { agentName: 'CORTEX' })
  const blockedOk = !blocked.success && String(blocked.result).includes('VÔ HIỆU HÓA')
  console.log(`[2] read_skill CORTEX → success=${blocked.success} (kỳ vọng false) → ${blockedOk ? 'PASS' : 'FAIL'}`)
  console.log(`    result: ${String(blocked.result).slice(0, 120)}`)

  // 3. read_skill với agentName=BOLT (không bị chặn) → PHẢI đọc được
  const allowed = await executeTool('read_skill', { slug: SLUG }, { agentName: 'BOLT' })
  const allowedOk = allowed.success === true
  console.log(`[3] read_skill BOLT → success=${allowed.success} (kỳ vọng true) → ${allowedOk ? 'PASS' : 'FAIL'}`)

  // 4. list_skills với CORTEX → skill pdf PHẢI bị ẩn khỏi filesystemSkills
  const listing = await executeTool('list_skills', { source: 'filesystem' }, { agentName: 'CORTEX' })
  const result = listing.result as { filesystemSkills?: Array<{ slug: string }>; _skillAccess?: string }
  const hiddenOk = !(result.filesystemSkills ?? []).some(s => s.slug === SLUG)
  console.log(`[4] list_skills CORTEX → pdf hidden=${hiddenOk} (kỳ vọng true) → ${hiddenOk ? 'PASS' : 'FAIL'}`)
  console.log(`    _skillAccess: ${result._skillAccess}`)

  // 5. list_skills với BOLT → pdf vẫn hiện
  const listingBolt = await executeTool('list_skills', { source: 'filesystem' }, { agentName: 'BOLT' })
  const resultBolt = listingBolt.result as { filesystemSkills?: Array<{ slug: string }> }
  const visibleOk = (resultBolt.filesystemSkills ?? []).some(s => s.slug === SLUG)
  console.log(`[5] list_skills BOLT → pdf visible=${visibleOk} (kỳ vọng true) → ${visibleOk ? 'PASS' : 'FAIL'}`)

  // 6. Dọn dẹp — reset về mặc định (trừ khi có row thật từ trước)
  if (!hadRow) {
    await setSkillAssignment(AGENT, SLUG, null, 'e2e-test')
    console.log(`[6] Cleanup: reset assignment CORTEX × ${SLUG} → xong`)
  } else {
    await setSkillAssignment(AGENT, SLUG, false, 'e2e-test') // khôi phục trạng thái gốc
    console.log(`[6] Cleanup: giữ nguyên assignment gốc (đã có từ trước)`)
  }

  const allPass = blockedOk && allowedOk && hiddenOk && visibleOk
  console.log(allPass ? '✅ ALL PASS — enforcement 2 lớp hoạt động' : '❌ CÓ FAIL — kiểm tra lại')
  process.exit(allPass ? 0 : 1)
}

main().catch(err => {
  console.error('E2E error:', err)
  process.exit(1)
})
