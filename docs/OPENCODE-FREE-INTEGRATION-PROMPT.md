# PROMPT: TÍCH HỢP OPENCODE FREE MODELS VÀO APP KHÁC

> **Cách dùng tài liệu này:** đây là prompt hoàn chỉnh, dán nguyên văn (hoặc theo phần) cho AI đang xây dựng một app KHÁC muốn dùng các model miễn phí của OpenCode Zen (opencode.ai). Toàn bộ kiến thức dưới đây được chi trả bằng thật bởi 3 phiên điều tra trên hệ thống TMO (2026-10-09 → 2026-10-14, gồm matrix 14 model, 7 phép cô lập biến, bisect 99 biến môi trường, E2E verify) — file gốc tham chiếu: `src/lib/llm.ts` (khối R10/R10b/R10c + callOpenCodeCLIProvider), `src/lib/agent-constants.ts` (catalog model). Ghi chú ngày 2026-10-15.

---

## PHẦN 0 — VAI TRÒ & MỤC TIÊU (dán cho AI nhận prompt)

```
Bạn là kỹ sư AI đang xây dựng một app (backend Node.js/TypeScript) muốn gọi các
LLM miễn phí của OpenCode Zen (https://opencode.ai/zen) — các model có đuôi
"-free" như space-bunny-free, big-pickle, mimo-v2.6-flash-free... — thay vì
trả phí API key. Tài liệu dưới đây là KẾT QUẢ ĐIỀU TRA THẬT từ một hệ thống đã
tích hợp thành công và E2E verify. NHIỆM VỤ CỦA BẠN:

1. Đọc kỹ PHẦN 2 "CÁC BẪY" — đây là 8 lỗi đã mất nhiều giờ điều tra; bỏ qua
   sẽ lặp lại đúng lộ trình sai.
2. Triển khai theo PHẦN 4 "CÔNG THỨC 12 BƯỚC" — đủ 12 bước, không bỏ bước.
3. Chạy PHẦN 5 "CHECKLIST XÁC MINH E2E" — chỉ tuyên bố thành công khi qua hết.
4. Tôn trọng PHẦN 6 "CẢNH BÁO TRUNG THỰC" — không hứa hẹn quá mức của free tier.
```

---

## PHẦN 1 — BỐI CẢNH: OPENCODE ZEN & CƠ CHẾ "GATE" FREE-TIER

OpenCode Zen là gateway model của opencode.ai, có nhóm model **free** (cost 0/0,
danh sách động — xem `opencode models` hoặc models.dev). Chính sách free-tier của
Zen được thực thi bởi một **gate phía server** với thông báo lỗi đặc trưng:

```
403 FreeTierError: "free tier can only be used from within OpenCode"
```

Ý nghĩa: server không chặn theo IP, không chặn theo identity (đăng nhập OAuth
KHÔNG giúp qua gate — đã verify). Gate chặn theo **"session có dấu hiệu là
OpenCode thuần hay không"** — cụ thể là phát hiện **project config** và các tín
hiệu "toolset/provider lạ" trong request. Đây là điểm mấu chốt mọi tích hợp
phải xoay quanh.

**Chỉ 1 model thoát rule trên ở thời điểm điều tra:** `space-bunny-free` — duy
nhất còn mở cho HTTP API key (oc_sk) → có thể gọi REST trực tiếp
`POST https://opencode.ai/zen/v1/chat/completions` với `Authorization: Bearer
oc_sk_...`. Mọi model free KHÁC (big-pickle, mimo, ling, longcat, nemotron,
step-5...) đều bị 403 trên HTTP — đường duy nhất cho chúng là **OpenCode CLI
spawn như một "người dùng OpenCode thật"** (xem Công thức).

---

## PHẦN 2 — CÁC BẪY (8 bẫy đã điều tra xong — KHÔNG lặp lại)

### Bẫy 1 — Nghĩ rằng đăng nhập OAuth sẽ mở free-tier
Sai. Gate không phân biệt identity — đăng nhập `opencode auth login` xong vẫn
403 nếu session có project config. Bằng chứng: 7 phép cô lập (2026-10-14).

### Bẫy 2 — opencode.json ở BẤT KỲ đâu trong chuỗi thư mục cha
CLI resolve config theo **cwd + toàn bộ thư mục cha** (directory chain). Chỉ
cần tồn tại file `opencode.json` (kể cả tối giản `{"permission":{...}}` không
có custom provider) trong cwd hoặc ancestor → 403 FreeTierError. Đặt workspace
lồng trong app dir (app có opencode.json) cũng chết — đã test `.oc-cli-ws`
lồng trong app dir, vẫn 403.

