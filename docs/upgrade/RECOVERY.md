# TMO UPGRADE — RECOVERY PLAN (sau sandbox reset 2026-08-25 01:22 UTC)

## 1. TÌNH TRẠNG

- Sandbox bị reset lúc 2026-08-25 01:22 UTC, TRƯỚC khi code được push lên GitHub.
- MẤT: repo TMO local (/home/z/my-project/download/TMO + symlink /home/z/tmo-app), toàn bộ thay đổi Phase 0-11, docs (smolab-code-audit.md ~600 dòng, smolab-code-blueprint.md ~3050 dòng, worklog.md, upgrade-completion-report.md), scripts (baseline-test.sh, integration-test.sh), snapshots/, PM2, Qdrant binary, db/custom.db (dữ liệu TMO).
- CÒN AN TOÀN: repo gốc TMO trên GitHub (github.com/nguyenquocviety2c-code/TMO) — chưa từng push thay đổi lên đó.
- CÒN TRONG CONVERSATION CONTEXT: ~95% tri thức triển khai (xem mục 3-8). Tài liệu này capture lại để chống reset tiếp theo.

## 2. CẦN TỪ USER ĐỂ REBUILD

1. **GitHub API token** (để clone repo TMO — user đã cung cấp trong conversation trước, đã mất do summarize)
2. **API keys cho .env** (tùy chọn — app degrade graceful không có chúng):
   - NVIDIA_API_KEY_1..4 (nvapi-...) — 4 keys NIM
   - R2: R2_ACCOUNT_ID=c1d3b24c7fbd0e873a0dd3b3e85b80db, R2_BUCKET_NAME=themagnumopus, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
   - SUPABASE_URL=https://asmvhepquroolmrpvlub.supabase.co, SUPABASE_SERVICE_KEY
3. Còn lại tôi có sẵn: NEO4J_URI=neo4j+s://6e688b02.databases.neo4j.io, NEO4J_USER=6e688b02, NEO4J_PASSWORD=cmG33gk2d5B1AK1-3VUAdirLyaP_6esG-A37ru9WtX8, NEO4J_DATABASE=6e688b02 (LƯU Ý: database tên "6e688b02" KHÔNG phải "themagnumopus" — instance display name khác database name), QDRANT_URL=http://localhost:6333, TMO_API_TOKEN=c4ceba4b199d267fb560b275dc08d35d (Phase 1), DATABASE_URL=file:/home/z/my-project/db/custom.db.

## 3. KIẾN TRÚC REBUILD (thứ tự)

```
1. Clone TMO về /home/z/my-project/download/TMO + ln -s → /home/z/tmo-app
2. bun install + bun run db:push (DATABASE_URL trỏ /home/z/my-project/db/custom.db)
3. npm install -g pm2 + TẢI QDRANT v1.19.0 binary từ GitHub releases → /home/z/qdrant/qdrant
4. Tạo .env (mục 2) + ecosystem.config.cjs có sẵn trong repo (cwd /home/z/tmo-app, log /home/z/my-project/dev.log)
5. pm2 start ecosystem.config.cjs (theopusflashlite + qdrant) — service-manager tự spawn 4 mini-services
   (opencode-server 18790 bind 127.0.0.1, cron-scheduler, openclaw-gateway 18789, gateway-bridge 18791)
6. Rồi implement lại 11 Phase theo mục 4-8
```

## 4. CÁC PHASE — TÓM TẮT IMPLEMENT (đã verify working trước reset)

### Phase 0 — Snapshot baseline
- mkdir snapshots/baseline-pre-upgrade + backup 11 file (env, ecosystem, opencode-server.ts, page.tsx, workspace-route, preview routes, execute-route, tool-executor.ts, feature-flags.ts, schema.prisma) + scripts/baseline-test.sh (smoke test 5 service) + pm2 save

