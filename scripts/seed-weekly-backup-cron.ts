/**
 * Phase 3 SMOLAB Proposal 10.5 — Seed the weekly full-backup cron job.
 *
 * Creates a CronJob row: every Saturday 3AM (server-local), the cron scheduler
 * fires POST /api/storage/snapshot-full?store=all (Qdrant snapshot + Neo4j
 * cypher dump → R2).
 *
 * Idempotent: createCronJob dedupes by jobHash.
 *
 * Usage: cd /home/z/tmo-app && set -a && source .env && set +a && bunx tsx scripts/seed-weekly-backup-cron.ts
 *
 * Alternative (no app DB): system crontab —
 *   0 3 * * 6 curl -s -X POST 'http://localhost:3000/api/storage/snapshot-full?store=all' --max-time 600 > /dev/null
 */

async function main() {
  const { createCronJob } = await import('../src/lib/cron/scheduler')

  const result = await createCronJob({
    schedule: {
      kind: 'cron',
      expr: '0 3 * * 6', // Saturday 3AM (field 5: 0=Sunday, 6=Saturday)
      tz: process.env.TZ || 'Asia/Ho_Chi_Minh',
    },
    task: [
      'Weekly full backup (Phase 3 SMOLAB Prop 10.5): call POST http://localhost:3000/api/storage/snapshot-full?store=all',
      'to upload the Qdrant chunks snapshot (tar) + Neo4j apoc cypher dump (gz) to the Cloudflare R2 bucket',
      'themagnumopus under backups/qdrant/ + backups/neo4j/. Manual alternative:',
      "curl -s -X POST 'http://localhost:3000/api/storage/snapshot-full?store=all' --max-time 600",
    ].join(' '),
  })

  console.log('[SeedWeeklyBackupCron] Result:', JSON.stringify(result, null, 2))
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[SeedWeeklyBackupCron] FAILED:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
