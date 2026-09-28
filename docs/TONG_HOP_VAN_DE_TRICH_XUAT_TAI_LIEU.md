# TỔNG HỢP VẤN ĐỀ TRÍCH XUẤT TÀI LIỆU — Theopusflashlite

> Ngày phân tích: 2026-03-05  
> Phiên bản: v2.0.0 — Next.js 16 (App Router, Turbopack)

---

## MỤC LỤC

1. [Cảnh báo pdf2json](#1-cảnh-báo-pdf2json)
2. [Lỗi "Failed to fetch" Runtime TypeError](#2-lỗi-failed-to-fetch-runtime-typeerror)
3. [Chậm khi chuyển tài liệu / bấm nút xử lý](#3-chậm-khi-chuyển-tài-liệu--bấm-nút-xử-lý)
4. [Race Condition trong quản lý Key Slot](#4-race-condition-trong-quản-lý-key-slot)
5. [Rò rỉ Slot khi Promise bị reject](#5-rò-rỉ-slot-khi-promise-bị-reject)
6. [autoRecoverStuckDocs đua với xử lý đang chạy](#6-autorecoverstuckdocs-đua-với-xử-lý-đang-chạy)
7. [Polling không có cơ chế retry/kết thúc khi mạng lỗi](#7-polling-không-có-cơ-chế-retrykết-thúc-khi-mạng-lỗi)
8. [Timeout của Serverless Function / Background Task](#8-timeout-của-serverless-function--background-task)
9. [Fallback provider tuần tự quá chậm](#9-fallback-provider-tuần-tự-quá-chậm)
10. [OpenRouter cạn kiệt nhanh (200 req/ngày)](#10-openrouter-cạn-kiệt-nhanh-200-reqngày)
11. [entityNameToIdMap tăng trưởng không giới hạn](#11-entitynametoidmap-tăng-trưởng-không-giới-hạn)
12. [Xử lý response HTTP 200 nhưng content rỗng](#12-xử-lý-response-http-200-nhưng-content-rỗng)
13. [Gấp đôi fetchDocuments từ 2 nguồn polling](#13-gấp-đôi-fetchdocuments-từ-2-nguồn-polling)
14. [Reconciliation chạy trên mỗi GET request dù không cần](#14-reconciliation-chạy-trên-mỗi-get-request-dù-không-cần)
15. [Vòng lặp vô hạn: error → recovery → error](#15-vòng-lặp-vô-hạn-error--recovery--error)
16. [Tóm tắt mức độ ưu tiên & đề xuất sửa](#16-tóm-tắt-mức-độ-ưu-tiên--đề-xuất-sửa)

---

## 1. Cảnh báo pdf2json

### Hiện tượng
Terminal liên tục hiển thị:
```
Warning: Unsupported: field.type of Link
Warning: NOT valid form element
```

### Nguyên nhân gốc
Cảnh báo đến từ thư viện `pdf2json` (v4.0.3), cụ thể từ 2 vị trí trong mã nguồn của nó:

| Cảnh báo | Nguồn trong pdf2json | Nguyên nhân |
|----------|---------------------|-------------|
| `Unsupported: field.type of Link` | `Field.isFormElement()` | PDF có annotation kiểu `Link` (hyperlink), nhưng pdf2json chỉ xử lý subtype `Widget` (form fields) |
| `NOT valid form element` | `PDFParser.S()` | `Field.isFormElement()` trả về `false` cho các annotation không phải form |

Cả hai đều phát qua `console.warn()` — **hoàn toàn vô hại** đối với việc trích xuất văn bản.

### Trạng thái suppress hiện tại
- **`process/route.ts` (dòng 328-337)**: Đã có hàm `suppressPdf2jsonWarnings()` bao bọc mọi lệnh gọi pdf2json qua `try/finally`. ✅ Đã suppress đúng.
- **`pdf-parser.ts`**: Chỉ dùng `pdf-parse`, không dùng `pdf2json` → không cần suppress.

### Tại sao vẫn thấy cảnh báo?
Có 3 khả năng:

1. **Đường mã khác** import pdf2json mà không dùng `suppressPdf2jsonWarnings()`.
2. **Hot-reload** — khi Next.js reload module, `console.warn` gốc đã được restore nhưng pdf2json vẫn giữ reference cũ đến logger nội bộ.
3. **pdf2json sử dụng logger riêng** — trong một số cấu hình, `l.warn()` nội bộ có thể không đi qua `console.warn` mà đi qua kênh logging khác.

### Đề xuất sửa
```typescript
// Thêm vào đầu process/route.ts hoặc next.config.ts
process.env.PDF2JSON_DISABLE_LOGS = '1'
```
Biến môi trường này tắt toàn bộ logging của pdf2json (được hỗ trợ native: `PDF2JSON_DISABLE_LOGS=1`). Đây là cách đơn giản và triệt để hơn so với monkey-patch `console.warn`.

---

## 2. Lỗi "Failed to fetch" Runtime TypeError

### Hiện tượng
```
Runtime TypeError: Failed to fetch
    at Home.useCallback[handleProcessDoc].pollBatchUntilDone
    at async Home.useCallback[handleProcessDoc].waitForCompletionAndAutoContinue
```

### Nguyên nhân gốc
`TypeError: Failed to fetch` là lỗi **trình duyệt** — `fetch()` không thể hoàn thành kết nối HTTP. Đây KHÔNG phải lỗi server (5xx), mà là TCP connection bị đứt hoặc không thể thiết lập.

### Các đường dẫn lỗi

#### Đường 1: Background task crash → server chết
```
POST /api/ingestion/process (async) → trả về 200 OK
→ bgPromise bắt đầu → runIngestionPipeline() → Neo4j/Qdrant lỗi → exception không xử lý
→ Next.js dev server crash/hang → poll tiếp theo: "Failed to fetch"
```

#### Đường 2: Serverless function bị kill giữa chừng
```
POST (async) → trả 200 → bgPromise chạy 40+ phút
→ Vercel/serverless kill function sau 10-60s (giới hạn platform)
→ Document kẹt ở 'extracting' → frontend poll → server đã chết → "Failed to fetch"
```

#### Đường 3: Dev server hot-reload khi đang xử lý
```
Pipeline đang chạy → phát hiện thay đổi code → Next.js hot-reload → process bị kill
→ Document kẹt → frontend poll đến server đã chết → "Failed to fetch"
```

#### Đường 4: `pollBatchUntilDone` KHÔNG có try-catch cho fetch
```typescript
// Dòng 12677 — KHÔNG có try-catch!
const docRes = await fetch('/api/ingestion/process?action=progress&documentId=' + docId)
if (!docRes.ok) continue  // ← Chỉ xử lý HTTP error, KHÔNG xử lý network error
```

Nếu `fetch()` ném `TypeError: Failed to fetch`, lỗi lan truyền lên `waitForCompletionAndAutoContinue` → `void` gọi không có catch → lỗi không được xử lý.

### Đề xuất sửa
```typescript
// Thêm try-catch và retry với exponential backoff
const pollBatchUntilDone = async (docId: string) => {
  let partialConfirmCount = 0
  let consecutiveFetchFailures = 0
  const MAX_FETCH_FAILURES = 10 // Thoát sau 10 lần lỗi liên tiếp (~30s)

  while (Date.now() - totalStartTime < maxTotalWaitMs) {
    await new Promise(resolve => setTimeout(resolve, 3000))
    if (pausedDocIdsRef.current.has(docId)) return 'partial'

    try {
      const docRes = await fetch('/api/ingestion/process?action=progress&documentId=' + docId)
      if (!docRes.ok) {
        consecutiveFetchFailures++
        if (consecutiveFetchFailures >= MAX_FETCH_FAILURES) return 'error'
        continue
      }
      consecutiveFetchFailures = 0
      const docData = await docRes.json()
      // ... logic xử lý status ...
    } catch (networkErr) {
      consecutiveFetchFailures++
      if (consecutiveFetchFailures >= MAX_FETCH_FAILURES) {
        console.error('[PollBatch] Max fetch failures:', networkErr)
        return 'error'
      }
      // Exponential backoff: 3s → 6s → 12s → 24s → max 30s
      const delay = Math.min(30_000, 3_000 * Math.pow(2, consecutiveFetchFailures - 1))
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  return 'unknown'
}
```

---

## 3. Chậm khi chuyển tài liệu / bấm nút xử lý

### Hiện tượng
Bấm nút "Xử lý" đôi khi rất chậm, UI phản hồi chậm.

### Nguyên nhân

#### 3.1 Reconciliation chạy trên mỗi GET request
`GET /api/ingestion/upload` (dòng 572-910) chạy reconciliation cho **tất cả** tài liệu mỗi lần được gọi:
- Với 300+ tài liệu, reconciliation duyệt qua từng tài liệu, truy vấn Qdrant + SQLite
- Dù đã giới hạn `MAX_RECONCILE_PER_PASS = 50`, nhưng vẫn cần duyệt toàn bộ danh sách để chọn 50 tài liệu cần reconciliation
- Auto-poll `useEffect` gọi `fetchDocuments()` mỗi 3s → mỗi 3 giây chạy một lần reconciliation (dù có cache)

#### 3.2 Gấp đôi fetchDocuments từ 2 nguồn polling
- `pollBatchUntilDone` (dòng 12684) gọi `fetchDocuments()` mỗi 3 giây
- Auto-poll `useEffect` cũng gọi `fetchDocuments()` mỗi 3 giây
- Tổng: 2 request reconciliation mỗi 3 giây cho mỗi tài liệu đang xử lý
- Nếu 4+ tài liệu đang xử lý: 8+ request/3s

#### 3.3 fetchDocuments không dùng lite mode khi polling
Polling nên dùng `?lite=true` (bỏ qua reconciliation & chunk coverage) nhưng auto-poll useEffect gọi không có tham số này.

### Đề xuất sửa
1. Polling gọi `fetchDocuments()` với `?lite=true` để bỏ qua reconciliation
2. Xóa `fetchDocuments()` bên trong `pollBatchUntilDone` — useEffect auto-poll đã lo việc này
3. Tăng thời gian auto-poll từ 3s → 5s khi không có tài liệu nào đang xử lý

---

## 4. Race Condition trong quản lý Key Slot

### Mức độ: 🔴 CAO

### Vị trí
`src/lib/llm.ts` — hàm `acquireKeySlot()` (dòng 1081)

### Vấn đề
Hàm `acquireKeySlot` **KHÔNG thread-safe**. Trong POST handler, nhiều request đồng thời có thể đọc cùng trạng thái slot trước khi bất kỳ request nào ghi:

```typescript
// Hai request đồng thời đều thấy slot.docIds.length < MAX_DOCS_PER_SLOT
const availableSlot = keySlots.find(s => s.docIds.length < MAX_DOCS_PER_SLOT)
availableSlot.docIds.push(docId)  // Cả hai push vào cùng slot → vượt quá giới hạn
```

### Hậu quả
- Một slot có thể tạm thời chứa hơn 5 tài liệu
- Vượt quá rate limit của API key được gán cho slot đó
- Provider trả về 429 (rate limited) → trích xuất thất bại

### Đề xuất sửa
Thêm mutex/lock bất đồng bộ quanh slot acquisition:
```typescript
const slotMutex = new AsyncMutex()

export async function acquireKeySlotAsync(docId: string): Promise<number> {
  return slotMutex.runExclusive(() => {
    // ... logic hiện tại ...
  })
}
```

---

## 5. Rò rỉ Slot khi Promise bị reject

### Mức độ: 🔴 CAO

### Vị trí
`src/app/api/ingestion/process/route.ts` — `bgPromise` IIFE (dòng 3247-3348)

### Vấn đề
`allDocIdsWithSlots` chỉ theo dõi tài liệu tại thời điểm thêm vào, nhưng:
1. Nếu `processWithAutoChain` ném lỗi trong `finally` block (sau khi slot đã được release), catch handler cố gắng release lại → double-release
2. Nếu auto-next doc được thêm vào `allDocIdsWithSlots` nhưng `processWithAutoChain` promise không được track đúng (e.g., `startDocIfSlotFree` ném lỗi trước khi promise được push vào `running`), slot bị rò rỉ

### Đề xuất sửa
Track slot acquisition trong try/finally ở mọi cấp, thay vì dựa vào catch handler duy nhất ở ngoài cùng.

---

## 6. autoRecoverStuckDocs đua với xử lý đang chạy

### Mức độ: 🔴 CAO

### Vị trí
`src/app/api/ingestion/process/route.ts` — hàm `autoRecoverStuckDocs()` (dòng 3559)

### Vấn đề
Race condition TOCTOU (Time-of-Check-Time-of-Use):
1. `autoRecoverStuckDocs` đọc `getActiveDocIds()` → doc X không trong set
2. Đồng thời, POST handler bắt đầu xử lý doc X và acquire slot
3. `autoRecoverStuckDocs` gọi `releaseKeySlot(doc.id)` → release slot doc X vừa acquire
4. `processWithAutoChain` của doc X tiếp tục chạy nhưng slot đã bị đánh cắp
5. Khi doc X xong, `releaseKeySlot` là no-op → slot counter sai

### Đề xuất sửa
Thêm "processing lock" flag trong Qdrant payload, check slot status và document status một cách atomic.

---

## 7. Polling không có cơ chế retry/kết thúc khi mạng lỗi

### Mức độ: 🔴 CAO

### Vị trí
`src/app/page.tsx` — `pollBatchUntilDone()` (dòng 12667-12705)

### Vấn đề
```typescript
const docRes = await fetch('/api/ingestion/process?action=progress&documentId=' + docId)
if (!docRes.ok) continue  // ← Lỗi HTTP bị nuốt, KHÔNG có giới hạn retry!
```

- `!docRes.ok` chỉ xử lý HTTP error (4xx, 5xx), KHÔNG xử lý network error (`TypeError: Failed to fetch`)
- Không có `MAX_RETRY` — nếu server chết, vòng lặp poll tiếp tục chạy 2 giờ, gửi request thất bại mỗi 3 giây
- Không có exponential backoff — gửi request liên tục gây thêm tải

### Đề xuất sửa
Như đã mô tả ở [Mục 2](#2-lỗi-failed-to-fetch-runtime-typeerror), thêm try-catch với `MAX_FETCH_FAILURES` và exponential backoff.

---

## 8. Timeout của Serverless Function / Background Task

### Mức độ: 🔴 CAO

### Vị trí
`src/app/api/ingestion/process/route.ts` — `maxDuration = 600` (dòng 45), `bgPromise` (dòng 3247)

### Vấn đề
- `maxDuration = 600` (10 phút) — chỉ hoạt động trên Vercel Pro
- Background pipeline (`processWithAutoChain`) có thể chạy **40+ phút** cho tài liệu lớn (445 chunks × 5s/chunk, 5+ batches × 500s timeout)
- Khi serverless function bị kill, tài liệu kẹt ở trạng thái 'extracting'
- Frontend tiếp tục poll nhưng không nhận được response → "Failed to fetch"

### Kiến trúc hiện tại
```
POST (async) → trả 200 ngay → bgPromise chạy nền (fire-and-forget)
→ Frontend poll GET ?action=progress mỗi 3s
→ Nếu bgPromise chết (timeout/crash), document kẹt, frontend treo
```

### Đề xuất sửa
1. **Dùng job queue thực sự** (BullMQ, Inngest) thay vì fire-and-forget promise
2. **Webhook-based architecture**: pipeline signal hoàn thành qua callback
3. **Chia nhỏ pipeline**: mỗi batch chạy trong một API call riêng biệt, không phụ thuộc vào long-running serverless function

---

## 9. Fallback provider tuần tự quá chậm

### Mức độ: 🟡 TRUNG BÌNH

### Vị trí
`src/lib/llm.ts` — `callLLMSlot()` (dòng 1939-1950)

### Vấn đề
Khi provider đầu tiên thất bại, code thử **tuần tự** từng provider với timeout 60s mỗi model mỗi provider:

```typescript
for (let i = 0; i < rotatedFns.length; i++) {
  const result = await rotatedFns[i]()  // Có thể mất 60s × N models
  if (result?.content) return result
}
```

- Worst case: 3 providers × 3 models × 60s timeout = **540 giây** cho một LLM call
- Pipeline trích xuất có 8 concurrent workers, mỗi worker chờ đến 540s
- Với `EXTRACTION_TIMEOUT_MS = 500_000`, một LLM call thất bại duy nhất có thể tiêu tốn toàn bộ batch timeout

### Đề xuất sửa
```typescript
// Sử dụng Promise.any() — provider nào trả về kết quả đầu tiên thì dùng
const result = await Promise.any([
  tryProviderWithSlotKey('nvidia', slotIndex, ...),
  tryProviderWithSlotKey('mistral', slotIndex, ...),
  tryProviderWithSlotKey('openrouter', slotIndex, ...),
])
```

---

## 10. OpenRouter cạn kiệt nhanh (200 req/ngày)

### Mức độ: 🟡 TRUNG BÌNH

### Vị trí
`src/lib/llm.ts` — ProviderKeyPool (dòng 1254-1280)

### Vấn đề
- OpenRouter: 50 req/ngày/key, 4 keys = 200 requests/ngày tối đa
- Pipeline trích xuất dùng 8 concurrent workers, mỗi worker gọi LLM
- Một tài liệu 445 chunks cần 445 LLM calls
- Nếu NVIDIA + Mistral thất bại → tất cả 445 fallback sang OpenRouter
- 200 daily limit → **cạn kiệt sau ~1.5 tài liệu**

Khi tất cả OpenRouter keys exhausted:
1. `tryProviderWithSlotKey()` trả về `null` cho mọi provider
2. `callLLMSlot()` trả về `{ content: '', error: 'All LLM providers failed' }`
3. `extractFromChunk()` trả về null → `failedChunks` tăng
4. Nếu TẤT CẢ chunks thất bại → pipeline trả về `{ status: 'error' }`

### Đề xuất sửa
1. Thêm backpressure: dừng auto-next khi OpenRouter daily usage > 80%
2. Ưu tiên NVIDIA/Mistral hơn (weighted round-robin với trọng số cao hơn cho provider có rate limit rộng hơn)
3. Thêm daily budget tracking và warning cho người dùng

---

## 11. entityNameToIdMap tăng trưởng không giới hạn

### Mức độ: 🟡 TRUNG BÌNH

### Vị trí
`src/app/api/ingestion/process/route.ts` — dòng 1909, 2081-2082

### Vấn đề
```typescript
entityNameToIdMap.set(entity.name.toLowerCase().trim(), entityId)
// ...
if (entityNameToIdMap.size > 100000) {
  console.warn(`[Process] entityNameToIdMap has ${entityNameToIdMap.size} entries`)
}
```

- Map tăng không giới hạn — chỉ có warning khi > 100K entries
- Với 8 concurrent workers và auto-chain lên đến 500 batches, Map có thể phát triển đến hàng triệu entries
- Gây áp lực bộ nhớ, tiềm năng OOM crash trên VPS nhỏ

### Đề xuất sửa
1. Xóa map giữa các auto-chain batches
2. Dùng LRU cache với giới hạn kích thước (e.g., 50K entries)
3. Thay Map bằng database lookup cho entity resolution

---

## 12. Xử lý response HTTP 200 nhưng content rỗng

### Mức độ: 🟡 TRUNG BÌNH

### Vị trí
`src/lib/llm.ts` — `tryProviderWithSlotKey()` (dòng 1603-1631)

### Vấn đề
Khi provider trả về HTTP 200 nhưng body không hợp lệ (choices rỗng, JSON parsing thất bại):
```typescript
if (response.ok) {
  const data = await response.json()
  const content = data.choices?.[0]?.message?.content
  if (content) {
    // Success
    return { content, ... }
  }
  // Falls through — KHÔNG log lỗi cho empty content!
}
```

- HTTP 200 với `choices` rỗng được xử lý giống hệt provider thất bại
- Không tăng failure count → key không được đánh dấu là có vấn đề
- Lặp lại vô tận với key bị lỗi

### Đề xuất sửa
```typescript
if (response.ok) {
  const data = await response.json()
  const content = data.choices?.[0]?.message?.content
  if (content) return { content, ... }
  // Log empty response
  console.warn(`[LLM] Provider ${provider} returned 200 with empty content`)
  // Count as soft failure
  pool.markSoftFailure(keyIndex)
}
```

---

## 13. Gấp đôi fetchDocuments từ 2 nguồn polling

### Mức độ: 🟡 TRUNG BÌNH

### Vị trí
`src/app/page.tsx` — dòng 12684 (pollBatchUntilDone), dòng 13011 (auto-poll useEffect)

### Vấn đề
Hai cơ chế polling độc lập cùng gọi `fetchDocuments()`:
1. `pollBatchUntilDone` gọi `fetchDocuments()` mỗi 3 giây (dòng 12684)
2. Auto-poll useEffect cũng gọi `fetchDocuments()` mỗi 3 giây (dòng 13011)

Kết quả: **2 lần reconciliation mỗi 3 giây** cho mỗi tài liệu đang xử lý. Với 4 tài liệu: 8 request/3s.

### Đề xuất sửa
Xóa `fetchDocuments()` khỏi `pollBatchUntilDone` — auto-poll useEffect đã đảm nhiệm việc này.

---

## 14. Reconciliation chạy trên mỗi GET request dù không cần

### Mức độ: 🟡 TRUNG BÌNH

### Vị trí
`src/app/api/ingestion/upload/route.ts` — GET handler (dòng 461-945)

### Vấn đề
- Mỗi `GET /api/ingestion/upload` chạy reconciliation cho tất cả tài liệu
- Có cache nhưng bị invalidate mỗi khi có tài liệu thay đổi status
- Auto-poll gọi GET mỗi 3s → reconciliation chạy liên tục
- `MAX_RECONCILE_PER_PASS = 50` giúp giảm tải, nhưng vẫn cần duyệt toàn bộ danh sách

### Đề xuất sửa
1. Tách reconciliation thành API riêng: `GET /api/ingestion/reconcile`
2. Chạy reconciliation tự động theo interval (mỗi 30s) thay vì trên mỗi GET request
3. GET chỉ trả về dữ liệu cached, không trigger reconciliation

---

## 15. Vòng lặp vô hạn: error → recovery → error

### Mức độ: 🟡 TRUNG BÌNH

### Vấn đề
Khi tất cả API keys exhausted:
1. Tài liệu → `error` (pipeline thất bại)
2. `autoRecoverStuckDocs` → reset về `uploaded` hoặc `partial`
3. Auto-next/reconciliation → thử lại → tất cả keys vẫn exhausted → `error` lại
4. Quay lại bước 2 → **vòng lặp vô hạn**

### Đề xuất sửa
1. Thêm cooldown cho error docs — không recovery trong 10 phút sau khi vừa error
2. Kiểm tra available keys trước khi recovery
3. Giới hạn số lần auto-retry cho mỗi tài liệu (e.g., max 3 lần, sau đó cần manual trigger)

---

## 16. Tóm tắt mức độ ưu tiên & đề xuất sửa

| # | Vấn đề | Mức độ | File | Đề xuất |
|---|--------|--------|------|---------|
| 1 | Cảnh báo pdf2json | 🟢 Thấp | process/route.ts | Đặt `PDF2JSON_DISABLE_LOGS=1` |
| 2 | Failed to fetch — không có try-catch trong poll | 🔴 Cao | page.tsx:12677 | Thêm try-catch + retry + backoff |
| 3 | Chậm — reconciliation trên mỗi GET | 🟡 Trung bình | upload/route.ts | Tách reconciliation API riêng |
| 4 | Chậm — gấp đôi fetchDocuments | 🟡 Trung bình | page.tsx:12684 | Xóa fetchDocuments() trong pollBatchUntilDone |
| 5 | Race condition acquireKeySlot | 🔴 Cao | llm.ts:1081 | Thêm async mutex |
| 6 | Rò rỉ slot khi Promise reject | 🔴 Cao | process/route.ts:3247 | Track slot trong try/finally mọi cấp |
| 7 | autoRecoverStuckDocs TOCTOU | 🔴 Cao | process/route.ts:3559 | Processing lock flag trong Qdrant |
| 8 | Serverless timeout kill background task | 🔴 Cao | process/route.ts:3247 | Dùng job queue (BullMQ/Inngest) |
| 9 | Fallback provider tuần tự chậm | 🟡 Trung bình | llm.ts:1939 | Dùng `Promise.any()` |
| 10 | OpenRouter cạn kiệt nhanh | 🟡 Trung bình | llm.ts:1254 | Backpressure + daily budget tracking |
| 11 | entityNameToIdMap tăng không giới hạn | 🟡 Trung bình | process/route.ts:1909 | Xóa giữa batches / LRU cache |
| 12 | HTTP 200 content rỗng không log | 🟡 Trung bình | llm.ts:1603 | Log + markSoftFailure |
| 13 | Polling gấp đôi fetchDocuments | 🟡 Trung bình | page.tsx:12684,13011 | Xóa duplicate call |
| 14 | Reconciliation trên mỗi GET | 🟡 Trung bình | upload/route.ts | Tách API + interval-based |
| 15 | Vòng lặp vô hạn error→recovery | 🟡 Trung bình | process/route.ts | Cooldown + available keys check |

### Thứ tự ưu tiên sửa

**Giai đoạn 1 — Sửa lỗi nghiêm trọng (Failed to fetch):**
1. Thêm try-catch + retry trong `pollBatchUntilDone` (#2)
2. Thêm `PDF2JSON_DISABLE_LOGS=1` (#1)

**Giai đoạn 2 — Sửa race condition:**
3. Async mutex cho `acquireKeySlot` (#5)
4. Processing lock flag cho autoRecoverStuckDocs (#7)
5. Track slot trong try/finally mọi cấp (#6)

**Giai đoạn 3 — Tối ưu hiệu năng:**
6. Xóa duplicate fetchDocuments (#13)
7. Tách reconciliation API (#14)
8. Dùng `Promise.any()` cho provider fallback (#9)

**Giai đoạn 4 — Kiến trúc dài hạn:**
9. Job queue thay vì fire-and-forget (#8)
10. Backpressure cho API key exhaustion (#10, #15)
11. LRU cache cho entityNameToIdMap (#11)
