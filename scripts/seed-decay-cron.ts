/**
 * Daily memory decay cron — Phase 4 SMOLAB Prop 3.10 operationalization.
 *
 * Creates a CronJob row: every day 4AM, POST /api/memory/decay (applies
 * exponential importance decay + tier migration to all agents' memories).
 *
 * Idempotent: createCronJob dedupes by jobHash.
 *
 * Usage: cd /home/z/tmo-app && set -a && source .env && set +a && bunx tsx scripts/seed-decay-cron.ts
 *
 * Alternative (no app DB): system crontab —
 *   0 4 * * * curl -s -X POST 'http://localhost:3000/api/memory/decay' -H 'Content-Type: application/json' -d '{}' > /dev/null
 */

async function main() {
  const { createCronJob } = await import('../src/lib/cron/scheduler')

  const result = await createCronJob({
    schedule: {
      kind: 'cron',
      expr: '0 4 * * *', // daily 4AM
      tz: process.env.TZ || 'Asia/Ho_Chi_Minh',
    },
    task: [
      'Daily memory decay (Phase 4 SMOLAB Prop 3.10): call POST http://localhost:3000/api/memory/decay',
      "with body {} to apply exponential importance decay + tier migration to every agent's memories.",
      'Manual alternative: curl -s -X POST http://localhost:3000/api/memory/decay -H "Content-Type: application/json" -d "{}"',
    ].join(' '),
  })

  console.log('[SeedDecayCron] Result:', JSON.stringify(result, null, 2))
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[SeedDecayCron] FAILED:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  })

// Module marker — tránh TS2393 trùng tên `main` với script khác khi tsc gộp toàn bộ *.ts
export {}
