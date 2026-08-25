# TMO UPGRADE WORKLOG (rebuild sau sandbox reset 2026-08-25)

> Sandbox reset lúc 01:22 UTC làm mất toàn bộ code + docs của lần upgrade đầu (11 phase hoàn thành nhưng CHƯA PUSH).
> Đây là bản rebuild theo /home/z/my-project/RECOVERY.md. Quy tắc số 1: **COMMIT + PUSH SAU MỖI PHASE**.
> Repo: github.com/nguyenquocviety2c-code/TMO. Token GitHub user cung cấp lại.

---
Task ID: rebuild-0-setup
Agent: main (orchestrator)
Task: Re-setup sandbox sau reset

Work Log:
- Clone TMO về /home/z/my-project/download/TMO (git clone với token) — repo gốc nguyên vẹn (HEAD a679a03).
- Symlink /home/z/tmo-app → download/TMO.
- Tạo .env đầy đủ theo RECOVERY.md (DATABASE_URL, Neo4j 6e688b02, Qdrant, TMO_API_TOKEN, OPENCODE_CORS_ORIGINS, 22 feature flags Phase 5). LƯU Ý: thiếu R2/Supabase/NVIDIA secret keys (mất theo reset) — app degraded graceful.
- bun install (909 packages) + bun run db:push.
- npm install -g pm2 (7.0.4) + tải Qdrant v1.19.0 tar.gz → /home/z/qdrant/qdrant.
- pm2 start ecosystem.config.cjs → theopusflashlite + qdrant online. Kill next dev cũ chiếm port 3000. Health: degraded (R2/Supabase/NVIDIA keys thiếu), qdrant connected 1.19.0, neo4j connected 15951 nodes.

Stage Summary:
- Setup DONE. App chạy port 3000. Bắt đầu Phase 0+1.

---
Task ID: rebuild-p2-3
Agent: general-purpose subagent
Task: Phase 2+3 rebuild — workspace sync + preview port fix

Work Log:
- Read RECOVERY.md (Phase 2/3 + lint protocol), worklog.md, Phase 1 state (7a3a5ed pushed, auth middleware + cookie bridge live).
- Phase 2 — src/app/api/workspace/route.ts POST: pre-check wm.getWorkspaceByPath(rootPath) → 409 {ok:false, conflict:true, data: existing} before create; try/catch P2002 race-fallback → 409 + existing; success 201 {ok:true, data}.
- Phase 2 — page.tsx: added import { authedFetch } from '@/lib/api-auth'; created handleWorkspaceSelect useCallback in CodeTabContent (after workspaceRoot persist effect, ~line 10715): setWorkspaceRoot + localStorage 'smolab_layout_opencode_root' + clear fileTree/selectedFile/fileContent + close picker + toast, then POST /api/workspace {name: folderName, rootPath} → 201 → PATCH {id} set active; 409 → PATCH existing id; else console.error + destructive toast. Replaced BOTH commit sites (folder double-click + "Chọn thư mục này" button) with `void handleWorkspaceSelect(...)`.
- Phase 3 — preview/start/route.ts rewrite: exported `runningProcesses` Map<string,{child, startedAt, port?, logFile?}>; TMO_RESERVED = [PORT..PORT+4]; findFreePort(max(3005, PORT+5), 3099) via net.createServer probe on 127.0.0.1; spawn detached+shell with stdio ['ignore','pipe','pipe'], stdout+stderr piped to /tmp/opencode-preview-<hex40-of-root>.log, env PORT=<port> + FORCE_COLOR=0; Next.js projects (deps.next) append `-- -p ${port}`, others `-- --port ${port}`; child.unref(); responds {status:'started', port, logFile, pid, command, startedAt}; already_running includes entry.port; GET updated to new map shape.
- Phase 3 — NEW preview/stop/route.ts: POST {root} → entry from runningProcesses → process.kill(-pid,'SIGTERM') + SIGKILL after 3s (timer.unref) → delete entry → {ok:true,stopped:true,pid} | {ok:true,message:'no running process'}.
- Phase 3 — NEW preview/stream/route.ts: GET ?root= SSE (text/event-stream) — init frame {type:'init',data:<full log>} on connect, 1s poll sends `: heartbeat` comment + incremental {type:'chunk',data:<delta>} by char offset (truncation-safe), abort cleanup via request.signal.
- Phase 3 — preview/detect/route.ts: TMO_RESERVED filter on port candidates (covers configuredPort too); Next.js/Nuxt/Remix/generic candidate lists now start at 3005+.
- Phase 3 — page.tsx: added previewEventSrcRef (useRef<EventSource|null>) + previewLogs (useState<string[]>); startPreviewLogStream(root) helper (EventSource → JSON parse {type:init|chunk} → previewLogs, cap 200, close+reset on re-open); handlePreviewToggle rewritten: OFF → close SSE + clear logs + authedFetch POST /api/opencode/preview/stop {root} + setPreviewPort(null); ON → authedFetch detect → detectedPort? use it + SSE : authedFetch start → startData.port → setPreviewPort + SSE + port-ready poll (24×500ms fetch no-cors 800ms timeout → setPreviewIframeKey(prev+1) remount iframe — timing-race fix); legacy no-port path keeps re-detect poll; fallback port scan starts at 3005 (skips 3000-3004); unmount useEffect closes SSE.
- page.tsx: <pre> log panel (last 15 previewLogs) below preview iframe inside flex-col wrapper (iframe flex-1 min-h-0).
- Codemod: converted ALL 31 `await fetch('/api/opencode...')` + 3 indirect `fetch(url)` (files/tree, knowledge/enrich, files/read) calls in page.tsx to authedFetch (Phase 1/2 auth).
- Lint: `bun run lint` → ✖ 25 problems (24 errors, 1 warning) = baseline, no new issues.

