/**
 * worker-env.ts — W2/S3 (BLUEPRINT-R17BC v0.2) — cấu hình process worker
 * =============================================================================
 * FB-W2-R1-01 (2026-10-20, phát hiện bằng đối chiếu log boot worker thật với
 * code): readEnvFileKey v1 (trong worker.ts) trả chuỗi rỗng '' cho key vắng —
 * '' KHÔNG nullish nên `process.env.K ?? readEnvFileKey(...) ?? DEFAULT`
 * không bao giờ tới DEFAULT: Number('') = 0 → Math.max(floor, 0) = floor —
 * ngưỡng MemWatchdog 1000MB biến thành 300MB, heart-movement 120s thành 30s
 * (worker chạy thật với ngưỡng sai — log boot "[theopus-worker] MemWatchdog
 * bật — ngưỡng RSS 300MB" + "ngưỡng 30s" là bằng chứng đối chiếu được).
 *
 * v2 (module này): trả undefined cho vắng/rỗng (nullish — ?? DEFAULT sống)
 * + readNumEnv chặn NaN (giá trị rác 'abc' → Number NaN → Math.max(NaN) =
 * NaN → mọi so sánh false = watchdog chết im lặng — rác rơi về DEFAULT).
 *
 * Tách module KHÔNG side-effect (thuần đọc) để test behavioral trực tiếp —
 * scripts/worker.ts là script boot (import = chạy main) nên không import
 * được trong test. Regression: r139 nhóm E.
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * Đọc 1 key từ file .env — parse thô không phụ thuộc Next (mirror tinh thần
 * db.ts:34 readEnvFileDatabaseUrl). Vắng file/vắng key/giá trị rỗng sau trim
 * → undefined (nullish) — KHÔNG trả '' (bug v1, xem header module).
 */
export function readEnvFileKey(root: string, key: string): string | undefined {
  const envPath = path.join(root, '.env')
  if (!fs.existsSync(envPath)) return undefined
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
      if (!m) continue
      if (m[1] !== key) continue
      let v = m[2].trim().replace(/\s+#.*$/, '').trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      return v === '' ? undefined : v
    }
  } catch { /* fail-open — coi như key vắng */ }
  return undefined
}

/**
 * Số cấu hình từ env: process.env TRƯỚC (pm2 override thắng), .env sau,
 * DEFAULT cuối. Giá trị rác (NaN) → DEFAULT (không floor — gõ sai không
 * được biến watchdog thành chết im lặng). Hợp lệ → max(floor, n).
 */
export function readNumEnv(root: string, envKey: string, def: number, floor: number): number {
  const raw = process.env[envKey] ?? readEnvFileKey(root, envKey) ?? String(def)
  const n = Number(raw)
  return Number.isFinite(n) ? Math.max(floor, n) : def
}

/** Root dự án = thư mục chứa prisma/schema.prisma (đi lên tối đa 6 tầng). */
export function findProjectRoot(): string {
  let root = process.cwd()
  for (let i = 0; i < 6 && !fs.existsSync(path.join(root, 'prisma', 'schema.prisma')); i++) {
    root = path.dirname(root)
  }
  return root
}