### Phase 1 — Auth (CRITICAL)
- src/middleware.ts: protect /api/opencode/** + /api/workspace/**; accept Authorization Bearer | cookie tmo_api_token | header x-tmo-api-token; PUBLIC_PATHS = /api/health, /api/auth; fail-closed 503 nếu TMO_API_TOKEN chưa config; 401 mismatch. matcher: ['/api/opencode/:path*', '/api/workspace/:path*']
- opencode-server/server.ts: CORS chỉ cho OPENCODE_CORS_ORIGINS (default http://localhost:3000), OPTIONS → 204; mọi request yêu cầu X-TMO-API-Token header; DANGEROUS_PATTERNS 22 exact-token + 6 wildcard regex ('curl *| *sh'...) — tokenize split whitespace, exact + substring match, wildcard regex.
- src/lib/opencode.ts opencodeFetch() PHẢI inject X-TMO-API-Token (nếu không service-manager coi opencode-server unhealthy → restart loop!)
- TMO_API_TOKEN=c4ceba4b199d267fb560b275dc08d35d trong .env

### Phase 2 — Workspace sync
- page.tsx handleWorkspaceSelect(folderPath): setWorkspaceRoot + localStorage 'smolab_layout_opencode_root' + clear state + POST /api/workspace {name, rootPath} → 201 {ok, data} (workspace trong .data!) → PATCH /api/workspace {id} set active; 409 conflict → PATCH existing. Response shape: {ok, conflict?, data}
- workspace route: pre-check getWorkspaceByPath trước create + try/catch P2002 → 409 + existing
- 2 callsite: double-click folder + nút "Chọn thư mục này" (button title="Chọn thư mục làm việc" là File Explorer)
- **AUTH COOKIE BRIDGE (bug fix quan trọng)**: tạo /api/opencode/../../api/auth/setup/route.ts — GET public set HttpOnly cookie tmo_api_token (sameSite=lax, path=/, maxAge 30d) + useEffect trong Home component gọi fetch('/api/auth/setup') khi mount. Không có cái này UI 401 hết.

### Phase 3 — Preview fix (CRITICAL port collision)
- preview/start: export runningProcesses Map; TMO_RESERVED = [3000..3004] (PORT env); findFreePort(3005,3099) bằng net.createServer probe; stdio ['ignore','pipe','pipe'] pipe stdout+stderr → /tmp/opencode-preview-<hex>.log; spawn(cmd, shell:true, detached:true) với PORT env + Next.js `-- -p ${port}` khác `-- --port ${port}`; trả {status:'started', port, logFile, pid, command, startedAt}
- preview/stop (MỚI): process.kill(-pid, 'SIGTERM') + SIGKILL sau 3s + delete map entry
- preview/stream (MỚI): GET ?root= SSE — init + chunk mỗi 1s đọc log file theo offset + ': heartbeat' comments; cleanup on abort
- preview/detect: filter TMO_RESERVED khỏi portCandidates
- page.tsx handlePreviewToggle: OFF → close SSE + POST stop; ON → detect → start → setPreviewPort(startData.port) + startLogStream(root) EventSource + **PORT-READY POLL** (fetch no-cors http://127.0.0.1:{port} mỗi 500ms max 24 lần → setPreviewIframeKey(prev+1) remount iframe) — fix timing race không cần refresh tay
- previewEventSrcRef + previewLogs state + log panel <pre> dưới iframe

### Phase 4 — Terminal upgrade
- src/lib/terminal-session-manager.ts: class TerminalSessionManager extends EventEmitter; create(id,{cwd,shell='/bin/bash'}) spawn(shell,['-i'],{cwd, env TERM=xterm-256color, stdio ['pipe','pipe','pipe']}); write→stdin; getOutput cumulative (cap 512KB tail); exists; kill SIGTERM→SIGKILL@2s; list; cleanupIdle(30min) + setInterval 5min .unref(); emit `output:${id}` + `exit:${id}` (dùng 'close' event thay 'exit' để flush stdio + killed flag + session-identity check chống double-exit)
- 4 routes /api/opencode/terminal/{start,stream,input,stop}: start {sessionId?, cwd?} — cwd default = getWorkspaceManager().getActiveWorkspace().rootPath (export THẬT: getWorkspaceManager); stream GET ?sessionId= SSE — luôn gửi init frame (kể cả rỗng) + chunk + exit; input {sessionId, data}; stop {sessionId}
- execute/route.ts: timeout 30s→600000, maxBuffer 1MB→10MB
- page.tsx: terminalSessionIdRef + terminalEvtRef + ensureTerminalSession (lazy lần đầu submit, đợi init frame ≤2s trước khi echo `$ cmd`); workspaceRoot change → teardown; nút "Khởi động lại" (RotateCcw); fallback /execute giữ nguyên

### Phase 5 — Feature flags (22 flags = true/dual/full)
ENABLE_SHELL_TOOL=true, ENABLE_NATIVE_FC=dual, ENABLE_LSP_DIAGNOSTICS=true, ENABLE_LINT=true, ENABLE_TYPE_CHECK=true, ENABLE_MCP_CALL=true, ENABLE_MASTER_ORCHESTRATOR=true, ENABLE_BROWSER_SCREENSHOT=true, ENABLE_DB_QUERY=true, ENABLE_TEST_COVERAGE=true, ENABLE_FILE_OPS/READ/EDIT/MULTI_EDIT/DELETE/LIST/GREP=true, ENABLE_GATEWAY_TOOLS=full, ENABLE_WEB_UNIFIED=true, ENABLE_TODO_TOOL=true, ENABLE_AUTO_CHECKPOINT=true, ENABLE_PLAN_MODE=true, ENABLE_CRON_TOOL=true, ENABLE_REAL_DELEGATE=true, ENABLE_SESSION_RESUME=true

### Phase 6 — AI tools start_preview/stop_preview
- tool-executor.ts: ALL_TOOL_DEFINITIONS là Record KHÔNG phải array; executeTool(toolName, args) KHÔNG có agent param; return {success, result, duration}
- 2 tool defs (start_preview: root?, port?, command?; stop_preview: root?) + 2 executor cases fetch http://127.0.0.1:3000/api/opencode/preview/{start,stop} với x-tmo-api-token header + getActiveWorkspaceRoot()
- workspace-manager.ts: thêm export async function getActiveWorkspaceRoot()
- agents.ts: thêm 2 tool cho TL/APEX, G2-A/BOLT, G3/CATALYST (KHÔNG cho G1/CORTEX, G2-B/SENTINEL read-only)
- /api/openclaw/tools LOCAL_TOOLS + /api/tools catalog + workflow-engine.ts + tool-calls.ts validToolNames (regex-fallback parser) — thiếu cái này text-mode tool calls bị drop!
- start_preview result đặt PORT ở ĐẦU JSON (detail bị truncate 500 chars)

### Phase 7 — UI SSE auto-open
- SSE event shapes THẬT: `data: {"type":"tool_call"|"tool_result","agent":"APEX","position":"TL","tool":"<name>","detail":"<escaped-JSON-string>","result":"OK"|"Error","duration":N}` — result chỉ 'OK'|'Error', data thật trong detail (JSON string, có thể truncate 200/500 chars → regex fallback extractJsonStringField/extractJsonNumberField)
- Bridge trong stream reader (page.tsx): window.dispatchEvent(new CustomEvent('tmo-ai-tool-event', {detail:{type, tool, detail, result, agent, position}})) cho mọi tool_call/tool_result — defensive
- CodeTabContent: useEffect window.addEventListener('tmo-ai-tool-event') → handleAIToolEvent(ev):
  - tool_call file_read/file_edit/file_multi_edit → handleFileSelect(absPath) + toast 📖/✏️; shell/opencode(bash) → setTerminalOutput push `$ [AI] cmd` + scrollIntoView; opencode(read/write) như file tools
  - tool_result OK: file_edit* → loadFileTree() + handleFileSelect(path,{refresh:true}) + toast ✅; file_delete → loadFileTree + toast 🗑️; start_preview → openAiPreview(port, root) = setShowPreview(true)+setPreviewPort(port)+SSE log stream+port-ready poll+toast 🚀; stop_preview → close all + toast ⏹️
  - resolveAbs: path relative → `${workspaceRoot}/${p}`
- openAiPreview mirror Phase 3 wiring
- Rich bubbles: formatToolBubble — 📖 Đang đọc {file} / ✏️ Đang sửa {file} ({n} edits) / ▶️ {cmd}
- **WORKSPACE-ROOT FIX (integration bug cốt lõi)**: tạo src/lib/code-team/workspace-root.ts — resolveWorkspaceRoot() 5s cache: getActiveWorkspaceRoot() → OPENCODE_WORKSPACE env → process.cwd(); invalidateWorkspaceRootCache(). Thay 12 usages trong dev-tools.ts + 4 trong workflow-engine.ts (`process.env.OPENCODE_WORKSPACE || process.cwd()` → `await resolveWorkspaceRoot()`); getWorkspaceRoot() → async + await 3 call sites. KHÔNG fix thì AI "Access denied: path escapes workspace root" vì cwd = TMO dir.

### Phase 8 — Monaco multi-tab
- bun add @monaco-editor/react monaco-editor + **VENDOR LOCAL**: cp -r node_modules/monaco-editor/min/vs public/monaco-vs + loader.config({paths:{vs:'/monaco-vs'}}) module-level (KHÔNG CDN!)
- src/components/code-editor/CodeEditor.tsx (~153 dòng, có code đầy đủ trong context): OpenFile {path, content, originalContent, isDirty, language?, lines?, size?}; tab bar (name+dirty dot amber+×); Monaco vs-dark, minimap, fontSize 13, wordWrap, automaticLayout, detectLanguage() map 40+ ext; Ctrl+S = editor.addCommand(KeyMod.CtrlCmd|KeyCode.KeyS) với activeIndexRef+onSaveRef (stale closure fix); key={activeFile.path}; empty state
- page.tsx: openFiles[] + activeFileIndex thay selectedFile/fileContent/editedContent — COMPAT DERIVATION: `const selectedFile = activeOpenFile?.path ?? null` để không phải sửa hàng chục call site; handleFileSelect GIỮ TÊN (Phase 7 + tree click phụ thuộc): existing → activate tab; {refresh:true} → re-fetch; new → fetch + append. handleSaveFile(idx?) POST /api/opencode/files/write {path, content} + originalContent=content + isDirty=false + metadata refresh. handleContentChange + handleCloseFile (adjust index)

### Phase 9 — Diff + PendingEdit
- /api/opencode/files/diff GET ?path=&root=&staged= → execFile('git',['show', staged?':rel':'HEAD:rel']) + fs.readFile working tree → getDiffManager().computeDiff(orig, curr, rel) → {ok, diff:{hunks,unified}, originalContent, currentContent, hasOriginal, addedLines, removedLines}. DiffHunk shape THẬT: {oldStart, oldCount, newStart, newCount, lines[]} (count +/− prefixes)
- DiffViewer.tsx: Monaco DiffEditor readOnly side-by-side vs-dark (cùng loader local)
- PendingEditModal.tsx: shadcn Dialog; edits từ GET /api/openclaw/pending-edits?status=pending → **fields THẬT: before/after (+legacy oldContent/newContent), KHÔNG có originalContent/summary** → fallback summary=agentName; per-edit Duyệt/Từ chối/Apply POST ?action=approve|reject|apply body {id, reviewerId:'smolab-user'} (**reviewerId BẮT BUỘC** — thiếu là 400); applyPendingEdit resolve theo ACTIVE workspace root
- page.tsx: diffViewActive (state có sẵn) → render DiffViewer(originalContent vs content session diff, KHÔNG cần API) THAY CodeEditor; nút 📝 Pending (N) cạnh nút Diff; loadPendingEdits + poll 30s + handleAIToolEvent file_edit tool_result → refresh

### Phase 10 — Rename/Delete/Search
- files/rename POST {oldPath,newPath,root?} → fs.rename + mkdir parent; trả {ok, oldPath, newPath, type}
- files/delete POST {path,recursive?,root?} → stat + fs.rm/unlink + path-escape guard chống xóa ngoài root; {ok, path, type}
- /api/opencode/search POST {query,root?,glob?,max?} → spawn('rg',['-i','--json','-g','!node_modules/**','!.git/**','!dist/**','!build/**','!.next/**','--max-count','20',query,root]) parse type=match → {path: data.path.text, line: data.line_number, text: lines.text.trim()}; exit 1 = empty OK; timeout 20s
- SearchPanel.tsx: input + Tìm + results (path:line + snippet click → onResultClick) + empty states
- page.tsx: nút search (title="Tìm kiếm trong workspace (rg)") + showSearchPanel; handleRenameFile (window.prompt → POST → update openFiles path in-place + loadFileTree); handleDeleteFile (window.confirm → POST → close tab nếu open + loadFileTree); hover buttons ✏ "Đổi tên" + 🗑 "Xóa" trên file rows (opacity-0 group-hover:opacity-100)

### Phase 11 — Integration + docs
- scripts/integration-test.sh: 20 test groups / 21 checks (auth 401/200, workspace active data.active.rootPath, preview port≥3005 + detect skip 3000 + HTTP :3005, terminal start/input-SSE/stop, tools list shell qua **/api/tools** (79-tool catalog) + start/stop_preview qua /api/openclaw/tools (11-tool), diff hunks, rename+delete, search rg, CORS blocked/allowed, dangerous blocked, health, GET / 200) — python3 JSON parse (không jq), EXIT trap cleanup
- Docs: audit.md banner FIXED, upgrade-completion-report.md, README "Upgrade v2" section
- snapshots/post-upgrade-final/ + pm2 save

