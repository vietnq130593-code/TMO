/**
 * Red Team Engine Phase 4.2 — seed automation crons.
 *
 * Two jobs (idempotent via createCronJob jobHash dedup):
 *   1. ATTACK RUN — Tue + Fri 3:30 AM: POST /api/redteam/run (15 cases).
 *      Scheduled AFTER the Saturday 3:00 AM weekly backup window family to
 *      avoid bandwidth contention.
 *   2. WEAPON REGEN — Sun 5:00 AM: POST /api/redteam/generate-cases (fresh
 *      arsenal incl. failure_mutation variants from the week's FailurePatterns).
 *
 * Usage: cd /home/z/tmo-app && set -a && source .env && set +a && bunx tsx scripts/seed-redteam-crons.ts
 */

async function main() {
  const { createCronJob } = await import('../src/lib/cron/scheduler')

  console.log('[SeedRedTeamCrons] 1/2 — attack run (Tue/Fri 3:30 AM)...')
  const attack = await createCronJob({
    schedule: {
      kind: 'cron',
      expr: '30 3 * * 2,5', // Tue + Fri 3:30 AM
      tz: process.env.TZ || 'Asia/Ho_Chi_Minh',
    },
    task: [
      'Red Team attack run (Phase 4.2): POST http://localhost:3000/api/redteam/run',
      'with body {"caseLimit":15} — adversarial self-testing battery over the curated+generated arsenal.',
      'Manual alternative: curl -s -X POST http://localhost:3000/api/redteam/run -H "Content-Type: application/json" -d \'{"caseLimit":15}\'',
    ].join(' '),
  })
  console.log('[SeedRedTeamCrons] attack run:', JSON.stringify(attack))

  console.log('[SeedRedTeamCrons] 2/2 — weapon regeneration (Sun 5:00 AM)...')
  const regen = await createCronJob({
    schedule: {
      kind: 'cron',
      expr: '0 5 * * 0', // Sunday 5:00 AM
      tz: process.env.TZ || 'Asia/Ho_Chi_Minh',
    },
    task: [
      'Red Team weapon regeneration (Phase 4.2): POST http://localhost:3000/api/redteam/generate-cases',
      '— refresh the attack arsenal (6 vectors, ~15 cases) including failure_mutation variants',
      'derived from the week\'s FailurePattern rows.',
      'Manual alternative: curl -s -X POST http://localhost:3000/api/redteam/generate-cases',
    ].join(' '),
  })
  console.log('[SeedRedTeamCrons] weapon regen:', JSON.stringify(regen))
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[SeedRedTeamCrons] FAILED:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
