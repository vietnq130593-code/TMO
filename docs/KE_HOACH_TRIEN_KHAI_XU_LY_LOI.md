# KẾ HOẠCH TRIỂN KHAI XỬ LÝ LỖI — Theopusflashlite

> Ngày tạo: 2026-03-05  
> Dựa trên: `TONG_HOP_VAN_DE_TRICH_XUAT_TAI_LIEU.md`  
> Phiên bản: v2.0.0 — Next.js 16 (App Router, Turbopack)

---

## MỤC LỤC

- [Tổng quan kiến trúc sửa chữa](#tổng-quan-kiến-trúc-sửa-chữa)
- [Giai đoạn 1 — Sửa lỗi nghiêm trọng (Failed to fetch + Warnings)](#giai-đoạn-1--sửa-lỗi-nghiêm-trọng)
- [Giai đoạn 2 — Sửa race condition & rò rỉ slot](#giai-đoạn-2--sửa-race-condition--rò-rỉ-slot)
- [Giai đoạn 3 — Tối ưu hiệu năng](#giai-đoạn-3--tối-ưu-hiệu-năng)
- [Giai đoạn 4 — Kiến trúc dài hạn](#giai-đoạn-4--kiến-trúc-dài-hạn)
- [Ma trận kiểm thử](#ma-trận-kiểm-thử)
- [Rủi ro & Rollback](#rủi-ro--rollback)

---

## Tổng quan kiến trúc sửa chữa

```
┌──────────────────────────────────────────────────────────────┐
│                    GIAI ĐOẠN TRIỂN KHAI                      │
├──────────┬──────────┬──────────────┬─────────────────────────┤
│  GĐ 1    │  GĐ 2    │    GĐ 3      │        GĐ 4             │
│ 🔴 Cấp  │ 🔴 Cấp   │ 🟡 Trung     │ 🟢 Dài hạn             │
│ bách     │ cao      │ bình         │                         │
├──────────┼──────────┼──────────────┼─────────────────────────┤
│ #1 pdf2j │ #5 Mutex │ #9 Promise   │ #8 Job Queue            │
│ son logs │  slot    │  .any()      │  (Inngest/BullMQ)       │
│ #2 Try-c │ #6 Track │ #10 Backpres │ #10 Daily budget        │
│ atch poll│  slot    │  sure OR     │  dashboard              │
│ #7 Retry │ #7 Proc  │ #11 LRU cach │ #11 DB-based entity     │
│  backoff │  lock    │  e map       │  resolution             │
│          │          │ #12 Soft fail│ #15 Error cooldown      │
│          │          │ #13 Dedup    │  + retry counter        │
│          │          │  fetchDoc    │                         │
│          │          │ #14 Recon    │                         │
│          │          │  interval    │                         │
└──────────┴──────────┴──────────────┴─────────────────────────┘
```

**Nguyên tắc**: Mỗi giai đoạn phải hoàn thành và pass lint trước khi chuyển sang giai đoạn tiếp. Mỗi thay đổi được wrap trong try-catch với fallback để không làm hỏng tính năng hiện có.

---

## Giai đoạn 1 — Sửa lỗi nghiêm trọng

### Fix #1: Tắt cảnh báo pdf2json

**Vấn đề**: Terminal liên tục báo `Warning: Unsupported: field.type of Link` và `Warning: NOT valid form element`

**File**: `src/app/api/ingestion/process/route.ts`

**Bước 1.1**: Thêm `PDF2JSON_DISABLE_LOGS` ở đầu file (dòng 44, trước `export const dynamic`)

```typescript
// Dòng 44 — Thêm TRƯỚC export const dynamic
// Suppress pdf2json warnings globally (supported natively by pdf2json library)
// This is more reliable than monkey-patching console.warn which can leak on hot-reload
if (typeof process !== 'undefined') {
  process.env.PDF2JSON_DISABLE_LOGS = '1'
}
```

**Bước 1.2**: Giữ nguyên `suppressPdf2jsonWarnings()` (dòng 328-337) như backup — không xóa, vì:
- Monkey-patch `console.warn` vẫn hữu ích nếu biến môi trường không được pdf2json đọc đúng
- Trên một số bundler, `process.env` có thể không available khi pdf2json init

**Bước 1.3**: Kiểm tra dev log — sau khi restart server, cảnh báo phải biến mất.

**Kiểm chứng**:
```bash
# Terminal phải KHÔNG còn hiển thị:
# Warning: Unsupported: field.type of Link
# Warning: NOT valid form element
```

---

### Fix #2 + #7: Thêm try-catch, retry, exponential backoff cho polling

**Vấn đề**: `pollBatchUntilDone()` (dòng 12667-12705) không có try-catch cho `fetch()`, không có giới hạn retry khi mạng lỗi, không có backoff.

**File**: `src/app/page.tsx`

**Bước 2.1**: Sửa hàm `pollBatchUntilDone` (dòng 12667-12705)

Thay thế toàn bộ hàm hiện tại bằng:

```typescript
/** Poll a single batch until it reaches a terminal state (partial/indexed/extracted/error).
 *  Includes network error recovery with exponential backoff and max failure threshold. */
const pollBatchUntilDone = async (docId: string): Promise<'done' | 'partial' | 'error' | 'unknown'> => {
  let partialConfirmCount = 0
  let consecutiveFetchFailures = 0
  const MAX_FETCH_FAILURES = 10  // Thoát sau 10 lần lỗi liên tiếp (~30s-5min tùy backoff)

  while (Date.now() - totalStartTime < maxTotalWaitMs) {
    await new Promise(resolve => setTimeout(resolve, 3000))

    // Early exit if the user paused this document
    if (pausedDocIdsRef.current.has(docId)) {
      return 'partial'
    }

    try {
      const docRes = await fetch('/api/ingestion/process?action=progress&documentId=' + docId)

      if (!docRes.ok) {
        consecutiveFetchFailures++
        if (consecutiveFetchFailures >= MAX_FETCH_FAILURES) {
          console.error(`[PollBatch] ${MAX_FETCH_FAILURES} consecutive HTTP errors (last: ${docRes.status}) — giving up`)
          return 'error'
        }
        continue
      }

      // Reset failure counter on successful response
      consecutiveFetchFailures = 0
      const docData = await docRes.json()
      const doc = docData.document
      if (!doc) return 'unknown'

      // NOTE: Không gọi fetchDocuments() ở đây — auto-poll useEffect đã lo việc này.
      // Tránh gấp đôi request reconciliation mỗi 3 giây.
      // Chỉ cập nhật stats (nhẹ hơn).
      fetchStats()

      if (['indexed', 'extracted', 'partial', 'error'].includes(doc.status)) {
        if (doc.status === 'error') {
          sonnerToast.error('Xử lý thất bại', { description: doc.error_message || 'Lỗi không xác định', duration: 8000 })
          return 'error'
        } else if (doc.status === 'partial') {
          // Confirm genuine partial (3 consecutive reads)
          partialConfirmCount++
          if (partialConfirmCount < 3) continue
          return 'partial'
        } else {
          // indexed or extracted — fully done
          return 'done'
        }
      }
      // Status is back to processing (e.g. 'extracting') — reset partial counter
      partialConfirmCount = 0
    } catch (networkErr) {
      // TypeError: Failed to fetch — network error, server down, DNS failure, etc.
      consecutiveFetchFailures++
      if (consecutiveFetchFailures >= MAX_FETCH_FAILURES) {
        console.error(`[PollBatch] ${MAX_FETCH_FAILURES} consecutive network errors — giving up:`, networkErr)
        return 'error'
      }
      // Exponential backoff: 3s → 6s → 12s → 24s → max 30s
      const backoffDelay = Math.min(30_000, 3_000 * Math.pow(2, consecutiveFetchFailures - 1))
      console.warn(`[PollBatch] Fetch failed (${consecutiveFetchFailures}/${MAX_FETCH_FAILURES}), retrying in ${backoffDelay / 1000}s:`, networkErr instanceof Error ? networkErr.message : String(networkErr))
      await new Promise(resolve => setTimeout(resolve, backoffDelay))
    }
  }
  return 'unknown'
}
```

**Thay đổi chính so với bản cũ**:
| Điểm | Bản cũ | Bản mới |
|------|--------|---------|
| Try-catch | ❌ Không có | ✅ Bao bọc toàn bộ fetch |
| Max retry | ❌ Không giới hạn (chạy 2h) | ✅ 10 lần liên tiếp → return 'error' |
| Backoff | ❌ Luôn 3s | ✅ 3s → 6s → 12s → 24s → 30s max |
| fetchDocuments() | ❌ Gọi mỗi 3s (gây reconciliation) | ✅ Xóa — chỉ gọi fetchStats() (nhẹ hơn) |
| HTTP error handling | `continue` vô hạn | Đếm `consecutiveFetchFailures` + giới hạn |

**Bước 2.2**: Thêm retry cho initial POST fetch trong `handleProcessDoc` (dòng 12553)

Sửa đoạn fetch POST hiện tại:

```typescript
// Bước 2.2: Thêm retry cho POST request ban đầu
const MAX_POST_RETRIES = 3
let res: Response | null = null
let lastPostError: Error | null = null

for (let attempt = 1; attempt <= MAX_POST_RETRIES; attempt++) {
  try {
    res = await fetch('/api/ingestion/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentIds: [documentId], async: true, autoNext: autoMode }),
    })
    break // Success — exit retry loop
  } catch (fetchErr) {
    lastPostError = fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr))
    if (attempt < MAX_POST_RETRIES) {
      const delay = attempt * 2000 // 2s, 4s
      console.warn(`[ProcessDoc] POST attempt ${attempt} failed, retrying in ${delay}ms:`, lastPostError.message)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}

if (!res) {
  throw new Error(`Không thể kết nối server sau ${MAX_POST_RETRIES} lần thử: ${lastPostError?.message || 'lỗi mạng'}`)
}
```

**Kiểm chứng**:
1. Tắt server giữa chừng khi đang poll → frontend phải hiển thị lỗi sau 10 lần thử, không crash
2. Khởi động lại server → polling phải tự phục hồi (consecutiveFetchFailures reset về 0)
3. Kiểm tra console không còn `TypeError: Failed to fetch` unhandled

---

### Fix #1b: Xóa fetchDocuments() trùng lặp trong pollBatchUntilDone

**Vấn đề**: `pollBatchUntilDone` (dòng 12684) và auto-poll useEffect đều gọi `fetchDocuments()` → gấp đôi reconciliation.

**File**: `src/app/page.tsx`

**Đã tích hợp vào Fix #2** — bản mới thay `fetchDocuments()` bằng `fetchStats()` (chỉ cập nhật thống kê, không chạy reconciliation).

---

## Giai đoạn 2 — Sửa race condition & rò rỉ slot

### Fix #5: Async Mutex cho acquireKeySlot

**Vấn đề**: `acquireKeySlot()` (llm.ts:1081) không thread-safe — nhiều request đồng thời có thể đọc cùng slot state → vượt quá giới hạn.

**File**: `src/lib/llm.ts`

**Bước 5.1**: Thêm AsyncMutex class (thêm vào đầu file, sau các import, ~dòng 50)

```typescript
// ==================== ASYNC MUTEX ====================

/** Simple async mutex for protecting concurrent access to shared state.
 *  Uses a promise chain to ensure only one caller holds the lock at a time. */
class AsyncMutex {
  private _queue: Promise<void> = Promise.resolve()

  /** Acquire the lock — returns a release function.
   *  Usage: const release = await mutex.acquire(); try { ... } finally { release(); } */
  acquire(): Promise<() => void> {
    let releaseFn!: () => void
    const nextPromise = new Promise<void>((resolve) => { releaseFn = resolve })
    const prevPromise = this._queue
    this._queue = nextPromise
    return prevPromise.then(() => releaseFn)
  }

  /** Run an exclusive async function — acquires lock, runs fn, releases lock. */
  async runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

/** Mutex for key slot operations — prevents race conditions when multiple
 *  POST /api/ingestion/process requests acquire/release slots concurrently. */
const slotMutex = new AsyncMutex()
```

**Bước 5.2**: Thêm hàm `acquireKeySlotAsync` mới (thêm sau `acquireKeySlot` hiện tại, ~dòng 1099)

```typescript
/** Async version of acquireKeySlot — uses mutex to prevent race conditions.
 *  This is the preferred API for route handlers where multiple requests may
 *  compete for slots simultaneously. */
export async function acquireKeySlotAsync(docId: string): Promise<number> {
  return slotMutex.runExclusive(() => acquireKeySlot(docId))
}

/** Async version of releaseKeySlot — uses mutex to prevent race conditions. */
export async function releaseKeySlotAsync(docId: string): Promise<void> {
  return slotMutex.runExclusive(() => { releaseKeySlot(docId) })
}
```

**Bước 5.3**: Cập nhật `process/route.ts` — thay `acquireKeySlot` bằng `acquireKeySlotAsync`

Sửa import (dòng 32):
```typescript
// Trước:
import { callLLM, callLLMSlot, acquireKeySlot, releaseKeySlot, ... } from '@/lib/llm'
// Sau:
import { callLLM, callLLMSlot, acquireKeySlotAsync, releaseKeySlotAsync, acquireKeySlot, releaseKeySlot, ... } from '@/lib/llm'
```

Sửa trong `startDocIfSlotFree` (dòng 3257):
```typescript
// Trước:
let slotIndex = acquireKeySlot(docId)
// Sau:
let slotIndex = await acquireKeySlotAsync(docId)
```

Sửa trong catch handler (dòng 3344):
```typescript
// Trước:
for (const docId of allDocIdsWithSlots) {
  releaseKeySlot(docId)
}
// Sau:
for (const docId of allDocIdsWithSlots) {
  releaseKeySlotAsync(docId).catch(() => releaseKeySlot(docId))
}
```

Sửa trong sync mode (dòng 3367):
```typescript
// Trước:
const slotIndex = acquireKeySlot(docId)
// Sau:
const slotIndex = await acquireKeySlotAsync(docId)
```

Và (dòng 3381):
```typescript
// Trước:
releaseKeySlot(docId)
// Sau:
await releaseKeySlotAsync(docId).catch(() => releaseKeySlot(docId))
```

**Giữ nguyên** `acquireKeySlot` (sync) để `autoRecoverStuckDocs` và các hàm nội bộ khác dùng — chúng chạy trong cùng một event loop tick, không cần mutex.

**Kiểm chứng**:
1. Gửi 5+ POST requests đồng thời (5 tài liệu cùng lúc) → không có slot nào vượt quá `MAX_DOCS_PER_SLOT = 5`
2. Kiểm tra log: `[KeyPool] Slot X acquired by doc ...` — mỗi slot phải có đúng số doc ≤ 5

---

### Fix #6: Track slot trong try/finally mọi cấp

**Vấn đề**: Slot rò rỉ khi `processWithAutoChain` ném lỗi ngoài `finally` block, hoặc khi auto-next doc được thêm vào `allDocIdsWithSlots` nhưng promise không được track đúng.

**File**: `src/app/api/ingestion/process/route.ts`

**Bước 6.1**: Thêm helper function `processDocWithSlotGuard` (thêm trước `bgPromise`, ~dòng 3245)

```typescript
/** Process a document with guaranteed slot cleanup.
 *  This wraps processWithAutoChain in a try/finally that ALWAYS releases the slot,
 *  even if processWithAutoChain's own finally block fails or is skipped. */
const processDocWithSlotGuard = async (docId: string, slotIndex: number): Promise<void> => {
  try {
    await processWithAutoChain(docId, slotIndex)
  } finally {
    // GUARANTEED slot release — even if processWithAutoChain's own finally failed
    // This is a safety net, not a replacement for processWithAutoChain's own releaseKeySlot
    try {
      const currentSlots = getKeySlotStatus()
      const slot = currentSlots.find(s => s.docIds.includes(docId))
      if (slot) {
        console.warn(`[Process] Slot guard: doc ${docId.slice(0, 8)}... still in slot ${slot.slotIndex} after processWithAutoChain — releasing`)
        releaseKeySlot(docId)
      }
    } catch (guardErr) {
      console.error('[Process] Slot guard error:', guardErr)
    }
  }
}
```

**Bước 6.2**: Cập nhật import để thêm `getKeySlotStatus`

```typescript
import { callLLM, callLLMSlot, acquireKeySlotAsync, releaseKeySlotAsync, acquireKeySlot, releaseKeySlot, flushTokenCount, MAX_SLOTS, MAX_DOCS_PER_SLOT, MAX_TOTAL_CONCURRENT, getFreeSlotCount, getActiveDocCount, getActiveDocIds, markDocPaused, clearDocPaused, isDocPaused, recoverSlots, persistSlotAssignments, getKeySlotStatus } from '@/lib/llm'
```

**Bước 6.3**: Thay `processWithAutoChain` bằng `processDocWithSlotGuard` trong `startDocIfSlotFree` (dòng 3265)

```typescript
// Trước:
const promise = processWithAutoChain(docId, slotIndex).then(async () => {
// Sau:
const promise = processDocWithSlotGuard(docId, slotIndex).then(async () => {
```

**Kiểm chứng**:
1. Xử lý tài liệu → kill server giữa chừng → restart → slot phải được giải phóng bởi guard
2. Kiểm tra log: nếu thấy `Slot guard: doc ... still in slot ... after processWithAutoChain — releasing` → guard đang hoạt động

---

### Fix #7: Processing Lock Flag cho autoRecoverStuckDocs

**Vấn đề**: `autoRecoverStuckDocs` (dòng 3559) có race condition TOCTOU — check slot active docs rồi release slot, nhưng giữa check và release, POST handler có thể đã acquire slot cho cùng doc.

**File**: `src/app/api/ingestion/process/route.ts`

**Bước 7.1**: Thêm processing lock set (thêm ở đầu POST handler, ngoài cùng, ~dòng 60)

```typescript
/** In-memory set of document IDs currently being processed.
 *  This is checked by autoRecoverStuckDocs to prevent it from releasing
 *  slots for docs that just started processing (TOCTOU race condition). */
const processingLockIds = new Set<string>()

/** Check if a document is currently locked for processing */
function isProcessingLocked(docId: string): boolean {
  return processingLockIds.has(docId)
}

/** Lock a document for processing */
function lockProcessing(docId: string): void {
  processingLockIds.add(docId)
}

/** Unlock a document after processing */
function unlockProcessing(docId: string): void {
  processingLockIds.delete(docId)
}
```

**Bước 7.2**: Thêm lock/unlock trong POST handler

Trong `startDocIfSlotFree` (sau khi acquire slot thành công):
```typescript
// Sau dòng: allDocIdsWithSlots.add(docId)
lockProcessing(docId)
```

Trong `.then()` callback của `processDocWithSlotGuard`:
```typescript
// Thêm vào đầu .then() callback:
unlockProcessing(docId)
```

Trong catch handler của `bgPromise`:
```typescript
// Thêm vào catch handler:
for (const docId of allDocIdsWithSlots) {
  unlockProcessing(docId)  // ← Thêm dòng này
  releaseKeySlotAsync(docId).catch(() => releaseKeySlot(docId))
}
```

**Bước 7.3**: Cập nhật `autoRecoverStuckDocs` — kiểm tra processing lock

Trong vòng lặp for của `autoRecoverStuckDocs` (dòng 3585), thêm check sau slot check:

```typescript
// Sau dòng: if (slotActiveDocIds.has(doc.id)) { continue }

// PROCESSING LOCK CHECK: Skip docs that just started processing.
// This prevents the TOCTOU race where recovery reads slot state,
// then a POST handler acquires a slot for the same doc.
if (isProcessingLocked(doc.id)) {
  console.log(`[Recovery] Skipping doc "${doc.payload.title}" — processing lock is active`)
  continue
}
```

**Kiểm chứng**:
1. Trigger auto-recovery (chờ 5+ phút hoặc dùng PUT force-recover) trong khi đang xử lý tài liệu → tài liệu đang xử lý KHÔNG bị recovery
2. Kiểm tra log: `Skipping doc ... — processing lock is active` phải xuất hiện cho tài liệu đang xử lý

---

## Giai đoạn 3 — Tối ưu hiệu năng

### Fix #9: Song song hóa provider fallback với Promise.any()

**Vấn đề**: `callLLMSlot()` (llm.ts:1939) thử provider tuần tự — worst case 540 giây cho 1 LLM call.

**File**: `src/lib/llm.ts`

**Bước 9.1**: Thêm hàm `callLLMSlotRacing` (thêm sau `callLLMSlot`, ~dòng 1959)

```typescript
/** Racing version of callLLMSlot — tries all providers in parallel using Promise.any().
 *  Returns the first successful result, cancelling the rest.
 *  Falls back to sequential mode if all racing attempts fail. */
export async function callLLMSlotRacing(
  slotIndex: number,
  prompt: string,
  systemPrompt?: string,
  task?: string,
  options?: LLMCallOptions
): Promise<LLMResult> {
  const taskLabel = task || 'general'

  if (slotIndex < 0 || slotIndex >= MAX_SLOTS) {
    return {
      content: '',
      provider: 'none',
      model: 'none',
      error: `Invalid slot index ${slotIndex}, must be 0-${MAX_SLOTS - 1}`,
    }
  }

  const temp = options?.temperature
  const maxTok = options?.maxTokens
  const aId = options?.agentId
  const aName = options?.agentName

  console.log(`[LLM-Racing] Slot ${slotIndex} Task: ${taskLabel}, Prompt: ${prompt.slice(0, 80)}...`)

  // Build provider try functions — same order as callLLMSlot
  type ProviderTryFn = () => Promise<LLMResult | null>
  const providerFns: ProviderTryFn[] = CEREBRAS_ENABLED
    ? [
        () => tryNvidiaSlot(slotIndex, prompt, systemPrompt, temp, maxTok, aId, aName),
        () => tryMistralSlot(slotIndex, prompt, systemPrompt, temp, maxTok, aId, aName),
        () => tryCerebrasSlot(slotIndex, prompt, systemPrompt, temp, maxTok, aId, aName),
        () => tryOpenRouterSlot(slotIndex, prompt, systemPrompt, temp, maxTok, aId, aName),
      ]
    : [
        () => tryNvidiaSlot(slotIndex, prompt, systemPrompt, temp, maxTok, aId, aName),
        () => tryMistralSlot(slotIndex, prompt, systemPrompt, temp, maxTok, aId, aName),
        () => tryOpenRouterSlot(slotIndex, prompt, systemPrompt, temp, maxTok, aId, aName),
      ]

  // Race all providers in parallel — first success wins
  // Each provider internally tries all its models sequentially.
  const racingPromises = providerFns.map(fn =>
    fn().then(result => {
      if (result?.content) return result
      // Return a "pending" sentinel so Promise.any doesn't resolve with null
      throw new Error('Provider returned no content')
    })
  )

  try {
    const winner = await Promise.any(racingPromises)
    const slot = keySlots[slotIndex]
    if (slot && winner.provider) {
      const providerIdx = PROVIDER_NAMES.indexOf(winner.provider.charAt(0).toUpperCase() + winner.provider.slice(1))
      if (providerIdx >= 0) slot.lastProviderUsed = providerIdx
    }
    return winner
  } catch {
    // All providers failed in parallel — fall back to sequential for detailed error reporting
    console.log(`[LLM-Racing] Slot ${slotIndex} all providers failed in parallel, falling back to sequential`)
    return callLLMSlot(slotIndex, prompt, systemPrompt, task, options)
  }
}
```

**Bước 9.2**: Export `callLLMSlotRacing` từ llm.ts

**Bước 9.3**: Sử dụng `callLLMSlotRacing` trong extraction pipeline

Trong `process/route.ts`, tìm nơi gọi `callLLMSlot` cho entity extraction và thay bằng `callLLMSlotRacing`.

**Lưu ý**: KHÔNG thay `callLLMSlot` bằng `callLLMSlotRacing` cho mọi call — chỉ dùng racing cho extraction (nơi tốc độ quan trọng nhất). Chat queries và classification vẫn dùng sequential để tiết kiệm API calls.

**Kiểm chứng**:
1. Khi NVIDIA timeout, Mistral hoặc OpenRouter phải trả kết quả trong ~5-10 giây thay vì 60+ giây
2. Kiểm tra log: `[LLM-Racing] Slot X all providers failed in parallel` chỉ xuất hiện khi TẤT CẢ providers thật sự thất bại

---

### Fix #10: Backpressure cho OpenRouter

**Vấn đề**: OpenRouter chỉ 200 req/ngày (4 keys × 50), tài liệu lớn có thể cạn kiệt trong 1.5 tài liệu.

**File**: `src/lib/llm.ts`

**Bước 10.1**: Thêm hàm `getOpenRouterDailyUsage` vào `ProviderKeyPool` class

```typescript
/** Get daily request count and limit for OpenRouter (for backpressure) */
getDailyUsageInfo(): { used: number; limit: number; ratio: number } | null {
  if (this._providerName !== 'OpenRouter') return null
  const today = getTodayDateStr()
  const used = this.keys.reduce((sum, k) => {
    return sum + (k.dailyRequestDate === today ? k.dailyRequestCount : 0)
  }, 0)
  const limit = this.keys.length * 50
  return { used, limit, ratio: used / limit }
}
```

**Bước 10.2**: Thêm helper function kiểm tra backpressure

```typescript
/** Check if OpenRouter is approaching daily limit — used by auto-next to stop queuing */
export function isOpenRouterNearLimit(threshold = 0.8): boolean {
  const usage = openRouterPool.getDailyUsageInfo()
  if (!usage) return false
  return usage.ratio >= threshold
}
```

**Bước 10.3**: Cập nhật auto-next logic trong `process/route.ts`

Trong `processWithAutoChain` `.then()` callback (dòng 3274), thêm check trước khi auto-next:

```typescript
// AUTO-NEXT: if enabled, find next eligible doc and add to queue.
if (autoNext) {
  // BACKPRESSURE: Stop auto-next if OpenRouter is near daily limit (>80%)
  // This prevents exhausting the last 20% of daily quota on auto-queued docs
  // when the user might need it for manually-triggered extractions.
  if (isOpenRouterNearLimit(0.8)) {
    const usage = openRouterPool.getDailyUsageInfo()
    console.warn(`[Process] Auto-next paused: OpenRouter daily usage at ${usage?.used}/${usage?.limit} (${Math.round((usage?.ratio ?? 0) * 100)}%) — reserving remaining quota`)
    // Don't add more docs to the queue, but let current ones finish
  } else {
    // ... existing auto-next logic ...
  }
}
```

**Kiểm chứng**:
1. Khi OpenRouter đạt 80% daily limit → auto-next phải dừng
2. Manual "Xử lý" vẫn hoạt động bình thường (không bị block)
3. Kiểm tra log: `Auto-next paused: OpenRouter daily usage at X/Y`

---

### Fix #11: Giới hạn entityNameToIdMap

**Vấn đề**: `entityNameToIdMap` (process/route.ts:1909) tăng không giới hạn, có thể gây OOM.

**File**: `src/app/api/ingestion/process/route.ts`

**Bước 11.1**: Tạo LRU Map class (thêm vào đầu file, ~dòng 70)

```typescript
/** Simple LRU Map with a maximum size limit.
 *  When the limit is reached, the oldest entries are evicted.
 *  Used for entityNameToIdMap to prevent unbounded memory growth. */
class LRUNode<K, V> {
  key: K
  value: V
  prev: LRUNode<K, V> | null = null
  next: LRUNode<K, V> | null = null
  constructor(key: K, value: V) { this.key = key; this.value = value }
}

class LRUMap<K, V> {
  private capacity: number
  private map = new Map<K, LRUNode<K, V>>()
  private head: LRUNode<K, V> | null = null  // Most recently used
  private tail: LRUNode<K, V> | null = null  // Least recently used

  constructor(capacity: number) { this.capacity = capacity }

  get size(): number { return this.map.size }

  get(key: K): V | undefined {
    const node = this.map.get(key)
    if (!node) return undefined
    this.moveToHead(node)
    return node.value
  }

  has(key: K): boolean { return this.map.has(key) }

  set(key: K, value: V): void {
    const existing = this.map.get(key)
    if (existing) {
      existing.value = value
      this.moveToHead(existing)
      return
    }
    const node = new LRUNode(key, value)
    this.map.set(key, node)
    this.addToHead(node)
    if (this.map.size > this.capacity) {
      const evicted = this.removeTail()
      if (evicted) this.map.delete(evicted.key)
    }
  }

  clear(): void {
    this.map.clear()
    this.head = null
    this.tail = null
  }

  private moveToHead(node: LRUNode<K, V>): void {
    if (node === this.head) return
    this.removeNode(node)
    this.addToHead(node)
  }

  private addToHead(node: LRUNode<K, V>): void {
    node.prev = null
    node.next = this.head
    if (this.head) this.head.prev = node
    this.head = node
    if (!this.tail) this.tail = node
  }

  private removeNode(node: LRUNode<K, V>): void {
    if (node.prev) node.prev.next = node.next
    else this.head = node.next
    if (node.next) node.next.prev = node.prev
    else this.tail = node.prev
    node.prev = null
    node.next = null
  }

  private removeTail(): LRUNode<K, V> | null {
    if (!this.tail) return null
    const node = this.tail
    this.removeNode(node)
    return node
  }
}
```

**Bước 11.2**: Thay `Map` bằng `LRUMap` trong `runIngestionPipeline`

Tìm khai báo `entityNameToIdMap` (khoảng dòng 1760):
```typescript
// Trước:
const entityNameToIdMap = new Map<string, string>()
// Sau:
const entityNameToIdMap = new LRUMap<string, string>(50_000)  // Max 50K entries ~5MB
```

**Bước 11.3**: Xóa map giữa các auto-chain batches

Trong `processWithAutoChain` (dòng 3160), thêm logic clear khi bắt đầu batch mới:
```typescript
while (batchNum <= maxBatches) {
  if (isDocPaused(docId)) return

  // NOTE: entityNameToIdMap được tạo mới mỗi lần gọi runIngestionPipeline,
  // nên tự động được clear giữa các batch. Không cần clear thủ công.
  try {
    const result = await runIngestionPipeline(docId, slotIndex) as Record<string, unknown>
    // ... existing logic ...
```

**Kiểm chứng**:
1. Xử lý tài liệu lớn (>100 chunks) → `entityNameToIdMap.size` không vượt quá 50,000
2. Memory usage ổn định hơn, không tăng liên tục

---

### Fix #12: Xử lý HTTP 200 content rỗng

**Vấn đề**: `tryProviderWithSlotKey` (llm.ts:1603) không log lỗi khi HTTP 200 nhưng content rỗng.

**File**: `src/lib/llm.ts`

**Bước 12.1**: Sửa đoạn xử lý response.ok (dòng 1603-1629)

```typescript
if (response.ok) {
  let data: { choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }
  try {
    data = await response.json() as typeof data
  } catch (jsonErr) {
    console.warn(`[LLM] Slot ${slotIndex} ${providerName} key#${slotIndex} model ${model} returned invalid JSON`)
    continue  // Try next model
  }
  const content = data.choices?.[0]?.message?.content
  const totalTokens = data.usage?.total_tokens ?? ((data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0))

  if (content) {
    // ... existing success handling (dòng 1611-1627) ...
    return { content, provider: providerName.toLowerCase(), model, tokensUsed: totalTokens }
  }

  // HTTP 200 but empty/missing content — treat as soft failure
  console.warn(`[LLM] Slot ${slotIndex} ${providerName} key#${slotIndex} model ${model} HTTP 200 but empty content (choices: ${JSON.stringify(data.choices?.length ?? 0)}, finish_reason: ${data.choices?.[0]?.['finish_reason'] ?? 'N/A'})`)
  // Count as a soft failure so the key doesn't get stuck in an infinite retry loop
  pool.markRateLimited(keyInfo.key, 10_000)  // 10s cooldown — less aggressive than hard failure
}
```

**Kiểm chứng**:
1. Khi provider trả về 200 rỗng → log phải hiện `HTTP 200 but empty content`
2. Key phải có 10s cooldown (không bị stuck vô hạn)

---

### Fix #13: Xóa duplicate fetchDocuments (đã tích hợp vào Fix #2)

**Đã xử lý** trong Giai đoạn 1 — bản `pollBatchUntilDone` mới đã thay `fetchDocuments()` bằng `fetchStats()`.

---

### Fix #14: Tách reconciliation thành interval-based

**Vấn đề**: Reconciliation chạy trên mỗi GET request → chậm với 300+ docs.

**File**: `src/app/api/ingestion/upload/route.ts`

**Bước 14.1**: Thêm interval-based reconciliation (thêm vào cuối file, trước GET handler)

```typescript
/** Periodic reconciliation — runs every 30 seconds instead of on every GET request.
 *  This dramatically reduces the load on Qdrant + SQLite when the client polls every 3s. */
let reconciliationInterval: ReturnType<typeof setInterval> | null = null
let isReconciling = false

function startPeriodicReconciliation(): void {
  if (reconciliationInterval) return  // Already started
  reconciliationInterval = setInterval(async () => {
    if (isReconciling) return  // Previous reconciliation still running
    isReconciling = true
    try {
      // Import the reconciliation logic from the GET handler
      // For now, we just invalidate the cache so the next GET request
      // will run reconciliation if needed
      invalidateReconciliationCache()
    } catch (err) {
      console.error('[Reconciliation-Interval] Error:', err)
    } finally {
      isReconciling = false
    }
  }, 30_000)  // Every 30 seconds

  // Don't prevent Node.js from exiting
  if (reconciliationInterval.unref) {
    reconciliationInterval.unref()
  }
}

// Start on module load
startPeriodicReconciliation()
```

**Bước 14.2**: Cập nhật GET handler — chỉ chạy reconciliation mỗi 30 giây thay vì mỗi request

Trong GET handler, sửa logic reconciliation (khoảng dòng 461):

```typescript
// Thay thế logic hiện tại bằng:
const forceReconcile = searchParams.get('reconcile') === 'true'
const isLite = searchParams.get('lite') === 'true'

if (isLite) {
  // Lite mode: skip reconciliation, return cached data as-is
  // ... existing lite mode logic ...
} else if (forceReconcile) {
  // Force reconcile: run full reconciliation now
  // ... existing reconciliation logic ...
} else {
  // Normal mode: use cached data, only re-reconcile if cache is stale (>30s old)
  if (reconciliationCache) {
    const age = Date.now() - reconciliationCache.timestamp
    if (age < 30_000) {
      // Cache is fresh (< 30s) — use it directly without re-reconciling
      const paginatedDocs = reconciliationCache.documents.slice(start, end)
      // ... return paginated cached data ...
    }
  }
  // Cache is stale (>30s) — run reconciliation as before
  // ... existing reconciliation logic ...
}
```

**Bước 14.3**: Cập nhật frontend polling — sử dụng `lite=true` cho auto-poll

Tìm auto-poll useEffect trong `page.tsx` (dòng ~13010) và sửa URL:

```typescript
// Trước:
fetchDocuments()
// Sau:
fetchDocuments(true)  // lite=true — skip reconciliation

// Cập nhật hàm fetchDocuments để chấp nhận tham số lite:
const fetchDocuments = useCallback(async (lite = false) => {
  const url = `/api/ingestion/upload?page=${docPageRef.current}&pageSize=${DOC_PAGE_SIZE}${lite ? '&lite=true' : ''}`
  // ... existing logic ...
}, [...])
```

**Kiểm chứng**:
1. Auto-poll (3s interval) gọi `?lite=true` → không chạy reconciliation
2. Manual refresh (F5 / click nút refresh) gọi không có `lite=true` → chạy reconciliation bình thường
3. Reconciliation chỉ chạy tối đa 1 lần mỗi 30 giây

---

## Giai đoạn 4 — Kiến trúc dài hạn

### Fix #8: Job Queue thay vì fire-and-forget

**Vấn đề**: `bgPromise` IIFE (process/route.ts:3247) chạy fire-and-forget — bị kill khi serverless timeout hoặc hot-reload.

**Kiến trúc đề xuất**:

```
┌──────────────────────────────────────────────────────────────┐
│                    KIẾN TRÚC JOB QUEUE                        │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Frontend                    Backend                         │
│  ─────────                   ─────────                       │
│  POST /process ──────────►  Enqueue job → SQLite             │
│  ← 202 Accepted {jobId}                                     │
│                                                              │
│  GET /process?jobId=X ──►  Query job status from SQLite     │
│  ← { status, progress, result }                             │
│                                                              │
│  [Worker Process] (separate from API)                        │
│  ─────────────────────                                       │
│  Poll SQLite every 5s → Pick pending job                     │
│  → runIngestionPipeline() → Update job status                │
│  → On completion: mark job done, notify via SSE/poll         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Bước 8.1**: Thêm Prisma schema cho Job Queue

```prisma
model IngestionJob {
  id          String   @id @default(cuid())
  documentId  String
  status      String   @default("pending")  // pending | running | completed | failed
  slotIndex   Int      @default(-1)
  batchNum    Int      @default(1)
  result      String?  // JSON string
  error       String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  startedAt   DateTime?
  completedAt DateTime?

  document    Document @relation(fields: [documentId], references: [id])

  @@index([status, createdAt])
  @@index([documentId])
}
```

**Bước 8.2**: Tạo worker script

```typescript
// mini-services/ingestion-worker/index.ts
// Independent bun process that polls SQLite for pending jobs and processes them

const POLL_INTERVAL = 5000 // 5 seconds

async function main() {
  while (true) {
    const job = await db.ingestionJob.findFirst({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
    })
    if (job) {
      await processJob(job)
    }
    await sleep(POLL_INTERVAL)
  }
}
```

**Bước 8.3**: Cập nhật API route — enqueue thay vì fire-and-forget

```typescript
// POST handler: thay bgPromise bằng job enqueue
const job = await db.ingestionJob.create({
  data: { documentId, status: 'pending' }
})
return NextResponse.json({ jobId: job.id, status: 'queued' })
```

**Bước 8.4**: Cập nhật GET handler — query job status

```typescript
if (action === 'progress' && documentId) {
  const job = await db.ingestionJob.findFirst({
    where: { documentId, status: { in: ['pending', 'running'] } },
    orderBy: { createdAt: 'desc' },
  })
  // ... return job status + document progress ...
}
```

**Lợi ích**:
- Worker process độc lập — không bị kill khi API server restart
- Job state persistent trong SQLite — recover được sau crash
- Có thể scale worker riêng biệt
- Frontend polling vẫn hoạt động bình thường

**Kiểm chứng**:
1. Restart API server giữa chừng → worker tiếp tục xử lý job
2. Kill worker → restart → worker tiếp tục từ job chưa hoàn thành
3. Frontend không thấy "Failed to fetch" — API server luôn response

---

### Fix #15: Error cooldown & retry counter

**Vấn đề**: Vòng lặp vô hạn error → recovery → error khi API keys exhausted.

**File**: `src/app/api/ingestion/process/route.ts`

**Bước 15.1**: Thêm error tracking vào Qdrant document payload

Trong hàm `updateDocProgress` và `updateDocumentStatus`, thêm field `error_count` và `last_error_at`:

```typescript
// Khi đánh dấu doc là 'error':
await updateDocumentStatus(docId, {
  status: 'error',
  error_message: errMsg,
  // Thêm tracking fields:
  error_count: (docPayload.error_count || 0) + 1,
  last_error_at: new Date().toISOString(),
})
```

**Bước 15.2**: Thêm cooldown check trong autoRecoverStuckDocs

```typescript
// Trong vòng lặp for của autoRecoverStuckDocs:
const errorCount = (doc.payload as any).error_count || 0
const lastErrorAt = (doc.payload as any).last_error_at

// COOLDOWN: Không recovery doc vừa lỗi trong 10 phút
if (lastErrorAt) {
  const timeSinceError = Date.now() - new Date(lastErrorAt).getTime()
  if (timeSinceError < 10 * 60 * 1000) {  // 10 phút
    console.log(`[Recovery] Skipping doc "${doc.payload.title}" — error cooldown (${Math.round(timeSinceError / 1000)}s ago, need 600s)`)
    continue
  }
}

// MAX RETRY: Không auto-recovery doc đã lỗi 3+ lần
if (errorCount >= 3) {
  console.log(`[Recovery] Skipping doc "${doc.payload.title}" — exceeded max auto-retry (${errorCount} errors, needs manual trigger)`)
  continue
}
```

**Bước 15.3**: Kiểm tra available keys trước khi recovery

```typescript
// Thêm vào đầu autoRecoverStuckDocs:
import { hasAnyAvailableKey } from '@/lib/llm'

// Nếu không có key nào available → không recovery (sẽ lỗi lại ngay)
if (!hasAnyAvailableKey()) {
  console.log('[Recovery] No LLM keys available — skipping recovery to avoid error loop')
  return { recovered: 0, smartRecovered: 0 }
}
```

Thêm hàm `hasAnyAvailableKey` vào `llm.ts`:
```typescript
/** Check if any provider has at least one available key */
export function hasAnyAvailableKey(): boolean {
  return nvidiaPool.hasAvailableKey() || mistralPool.hasAvailableKey() || openRouterPool.hasAvailableKey()
}
```

**Kiểm chứng**:
1. Doc lỗi 3 lần → autoRecoverStuckDocs bỏ qua → cần manual "Xử lý"
2. Doc vừa lỗi <10 phút → không recovery → đợi cooldown
3. Không có key available → không recovery → log `No LLM keys available`

---

## Ma trận kiểm thử

| Test case | Giai đoạn | Mô tả | Kết quả mong đợi |
|-----------|-----------|-------|------------------|
| TC-01 | GĐ1 | Tải PDF có hyperlink → terminal | Không còn cảnh báo pdf2json |
| TC-02 | GĐ1 | Tắt server giữa poll | Try-catch bắt lỗi, 10 lần retry rồi return 'error' |
| TC-03 | GĐ1 | Server chết → restart → poll tiếp | Polling tự phục hồi, consecutiveFetchFailures reset |
| TC-04 | GĐ1 | POST request thất bại mạng | Retry 3 lần, show error toast |
| TC-05 | GĐ2 | 5+ POST đồng thời | Không có slot vượt MAX_DOCS_PER_SLOT |
| TC-06 | GĐ2 | processWithAutoChain crash | Slot guard release slot |
| TC-07 | GĐ2 | Recovery chạy khi doc đang xử lý | Processing lock ngăn recovery |
| TC-08 | GĐ3 | NVIDIA timeout + Mistral OK | Promise.any trả kết quả Mistral trong ~10s |
| TC-09 | GĐ3 | OpenRouter 80% daily | Auto-next dừng, manual vẫn hoạt động |
| TC-10 | GĐ3 | 445 chunks doc | entityNameToIdMap.size ≤ 50,000 |
| TC-11 | GĐ3 | Provider trả 200 rỗng | Log warning, key 10s cooldown |
| TC-12 | GĐ3 | Auto-poll 3s | Gọi ?lite=true, không chạy reconciliation |
| TC-13 | GĐ4 | Restart API server | Worker tiếp tục job, không mất data |
| TC-14 | GĐ4 | Doc lỗi 3 lần | Không auto-recovery, cần manual trigger |
| TC-15 | GĐ4 | Không có key available | Không recovery, log warning |

---

## Rủi ro & Rollback

### Rủi ro theo giai đoạn

| Giai đoạn | Rủi ro | Xác suất | Tác động | Mitigation |
|-----------|--------|----------|----------|------------|
| GĐ1 | `PDF2JSON_DISABLE_LOGS` không hoạt động trên một số môi trường | Thấp | Thấp | Giữ `suppressPdf2jsonWarnings()` làm backup |
| GĐ1 | Exponential backoff làm poll chậm hơn khi server thực sự bận | Trung bình | Thấp | Max backoff 30s, reset ngay khi fetch thành công |
| GĐ2 | AsyncMutex gây deadlock nếu `release()` không được gọi | Thấp | Cao | Mọi acquire đều có try/finally, thêm timeout cho mutex |
| GĐ2 | Processing lock không được unlock nếu process crash | Trung bình | Trung bình | Lock là in-memory → tự clear khi process restart |
| GĐ3 | `Promise.any()` tăng số LLM API calls (gọi tất cả providers) | Cao | Trung bình | Chỉ dùng cho extraction, không dùng cho chat/classification |
| GĐ3 | LRU Map evict entry đang cần dùng | Trung bình | Thấp | Capacity 50K đủ lớn cho hầu hết tài liệu |
| GĐ4 | Worker process cần quản lý thêm | Cao | Cao | Dùng Bun's built-in process manager, có health check |

### Chiến lược Rollback

Mỗi giai đoạn được triển khai độc lập. Nếu phát hiện vấn đề:

1. **GĐ1**: Revert `pollBatchUntilDone` về bản cũ → chỉ mất retry/backoff
2. **GĐ2**: Dùng lại `acquireKeySlot` (sync) → chỉ mất mutex protection
3. **GĐ3**: Dùng lại `callLLMSlot` → chỉ mất parallel racing
4. **GĐ4**: Quay lại fire-and-forget → chỉ mất job persistence

Tất cả các fix đều **additive** — không xóa code cũ, chỉ thêm code mới và thay thế reference. Code cũ được giữ lại làm fallback.

---

## Phụ lục: Danh sách file cần sửa

| File | Giai đoạn | Sửa chữa |
|------|-----------|----------|
| `src/app/api/ingestion/process/route.ts` | GĐ1,2,3,4 | #1 pdf2json, #6 slot guard, #7 processing lock, #11 LRU map, #14 reconciliation, #15 error cooldown |
| `src/app/page.tsx` | GĐ1,3 | #2 pollBatchUntilDone, #7 retry/backoff, #13 dedup fetchDocuments |
| `src/lib/llm.ts` | GĐ2,3 | #5 AsyncMutex, #9 Promise.any(), #10 backpressure, #12 soft failure |
| `src/app/api/ingestion/upload/route.ts` | GĐ3 | #14 reconciliation interval, lite mode |
| `prisma/schema.prisma` | GĐ4 | #8 IngestionJob model |
| `mini-services/ingestion-worker/` (MỚI) | GĐ4 | #8 Worker process |