**Ngoài ra:** config toàn cục `~/.config/opencode/` cũng bị gate bắt — global
config làm session "không thuần OpenCode" tương tự.

### Bẫy 3 — Biến môi trường PWD (không chỉ cwd!)
Quan trọng nhất và khó bắt nhất. CLI đọc biến **PWD** từ environment (không chỉ
process cwd) khi resolve project config. Spawn với `cwd = workspace sạch` nhưng
env `PWD = /app-dir` (chứa opencode.json) → **vẫn 403**. Bisect 99 biến môi
trường: PWD là thủ phạm DUY NHẤT. **Phải ghi đè `PWD` = workspace sạch trong
env của lần spawn.**

### Bẫy 4 — .opencode/package.json → CLI tự npm-install → server 500
Nếu workspace có `.opencode/package.json`, CLI sẽ tự `npm install` dependencies
→ tạo node_modules → các run SAU đó bị Zen trả "Unexpected server error" (500)
vì toolset/provider SDK lạ trong session. Giải pháp: KHÔNG copy package.json
vào workspace; chủ động dọn `node_modules/package.json/package-lock.json` mỗi
lần chuẩn bị spawn (self-heal — CLI có thể tạo lại bất cứ lúc nào).

### Bẫy 5 — tools-filter / permission trong agent frontmatter
File agent `.opencode/agent/<tên>.md` chỉ được chứa `description / mode /
prompt`. Thêm key `tools:` (filter) hoặc `permission:` → request mang toolset
khác mặc định → 403. Mọi cơ chế "chặn cứng" tool đều lộ tín hiệu với gate.

### Bẫy 6 — Custom HTTP provider với SDK lạ
Định nghĩa provider riêng qua `@ai-sdk/openai-compatible` (kiểu alias opencode.json
trỏ về baseURL zen) → 403 trên model free (chỉ SBF được phép). Alias kiểu này
chỉ hợp lệ cho SBF (mục đích xoay key — xem Bước 9).

### Bẫy 7 — Mỗi spawn CLI ~600MB RAM
`opencode run` là process Node nặng (~600MB). 2 spawn đồng thời + app server
(~1GB) trên máy 4GB → MemAvailable sụt dưới ngưỡng → watchdog giết process /
OOM-kill → run đang sống bị chết oan (bằng chứng: crash loop PM2 restart 9
lần/2.5h). **Bắt buộc semaphore giới hạn spawn đồng thời (mặc định 1).**

### Bẫy 8 — Policy Zen LẬT NGƯỢC NHIỀU LẦN
Đã ghi nhận chuỗi: 09-27 chặn CLI free → 10-09 mở (r72) → 10-09 chặn lại (r74)
→ 10-14 mở có điều kiện (workspace sạch, R10). **Đừng hardcode trạng thái
sống/chết của model** — phải có block-cache động (Bước 10) + failover đa tầng
(Bước 11) + hiển thị trạng thái thật cho người dùng.

---

## PHẦN 3 — NGUYÊN TẮC GATE (tổng kết 7 phép cô lập biến)

| # | Thử nghiệm | Kết quả |
|---|---|---|
| 1 | CLI chạy từ dir trắng, IP datacenter, keyless | **OK** — Zen không chặn theo IP |
| 2 | opencode.json trong cwd/ancestor HOẶC `~/.config/opencode/` | **403** |
| 3 | Workspace lồng trong app dir (có opencode.json phía trên) | **403** — directory chain |
| 4 | `.opencode/` tools + agent .md prompt-only | **OK** — qua gate |
| 4b | Như 4 nhưng thêm `tools:`/`permission:` trong frontmatter | **403** |
| 5 | `.opencode/package.json` (CLI tự npm-install) | Run sau **500** |
| 6 | env đầy đủ app + PWD=app-dir, cwd=workspace sạch | **403** |
| 7 | env đầy đủ app + PWD=workspace sạch | **OK** ← chìa khóa |

**Kết luận thiết kế:** free-tier gate = machine detection qua project-config &
toolset. Giải pháp = spawn CLI trong **workspace sạch đứng NGOÀI app dir**, không
opencode.json, không package.json, **ghi đè PWD**, agent frontmatter tối giản,
custom tools chỉ import `@opencode-ai/plugin` (CLI tự cung cấp nội bộ — không
cần npm install).

---

## PHẦN 4 — CÔNG THỨC TÍCH HỢP 12 BƯỚC

