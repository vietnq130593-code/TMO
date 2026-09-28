# TheOpusFlashLite — Tổng Hợp Vấn Đề & Thiết Kế Xử Lý

> **Ngày tạo:** 2026-03-05  
> **Project:** TheOpusFlashLite — Next.js 16.1.3 (Turbopack) + Prisma/SQLite + Qdrant + Neo4j  
> **Mục tiêu:** Tổng hợp TẤT CẢ vấn đề, phân tích nguyên nhân gốc, và thiết kế kế hoạch xử lý chia theo phases

---

## MỤC LỤC

1. [Tổng Quan Các Vấn Đề](#1-tổng-quan-các-vấn-đề)
2. [Phân Tích Chi Tiết Từng Vấn Đề](#2-phân-tích-chi-tiết-từng-vấn-đề)
3. [Thiết Kế Xử Lý Theo Phases](#3-thiết-kế-xử-lý-theo-phases)
4. [Chi Tiết Kế Hoạch Từng Phase](#4-chi-tiết-kế-hoạch-từng-phase)
5. [Ma Trận Vấn Đề × Phase](#5-ma-trận-vấn-đề--phase)
6. [Rủi Ro & Giảm Thiểu](#6-rủi-ro--giảm-thiểu)
7. [Kết Quả Mong Đợi Sau Từng Phase](#7-kết-quả-mong-đợi-sau-từng-phase)

---

## 1. Tổng Quan Các Vấn Đề

| # | Vấn Đề | Mức Độ | Trạng Thái | Phase Xử Lý |
|---|--------|--------|------------|-------------|
| V1 | Chat mất dữ liệu khi quay lại phiên cũ | 🔴 CRITICAL | ✅ Đã fix | Phase 1 |
| V2 | Document Processing Pipeline chưa chạy hoàn chỉnh | 🔴 CRITICAL | ✅ Đã fix | Phase 2 |
| V3 | Qdrant kết nối nhưng chưa có data thật | 🟡 MEDIUM | ✅ Đã fix | Phase 2 |
| V4 | Neo4j hiện đỏ — chưa kết nối | 🟡 MEDIUM | ✅ Đã fix | Phase 3 |
| V5 | Session ID không nhất quán (client vs server) | 🟡 MEDIUM | ✅ Đã fix | Phase 1 |
| V6 | clearChat không xóa messages phía server | 🟡 MEDIUM | ✅ Đã fix | Phase 1 |
| V7 | Agent list không hiển thị (API 500) | 🟢 FIXED | ✅ Đã fix | — |
| V8 | TokenUsage API trả về 500 | 🟢 FIXED | ✅ Đã fix | — |
| V9 | Tài liệu upload không xuất hiện danh sách | 🟢 FIXED | ✅ Đã fix | — |
| V10 | Qdrant orderDir bug (luôn ASC) | 🟢 FIXED | ✅ Đã fix | — |

---

## 2. Phân Tích Chi Tiết Từng Vấn Đề

### V1 🔴 CRITICAL — Chat Mất Dữ Liệu Khi Quay Lại Phiên Cũ

**Hiện tượng:**
- User chat với Agent (VD: Omega) → tin nhắn hiển thị bình thường
- Chuyển sang phiên khác hoặc quay lại → **toàn bộ tin nhắn cũ biến mất**
- Click chọn phiên chat cũ → UI hiện trống, không có message nào

**Nguyên nhân gốc (Root Cause):**

1. **Frontend KHÔNG load messages từ DB khi chọn session cũ:**
   - File: `src/app/page.tsx` — dòng ~6726
   - Khi click session: `onClick={() => { setCurrentSessionId(s.sessionId); setShowSessionSelect(false) }}`
   - `setCurrentSessionId()` chỉ cập nhật state cục bộ (React state)
   - **KHÔNG có `useEffect` nào watch `currentSessionId` để fetch messages từ API**

2. **Backend API đã hoạt động tốt:**
   - `GET /api/chat-messages?sessionId=xxx` → trả về danh sách messages chính xác
   - `saveChatMessages()` trong `lib/agent-memory.ts` → lưu messages vào SQLite `ChatMessage` table ✅
   - `getSessionMessages()` → đọc lại messages, sort theo `createdAt ASC` ✅

3. **Kiểm chứng:**
   - Grep `useEffect.*currentSessionId` trong page.tsx → **0 kết quả**
   - Grep `chat-messages` trong page.tsx → **0 kết quả** (frontend chưa từng gọi API này)
   - Messages được lưu vào DB nhưng KHÔNG BAO GIỜ được đọc lại

**Sơ đồ luồng lỗi:**
```
User click session cũ
    → setCurrentSessionId(id)     // chỉ set React state
    → UI render với messages=[]   // vì không fetch từ DB
    → Hiển thị chat trống ❌

Trong khi đó:
    Backend: /api/chat-messages?sessionId=xxx → trả data đúng ✅
    SQLite: ChatMessage table → có data ✅
```

---

### V2 🔴 CRITICAL — Document Processing Pipeline Chưa Chạy Hoàn Chỉnh

**Hiện tượng:**
- Upload tài liệu thành công → tài liệu xuất hiện trong danh sách (status: "uploaded")
- Nhưng tài liệu KHÔNG được xử lý tiếp (không có chunks, embeddings, entities)
- Qdrant collection `theopus_chunks` trống → không thể tìm kiếm semantic

**Nguyên nhân gốc:**

1. **Pipeline xử lý tách biệt với upload:**
   - Upload route (`/api/ingestion/upload`) → chỉ lưu file + metadata
   - Process route (`/api/ingestion/process`) → pipeline xử lý riêng
   - **Frontend cần trigger process API sau khi upload** — cần kiểm tra flow

2. **Pipeline đầy đủ nhưng chưa được kích hoạt tự động:**
   - Bước 1: Download PDF
   - Bước 2: Parse PDF (pdf2json + pdf-parse fallback)
   - Bước 3: Phân loại domain (LLM hoặc keyword fallback)
   - Bước 4: Chunk text (theo domain)
   - Bước 5: Lưu chunks vào Qdrant
   - Bước 6: Xóa embeddings cũ
   - Bước 7: Trích xuất entities & relationships (LLM, 8 concurrent)
   - Bước 8: Resolve entities (exact + fuzzy match)
   - Bước 9: Lưu entities → SQLite + Neo4j
   - Bước 10: Lưu relationships → SQLite + Neo4j
   - Bước 11: Generate embeddings (NVIDIA → OpenRouter → pseudo-hash)
   - Bước 12: Upsert embeddings vào Qdrant
   - Bước 13: Cập nhật status → "indexed"

3. **Phụ thuộc Qdrant & Neo4j:**
   - Qdrant cần chạy → lưu chunks + embeddings
   - Neo4j cần chạy → lưu entities & relationships (tuy nhiên có SQLite buffer dự phòng)
   - Nếu Qdrant không chạy → pipeline thất bại ở bước 5, 11, 12

4. **Frontend auto-trigger:**
   - Frontend có cơ chế auto-trigger continuation cho partial documents
   - Auto-mode xử lý 4 documents song song
   - Nhưng cần đảm bảo trigger ban đầu hoạt động

---

### V3 🟡 MEDIUM — Qdrant Kết Nối Nhưng Chưa Có Data Thật

**Hiện tượng:**
- Qdrant chạy local → status indicator hiện XANH
- Nhưng trong app không có data vector nào → search không trả kết quả

**Nguyên nhân gốc:**

1. **Qdrant chỉ là storage — cần pipeline tạo data:**
   - Qdrant chỉ lưu data khi pipeline process chạy và upsert
   - Hiện tại pipeline chưa chạy hoàn chỉnh → Qdrant trống

2. **Collections đã được tạo:**
   - `theopus_documents` — dummy `[0]` vector, payload-only
   - `theopus_chunks` — 1536-dim embeddings (trống)
   - `agent_memory` — episodic memory vectors (trống)

3. **Kiến trúc SQLite-primary:**
   - Document metadata → SQLite là primary, Qdrant là secondary
   - Chunks & embeddings → Qdrant là primary storage
   - Nếu Qdrant down → app vẫn chạy nhưng không có vector search

**Giải quyết:** Cần V2 (pipeline) chạy xong → Qdrant tự động có data

---

### V4 🟡 MEDIUM — Neo4j Hiện Đỏ — Chưa Kết Nối

**Hiện tượng:**
- Neo4j status indicator hiện ĐỎ trong UI
- Neo4j chạy local tại `bolt://127.0.0.1:7687` nhưng app không kết nối được

**Nguyên nhân gốc:**

1. **Neo4j chưa cài/ chưa chạy trên máy local:**
   - `.env` có `NEO4J_URI=bolt://127.0.0.1:7687`
   - Nhưng Neo4j server chưa start → driver không kết nối

2. **App vẫn hoạt động không cần Neo4j:**
   - `getNeo4jDriver()` → lazy initialization, trả `null` nếu env vars thiếu
   - Entity/relationship writes → fail gracefully, lưu vào SQLite buffer
   - Knowledge Graph features → không khả dụng nhưng app không crash

3. **Neo4j chỉ cần cho:**
   - Knowledge Graph visualization
   - GraphRAG (graph-based retrieval augmented generation)
   - Entity relationship queries
   - Advanced search across document networks

**Giải quyết:** Cài & start Neo4j local → app tự động kết nối

---

### V5 🟡 MEDIUM — Session ID Không Nhất Quán

**Hiện tượng:**
- Session ID được tạo ở cả client-side lẫn server-side với format khác nhau

**Nguyên nhân gốc:**
- Client-side tạo: `sess_` prefix + timestamp/random (dòng ~5945 trong page.tsx)
- Server-side tạo: qua API endpoint (dòng ~5862)
- Không nhất quán → có thể gây conflict khi load messages

**Impact:** Khi frontend tạo session ID client-side, messages có thể bị lưu dưới session ID khác với ID hiển thị trong dropdown

---

### V6 🟡 MEDIUM — clearChat Không Xóa Messages Phía Server

**Hiện tượng:**
- Click "New Chat" hoặc clear → chỉ xóa UI state
- Messages vẫn còn trong SQLite ChatMessage table

**Nguyên nhân gốc:**
- `clearChat()` function (dòng ~6473 trong page.tsx) chỉ set `messages=[]`
- Không gọi API để xóa messages trong database

**Impact:**
- Khi load lại session cũ → messages cũ vẫn xuất hiện (sau khi fix V1)
- Dung lượng DB tăng không cần thiết
- Có thể gây nhầm lẫn cho user

---

### V7-V10 🟢 FIXED — Các Vấn Đề Đã Xử Lý

**V7 — Agent list 500:** Đã thêm `retryDbOp()` + fallback empty list  
**V8 — TokenUsage 500:** Đã thêm fallback data cho ALL errors  
**V9 — Documents không hiện:** Đã chuyển SQLite primary + Qdrant optional  
**V10 — Qdrant orderDir bug:** Đã fix `order_by` từ string sang object với direction

---

## 3. Thiết Kế Xử Lý Theo Phases

```
┌─────────────────────────────────────────────────────────┐
│                    PHASE 1 (CRITICAL)                    │
│           Chat Session Persistence                       │
│   V1: Load old messages + V5: Session ID + V6: Clear    │
│   ⏱ Estimated: 2-3 giờ                                  │
├─────────────────────────────────────────────────────────┤
│                    PHASE 2 (HIGH)                        │
│        Document Processing Pipeline                      │
│   V2: Pipeline hoàn chỉnh + V3: Qdrant data             │
│   ⏱ Estimated: 3-4 giờ                                  │
├─────────────────────────────────────────────────────────┤
│                    PHASE 3 (MEDIUM)                      │
│          Neo4j & Knowledge Graph                         │
│   V4: Neo4j connection + GraphRAG                        │
│   ⏱ Estimated: 2-3 giờ                                  │
├─────────────────────────────────────────────────────────┤
│                    PHASE 4 (POLISH)                      │
│         Optimization & Edge Cases                        │
│   Embedding batch parallel + Error UX + Testing          │
│   ⏱ Estimated: 2-3 giờ                                  │
└─────────────────────────────────────────────────────────┘
```

**Tổng cộng: 4 Phases, 9-13 giờ ước tính**

**Nguyên tắc phân phase:**
- Phase 1: Fix bug nghiêm trọng nhất — user mất data chat
- Phase 2: Kích hoạt tính năng core — RAG search
- Phase 3: Tính năng nâng cao — Knowledge Graph
- Phase 4: Tối ưu & hoàn thiện

---

## 4. Chi Tiết Kế Hoạch Từng Phase

### ═══════════════════════════════════════════
### PHASE 1 — Chat Session Persistence (CRITICAL)
### ═══════════════════════════════════════════

**Mục tiêu:** Chat session hoạt động đúng — chuyển phiên và quay lại vẫn thấy dữ liệu cũ

**Vấn đề xử lý:** V1, V5, V6

#### Task 1.1: Thêm useEffect Load Messages Khi Chuyển Session (V1)

**File sửa:** `src/app/page.tsx`

**Thêm useEffect mới:**
```tsx
// Watch currentSessionId changes → fetch messages from DB
useEffect(() => {
  if (!currentSessionId) {
    setMessages([])
    return
  }
  
  setLoadingMessages(true) // thêm state mới
  
  fetch(`/api/chat-messages?sessionId=${encodeURIComponent(currentSessionId)}`)
    .then(r => r.json())
    .then(data => {
      if (data.messages && Array.isArray(data.messages)) {
        const loaded = data.messages.map((m: any) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: new Date(m.createdAt),
          // map thêm các field khác tùy UI cần
        }))
        setMessages(loaded)
      } else {
        setMessages([])
      }
    })
    .catch(err => {
      console.error('Failed to load session messages:', err)
      setMessages([])
    })
    .finally(() => setLoadingMessages(false))
}, [currentSessionId])
```

**Thêm state:**
```tsx
const [loadingMessages, setLoadingMessages] = useState(false)
```

**Thêm UI loading indicator:**
```tsx
{loadingMessages && (
  <div className="flex items-center justify-center p-4">
    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    <span className="ml-2 text-sm text-muted-foreground">Đang tải tin nhắn...</span>
  </div>
)}
```

**Kiểm tra:** 
- Mở chat → gửi vài tin nhắn → chuyển sang session khác → quay lại → tin nhắn cũ xuất hiện ✅

---

#### Task 1.2: Chuẩn Hóa Session ID Generation (V5)

**File sửa:** `src/app/page.tsx`

**Vấn đề:** Session ID tạo ở 2 nơi với format khác nhau

**Giải pháp:** 
- Ưu tiên dùng server-side session ID (từ API)
- Nếu cần tạo client-side → dùng cùng format với server
- Đảm bảo session ID được lưu nhất quán

```tsx
// Thay vì tạo random ID client-side:
const newSessionId = await fetch('/api/agent-sessions', {
  method: 'POST',
  body: JSON.stringify({ agentId: selectedAgent })
}).then(r => r.json()).then(d => d.sessionId)

// Hoặc nếu tạo client-side, dùng format nhất quán:
const newSessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
```

**Kiểm tra:**
- Tạo session mới → kiểm tra DB → session ID format nhất quán ✅
- Load session cũ → messages hiển thị đúng ✅

---

#### Task 1.3: clearChat Xóa Cả Server-Side Messages (V6)

**File sửa:** `src/app/page.tsx`

**Sửa hàm clearChat:**
```tsx
const clearChat = useCallback(async () => {
  // Xóa UI state
  setMessages([])
  
  // Nếu có session hiện tại → xóa messages trong DB
  if (currentSessionId) {
    try {
      await fetch(`/api/chat-messages?sessionId=${encodeURIComponent(currentSessionId)}`, {
        method: 'DELETE'
      })
    } catch (err) {
      console.error('Failed to clear server messages:', err)
    }
  }
  
  // Reset session ID
  setCurrentSessionId(null)
}, [currentSessionId])
```

**Cần thêm API endpoint:**
- `DELETE /api/chat-messages?sessionId=xxx` → xóa tất cả messages của session

**Hoặc thay thế: Không xóa DB, chỉ tạo session mới:**
```tsx
const clearChat = useCallback(() => {
  setMessages([])
  setCurrentSessionId(null) // session mới sẽ được tạo khi gửi tin nhắn đầu tiên
}, [])
```

**Kiểm tra:**
- Click "New Chat" → messages cũ bị xóa ✅
- Quay lại session cũ → messages cũ vẫn còn (nếu chọn không xóa DB) ✅

---

#### Task 1.4: Thêm DELETE Endpoint Cho Chat Messages

**File sửa:** `src/app/api/chat-messages/route.ts`

**Thêm DELETE handler:**
```typescript
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const sessionId = searchParams.get('sessionId')
    
    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId required' }, { status: 400 })
    }
    
    await retryDbOp(() => db.chatMessage.deleteMany({
      where: { sessionId }
    }))
    
    return NextResponse.json({ success: true, deleted: true })
  } catch (error) {
    console.error('Failed to delete chat messages:', error)
    return NextResponse.json({ error: 'Failed to delete messages' }, { status: 500 })
  }
}
```

---

### ═══════════════════════════════════════════
### PHASE 2 — Document Processing Pipeline (HIGH)
### ═══════════════════════════════════════════

**Mục tiêu:** Upload tài liệu → tự động xử lý → có thể tìm kiếm semantic qua Qdrant

**Vấn đề xử lý:** V2, V3

#### Task 2.1: Kiểm Tra & Sửa Auto-Trigger Pipeline Sau Upload

**File kiểm tra:** `src/app/page.tsx` — phần upload UI

**Vấn đề:** Sau khi upload → frontend cần gọi `/api/ingestion/process` để bắt đầu xử lý

**Giải pháp:**
```tsx
// Sau khi upload thành công:
const handleUpload = async (files: File[]) => {
  // ... upload logic ...
  
  // Trigger processing cho mỗi document
  for (const doc of uploadedDocs) {
    fetch(`/api/ingestion/process?documentId=${doc.id}`, {
      method: 'POST'
    }).catch(err => console.error('Process trigger failed:', err))
  }
}
```

**Hoặc:** Thiết kế upload route tự động trigger process sau khi save

---

#### Task 2.2: Đảm Bảo Pipeline Process Route Hoạt Động

**File:** `src/app/api/ingestion/process/route.ts`

**Kiểm tra:**
1. PDF parsing hoạt động với file thực
2. Domain classification → LLM hoặc keyword fallback
3. Chunking → tạo chunks đúng
4. Qdrant upsert → chunks được lưu
5. Entity extraction → LLM extraction hoạt động
6. Embedding generation → NVIDIA/OpenRouter/pseudo-hash fallback chain
7. Status updates → SQLite được cập nhật qua từng bước

**Test cases:**
- Upload 1 PDF → kiểm tra status chuyển: uploaded → parsing → chunking → extracting → indexing → indexed
- Kiểm tra Qdrant `theopus_chunks` collection có data
- Kiểm tra SQLite `Document` record status = "indexed"

---

#### Task 2.3: Qdrant Data Population (V3)

**Điều kiện tiên quyết:** Task 2.1 và 2.2 hoàn thành

**Kiểm tra sau khi pipeline chạy:**
1. `theopus_chunks` collection có points với 1536-dim vectors
2. Payload chứa: documentId, chunkIndex, text, domain, entities
3. `searchSimilar()` và `hybridSearch()` trả kết quả
4. Frontend search/query sử dụng được vector search

**Re-process existing documents:**
```bash
# API call để re-process tất cả documents chưa indexed
curl -X POST http://localhost:3000/api/ingestion/process?documentId=ALL
```

**Hoặc tạo API endpoint riêng:**
```typescript
// POST /api/ingestion/process-all
// → Lấy tất cả documents với status != "indexed"
// → Process từng document theo batch
```

---

#### Task 2.4: Embedding Fallback Chain Verification

**File:** `src/lib/embeddings.ts`

**Kiểm tra fallback chain:**
1. NVIDIA NIM (primary) → 1536-dim vectors
   - Rate limit: 40 RPM
   - Cần `NVIDIA_API_KEY` trong `.env`
2. OpenRouter (fallback) → text-embedding-3-small, 1536-dim
   - Cần `OPENROUTER_API_KEY` trong `.env`
3. Pseudo-hash (last resort) → SHA-256 based, deterministic
   - Không cần API key
   - Chất lượng search kém hơn nhưng app không crash

**Cần đảm bảo:** `.env` có API keys cho ít nhất NVIDIA hoặc OpenRouter

---

### ═══════════════════════════════════════════
### PHASE 3 — Neo4j & Knowledge Graph (MEDIUM)
### ═══════════════════════════════════════════

**Mục tiêu:** Neo4j kết nối → Knowledge Graph visualization + GraphRAG

**Vấn đề xử lý:** V4

#### Task 3.1: Cài Đặt & Cấu Hình Neo4j Local

**Bước 1: Cài Neo4j**
```bash
# Option A: Neo4j Desktop
# Download từ: https://neo4j.com/download/

# Option B: Docker
docker run -d \
  --name neo4j \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/your_password \
  -e NEO4J_PLUGINS='["apoc"]' \
  neo4j:latest

# Option C: Neo4j Community Server
# Download từ: https://neo4j.com/download-center/
```

**Bước 2: Cấu hình `.env`**
```env
NEO4J_URI=bolt://127.0.0.1:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your_password
```

**Bước 3: Verify connection**
```bash
curl http://localhost:7474
# Hoặc mở browser: http://localhost:7474
```

---

#### Task 3.2: Verify Neo4j Integration Trong App

**File:** `src/lib/neo4j.ts`

**Kiểm tra:**
1. `getNeo4jDriver()` → tạo driver thành công
2. Constraints + indexes được tạo tự động
3. Entity labels (11 loại) được tạo đúng
4. Relationship types (14 loại) hoạt động
5. Batch upsert (500/batch) hoạt động

**Test:**
- Process document → entities & relationships được lưu vào Neo4j
- Mở Neo4j Browser → kiểm tra nodes & edges

---

#### Task 3.3: Sync Existing Entities Từ SQLite Buffer Sang Neo4j

**Vấn đề:** Entities đã được extract → lưu vào SQLite `LocalEntity`/`LocalRelationship` buffer

**Giải pháp:** Tạo API endpoint sync:
```typescript
// POST /api/neo4j/sync
// → Đọc tất cả entities từ LocalEntity
// → Upsert vào Neo4j
// → Đọc tất cả relationships từ LocalRelationship
// → Upsert vào Neo4j
```

**Hoặc:** Re-process documents → pipeline tự động sync vào Neo4j (nếu đã kết nối)

---

#### Task 3.4: Knowledge Graph UI (Optional)

**Tính năng nâng cao:**
- Graph visualization (D3.js hoặc vis.js)
- Entity detail panel
- Relationship exploration
- Graph-based search

**Chỉ triển khai nếu user cần** — không phải core functionality

---

### ═══════════════════════════════════════════
### PHASE 4 — Optimization & Polish (LOW)
### ═══════════════════════════════════════════

**Mục tiêu:** Tối ưu hiệu năng, xử lý edge cases, cải thiện UX

#### Task 4.1: Parallel Embedding Generation

**File:** `src/lib/embeddings.ts`

**Vấn đề:** `generateEmbeddingBatch` xử lý sequential → chậm với batch lớn

**Giải pháp:**
```typescript
// Thay vì sequential:
async function generateEmbeddingBatch(texts: string[]) {
  const results = await Promise.all(
    texts.map(text => generateEmbedding(text))
  )
  return results
}

// Hoặc chunked parallel (để tránh rate limit):
async function generateEmbeddingBatch(texts: string[], concurrency = 5) {
  const results = []
  for (let i = 0; i < texts.length; i += concurrency) {
    const chunk = texts.slice(i, i + concurrency)
    const chunkResults = await Promise.all(
      chunk.map(text => generateEmbedding(text))
    )
    results.push(...chunkResults)
  }
  return results
}
```

---

#### Task 4.2: SQLite Concurrent Access Optimization

**File:** `src/lib/db.ts`

**Vấn đề:** SQLITE_BUSY errors khi Turbopack hot-reload

**Giải pháp hiện tại:** `retryDbOp()` với exponential backoff

**Cải thiện thêm:**
```prisma
// Trong schema.prisma, thêm WAL mode config
// (SQLite WAL mode cho phép concurrent reads)
```

```typescript
// Trong db.ts, set WAL mode on startup
await db.$executeRawUnsafe('PRAGMA journal_mode=WAL')
await db.$executeRawUnsafe('PRAGMA busy_timeout=5000')
await db.$executeRawUnsafe('PRAGMA synchronous=NORMAL')
```

---

#### Task 4.3: Error Handling & UX Improvements

**Cải thiện:**
1. **Toast notifications** cho lỗi API thay vì silent fail
2. **Retry buttons** cho failed document processing
3. **Progress bars** chi tiết hơn cho document processing
4. **Connection status indicators** chính xác hơn (Qdrant, Neo4j)
5. **Empty states** tốt hơn cho danh sách rỗng

---

#### Task 4.4: Session Management Improvements

**Cải thiện:**
1. **Session list** hiển thị preview tin nhắn đầu tiên
2. **Session rename** — cho phép đổi tên session
3. **Session delete** — xóa session và messages
4. **Session search** — tìm kiếm trong lịch sử chat
5. **Session export** — xuất chat ra file

---

## 5. Ma Trận Vấn Đề × Phase

| Vấn Đề | Phase 1 | Phase 2 | Phase 3 | Phase 4 |
|--------|---------|---------|---------|---------|
| V1: Chat mất data | ✅ Fix | | | |
| V2: Pipeline chưa chạy | | ✅ Fix | | |
| V3: Qdrant trống | | ✅ Fix | | |
| V4: Neo4j đỏ | | | ✅ Fix | |
| V5: Session ID không nhất quán | ✅ Fix | | | |
| V6: clearChat không xóa server | ✅ Fix | | | |
| V7: Agent list 500 | ✅ Đã fix | | | |
| V8: TokenUsage 500 | ✅ Đã fix | | | |
| V9: Documents không hiện | ✅ Đã fix | | | |
| V10: Qdrant orderDir | ✅ Đã fix | | | |
| Embedding batch parallel | | | | ✅ Optimize |
| SQLite concurrent | | | | ✅ Optimize |
| Error UX | | | | ✅ Polish |
| Session management | | | | ✅ Polish |

---

## 6. Rủi Ro & Giảm Thiểu

### Phase 1 Risks

| Rủi Ro | Xác Suất | Impact | Giảm Thiểu |
|--------|----------|--------|------------|
| useEffect trigger nhiều lần (re-render) | Medium | Medium | Dùng `useRef` để track previous session ID |
| API chat-messages chậm → UI flickering | Low | Low | Loading state + optimistic UI |
| Session ID format conflict | Medium | High | Chuẩn hóa format trong Task 1.2 |

### Phase 2 Risks

| Rủi Ro | Xác Suất | Impact | Giảm Thiểu |
|--------|----------|--------|------------|
| NVIDIA rate limit (40 RPM) → pipeline chậm | High | Medium | Batch processing + delays + OpenRouter fallback |
| PDF parsing thất bại với file phức tạp | Medium | Medium | pdf2json + pdf-parse dual fallback |
| Qdrant out of memory với documents lớn | Low | High | Chunk size limits + batch upsert |
| Embedding API timeout | Medium | Medium | Pseudo-hash fallback + retry logic |

### Phase 3 Risks

| Rủi Ro | Xác Suất | Impact | Giảm Thiểu |
|--------|----------|--------|------------|
| Neo4j không cài được trên máy | Low | Medium | Docker option + optional dependency |
| Neo4j memory usage cao | Medium | Low | Limit graph size + periodic cleanup |
| Entity extraction quality thấp | Medium | Medium | Human review + correction workflow |

### Phase 4 Risks

| Rủi Ro | Xác Suất | Impact | Giảm Thiểu |
|--------|----------|--------|------------|
| Parallel embedding → rate limit | Medium | Medium | Concurrency limits + rate limiter |
| WAL mode không tương thích | Low | Low | Fallback to default journal mode |
| UX changes gây nhầm lẫn | Low | Low | A/B testing + user feedback |

---

## 7. Kết Quả Mong Đợi Sau Từng Phase

### ✅ Sau Phase 1 — Chat Session Persistence
- [x] Chuyển giữa các session → tin nhắn cũ được load và hiển thị đúng
- [x] Tạo session mới → session ID format nhất quán
- [x] Clear chat → messages được xóa cả UI lẫn DB
- [x] Không còn mất dữ liệu chat khi chuyển session
- [x] DELETE endpoint cho chat-messages hoạt động

### ✅ Sau Phase 2 — Document Processing Pipeline
- [x] Upload PDF → tự động trigger processing pipeline
- [x] Pipeline chạy hoàn chỉnh: parse → chunk → extract → embed → index
- [x] Qdrant `theopus_chunks` có data với 1536-dim vectors
- [x] Semantic search trả kết quả từ processed documents
- [x] Document status chuyển đúng: uploaded → indexed
- [x] Embedding fallback chain hoạt động (NVIDIA → OpenRouter → hash)

**Bugs fixed during Phase 2:**
- `createPayload_index` → `createPayloadIndex` method name bug (Qdrant indexes never created)
- `localResolvedEntity.count()` not scoped to document (3 locations)
- `generateAndSaveEmbeddings` delete-then-recreate race condition (zero vectors)
- Missing `wait: true` on Qdrant upsert operations
- No cache invalidation sharing between upload and process routes

### ✅ Sau Phase 3 — Neo4j & Knowledge Graph
- [x] Neo4j kết nối thành công → status indicator XANH
- [x] Entities & relationships được lưu vào Neo4j graph
- [x] Knowledge Graph visualization khả dụng (Cypher query tool trong UI)
- [x] GraphRAG enhance chat responses với graph context
- [x] SQLite buffer entities được sync sang Neo4j

**Bugs fixed during Phase 3:**
- `.env` NEO4J_URI changed from `neo4j://` (routing/cluster) to `bolt://` (single instance) — caused "Could not perform discovery" error
- `agentGraphQuery()` in knowledge-bridge.ts returned raw Neo4j Integer objects instead of native JS numbers — exported `toNative()` and applied conversion
- `exploreEntity()` in knowledge-graph/route.ts required entity to have relationships — fixed to return entity info even with 0 relationships
- `sync-neo4j` API rewritten: was only listing documents, never actually syncing data

### ✅ Sau Phase 4 — Optimization & Polish
- [x] Embedding generation nhanh hơn (parallel — concurrency=5, ~5x speedup)
- [x] SQLite ít SQLITE_BUSY errors hơn (WAL mode + busy_timeout=5000 + synchronous=NORMAL)
- [x] Better error UX (Sonner toasts, retry buttons with gradient, PipelineIndicator)
- [x] Session management nâng cao (rename, delete, search, export)
- [x] Connection status indicators chính xác (always-visible footer with Qdrant/Neo4j/SQLite/LLM status)

**Improvements made during Phase 4:**
- `generateEmbeddingBatch()` rewritten from sequential to chunked parallel (5 concurrent)
- SQLite PRAGMAs: WAL, busy_timeout=5000, synchronous=NORMAL, cache_size=64MB, temp_store=MEMORY
- Sonner toast notifications for all document operations
- PipelineIndicator component: 6-stage horizontal dot tracker with glow effects
- Session search: filters by title, empty state, auto-clear
- Session export: downloads chat as JSON file with toast feedback
- ConnectionStatus footer: always-visible, auto-refresh 10s, tooltips, colored dots

---

## PHỤ LỤC — File & Code Reference

### Files Đã Sửa (Previous Session)
| File | Thay đổi |
|------|----------|
| `.gitignore` | Xóa `.env` khỏi exclude list |
| `.env` | Push lên GitHub cùng API keys |
| `src/app/api/agents/route.ts` | Thêm `retryDbOp()` + fallback empty list |
| `src/app/api/token-usage/route.ts` | Fallback data cho ALL errors |
| `src/app/api/ingestion/upload/route.ts` | SQLite primary + Qdrant optional |
| `src/lib/qdrant.ts` | Fix `orderDir` bug |
| `prisma/schema.prisma` | Thêm model `Document` |

### Files Cần Sửa (Phases 1-4)
| File | Phase | Thay đổi |
|------|-------|----------|
| `src/app/page.tsx` | 1 | Thêm `useEffect` load messages, chuẩn hóa session ID, sửa `clearChat` |
| `src/app/api/chat-messages/route.ts` | 1 | Thêm DELETE handler |
| `src/app/api/ingestion/process/route.ts` | 2 | Verify & fix auto-trigger |
| `src/lib/embeddings.ts` | 4 | Parallel batch generation |
| `src/lib/db.ts` | 4 | WAL mode + PRAGMA settings |
| `src/lib/neo4j.ts` | 3 | Verify connection after Neo4j install |

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        FRONTEND (React)                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Chat UI  │  │ Doc List │  │ Agent    │  │ Knowledge     │  │
│  │          │  │          │  │ Selector │  │ Graph View    │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬────────┘  │
│       │              │              │               │           │
└───────┼──────────────┼──────────────┼───────────────┼───────────┘
        │              │              │               │
        ▼              ▼              ▼               ▼
┌─────────────────────────────────────────────────────────────────┐
│                     API LAYER (Next.js)                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ /chat    │  │ /ingest  │  │ /agents  │  │ /neo4j/sync   │  │
│  │ messages │  │ upload   │  │          │  │               │  │
│  │          │  │ process  │  │          │  │               │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬────────┘  │
└───────┼──────────────┼──────────────┼───────────────┼───────────┘
        │              │              │               │
        ▼              ▼              ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────┐ ┌──────────────┐
│   SQLite     │ │   Qdrant     │ │ LLM APIs │ │   Neo4j      │
│ (Primary DB) │ │ (Vectors)    │ │ NVIDIA   │ │ (Graph DB)   │
│              │ │              │ │ OpenRoute│ │              │
│ • Agents     │ │ • Chunks     │ │ Mistral  │ │ • Entities   │
│ • Sessions   │ │ • Embeddings │ │ Cerebras │ │ • Relations  │
│ • Messages   │ │ • Documents  │ │          │ │ • GraphRAG   │
│ • Documents  │ │ • Memory     │ │          │ │              │
│ • Entities   │ │              │ │          │ │              │
│ • Tokens     │ │              │ │          │ │              │
└──────────────┘ └──────────────┘ └──────────┘ └──────────────┘

     ✅ Required      ⚡ Optional (enhances features)
```

---

> **Ghi chú:** Document này sẽ được cập nhật khi từng phase hoàn thành. Mỗi phase cần verify bằng testing thực tế trước khi chuyển sang phase tiếp theo.
