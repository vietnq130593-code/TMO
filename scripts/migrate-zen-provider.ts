/**
 * DB Migration: Switch TMO agents to OpenCode Zen provider (2026-09-24)
 * =============================================================================
 * User directive: Omega, Opus, MEGATRON (TL), NEMESIS (TL) → nemotron-3-ultra-free
 *                 G1/G2/G3 (both teams) + ALISTA → muse-spark-1.3-contributor-free
 *
 * The seed files (code-team/agents.ts, research-team/agents.ts, standalone-agents.ts,
 * opus/opus-agent.ts) already declare provider='zen' — but seed logic SKIPS existing
 * rows (preserves user customization). This script updates EXISTING AgentProfile rows
 * so the running DB matches the new Zen config without needing a full reseed.
 *
 * Usage: bun run scripts/migrate-zen-provider.ts
 * Safe to re-run (idempotent — only updates rows that don't already match).
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

// Agent → Zen model mapping (user directive 2026-09-24)
const NEMOTRON_AGENTS = ['Omega', 'Opus', 'MEGATRON', 'NEMESIS']
const MUSE_SPARK_AGENTS = [
  'SHOCWAVE', 'RAMPAGE', 'SENTINEL', 'CATALYST',  // Code Team G1-G3
  'SIVIL', 'BELI', 'LISMA', 'HAN',                 // Research Team G1-G3
  'ALISTA',                                         // Standalone
]

async function main() {
  console.log('[Zen Migration] Bắt đầu cập nhật AgentProfile → OpenCode Zen provider...')

  let updatedNemotron = 0
  let updatedMuseSpark = 0
  let skipped = 0

  // 1. TL/Omega/Opus → nemotron-3-ultra-free
  for (const name of NEMOTRON_AGENTS) {
    const row = await db.agentProfile.findUnique({ where: { name } })
    if (!row) {
      console.log(`  ⚠️  "${name}" không tìm thấy trong DB — skip (sẽ seed lại khi app boot)`)
      continue
    }
    if (row.provider === 'zen' && row.model === 'nemotron-3-ultra-free') {
      console.log(`  ✓  "${name}" đã là zen/nemotron-3-ultra-free — skip`)
      skipped++
      continue
    }
    await db.agentProfile.update({
      where: { name },
      data: { provider: 'zen', model: 'nemotron-3-ultra-free' },
    })
    console.log(`  ✓  "${name}": ${row.provider}/${row.model} → zen/nemotron-3-ultra-free`)
    updatedNemotron++
  }

  // 2. G1-G3 + ALISTA → muse-spark-1.3-contributor-free
  for (const name of MUSE_SPARK_AGENTS) {
    const row = await db.agentProfile.findUnique({ where: { name } })
    if (!row) {
      console.log(`  ⚠️  "${name}" không tìm thấy trong DB — skip (sẽ seed lại khi app boot)`)
      continue
    }
    if (row.provider === 'zen' && row.model === 'muse-spark-1.3-contributor-free') {
      console.log(`  ✓  "${name}" đã là zen/muse-spark-1.3-contributor-free — skip`)
      skipped++
      continue
    }
    await db.agentProfile.update({
      where: { name },
      data: { provider: 'zen', model: 'muse-spark-1.3-contributor-free' },
    })
    console.log(`  ✓  "${name}": ${row.provider}/${row.model} → zen/muse-spark-1.3-contributor-free`)
    updatedMuseSpark++
  }

  console.log('')
  console.log(`[Zen Migration] Hoàn tất:`)
  console.log(`  • nemotron-3-ultra-free:        ${updatedNemotron} agents updated (Omega, Opus, MEGATRON, NEMESIS)`)
  console.log(`  • muse-spark-1.3-contributor-free: ${updatedMuseSpark} agents updated (G1-G3 + ALISTA)`)
  console.log(`  • Skipped (đã đúng config):      ${skipped}`)
  console.log('')
  console.log('[Zen Migration] LLM routing sẽ dùng Zen provider khi agent có provider="zen".')
  console.log('[Zen Migration] Zen fail → tự fallback NIM kimi-k3 chain (safety net).')
}

main()
  .catch((err) => {
    console.error('[Zen Migration] LỖI:', err)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
