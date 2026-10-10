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
//   - Copy thêm -wal (SQLite WAL mode) — nếu không, bản copy có thể thiếu
//     schema mới nhất vì phần đó nằm trong WAL.
//   - KHÔNG copy -shm: đó là WAL-index tạm (SQLite tự dựng lại từ -wal khi mở
//     DB). Copy -shm từ hệ thống ĐANG CHẠY đem theo index trạng-thái-sống có
//     thể khiến SQLite ở bản copy bỏ qua việc recover WAL → schema/dữ liệu
//     mới push thiếu cột thật (P2022 — phát hiện đợt 7: push schema xong chạy
//     test ngay thì cột mới nằm gọn trong WAL, bản copy không thấy).
//   - ENV-LEAK GUARD (phát hiện đợt 7, cùng họ lỗi với guard của src/lib/db.ts
//     nhưng ánh xạ khác): shell sandbox xuất DATABASE_URL=file:/home/z/my-project/
//     db/custom.db — DB của project SCAFFOLD KHÁC (schema cũ, 0 dữ liệu TMO).
//     Bun không đè env đã set bằng .env → preload copy NHẦM DB ngoại lai →
//     test chạy trên schema lạ (P2022 "column does not exist" với cột mới
//     push). Chính sách: env trỏ file NGOÀI project root → BỎ (dùng .env của
//     project); env trỏ file TRONG project (vd db/.quality-gate-test.db của
//     quality-gate) → GIỮ NGUYÊN (ý định chủ đích, cùng tinh thần db.ts).
//   - Nếu không parse được DATABASE_URL dạng file: → không làm gì (để nguyên).
// ============================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TMP_PREFIX = "tmo-test-db-";
const STALE_MS = 10 * 60 * 1000; // 10 phút

/** Tìm project root (thư mục chứa prisma/schema.prisma) — cùng cách src/lib/db.ts. */
function findProjectRoot(): string {
  let root = process.cwd();
  for (let i = 0; i < 6 && !fs.existsSync(path.join(root, "prisma", "schema.prisma")); i++) {
    root = path.dirname(root);
  }
  return root;
}

/** Đọc DATABASE_URL= từ .env của project ('' = không khai báo). */
function readProjectEnvDatabaseUrl(): string {
  const envPath = path.join(findProjectRoot(), ".env");
  if (!fs.existsSync(envPath)) return "";
  try {
    const lines = fs.readFileSync(envPath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*)$/);
      if (m) {
        let value = m[1].trim();
        // strip comment cuối dòng + quote bao quanh
        const hashIdx = value.indexOf(" #");
        if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        return value;
      }
    }
  } catch {
    // đọc .env lỗi → coi như không khai báo
  }
  return "";
}

/**
 * Nguồn copy cho DB test: chuẩn hóa env hiện tại chống leak DB ngoại lai.
 * Trả về URL dạng file: TUYỆT ĐỐI trỏ file TỒN TẠI, hoặc '' khi không xác định
 * được (caller bỏ qua việc copy — giữ hành vi cũ).
 */
function resolveCopySourceUrl(rawEnvUrl: string): string {
  const projectRoot = findProjectRoot();

  // Quy ước resolve của prisma: file: tương đối tính từ prisma/ (schema-relative)
  const toAbsolute = (fileUrl: string): string | null => {
    const m = fileUrl.match(/^file:(.*)$/);
    if (!m || !m[1]) return null;
    return path.isAbsolute(m[1]) ? m[1] : path.resolve(projectRoot, "prisma", m[1]);
  };

  const envAbs = toAbsolute(rawEnvUrl);
  // Env trỏ file TỒN TẠI và NẰM TRONG project → tin (vd gate: db/.quality-gate-test.db)
  if (envAbs && fs.existsSync(envAbs) && envAbs.startsWith(projectRoot + path.sep)) {
    return `file:${envAbs}`;
  }

  // Env bị leak ra ngoài project (hoặc trỏ file không tồn tại) → .env của project là nguồn sự thật
  const projectUrl = readProjectEnvDatabaseUrl();
  const projectAbs = toAbsolute(projectUrl);
  if (projectAbs && fs.existsSync(projectAbs)) {
    return `file:${projectAbs}`;
  }

  // .env không có file hợp lệ → giữ env cũ nếu nó tồn tại (hành vi cũ), ngược lại bỏ
  if (envAbs && fs.existsSync(envAbs)) return `file:${envAbs}`;
  return "";
}

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

const rawLeaked = process.env.DATABASE_URL || "";
const resolvedUrl = resolveCopySourceUrl(rawLeaked);
const m = resolvedUrl.match(/^file:(.*)$/);

if (m && m[1]) {
  const srcPath = m[1]; // đã tuyệt đối + tồn tại (resolveCopySourceUrl chuẩn hóa)

  if (fs.existsSync(srcPath)) {
    sweepOrphanDirs(Date.now());

    // Tên thư mục mang PID chủ sở hữu để sweepOrphanDirs nhận biết mồ côi.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}${process.pid}-`));
    const dest = path.join(dir, "test.db");

    // Chỉ copy db + -wal (xem ghi chú đầu file: -shm là index tạm, KHÔNG copy —
    // SQLite recover WAL từ đầu khi mở bản copy, an toàn với mọi trạng thái sống)
    for (const suffix of ["", "-wal"]) {
      try {
        fs.copyFileSync(srcPath + suffix, dest + suffix);
      } catch {
        // thiếu -wal là bình thường (đã checkpoint sạch) — bỏ qua
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
