/**
 * Ensure Default Workspace — CI-6.1 (Task 10-b)
 *
 * Bootstrap workspace mặc định cho agent Omega lúc app khởi động (roadmap
 * docs/CODE_EXECUTION_IMPROVEMENT_ROADMAP.md — hạng mục CI-6):
 *
 * Env keys (đều OPTIONAL — thiếu env thì no-op, an toàn cho sandbox):
 *   - TMO_DEFAULT_WORKSPACE:   đường dẫn tuyệt đối workspace trên máy user
 *                              (vd E:\APP\TMO-clone — chính là thư mục app
 *                              TMO chạy local, nơi Omega thực hiện code changes)
 *   - TMO_REPO_URL:            remote origin workspace trỏ tới (vd
 *                              https://github.com/nguyenquocviety2c-code/TMO).
 *                              KHÔNG BAO GIỜ nhúng token vào URL này — token
 *                              sống trong GitHub Token Store riêng.
 *   - TMO_AUTO_OPEN_WORKSPACE: 'true' → mở File Explorer tại workspace khi
 *                              bootstrap MỚI (kích hoạt lần đầu) — không mở
 *                              lại sau mỗi lần restart app.
 *
 * Hành vi:
 *   1. TMO_DEFAULT_WORKSPACE chưa cấu hình → return im lặng (log 1 dòng).
 *   2. Đã có workspace ACTIVE và rootPath còn tồn tại trên đĩa → no-op
 *      (không bootstrap lại, KHÔNG mở explorer lại).
 *   3. Bootstrap: mkdir -p → git init -b main (nếu chưa có .git) → set remote origin
 *      (add/set-url theo TMO_REPO_URL) → upsert Workspace row (rootPath
 *      @unique) + deactivate mọi row khác.
 *   4. TMO_AUTO_OPEN_WORKSPACE='true' → mở Explorer (chỉ khi bootstrap mới).
 *
 * Toàn bộ wrap try/catch — lỗi bootstrap KHÔNG BAO GIỜ crash app startup.
 *
 * Wire-up: src/instrumentation-node.ts gọi 1 lần sau ensureDbReady()
 * (globalThis guard chống HMR double-run).
 */

import { sanitizeEnvPath } from '@/lib/workspace/sanitize-env-path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import { db } from '@/lib/db'
import { isRootPathSaneForPlatform } from '@/lib/workspace/workspace-manager'

const execFileAsync = promisify(execFile)

/**
 * Strip token embedded trong URL (https://token@host/...) — remote origin
 * KHÔNG BAO GIỜ được chứa token (token sống trong GitHub Token Store).
 */
function stripEmbeddedToken(url: string): string {
  return url.trim().replace(/^(https?:\/\/)[^@/\s]+@/, '$1')
}

