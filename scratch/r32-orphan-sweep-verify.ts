/**
 * scratch/r32-orphan-sweep-verify.ts — VERIFY Task 32 (GIAO_THUC-GS)
 * ============================================================================
 * Mục đích: chạy rule 4 orphan-sweep (code MỚI trong alerts.ts) từ process
 * riêng để dọn 2 AgentRunRecord mồ côi đang tồn tại THẬT trong DB vận hành:
 *   - Omega 16:26:56 (92' tuổi — run stall thật, bộ nhớ app không còn)
 *   - MEGATRON 17:01:34 (59' tuổi — run lỗi "Lỗi ⏱ 1m4s", record kẹt 'running')
 *
 * AN TOÀN (2 lớp):
 *   1. Ngưỡng > 30 phút: run Omega ĐANG SỐNG (17:43:35, hiện ~17') không thuộc
 *      phạm vi quét — isRunIdActiveInMemory trong process này trống nhưng run
 *      đó chưa vượt ngưỡng tuổi nên KHÔNG bị đụng.
 *   2. Process này dùng ĐÚNG code path sweeper đã qua gate (không SQL tay) —
 *      obs.alert rule orphan-sweep được phát vào timeline (Đài quan sát thấy).
 *
 * Lưu ý vận hành: chạy 1 lần duy nhất lúc verify — về sau sweeper tự chạy
 * trong tick 10' của app (sau khi app restart nạp code mới).
 */

async function main() {
  const { db } = await import('@/lib/db')
  const { runAlertChecks } = await import('@/lib/observation/alerts')

  const before = await db.agentRunRecord.findMany({
    where: { status: 'running' },
    select: { id: true, runId: true, agentName: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
  console.log('=== TRƯỚC — các record đang "running": ===')
  for (const r of before) {
    const ageMin = Math.round((Date.now() - r.createdAt.getTime()) / 60_000)
    console.log(`  ${r.agentName} · ${r.runId} · ${ageMin} phút tuổi`)
  }

  console.log('\n=== CHẠY runAlertChecks (bao gồm rule 4 orphan-sweep) ===')
  await runAlertChecks()

  const after = await db.agentRunRecord.findMany({
    where: { status: 'running' },
    select: { id: true, runId: true, agentName: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
  console.log('\n=== SAU — các record còn "running": ===')
  for (const r of after) {
    const ageMin = Math.round((Date.now() - r.createdAt.getTime()) / 60_000)
    console.log(`  ${r.agentName} · ${r.runId} · ${ageMin} phút tuổi`)
  }

  const swept = await db.agentRunRecord.findMany({
    where: { status: 'failed', stopReason: 'crashed' },
    select: { id: true, runId: true, agentName: true, createdAt: true, completedAt: true },
    orderBy: { completedAt: 'desc' },
    take: 5,
  })
  console.log('\n=== Record vừa bị sweep (failed/crashed mới nhất): ===')
  for (const r of swept) {
    console.log(`  ${r.agentName} · ${r.runId} · start ${r.createdAt.toISOString()} → closed ${r.completedAt?.toISOString()}`)
  }

  const alerts = await db.observationEvent.findMany({
    where: { kind: 'obs.alert' },
    orderBy: { seq: 'desc' },
    take: 3,
  })
  console.log('\n=== obs.alert mới nhất trong timeline: ===')
  for (const a of alerts) {
    console.log(`  seq ${a.seq} · ${a.ts.toISOString()} · ${a.summary.slice(0, 110)}`)
  }

  const orph = alerts.filter(a => a.summary.includes('mồ côi'))
  console.log(`\nKẾT QUẢ: ${before.length} running trước → ${after.length} running sau · ${orph.length} alert orphan-sweep phát`)

  await db.$disconnect()
}

main().catch(err => {
  console.error('VERIFY FAILED:', err)
  process.exit(1)
})

export {}