Stage Summary:
- Files modified: src/app/api/workspace/route.ts, src/app/api/opencode/preview/start/route.ts, src/app/api/opencode/preview/detect/route.ts, src/app/page.tsx
- Files created: src/app/api/opencode/preview/stop/route.ts, src/app/api/opencode/preview/stream/route.ts
- Test results (ALL PASS): P2-T1 create=201 {ok,data:{id,rootPath,isActive:true}} PASS; P2-T2 active=/tmp/test-phase3b PASS; P2-T3 conflict=409 PASS; P3-T1 detect-skip=OK (no 3000 in detectedPorts) PASS; P3-T2 start=OK port 3005 (logFile /tmp/opencode-preview-<hex>.log, pid reported) PASS; P3-T3 http=http://127.0.0.1:3005 serves fixture HTML PASS; P3-T4 sse=3 heartbeats in 4s PASS; P3-T5 stop={ok,stopped:true,pid} + 0 remaining procs (whole process group killed, port 3005 closed) PASS; baseline-test.sh=OK (5 services + lint 25); extra: no-token stop/stream → 401, idempotent stop → 'no running process', GET start check → {running:false}, root page 200. Lint 25=baseline. Commit 3face20 pushed to main.
- Rollback: git revert 3face20 — routes are self-contained; page.tsx changes are additive (new helper/state) + 2 commit-site rewrites + handlePreviewToggle replacement.
- Notes for next phases: state names previewEventSrcRef/previewLogs/previewIframeKey live in CodeTabContent (~line 10641-10645); handleWorkspaceSelect at ~line 10715 (deps []); startPreviewLogStream at ~line 11266 (deps []); handlePreviewToggle deps [showPreview, workspaceRoot, startPreviewLogStream]; runningProcesses exported from preview/start/route.ts (stop+stream import it); preview log files at /tmp/opencode-preview-<hex40>.log; Phase 7 openAiPreview should mirror handlePreviewToggle ON branch (setPreviewPort + startPreviewLogStream + port-ready poll).