## 5. LINT/TEST PROTOCOL

- Lint baseline: 25 problems (24 errors + 1 warning) pre-existing — không được vượt. require() BỊ CẤM (no-require-imports) — luôn import ES6.
- Sau mỗi thay đổi: bun run lint → pm2 restart theopusflashlite → sleep 8-10 → curl /api/health (healthy)
- Tool trục trặc hay gặp: Bash tool display artifact "ăn ký tự" (hiện sai nội dung file — verify bằng node -e đọc hex); agent-browser CDP timeout khi trang nặng → close + reopen; overlay div chặn click → dùng eval IIFE click.
- NIM LLM cold-start timeout 120s hay gặp ban đêm → fallback global pool (gpt-oss-120b/nemotron) — environmental, retry.
- page.tsx ~15000 dòng: GREP + Read offset/limit ≤250, KHÔNG BAO GIỜ read/rewrite full.

## 6. TEST WORKSPACE fixture

/tmp/test-phase3b: package.json {"name":"test-phase3b","scripts":{"dev":"node server.js"}} + server.js = http.createServer trả HTML "✅ Phase 3 Preview Test / test-phase3b port ${PORT}" listen(process.env.PORT||3005)

## 7. BÀI HỌC (cho lần rebuild)

1. **PUSH LÊN GIT NGAY SAU MỖI PHASE** — đây là lý do mất toàn bộ work. Commit + push mỗi phase, không đợi cuối.
2. .env KHÔNG push lên git (blueprint 7.3) nhưng cần backup riêng — user tự giữ keys.
3. Backup docs (audit/blueprint/worklog) vào repo (docs/upgrade/) thay vì chỉ để ngoài root my-project.

## 8. NEXT STEP

User cung cấp GitHub token → clone → rebuild theo mục 3-4 (ước lượng nhanh hơn 50-70% lần đầu vì toàn bộ design decisions + code patterns đã có sẵn, không cần audit + explore lại).