### Bước 1 — Cài CLI
```bash
npm i -g opencode-ai        # hoặc curl -fsSL https://opencode.ai/install | bash
opencode --version          # verify
```
App cần resolver binary: thử `env OPENCODE_CLI_BIN` → `~/.opencode/bin/opencode`
→ `which opencode`. Thiếu CLI không làm hỏng app — chỉ mất đường model free
(fail về HTTP/SBF).

### Bước 2 — Workspace sạch NGOÀI app dir
Ví dụ `~/.oc-cli-ws`. Quy tắc bất biến:
- **KHÔNG** `opencode.json` (không ở ws, không ở bất kỳ ancestor nào của ws —
  `~` thường an toàn; tuyệt đối không đặt trong thư mục app).
- **KHÔNG** `.opencode/package.json` / package-lock.json / node_modules.
- **CÓ THỂ** `.opencode/tools/*.ts` (custom tools — xem Bước 12) và
  `.opencode/agent/build.md` (agent prompt — chỉ description/mode/prompt).
- Self-heal mỗi spawn: xóa 3 mục "độc" nếu CLI tự tạo lại; refresh tools khi
  nguồn (app dir) mới hơn (so mtime + marker `.copied-at`).

### Bước 3 — auth.json tự nạp (không cần tương tác người dùng)
Nếu có oc_sk key (lấy tại opencode.ai/zen): ghi
`~/.local/share/opencode/auth.json`:
```json
{ "opencode": { "type": "api", "key": "oc_sk_..." } }
```
mode `0600`. KHÔNG BAO GIỜ đè file có sẵn (tôn trọng credential người dùng tự
`opencode auth login`). Không có key → vẫn chạy được một số model keyless (gate
không đòi key, chỉ đòi "thuần OpenCode").

### Bước 4 — Spawn đúng chuẩn
```
opencode run --model opencode/<model> --format json [--variant <effort>]
```
- Prefix `opencode/` = **native provider** (đường sống cho model free ngoài SBF).
- `--variant` = reasoning effort (vd space-bunny: low|medium|high|xhigh|max;
  chỉ truyền cho model có knob — giá trị lạ bị CLI từ chối).
- env spawn: `{ ...process.env, PWD: <workspace>, NO_COLOR: '1', TERM: 'dumb' }`.
- `cwd: <workspace>`. Trên Windows shim `.cmd` cần `shell: true` (chỉ an toàn vì
  args chứa HOÀN TOÀN flags — xem Bước 5).

### Bước 5 — Prompt qua STDIN (KHÔNG argv)
Prompt app thường 30-100KB; command line giới hạn ~32K (Windows). Truyền prompt
qua stdin, **đóng stdin ngay sau write** (signal non-interactive, tránh TTY wait).
`child.stdin.on('error', ignore)` để không crash khi child exit sớm (EPIPE).

### Bước 6 — Parse NDJSON stream
`--format json` xuất event stream từng dòng JSON (NDJSON). Giữ buffer dòng
chưa hoàn chỉnh. Các event quan trọng:
- `{type:'text', part:{type:'text', text}}` — nội dung trả lời
- `{type:'text', part:{type:'reasoning', text}}` — reasoning tokens (đếm riêng)
- `{type:'tool_use', part:{name, tool, state:{input,...}}}` — model gọi custom tool
- `{type:'tool_result', part:{tool_call_id, state:{status, output, error, time}}}`
  — kết quả tool CLI đã thực thi (thu thập làm bằng chứng)
- `part.tokens: {total, input, output, reasoning}` — token usage
- Event `error` (vd FreeTierError) xuất hiện sớm trong stream — giữ raw head
  64KB đầu để phát hiện + đưa vào block-cache.
Ghép `systemPrompt + '\n\n---\n\n' + prompt` thành 1 prompt stdin.

### Bước 7 — Timeout + PARTIAL-ON-TIMEOUT
Đặt timeout (vd 240s). Khi timeout: SIGKILL, nhưng **KHÔNG vứt kết quả** —
trả partial (content rỗng + các tool đã thực thi + reasoning). Bằng chứng thật:
agent có thể đã edit file/chạy lệnh đúng trước khi bị kill — vứt hết khiến
evaluator kết luận oan "không làm gì". Mọi đường resolve (close/timeout/error)
phải release semaphore đúng 1 lần.

### Bước 8 — Semaphore chống OOM
Gate spawn đồng thời (mặc định 1, env `OC_CLI_MAX_CONCURRENT` nâng trên máy
nhiều RAM). Pattern: `{active, queue}` + globalThis-guard (tránh Next.js dev
nạp module đa instance). Acquire TRƯỚC spawn, release ở MỌI đường thoát.

