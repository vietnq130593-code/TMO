/**
 * Helper cho r138 — KPI #9 (P2-2b): định lượng ops mất/crash khi SIGKILL.
 * Chạy như process CON độc lập (bun tests/helpers/write-batcher-kill9-child.ts <mode>).
 * Mode:
 *   pending — enqueue 40 ops rồi print READY, NGỦ (flush timer bị triệt tiêu
 *             bởi DB_WRITE_BATCH_FLUSH_MS=60000 từ parent) → parent kill -9
 *             → đo "at-most-once qua SIGKILL" (danh hiệu trung thực P0-1.3).
 *   flushed — enqueue 40 ops, GỌI flushWriteQueueNow() (trigger 3 như run-close)
 *             rồi print FLUSHED, ngủ → parent kill -9 → đo flushNow che cửa sổ.
 * Đánh dấu ops bằng toolName chứa "K9CHILD" — parent đếm sau khi giết.
 */
import { db } from '@/lib/db'
import { enqueueWriteFireAndForget, flushWriteQueueNow } from '@/lib/db-write-batcher'

const MODE = process.argv[2] === 'flushed' ? 'flushed' : 'pending'
const MARK = `K9CHILD-${MODE}-${Date.now().toString(36)}`

async function main() {
  for (let i = 0; i < 40; i++) {
    enqueueWriteFireAndForget(
      {
        kind: 'create',
        model: 'toolMetric',
        data: {
          toolName: `${MARK}-${i}`,
          sessionId: 'r138-kill9',
          agentRole: 'CHILD',
          success: true,
          exitCode: 0,
          durationMs: i,
          errorTag: null,
        },
      },
      { label: `kill9-child.${i}` },
    )
  }
  if (MODE === 'flushed') {
    await flushWriteQueueNow() // trigger 3 — như run-close (P0-1.1)
    console.log(`FLUSHED ${MARK}`)
  } else {
    console.log(`READY ${MARK}`) // timer 60s sẽ không kịp — cửa sổ at-most-once mở
  }
  // Giữ process sống cho parent kịp kill; không tự thoát
  await new Promise(r => setTimeout(r, 30_000))
  await db.$disconnect?.()
  process.exit(0)
}

void main().catch(err => {
  console.error('CHILD-ERROR', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
