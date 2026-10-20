/**
 * scripts/worker-heart-thread.ts — W2/S3 (BLUEPRINT-R17BC v0.2 · REVIEW-1 P1-3)
 * =====================================================================================
 * HEART-MOVEMENT WATCHDOG chạy trong worker_threads RIÊNG — vòng sự kiện của
 * thread ĐỘC LẬP với event loop chính: khi event loop chính KẸT/đóng băng
 * (await treo, vòng sync vô hạn...), timer của thread VẪN chạy → phát hiện
 * được chính xác điều mà in-process timer không bao giờ thấy (timer cùng vòng
 * thì chết theo vòng).
 *
 * Giao thức ping-pong: thread postMessage('ping') mỗi 15s; main trả 'pong'.
 * Không pong trong WORKER_HEART_MOVEMENT_MS (default 120s) → console.error +
 * process.exit(1) — thread exit được THẾ process (kill cả process) → pm2 kéo
 * dậy. KHÔNG phải STALL (STALL chỉ pause job — pause không chữa process treo).
 *
 * Chạy độc lập không parentPort (vd test spawn) → thoát yên tĩnh mã 0.
 */
import { parentPort } from 'node:worker_threads'

const parent = parentPort
if (!parent) {
  // Không có process cha — chạy trực tiếp; thoát ngay an toàn.
  process.exit(0)
}

// FB-W2-R1-01: giá trị rác → NaN → Math.max(NaN)=NaN → mọi so sánh false =
// watchdog chết im lặng. Chặn isFinite — rác rơi về default 120s.
const RAW_THRESHOLD_MS = Number(process.env.WORKER_HEART_MOVEMENT_MS ?? 120_000)
const THRESHOLD_MS = Math.max(30_000, Number.isFinite(RAW_THRESHOLD_MS) ? RAW_THRESHOLD_MS : 120_000)
const PING_INTERVAL_MS = Math.max(5_000, Math.floor(THRESHOLD_MS / 8))

let lastPongAt = Date.now()

parent.on('message', (m: unknown) => {
  if (m === 'pong') lastPongAt = Date.now()
})

const tick = () => {
  const silentMs = Date.now() - lastPongAt
  if (silentMs > THRESHOLD_MS) {
    console.error(
      `[WorkerHeartMovement] không pong ${Math.round(silentMs / 1000)}s ≥ ngưỡng ${Math.round(THRESHOLD_MS / 1000)}s (WORKER_HEART_MOVEMENT_MS) — event loop chính kẹt/đóng băng → self-exit(1) cho pm2 restart (P1-3: STALL chỉ pause job, không chữa process treo; thread này có vòng sự kiện riêng nên vẫn thấy được)`
    )
    process.exit(1)
  }
  parent?.postMessage('ping')
}

parent.postMessage('ping')
setInterval(tick, PING_INTERVAL_MS)
