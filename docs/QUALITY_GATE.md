# TMO Quality Gate — Cổng kiểm soát chất lượng

> Triết lý: **KHÔNG code nào được push/merge khi `type_check` + `lint` + `run_tests` + build thử còn FAIL.**
> Một nguồn sự thật duy nhất: `scripts/quality-gate.mjs` — cả git hook lẫn GitHub Actions đều gọi đúng script này.

## 4 Stage (chạy tuần tự, tất cả phải PASS)

| Stage | Lệnh | Ghi chú |
|---|---|---|
| `type_check` | `bunx tsc --noEmit` | TypeScript strict — CHẶN hết lỗi type (nhớ: `next.config.ts` có `ignoreBuildErrors: true` cho build, nên tsc ở đây là lớp type-check THẬT) |
| `lint` | `bun run lint` (`eslint .`) | Toàn repo |
| `tests` | `prisma db push` → DB test cô lập → `bun test` | **KHÔNG bao giờ đụng `db/custom.db`** — tạo fresh `db/.quality-gate-test.db`, push schema vào đó, chạy 169 test, xóa sạch sau khi xong |
| `build` | `TMO_BUILD_DIST_DIR=.next-qa bunx next build` | Build THỬ, ghi ra `.next-qa/` riêng — **không đụng `.next/` của dev server đang chạy**. Xong tự dọn |

## 3 lớp enforcement

1. **Git hooks (local)** — `pre-push` + `pre-merge-commit` chặn ngay máy bạn:
   ```bash
   bun run setup:hooks     # hoặc bun run setup (đã ghép sẵn)
   ```
   Hooks track được trong repo (`scripts/hooks/`) — mọi máy pull về chỉ cần chạy lệnh trên 1 lần.
   Lối thoát khẩn cấp: `git push --no-verify` / `git merge --no-verify` (không khuyến khích).

2. **GitHub Actions (remote)** — `.github/workflows/quality-gate.yml` chạy FULL gate trên **mọi push vào main** + mọi PR vào main. Dù local bỏ hook, commit đỏ vẫn bị đánh dấu đỏ trên GitHub.

3. **Branch protection (khuyến nghị, bật 1 lần bằng tay)** — để GitHub chặn HẲN việc merge khi CI đỏ:
   - Repo → Settings → Branches → Add rule cho `main`
   - ✔ Require status checks → chọn job `quality-gate`
   - ✔ Require branches to be up to date

## Các lệnh

```bash
bun run quality-gate            # full gate (4 stage)
bun run quality-gate -- --quick # chỉ type_check + lint (nhanh nhất)
bun run quality-gate -- --stage=tests
bun run quality-gate -- --skip-build
bun run typecheck               # chỉ tsc
bun run test                    # chỉ tests (tự tạo DB test cô lập)
```

## Máy yếu / đang chạy dev server song song?

Tạo file `.quality-gate.local` ở gốc repo (đã gitignore — mỗi máy tự cấu hình):

```
skipBuild=true
```

→ gate local bỏ stage build (cho push nhanh), nhưng **GitHub Actions vẫn chạy full gate** trên push đó — không có gì lọt kiểm duyệt.

Biến môi trường tương đương: `TMO_GATE_SKIP_BUILD=1`.

## Trạng thái triển khai (2026-09-10)

- ✅ **Lớp 1 — Git hooks local**: HOẠT ĐỘNG (đã verify: pre-push chạy gate 36.6s, 169/169 test xanh trước khi cho push `d8c4cc4`).
- ⚠️ **Lớp 2 — GitHub Actions**: workflow đúng, GitHub đã nhận diện và trigger — nhưng job chết sau 2s với lỗi **"The job was not started because recent account payments have failed or your spending limit needs to be increased"** (hết phút Actions / hạn mức chi tiêu của account — private repo cần trả phí). **Cần Mr. Architect vào GitHub → Settings → Billing & plans** nạp/add spending limit; sau đó workflow tự chạy bình thường, không cần sửa gì.
- ⬜ **Lớp 3 — Branch protection**: bật sau khi lớp 2 sống.

## Lịch sử & quy ước

- **2026-09-10**: Gate ra đời. Baseline trước gate: `tsc` PASS, `eslint` PASS, `bun test` 168/169 — 1 test flaky (`FsCheckpoint > listCheckpoints`) do 2 checkpoint cùng millisecond → `orderBy createdAt` không xác định thứ tự; đã fix bằng cách đảm bảo 2 lần tạo cách ≥5ms. 25/169 test khác fail khi chạy ngoài PM2 do `DATABASE_URL` từ `.env` trỏ DB khác → gate luôn ghi đè `DATABASE_URL` sang DB test cô lập.
- Quy ước: thêm code mới = kèm/giữ test trong `src/lib/**/__tests__/*.test.ts` — gate tự pick up. Test phải hermetic (không gọi API ngoài, không phụ thuộc thứ tự chạy).