export async function ensureDefaultWorkspace(): Promise<void> {
  // FIX 2026-10-14 (spawn ENOENT): chuẩn hóa + kiểm định giá trị từ biến môi
  // trường TRƯỚC khi dùng. Nếu cấu hình là Windows path (E:\APP\...), trên Linux
  // path.resolve() sẽ tạo thư mục LITERAL và spawn(/bin/bash, { cwd }) ném ENOENT.
  const sanitizedDefault = sanitizeEnvPath(process.env.TMO_DEFAULT_WORKSPACE, 'TMO_DEFAULT_WORKSPACE')
  for (const w of sanitizedDefault.warnings) console.log('[WORKSPACE] ' + w)
  const rootPath = sanitizedDefault.path || ''
  if (!rootPath) {
    console.log('[WORKSPACE] TMO_DEFAULT_WORKSPACE chưa cấu hình — bỏ qua bootstrap')
    return
  }

  const repoUrl = stripEmbeddedToken((process.env.TMO_REPO_URL || '').trim())
  const autoOpen = (process.env.TMO_AUTO_OPEN_WORKSPACE || '').trim().toLowerCase() === 'true'

  try {
    // (1) No-op nếu đã có workspace ACTIVE và thư mục còn tồn tại trên đĩa —
    // tránh bootstrap lại + KHÔNG mở explorer sau mỗi lần restart app.
    // FIX review #11: phân biệt 3 trạng thái rõ ràng:
    //   (a) active == rootPath → sẵn sàng, im lặng
    //   (b) active khác rootPath (user đang dùng workspace khác) → KHÔNG đè
    //       ý định user — chỉ log 1 dòng nhắc (env vẫn thế, lần active bị
    //       deactivate/hủy sẽ tự bootstrap lại)
    //   (c) không active / thư mục biến mất → bootstrap env workspace
    const active = await db.workspace.findFirst({ where: { isActive: true } })
    // R11 (F1 — bổ sung cho sanitizeEnvPath của agent bên trên): sanity cho cả
    // row ACTIVE trong DB — đường dẫn từ máy khác (Windows-path-on-POSIX) coi
    // như vô hiệu (existsSync trước đây trả TRUE oan qua thư mục literal rác
    // "E:\APP\TMO-clone" trong app dir → active giữ mãi root vô nghĩa).
    const activeOk = !!(active && existsSync(active.rootPath) && isRootPathSaneForPlatform(active.rootPath))
    if (active && activeOk) {
      const activeResolved = path.resolve(active.rootPath)
      const envResolved = path.resolve(rootPath)
      if (activeResolved === envResolved) {
        console.log(`[WORKSPACE] Workspace active đã sẵn sàng (${active.rootPath}) — bỏ qua bootstrap`)
        return
      }
      console.log(
        `[WORKSPACE] Workspace active hiện tại là "${active.rootPath}" (khác TMO_DEFAULT_WORKSPACE="${rootPath}") — giữ nguyên lựa chọn đang dùng, không bootstrap đè. Hủy active workspace đó nếu muốn chuyển.`,
      )
      return
    }
    if (active && !activeOk) {
      console.log(`[WORKSPACE] R11: workspace active cũ vô hiệu trên ${process.platform} hoặc biến mất trên đĩa (${active.rootPath}) — deactivating, bootstrap lại từ env`)
      await db.workspace.update({ where: { id: active.id }, data: { isActive: false } }).catch(() => {})
    }

    // (2) Bootstrap thư mục vật lý
    if (!existsSync(rootPath)) {
      await fs.mkdir(rootPath, { recursive: true })
      console.log(`[WORKSPACE] Đã tạo thư mục workspace: ${rootPath}`)
    }
    if (!existsSync(path.join(rootPath, '.git'))) {
      // FIX 2026-09-13 (user report: workspace git init mặc định nhánh 'master'
      // trong khi repo GitHub mặc định 'main' → push/pull lệch nhánh): init với
      // -b main. Git < 2.28 không hỗ trợ -b → fallback git init + symbolic-ref.
      try {
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: rootPath, timeout: 30_000 })
      } catch {
        await execFileAsync('git', ['init'], { cwd: rootPath, timeout: 30_000 })
        await execFileAsync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: rootPath, timeout: 10_000 }).catch(() => {})
      }
      console.log(`[WORKSPACE] Đã git init (nhánh main) tại ${rootPath}`)
    }

    // (3) Remote origin — KHÔNG BAO GIỜ nhúng token vào remote URL
    if (repoUrl) {
      const currentRemote = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
        cwd: rootPath,
        timeout: 10_000,
      })
        .then(r => r.stdout.trim())
        .catch(() => '') // chưa có remote → chuỗi rỗng
      const currentClean = stripEmbeddedToken(currentRemote)
      if (!currentClean) {
        await execFileAsync('git', ['remote', 'add', 'origin', repoUrl], { cwd: rootPath, timeout: 10_000 })
        console.log(`[WORKSPACE] Đã thêm remote origin → ${repoUrl}`)
      } else if (currentClean !== repoUrl) {
        await execFileAsync('git', ['remote', 'set-url', 'origin', repoUrl], { cwd: rootPath, timeout: 10_000 })
        console.log(`[WORKSPACE] Đã cập nhật remote origin: ${currentClean} → ${repoUrl}`)
      } else if (currentRemote !== currentClean) {
        // FIX 2026-09-11 (review #10 LOW): URL trùng nhưng đang NHÚNG TOKEN trong
        // .git/config → normalize về URL sạch (token sống ở token store, không
        // nằm trong config world-readable)
        await execFileAsync('git', ['remote', 'set-url', 'origin', repoUrl], { cwd: rootPath, timeout: 10_000 })
        console.log('[WORKSPACE] Đã bỏ token nhúng khỏi remote origin URL (normalize an toàn)')
      }
    }

    // (4) Upsert Workspace row (rootPath @unique) + deactivate các row khác
    const existing = await db.workspace.findUnique({ where: { rootPath } })
    const ws = existing
      ? await db.workspace.update({
          where: { id: existing.id },
          data: { name: 'TMO-clone', isActive: true },
        })
      : await db.workspace.create({
          data: { name: 'TMO-clone', rootPath, isActive: true },
        })
    await db.workspace.updateMany({
      where: { isActive: true, id: { not: ws.id } },
      data: { isActive: false },
    })
    console.log(`[WORKSPACE] Bootstrap xong — workspace active: ${rootPath}`)

    // (5) Mở File Explorer tại workspace — CHỈ khi bootstrap MỚI (bước 1
    // không early-return). Impl nằm ở dev-tools; lazy import để không kéo
    // cả dependency graph của dev-tools vào boot path.
    if (autoOpen) {
      const { openWorkspaceInExplorer } = await import('@/lib/code-team/dev-tools')
      const receipt = await openWorkspaceInExplorer(rootPath)
      console.log(
        `[WORKSPACE] TMO_AUTO_OPEN_WORKSPACE=true → ${receipt.success ? 'đã mở' : 'không mở được'} workspace bằng ${receipt.method}: ${receipt.message}`
      )
    }
  } catch (err) {
    // Fail-open tuyệt đối: bootstrap lỗi KHÔNG bao giờ crash app startup
    console.error('[WORKSPACE] bootstrap lỗi:', err instanceof Error ? err.message : String(err))
  }
}