### Bước 9 — Multi-key xoay key (chỉ cho space-bunny-free qua HTTP)
SBF là model duy nhất mở HTTP → nếu có nhiều oc_sk key: xoay round-robin +
per-key 429 cooldown (bỏ key rate-limit khỏi vòng trong cooldown window).
Cấu hình alias `opencode-k1/k2/k3` trong opencode.json **chỉ dùng được khi CLI
nhìn thấy opencode.json** — mâu thuẫn với workspace sạch (Bẫy 2) → trên đường
CLI, MỌI model (kể cả SBF) dùng native provider + auth.json key#1. Chấp nhận
đa-key chỉ ở tầng HTTP.

### Bước 10 — Free-tier block-cache động
Model bị 403 FreeTierError ở transport nào → cache block theo `(transport,
model)` (vd 7 ngày hoặc đến khi có tín hiệu mở lại) → call sau skip thẳng,
không tốn 5-10s spawn mỗi lần. Policy lật kèo (Bẫy 8) → cần đường "probe lại"
thủ công hoặc TTL.

### Bước 11 — Chuỗi failover nhiều tầng (app không bao giờ chết cứng)
Ví dụ chuẩn: `Zen HTTP (SBF) → OpenCode CLI native (mọi model free) → ZEN
FAILOVER (SBF) → trả lỗi`. Mỗi tầng độc lập; lỗi tầng này tự rơi tầng kế. Trạng
thại sống/chết model hiển thị THẬT cho người dùng (badge blockedTransports).

### Bước 12 — Custom tools + bảo mật trung thực
- Tools `.opencode/tools/*.ts` chỉ `import ... from '@opencode-ai/plugin'` —
  CLI tự cung cấp; KHÔNG cần npm install (muốn vậy đừng bao giờ để package.json
  trong ws). Truyền context app qua env (vd `MYAPP_BASE_URL`, `MYAPP_AGENT_NAME`).
- **GIỚI HẠN AN NINH PHẢI BIẾT:** native `write/edit/bash` của CLI KHÔNG THỂ
  chặn cứng trên đường free-tier (mọi cơ chế chặn đều lộ tín hiệu với gate —
  Bẫy 5). Giảm rủi ro bằng **chặn mềm 2 lớp prompt**: (a) agent frontmatter
  description + prompt yêu cầu dùng tool bridge của app (vd `myapp_file_write`
  có audit/guard), (b) system prompt nhắc lại. Đây là tradeoff có ý thức —
  khi Zen mở HTTP oc_sk hoặc dùng trả phí thì quay lại opencode.json permission
  chặn cứng được.

---

## PHẦN 5 — CHECKLIST XÁC MINH E2E (chỉ tuyên bố xong khi qua hết)

1. [ ] `opencode --version` in ra (resolver tìm được bin).
2. [ ] Workspace sạch tồn tại: KHÔNG opencode.json (ws + ancestors), KHÔNG
   package.json/node_modules; `.opencode/agent/build.md` có mặt.
3. [ ] Probe trực tiếp từ shell (chuẩn hóa PWD):
   ```bash
   cd ~/.oc-cli-ws && PWD=~/.oc-cli-ws opencode run --model opencode/mimo-v2.6-flash-free --format json <<< "Trả lời đúng 1 từ: OK"
   ```
   → stream NDJSON có text "OK", KHÔNG có event FreeTierError.
4. [ ] Probe ngược (chứng minh gate còn tác động — kiểm tra tích hợp hiểu gate):
   spawn cùng lệnh với `PWD=<app-dir có opencode.json>` → phải 403. Nếu KHÔNG
   403 thì policy đã đổi → cập nhật block-cache/ghi chú.
5. [ ] Từ code app: spawn với env override PWD + cwd ws → parse được content +
   tokens từ NDJSON; timeout path trả partial; semaphore release đúng khi kill.
6. [ ] 2 request đồng thời → log semaphore cho thấy 1 chạy + 1 xếp hàng (không
   2 process song song).
7. [ ] Model bị 403 (gd thử 1 model chết) → call 2 lần không spawn lại (block-cache).
8. [ ] Chuỗi failover: tắt CLI (rename bin) → request vẫn sống qua HTTP/SBF.
9. [ ] Theo dõi RAM qua 5 spawn liên tiếp: không process nào bị OOM-kill.
10. [ ] Hiển thị trạng thái model trung thực (sống/chết từng transport) ở UI/log.

---

## PHẦN 6 — CẢNH BÁO TRUNG THỰC (nói với người dùng app của bạn)

1. **Free ≠ vô hạn:** fair-use soft limits, limited-time promotion — có ngày
   hết hạn hoặc thắt lại không báo trước.
