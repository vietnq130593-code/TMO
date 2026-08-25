# TMO UPGRADE — COMPLETION REPORT (REBUILD EDITION)

> **Ngày hoàn thành:** 2026-08-25 (rebuild sau sandbox reset)
> **Repo:** github.com/nguyenquocviety2c-code/TMO — toàn bộ code ĐÃ PUSH theo từng phase
> **Kết quả:** Integration test **20/20 ALL GREEN** + Browser E2E PASS + Baseline OK

## 1. Executive Summary

Nâng cấp module Smolab > Code của TMO từ "AI chỉ chat + edit file qua whitelist hẹp" lên **nền tảng full-stack AI coding đúng nghĩa VSCode-like**: auth bảo mật, workspace sync thật, Monaco multi-tab editor với Ctrl+S, terminal persistent shell với SSE stream, preview port 3005+ không còn self-collision, AI tự start/stop preview qua tool riêng, UI tự mở file khi AI sửa, real git diff + PendingEdit review modal, search-across-files bằng ripgrep.

*Lần build đầu (đêm 24-25/08) hoàn thành 11 phase nhưng sandbox reset trước khi push — toàn bộ bị mất. Bản rebuild này hoàn thành tương đương (~13 giờ) với bài học血costly: **commit + push sau TỪNG phase** (8 commits, tất cả đã an toàn trên GitHub).*

## 2. 11 Phases — Trạng thái & Evidence

| Phase | Nội dung | Commit | Tests |
|---|---|---|---|
| 0 | Snapshot baseline + scripts | (snapshot local) | baseline-test.sh 5/5 |
| 1 | Auth middleware + CORS + dangerous-pattern | `7a3a5ed` | 8/8 PASS |
| 2 | Workspace sync folder picker → DB | `3face20` | 3/3 + E2E |
| 3 | Preview port 3005+ + /stop + SSE stream | `3face20` | 5/5 + iframe verified |
| 4 | Terminal spawn + SSE + persistent shell + stdin | `57d30e6` | 5/5 + E2E |
| 5 | 22 feature flags flip | (trong .env) | flags verified |
| 6 | AI tools start_preview/stop_preview | `37312f5` | executeTool direct PASS |
| 7 | UI SSE auto-open + rich bubbles + workspace-root fix | `37312f5` | bridge + dispatch verified |
| 8 | Monaco multi-tab + Ctrl+S (local, 0 CDN) | `d0d37fe` | browser full PASS |
| 9 | Real git diff + PendingEdit modal | `131ff43` | 12/12 curl |
| 10 | Rename/Delete + search rg | `131ff43` | 12/12 curl + browser |
| 11 | Integration test + docs | (commit này) | **20/20 ALL GREEN** |

## 3. Capability Matrix BEFORE → AFTER

| Năng lực | Trước | Sau |
|---|---|---|
| AI edit file | ✅ (đã có) | ✅ + đúng workspace user (không còn process.cwd()) |
| AI chạy terminal | ⚠️ whitelist hẹp, shell DISABLE | ✅ shell tool + 22 flags on |
| AI start preview | ❌ | ✅ start_preview/stop_preview tools (TL, G2-A, G3) |
| User terminal | ❌ 30s/1MB/no-stream | ✅ persistent bash -i + SSE + stdin |
| Preview | ❌ self-collision port 3000 | ✅ 3005+ + stop + log stream + auto-refresh |
| Editor | ❌ textarea single-file | ✅ Monaco multi-tab + Ctrl+S + dirty + revert |
| UI thấy AI làm gì | ❌ chat bubble "🔧 tool" | ✅ auto-open file + 📖✏️▶️ bubbles + toasts |
| Diff view | ❌ pseudo regex | ✅ Monaco DiffEditor (session + git HEAD) |
| AI edit review | ❌ | ✅ PendingEditModal Duyệt/Từ chối/Apply |
| Search files | ❌ | ✅ ripgrep panel click-to-open |
| Auth | ❌ ZERO auth, CORS '*' | ✅ token middleware + HttpOnly cookie + CORS lock |

## 4. Files mới (23)

**Backend:** middleware.ts, api/auth/setup, api/opencode/preview/{stop,stream}, api/opencode/terminal/{start,stream,input,stop}, api/opencode/files/{diff,rename,delete}, api/opencode/search, lib/api-auth.ts, lib/terminal-session-manager.ts, lib/code-team/workspace-root.ts
**Frontend:** components/code-editor/{CodeEditor,DiffViewer,PendingEditModal,SearchPanel}.tsx + public/monaco-vs (vendored, 0 CDN)
**Sửa:** page.tsx (auth setup, workspace select, preview toggle, terminal SSE, AI event bridge + dispatch, Monaco wiring, diff/pending/search/rename/delete), opencode-server (CORS+token+blocklist), opencode.ts (token inject), workspace route (conflict 409), preview start/detect, execute (10min/10MB), tool-executor + agents + catalogs (2 tools), dev-tools + workflow-engine (workspace-root 16 sites), service-manager (health token fix)

## 5. Known Limitations (by design)

- NVIDIA/R2/Supabase secret keys mất theo sandbox reset — user cần cung cấp lại để bật LLM live + cloud (app degrade graceful)
- xterm.js ANSI terminal skipped (raw stream đủ dùng)
- PendingEditModal bỏ Modify-flow (Duyệt/Từ chối/Apply đủ)
- `applyPendingEdit` resolve theo active workspace root (pre-existing)
- Monaco init ~8-10s lần đầu trên sandbox (nhiều chunks)

## 6. Cách verify

```bash
bash /home/z/my-project/scripts/integration-test.sh   # 20/20 ALL GREEN
bash /home/z/my-project/scripts/baseline-test.sh      # Baseline OK
```
Manual: mở Preview Panel → Smolab → Code → chọn folder → Monaco multi-tab, Ctrl+S, terminal, Preview, Diff, 📝 Pending, search, hover rename/delete.

## 7. Rollback

Snapshot gốc: `/home/z/my-project/snapshots/baseline-pre-upgrade/` (7 file). Mỗi phase có rollback hint trong worklog. Code an toàn trên GitHub (8 commits) — sandbox reset không còn là rủi ro.
