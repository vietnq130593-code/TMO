/**
 * AgentRenameInstructionFix (Task 20 — 2026-09-03)
 *
 * Bối cảnh: các migration rename agent (APEX→MEGATRON / CORTEX→SHOCWAVE /
 * BOLT→RAMPAGE @ 5b46d9d, KING→NEMESIS @ 9da1916) đổi trường `name` +
 * tool/skill/model/cron assignment — nhưng KHÔNG dọn text tên cũ còn sót trong
 * `instruction` (persona system prompt) + `description` của các AgentProfile
 * ĐÃ SEED từ trước (seed skip-if-exists giữ nguyên customization). Hệ quả
 * verify live 2026-09-03: chat với NEMESIS (đã rename) → agent tự xương
 * "Tôi là KING" (9 agent bị: NEMESIS/SIVIL/BELI/LISMA/HAN sót 'KING';
 * MEGATRON sót 'APEX'+'BOLT'; SHOCWAVE sót 'CORTEX'; RAMPAGE sót 'BOLT';
 * Omega prompt 13k ký tự sót đủ 3 tên cũ team Code).
 *
 * Fix: replace word-boundary tên cũ → tên mới trong instruction/description
 * của MỌI AgentProfile (giữ nguyên phần customization khác). Idempotent —
 * chạy mỗi boot, no-op khi không còn tên cũ (self-heal nếu row cũ quay lại).
 *
 * Chạy từ instrumentation-node.ts lúc boot (fail-open, globalThis guard).
 */
import { db } from '@/lib/db'

/** Cặp rename đã áp dụng trong DB (mirror AGENT_RENAMES code-team + research-team) */
const AGENT_RENAME_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['KING', 'NEMESIS'],
  ['APEX', 'MEGATRON'],
  ['CORTEX', 'SHOCWAVE'],
  ['BOLT', 'RAMPAGE'],
  // TASK 48 — RAVAGE → "Linh Sickyx" (rename + tách thành standalone độc lập).
  // Safety-net: dọn text "RAVAGE" còn sót trong instruction/description của
  // MỌI profile (persona chính của Linh Sickyx đã được replace trọn bởi
  // migration _migrateRavageToLinhSickyx — cặp này phủ các profile khác +
  // self-heal nếu row cũ quay lại).
  ['RAVAGE', 'Linh Sickyx'],
]

export async function fixStaleAgentNamesInInstructions(): Promise<void> {
  const profiles = await db.agentProfile.findMany({
    select: { id: true, name: true, instruction: true, description: true },
  })
  let fixed = 0
  for (const p of profiles) {
    let changed = false
    let instruction = p.instruction ?? ''
    let description = p.description ?? ''
    for (const [oldName, newName] of AGENT_RENAME_PAIRS) {
      // Word-boundary — không đụng substring (vd "KINGDOM", "THUNDERBOLT")
      const re = new RegExp(`\\b${oldName}\\b`, 'g')
      if (re.test(instruction)) {
        instruction = instruction.replace(re, newName)
        changed = true
      }
      if (re.test(description)) {
        description = description.replace(re, newName)
        changed = true
      }
    }
    if (changed) {
      await db.agentProfile.update({
        where: { id: p.id },
        data: { instruction, description },
      })
      fixed++
      console.log(`[AgentRenameFix] ${p.name}: dọn tên cũ sót trong instruction/description → tên mới`)
    }
  }
  if (fixed > 0) {
    console.log(`[AgentRenameFix] xong — ${fixed}/${profiles.length} agent đã làm sạch tên cũ trong persona (idempotent, chạy lại mỗi boot)`)
  } else {
    console.log('[AgentRenameFix] không còn tên cũ nào trong persona — no-op')
  }
}
