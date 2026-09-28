// ============================================
// Test DB isolation preload (Task 54 — root-cause fix)
// ============================================
// VÌ SAO FILE NÀY TỒN TẠI:
//   `bun run test` (quality-gate.mjs) ĐÃ cô lập DB bằng cách ghi đè DATABASE_URL
//   sang db/.quality-gate-test.db. NHƯNG agents trong hệ thống gọi tool
//   `run_tests` — và tool đó chạy `bun test` TRỰC TIẾP, KHÔNG qua quality-gate.
//   Khi đó bun tự nạp .env (DATABASE_URL=file:../db/custom.db) → test chạy trên
//   DB PRODUCTION của app đang hoạt động.
//
//   Hậu quả đã xảy ra thật (Task 54): src/lib/workspace/__tests__/workspace-manager.test.ts
//   gọi wm.createWorkspace({ rootPath: /tmp/theopus-test-workspace-* }) → ghi record
//   Workspace vào DB thật VÀ cướp mất cờ isActive khỏi workspace đang dùng. Mọi
//   file tool (file_read/file_list/file_edit...) resolve đường dẫn theo workspace
//   active trong DB → hệ thống sập với lỗi "path escapes workspace root".
//
// CÁCH VÁ Ở ĐÂY:
//   preload script chạy TRƯỚC mọi test file (đăng ký qua bunfig.toml [test].preload),
//   copy file DB ra một bản riêng trong /tmp và trỏ DATABASE_URL vào bản copy đó.
//   → Test vẫn thấy ĐÚNG SCHEMA (nên pass như cũ) nhưng mọi ghi/xoá chỉ đụng
//     bản copy, tuyệt đối không chạm DB của app đang chạng.
//
// LƯU Ý QUAN TRỌNG (rò /tmp đã xảy ra thật — Task 54 follow-up):
//   - Mỗi test file chạy trong process riêng → mỗi process tạo 1 thư mục /tmp.
//   - `process.on("exit")` KHÔNG đủ tin cậy: bun test kết thúc worker bằng đường
//     khiến hook không chạy → rò 11 thư mục sau vài lần chạy (đã đo: 11 dir).
//   - VÁ: quét dọn các thư mục CŨ (>10 phút) mỗi lần preload chạy → rò bị chặn ở
//     mức ≤1 lần chạy, không tích luỹ vô hạn.
//   - Copy thêm cả -wal và -shm (SQLite WAL mode) — nếu không, bản copy có thể
//     thiếu schema mới nhất vì phần đó nằm trong WAL.
//   - Nếu không parse được DATABASE_URL dạng file: → không làm gì (để nguyên).
// ============================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TMP_PREFIX = "tmo-test-db-";
const STALE_MS = 10 * 60 * 1000; // 10 phút

/** pid còn sống hay không. EPERM = tồn tại nhưng thuộc user khác → coi như sống. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Quét dọn thư mục tạm mồ côi.
 *
 *  VÌ SAO ĐỔI TỪ "CŨ >10 PHÚT" SANG "CHỦ ĐÃ CHẾT":
 *  Đo thật (Task 54) — sweep theo tuổi chặn rò ở mức ~1 thư mục/lần chạy, tức
 *  12 → 13 dir sau 2 lần chạy liên tiếp (148M → 160M). Vì một lần chạy tạo ra
 *  N thư mục (mỗi process test 1 thư mục) và các lần chạy sát nhau đều <10 phút,
 *  điều kiện tuổi không bao giờ kích hoạt giữa các lần chạy.
 *
 *  Cách đúng: đặt PID chủ sở hữu vào TÊN thư mục (tmo-test-db-<pid>-xxxx) rồi
 *  xoá khi PID đó đã chết — không phụ thuộc thời gian, nên sau mỗi lần chạy
 *  chỉ còn tối đa 1 thư mục mồ côi (thư mục của chính lần chạy đang diễn ra). */
function sweepOrphanDirs(now: number): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(os.tmpdir());
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    const full = path.join(os.tmpdir(), name);
    try {
      const st = fs.statSync(full);
      const fresh = now - st.mtimeMs <= STALE_MS;
      let ownerAlive = false;
      if (fresh) {
        const ownerPid = Number.parseInt(name.slice(TMP_PREFIX.length), 10);
        ownerAlive = Number.isFinite(ownerPid) && isProcessAlive(ownerPid);
      }
      if (!fresh || !ownerAlive) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    } catch {
      // ignore — thư mục đã bị xoá bởi process khác
    }
  }
}

const raw = process.env.DATABASE_URL || "";
const m = raw.match(/^file:(.*)$/);

if (m && m[1]) {
  // URL trong .env là đường dẫn TƯƠNG ĐỐI so với thư mục chứa schema.prisma
  const srcPath = path.resolve(process.cwd(), "prisma", m[1]);

  if (fs.existsSync(srcPath)) {
    sweepOrphanDirs(Date.now());

    // Tên thư mục mang PID chủ sở hữu để sweepOrphanDirs nhận biết mồ côi.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}${process.pid}-`));
    const dest = path.join(dir, "test.db");

    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.copyFileSync(srcPath + suffix, dest + suffix);
      } catch {
        // thiếu -wal/-shm là bình thường — bỏ qua
      }
    }

    process.env.DATABASE_URL = `file:${dest}`;
    process.env.TMO_TEST_DB_ISOLATED = "1";

    const cleanup = () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    };
    process.on("exit", cleanup);
    // Bun có thể bỏ qua hook "exit" khi kết thúc worker → thêm 2 tín hiệu này.
    process.on("SIGINT", () => {
      cleanup();
      process.exit(130);
    });
    process.on("SIGTERM", () => {
      cleanup();
      process.exit(143);
    });
  }
}