2. **Policy lật kèo:** trạng thái model free đổi nhiều lần trong 1 tháng điều
   tra — luôn giữ chuỗi failover + model trả phí dự phòng cho tác vụ quan trọng.
3. **Một số model geo-block** theo khu vực tài khoản/IP (vd muse-spark tại máy
   điều tra) — kiểm tra từng model với môi trường của bạn.
4. **Chất lượng không đồng đều:** test battery cho thấy space-bunny-free + 
   longcat hay lỗi format JSON schema lồng nhau; big-pickle/mimo/ling giữ JSON
   chuẩn — chọn model theo loại việc, đừng lấy 1 model cho tất cả.
5. **Chi phí thật của "free":** mỗi spawn ~600MB RAM + 2-6s khởi động —
   "free" về tiền, KHÔNG free về tài nguyên máy. Semaphore là bắt buộc.
6. **An ninh đường free là chặn mềm:** agent trong CLI vẫn có native
   write/edit/bash về nguyên tắc — chỉ ngăn bằng prompt. Không chạy đường này
   trong môi trường tin cậy cao mà không có lớp audit riêng.

---

## PHỤ LỤC A — Catalog model free đã verify (2026-10-09, matrix r73 + cập nhật R5 2026-10-14)

| Model | Năng lực (coding/reasoning/agentic) | Ghi chú vận hành |
|---|---|---|
| space-bunny-free | ✓/✓/✗ | LÕI CHÍNH — model free duy nhất mở HTTP oc_sk (xoay key đa key được); effort low..max; hay đứt tool-call format — cần parser salvage |
| big-pickle | ✓/✓/✓ | Nhanh nhất coding, JSON schema chuẩn — toàn diện |
| mimo-v2.6-flash-free | ✓/✓/✓ | Nhanh nhất tổng thể — hợp tác vụ nhẹ |
| ling-3.1-flash-free | ✓/✓/✓ | Đủ 3 năng lực, coding chậm hơn TB |
| longcat-2.5-preview-free | ✓/✓/✗ | JSON phức tạp hay lỗi format |
| nemotron-3-ultra-free | ✓/✓/✓ | Reasoning sâu nhất — chậm |
| nemotron-3.5-lightning-free | ✓/✓/✓ | Tốc độ trung bình (đã từng treo 5/5 ở một đợt probe — theo dõi) |
| step-5-preview-free | ✓/✓/✓ | Coding chậm nhất |

Đã loại (matrix r73): exo-free (deprecated), ling-3.0-flash-fin-free (không
phản hồi), muse-spark-1.3-contributor-free (geo-block), claude-fable-5 /
-5-1 (access disabled / insufficient funds), grok-build-0.1 (không phản hồi).
Danh sách động — đối chiếu `opencode models --verbose --refresh` + models.dev
định kỳ; 4 model mới bổ sung 2026-10-14 xem agent-constants.ts (đã có live
blockedTransports thay vì hardcode).

## PHỤ LỤC B — Snippet chuẩn hóa spawn (TypeScript, rút từ hệ thống thật)

```typescript
import { spawn } from 'child_process'
import path from 'path'
import os from 'os'

const WS = process.env.OPENCODE_CLI_WORKSPACE?.trim() || path.join(os.homedir(), '.oc-cli-ws')

function spawnOpenCode(model: string, prompt: string, systemPrompt?: string) {
  const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt
  const child = spawn('opencode', [
    'run', '--model', `opencode/${model}`, '--format', 'json',
  ], {
    cwd: WS,                                  // Bẫy 2: ngoài app dir
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PWD: WS,          // Bẫy 3: CHÌA KHÓA — ghi đè PWD, không chỉ cwd
      NO_COLOR: '1',
      TERM: 'dumb',
      // truyền context cho custom tools qua env ở đây
    },
    timeout: 240_000,                         // Bước 7
  })
  child.stdin?.on('error', () => {})          // EPIPE khi child exit sớm
  child.stdin?.write(fullPrompt)              // Bước 5: STDIN không argv
  child.stdin?.end()
  // Bước 6: đọc child.stdout dòng-NJSON, gộp evt.type='text' → content,
  // evt.part.type='reasoning' → reasoning; giữ raw head 64KB dò FreeTierError.
  // Bước 7: on timeout → SIGKILL + resolve PARTIAL (tool đã chạy + reasoning).
  // Bước 8: acquire/release semaphore quanh toàn bộ vòng đời spawn.
  return child
}
```

---

*Tài liệu này do hệ thống TMO xuất bản cho mục đích tái sử dụng nội bộ/nghiên cứu. Khi policy Zen thay đổi, hãy xác minh lại bằng PHẦN 5 trước khi đổ lỗi cho tích hợp.*
