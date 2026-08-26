/**
 * Ingestion Process API — Self-contained ingestion pipeline
 *
 * Architecture: SQLite (buffer) → Qdrant (vector+document) + Neo4j (graph)
 *
 * Handles the full ingestion pipeline directly (no proxy to mini-services).
 * Uses shared lib modules for LLM, embeddings, Neo4j, Qdrant, and SQLite.
 *
 * POST /api/ingestion/process — run ingestion pipeline for a document
 * GET  /api/ingestion/process — get document processing status
 * PUT  /api/ingestion/process — recover stuck documents (reset transitional states + auto-retry errors)
 * PATCH /api/ingestion/process — pause a running document (mark extracting → partial)
 *
 * Pipeline steps:
 *   1. Get document from Qdrant, download PDF from local filesystem
 *   2. Parse PDF (pdf2json primary + pdf-parse fallback)
 *   3. Chunk text (domain-specific configs)
 *   4. Save chunks to Qdrant chunks collection
 *   5. Delete old embeddings for this document first
 *   6. Extract entities & relationships using callLLM (loop through chunks)
 *   7. Resolve entities (exact match + fuzzy match, skip LLM resolution for speed)
 *   8. Save entities to SQLite buffer + Neo4j
 *   9. Save relationships to SQLite buffer + Neo4j
 *  10. Write to Neo4j (create entity nodes + relationship edges)
 *  11. Generate embeddings using generateEmbeddingBatch from @/lib/embeddings
 *  12. Save embeddings to Qdrant chunks collection
 *  13. Update document status in Qdrant
 *  14. Return pipeline stats
 */

import { NextRequest, NextResponse } from 'next/server'
import { callLLM, callLLMSlot, acquireKey, releaseKey, flushTokenCount, MAX_KEYS, MAX_DOCS_PER_KEY, MAX_TOTAL_CONCURRENT, getFreeKeyCount, getActiveDocCount, getActiveDocIds, markDocPaused, clearDocPaused, isDocPaused, recoverKeys, persistKeyAssignments, getOverallAvailability, getProviderAvailability } from '@/lib/llm'
import { generateEmbeddingBatch, getEmbeddingDimension } from '@/lib/embeddings'
import { getNeo4jDriver, safeSession, executeCypher, readCypher, upsertDocumentNode } from '@/lib/neo4j'
import { upsertDocument, getDocument, listDocuments, updateDocumentStatus, deleteDocument, upsertChunks, getChunksByDocument, getChunkCount, deleteChunksByDocument } from '@/lib/qdrant'
import type { DocumentPayload, ChunkPayload } from '@/lib/qdrant'
import { db } from '@/lib/db'
import { invalidateDocumentCache } from '@/lib/doc-cache'
import { downloadFileFromR2, isR2Configured, listR2Objects } from '@/lib/r2-storage'
import { resolveEntities as resolveEntitiesLib, type ResolvedEntity as ResolvedEntityLib, type DuplicatePair as DuplicatePairLib } from '@/lib/ingestion/entity-resolver'
import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'

// Suppress pdf2json warnings globally (supported natively by pdf2json library)
// This is more reliable than monkey-patching console.warn which can leak on hot-reload.
// Must be set BEFORE pdf2json is imported/loaded.
if (typeof process !== 'undefined') {
  process.env.PDF2JSON_DISABLE_LOGS = '1'
}

export const dynamic = 'force-dynamic'
export const maxDuration = 600 // 10 minutes — allows multiple extraction batches for large documents

/** Timeout threshold (ms) — stop extraction loop if this much time has elapsed.
 *  With maxDuration=600s, we use 500s for extraction and leave 100s buffer for resolve+Neo4j+embeddings.
 *  When timed out, the document is marked 'partial' and the frontend auto-triggers the next batch.
 *
 *  WHY NOT RUN FOREVER?
 *  - Serverless functions have hard execution limits (Vercel Pro: 300s, local: configurable)
 *  - Long-running Node.js processes accumulate memory (entities, relationships arrays grow)
 *  - LLM APIs may have session/connection timeouts
 *  - Batch checkpointing ensures partial progress is saved — no data loss on timeout
 *  - The frontend auto-continues, so the user experience is seamless
 *
 *  For a 445-chunk document at ~5s/chunk: 500s timeout → ~100 chunks/batch → ~5 batches total
 */
const EXTRACTION_TIMEOUT_MS = 500_000

/** Number of chunks to process per batch before checking timeout.
 *  After each batch, progress is saved to DB so partial results are preserved.
 */
const CHUNKS_PER_BATCH = 20

// ==================== TYPES ====================

type DocumentDomain = 'programming' | 'algorithm' | 'ml' | 'meta_cognitive' | 'linux' | 'security' | 'ux_ui' | 'mixed'
type EntityType = 'Concept' | 'Technology' | 'Framework' | 'Vulnerability' | 'Principle' | 'Domain' | 'Document' | 'Person'
type RelationshipType = 'PART_OF' | 'IMPLEMENTED_IN' | 'USES' | 'EXPLOITS' | 'MITIGATES' | 'RUNS_ON' | 'DEPENDS_ON' | 'CONTRASTS_WITH' | 'ENABLES' | 'CONTAINS' | 'EXTENDS' | 'APPLIES_TO' | 'CREATED_BY' | 'DOCUMENTED_IN' | 'ALTERNATIVE_TO'

interface ParsedChunk { content: string; chunkIndex: number; headingPath: string; tokenCount: number; domain: DocumentDomain }
interface ParseResult { chunks: ParsedChunk[]; totalPages: number; totalTokens: number }
interface ExtractedEntity { name: string; type: EntityType; description: string; properties: Record<string, string | number | boolean>; confidenceScore: number; source: string; domain: DocumentDomain }
interface ExtractedRelationship { source: string; target: string; type: RelationshipType; description: string; confidenceScore: number; source_provider: string }
// Phase 5.5: ResolvedEntity and DuplicatePair are now imported from @/lib/ingestion/entity-resolver
// The lib types are compatible with the pipeline — same fields, same behavior.
type ResolvedEntity = ResolvedEntityLib
type DuplicatePair = DuplicatePairLib

const VALID_ENTITY_TYPES: EntityType[] = ['Concept', 'Technology', 'Framework', 'Vulnerability', 'Principle', 'Domain', 'Document', 'Person']
const VALID_RELATIONSHIP_TYPES: RelationshipType[] = ['PART_OF', 'IMPLEMENTED_IN', 'USES', 'EXPLOITS', 'MITIGATES', 'RUNS_ON', 'DEPENDS_ON', 'CONTRASTS_WITH', 'ENABLES', 'CONTAINS', 'EXTENDS', 'APPLIES_TO', 'CREATED_BY', 'DOCUMENTED_IN', 'ALTERNATIVE_TO']
const RATE_LIMIT_DELAY_MS = 100
const CONCURRENT_CHUNKS = 4 // Reduced from 8 → 4 (user Option C: less rate-limit on nemotron-550b)

/** Sliding window concurrency: each worker takes the next chunk from the iterator
 *  as soon as it finishes the current one. No waiting for group completion.
 *  This maximizes RPM utilization — when a fast chunk finishes, its key
 *  is immediately used for the next chunk, instead of waiting for the slowest
 *  chunk in the group to finish (as with Promise.allSettled groups).
 */
const SLIDING_WINDOW_CONCURRENCY = CONCURRENT_CHUNKS
const EMBEDDING_DIMENSION = getEmbeddingDimension() // Uses shared constant from @/lib/embeddings

// ==================== DOMAIN CHUNKING CONFIGS ====================

const DOMAIN_CONFIGS: Record<DocumentDomain, { maxTokens: number; overlapTokens: number; preservePatterns: RegExp[] }> = {
  programming: { maxTokens: 512, overlapTokens: 64, preservePatterns: [/```[\s\S]*?```/g, /`[^`]+`/g] },
  algorithm: { maxTokens: 512, overlapTokens: 64, preservePatterns: [/```[\s\S]*?```/g, /`[^`]+`/g, /Step \d+[:.]/gi] },
  ml: { maxTokens: 640, overlapTokens: 96, preservePatterns: [/\$[^$]+\$/g, /\$\$[\s\S]*?\$\$/g, /[a-zA-Z]\s*=\s*[a-zA-Z0-9+\-*/().]+/g, /L_\d+/g] },
  meta_cognitive: { maxTokens: 768, overlapTokens: 128, preservePatterns: [/Therefore[,\.]/gi, /Thus[,\.]/gi, /Because/gi, /Since/gi, /This (implies|means|shows|demonstrates)/gi, /We can (conclude|infer|deduce)/gi] },
  linux: { maxTokens: 512, overlapTokens: 64, preservePatterns: [/\$\s+[a-zA-Z]/g, /sudo\s+/g, /apt|yum|dnf|pip|npm/g, /#[^\n]*$/gm] },
  security: { maxTokens: 512, overlapTokens: 64, preservePatterns: [/CVE-\d{4}-\d+/g, /nmap|nikto|sqlmap|metasploit/gi, /sudo\s+/g, /exploit/gi, /vulnerability/gi] },
  ux_ui: { maxTokens: 640, overlapTokens: 96, preservePatterns: [/```[\s\S]*?```/g, /`[^`]+`/g, /Step \d+[:.]/gi, /\[[\s\S]*?\]\([\s\S]*?\)/g] },
  mixed: { maxTokens: 512, overlapTokens: 64, preservePatterns: [] },
}

// ==================== HELPERS ====================

/** Upload directory for local filesystem storage */
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/theopus-uploads'

/** Convert Qdrant DocumentPayload to a flat record format expected by the pipeline.
 *  Qdrant stores the full DocumentPayload — we map it to the flat shape the pipeline expects.
 */
function qdrantDocToRecord(payload: DocumentPayload, id: string): Record<string, unknown> {
  return {
    id,
    title: payload.title,
    file_path: payload.file_path,
    domain: payload.domain,
    page_count: payload.page_count,
    status: payload.status,
    error_message: payload.error_message,
    processing_steps: payload.processing_steps,
    processing_percent: payload.processing_percent,
    created_at: payload.created_at,
    updated_at: payload.updated_at,
    // Preserve R2 linkage for fallback download when local file is missing
    r2_key: (payload as Record<string, unknown>).r2_key,
  }
}

/** Convert ProcessingStepRecord[] to the Qdrant-compatible format.
 *  Qdrant DocumentPayload stores processing_steps as Array<{ step, status, timestamp }>,
 *  but since Qdrant stores JSON as-is, the richer ProcessingStepRecord format is preserved.
 *  This function is used when we need to explicitly convert for the type system.
 */
function stepsToQdrantFormat(steps: ProcessingStepRecord[]): Array<{ step: string; status: string; timestamp: string }> {
  return steps.map(s => ({
    step: `${s.name}: ${s.label}`,
    status: s.status,
    timestamp: s.startedAt || s.completedAt || new Date().toISOString(),
  }))
}

/** Download file from local filesystem */
async function downloadFromFilesystem(filePath: string): Promise<Buffer | null> {
  try {
    const fullPath = filePath.startsWith('/') ? filePath : join(UPLOAD_DIR, filePath)
    if (!existsSync(fullPath)) {
      console.warn(`[FS] File not found: ${fullPath}`)
      return null
    }
    const data = await readFile(fullPath)
    return Buffer.from(data)
  } catch (err) {
    console.error('[FS] File download error:', err instanceof Error ? err.message : String(err))
    return null
  }
}

/** Fetch ALL local entities for a document from SQLite buffer.
 *  Reads from SQLite local buffer (entity extraction data).
 */
async function fetchAllEntitiesForDoc(documentId: string) {
  return db.localEntity.findMany({ where: { documentId } })
}

/** Fetch ALL local relationships for a document from SQLite buffer.
 *  Reads from SQLite local buffer (relationship extraction data).
 */
async function fetchAllRelationshipsForDoc(documentId: string) {
  return db.localRelationship.findMany({ where: { documentId } })
}

/** Fetch ALL chunks for a document from Qdrant, ordered by chunk_index.
 *  Reads all chunks from Qdrant chunks collection, ordered by chunk_index.
 *  Includes retry logic with delays — Qdrant may need a brief moment after upsert
 *  to make points readable, even with wait:true (eventual consistency on scroll API).
 */
async function fetchAllChunksForDoc(documentId: string, retryCount = 5): Promise<Array<{ id: string; chunk_index: number; content: string; domain: string | null; heading_path?: string; token_count?: number }>> {
  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      const chunks = await getChunksByDocument(documentId, { limit: 100000 })
      if (chunks.length > 0) {
        return chunks.map(c => ({
          id: c.id,
          chunk_index: c.payload.chunk_index,
          content: c.payload.content,
          domain: c.payload.domain || null,
          heading_path: c.payload.heading_path,
          token_count: c.payload.token_count,
        }))
      }
      // Chunks not yet readable — wait and retry with progressive delays
      // For large documents (2500+ chunks), Qdrant needs more time to make points readable
      if (attempt < retryCount) {
        const delay = attempt * 1000 // 1s, 2s, 3s, 4s — more generous than before
        console.log(`[Process] fetchAllChunksForDoc: attempt ${attempt}/${retryCount} returned 0 chunks — retrying in ${delay}ms...`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    } catch (err) {
      console.warn(`[Process] fetchAllChunksForDoc: attempt ${attempt}/${retryCount} error:`, err instanceof Error ? err.message : String(err))
      if (attempt < retryCount) {
        await new Promise(resolve => setTimeout(resolve, attempt * 1000))
      }
    }
  }
  return []
}

/** Fetch all documents matching a set of statuses from Qdrant.
 *  Qdrant's listDocuments doesn't support multiple status values in a single filter,
 *  so we query each status separately and merge.
 */
async function fetchDocsByStatuses(statuses: string[], options?: { limit?: number; orderBy?: 'created_at' | 'updated_at'; orderDir?: 'asc' | 'desc' }): Promise<Array<{ id: string; payload: DocumentPayload }>> {
  const allDocs: Array<{ id: string; payload: DocumentPayload }> = []
  // Ensure a minimum per-status limit so we don't miss eligible docs when statuses.length is large
  // but the total limit is small (e.g., limit=3 with 3 statuses → 1 per status = might miss docs)
  const limitPerStatus = Math.max(options?.limit ?? 1000, Math.ceil((options?.limit ?? 1000) / statuses.length), 10)

  for (const status of statuses) {
    const result = await listDocuments({
      status,
      limit: limitPerStatus,
      orderBy: options?.orderBy,
      orderDir: options?.orderDir,
    })
    allDocs.push(...result.documents)
  }

  // Sort by requested order
  if (options?.orderBy && options?.orderDir) {
    const dir = options.orderDir === 'asc' ? 1 : -1
    allDocs.sort((a, b) => {
      const aVal = a.payload[options.orderBy!] || ''
      const bVal = b.payload[options.orderBy!] || ''
      return dir * aVal.localeCompare(bVal)
    })
  }

  // Apply overall limit
  if (options?.limit && allDocs.length > options.limit) {
    return allDocs.slice(0, options.limit)
  }

  return allDocs
}

/** Sanitize text for database insertion — remove invalid Unicode that causes insertion errors */
function sanitizeForDB(text: string): string {
  if (!text) return ''
  return text
    // Remove null bytes and other control characters (except newline/tab)
    .replace(/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/g, '')
    // Remove non-characters (U+FDD0..U+FDEF, and codepoints ending in FFFE/FFFF)
    .replace(/[\uFDD0-\uFDEF\uFFFE\uFFFF]/g, '')
    // Remove lone surrogates (unpaired high/low surrogates)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    // Replace backslash-u followed by invalid hex (broken Unicode escapes from PDF parsing)
    .replace(/\\u(?![0-9a-fA-F]{4})/gi, '')
    // Remove any remaining backslash sequences that aren't standard escapes
    .replace(/\\(?!["\\/bfnrt])/g, '')
}

function estimateTokenCount(text: string): number { return Math.ceil(text.length / 4) }

function extractHeadingPath(text: string): string {
  const headingPattern = /^(#{1,6})\s+(.+)$/gm
  const headings: { level: number; text: string }[] = []
  let match: RegExpExecArray | null
  while ((match = headingPattern.exec(text)) !== null) headings.push({ level: match[1].length, text: match[2].trim() })
  if (headings.length === 0) return ''
  const path: string[] = []
  for (const h of headings) { while (path.length > 0 && path.length >= h.level) path.pop(); path.push(h.text) }
  return path.join(' > ')
}

function getDominantHeading(text: string, previousHeading: string): string {
  const lines = text.split('\n')
  let lastHeading = previousHeading
  for (const line of lines) { const headerMatch = line.match(/^(#{1,6})\s+(.+)$/); if (headerMatch) lastHeading = headerMatch[2].trim() }
  return lastHeading
}

function isInsideCodeBlock(text: string, position: number): boolean {
  const beforeText = text.substring(0, position)
  const codeBlockCount = (beforeText.match(/```/g) || []).length
  return codeBlockCount % 2 !== 0
}

function findSafeSplitPoint(text: string, targetPosition: number): number {
  const searchRange = 100
  for (let offset = 0; offset < searchRange; offset++) {
    for (const dir of [-1, 1]) {
      const pos = targetPosition + offset * dir
      if (pos <= 0 || pos >= text.length) continue
      if (text.substring(pos - 2, pos) === '\n\n' && !isInsideCodeBlock(text, pos)) return pos
    }
  }
  for (let offset = 0; offset < searchRange; offset++) {
    for (const dir of [-1, 1]) {
      const pos = targetPosition + offset * dir
      if (pos <= 0 || pos >= text.length) continue
      if (text[pos - 1] === '\n' && !isInsideCodeBlock(text, pos)) return pos
    }
  }
  for (let offset = 0; offset < searchRange; offset++) {
    for (const dir of [-1, 1]) {
      const pos = targetPosition + offset * dir
      if (pos <= 0 || pos >= text.length) continue
      if ((text[pos - 1] === '.' || text[pos - 1] === '!' || text[pos - 1] === '?') && !isInsideCodeBlock(text, pos)) return pos
    }
  }
  return targetPosition
}

function chunkText(text: string, domain: DocumentDomain): ParsedChunk[] {
  const config = DOMAIN_CONFIGS[domain] || DOMAIN_CONFIGS.mixed
  const chunks: ParsedChunk[] = []
  if (!text.trim()) return chunks
  const maxCharSize = config.maxTokens * 4
  const overlapCharSize = config.overlapTokens * 4
  let position = 0
  let chunkIndex = 0
  let currentHeading = ''
  while (position < text.length) {
    let endPosition = Math.min(position + maxCharSize, text.length)
    if (endPosition < text.length) endPosition = findSafeSplitPoint(text, endPosition)
    const chunkContent = text.substring(position, endPosition).trim()
    if (chunkContent) {
      currentHeading = getDominantHeading(chunkContent, currentHeading)
      const headingPath = extractHeadingPath(chunkContent) || currentHeading
      chunks.push({ content: chunkContent, chunkIndex, headingPath: headingPath || currentHeading, tokenCount: estimateTokenCount(chunkContent), domain })
      chunkIndex++
    }
    if (endPosition >= text.length) break
    position = Math.max(position + 1, endPosition - overlapCharSize)
    if (position <= 0 && chunkIndex > 0) break
  }
  return chunks
}

// ==================== PDF PARSING (pdf-parse primary + pdfjs-dist fallback) ====================

/** Path to pdfjs-dist standard_fonts directory.
 *  pdfjs-dist requires standardFontDataUrl to decode standard PDF fonts (Helvetica, Times, etc.)
 *  Without this, PDFs using standard fonts throw UnknownErrorException.
 *  The standard_fonts directory is provided by the pdfjs-dist package (dependency of pdf-parse).
 */
let _standardFontDataUrl: string | null = null
async function getStandardFontDataUrl(): Promise<string> {
  if (_standardFontDataUrl) return _standardFontDataUrl
  try {
    const path = await import('path')
    const { existsSync } = await import('fs')
    // pdfjs-dist is a dependency of pdf-parse — find its standard_fonts directory
    const candidates = [
      // Direct dependency path
      path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts'),
      // Hoisted dependency path
      path.join(process.cwd(), 'node_modules', 'pdf-parse', 'node_modules', 'pdfjs-dist', 'standard_fonts'),
    ]
    for (const dir of candidates) {
      if (existsSync(dir)) {
        // pdfjs-dist standardFontDataUrl needs a URL-like path
        _standardFontDataUrl = `file://${dir}/`
        console.log(`[PDF] Found standard_fonts at: ${dir}`)
        return _standardFontDataUrl
      }
    }
    console.warn('[PDF] standard_fonts directory not found — standard PDF fonts may not decode correctly')
  } catch {
    console.warn('[PDF] Could not resolve standard_fonts path')
  }
  return ''
}

/** Extract text from PDF using pdfjs-dist directly (with proper standardFontDataUrl configuration).
 *  This is used as a fallback when pdf-parse returns empty text.
 *  Unlike pdf2json (which bundles PDF.js without exposing standardFontDataUrl),
 *  this uses the standalone pdfjs-dist package with proper font configuration.
 */
async function extractTextWithPdfjsDist(buffer: Buffer): Promise<{ text: string; totalPages: number }> {
  try {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const fontUrl = await getStandardFontDataUrl()
    const doc = await pdfjsLib.getDocument({
      data: new Uint8Array(buffer),
      standardFontDataUrl: fontUrl || undefined,
      useSystemFonts: true, // Fallback: use system fonts if standard fonts unavailable
    }).promise
    const totalPages = doc.numPages
    const pageTexts: string[] = []
    for (let i = 1; i <= totalPages; i++) {
      try {
        const page = await doc.getPage(i)
        const content = await page.getTextContent()
        const pageText = content.items
          .map((item: any) => item.str || '')
          .join(' ')
        pageTexts.push(pageText)
      } catch (pageErr) {
        // Skip pages that fail to decode (e.g., font issues) instead of failing entire document
        console.warn(`[PDF] pdfjs-dist: Page ${i}/${totalPages} failed:`, pageErr instanceof Error ? pageErr.message : String(pageErr))
      }
    }
    await doc.destroy()
    const text = pageTexts.join('\n\n')
    if (text.trim().length > 0) {
      console.log(`[PDF] pdfjs-dist fallback succeeded: ${totalPages} pages, ${text.length} chars`)
    }
    return { text, totalPages }
  } catch (err) {
    console.error('[PDF] pdfjs-dist fallback failed:', err instanceof Error ? err.message : String(err))
    return { text: '', totalPages: 0 }
  }
}

async function parsePDF(buffer: Buffer, domain: DocumentDomain = 'mixed'): Promise<ParseResult> {
  let text = ''
  let totalPages = 0

  // PRIMARY: pdf-parse v2 (modern, reliable, handles standard fonts natively)
  // pdf-parse v2 uses pdfjs-dist internally with proper font support.
  try {
    const pdfParseModule = await import('pdf-parse')
    if (pdfParseModule.PDFParse) {
      // v2: PDFParse class — constructor expects { data: Uint8Array } config object
      const parser = new pdfParseModule.PDFParse({ data: new Uint8Array(buffer) })
      try {
        const textResult = await parser.getText()
        text = textResult.text || ''
        totalPages = textResult.total || 0
        if (text.trim().length > 0) {
          console.log(`[PDF] pdf-parse v2 succeeded: ${totalPages} pages, ${text.length} chars`)
        }
      } finally {
        await parser.destroy().catch(() => {})
      }
    } else if (typeof pdfParseModule.default === 'function') {
      // v1: default export is a function
      const data = await pdfParseModule.default(buffer)
      text = data.text || ''
      totalPages = data.numpages || data.total || 0
      if (text.trim().length > 0) {
        console.log(`[PDF] pdf-parse v1 succeeded: ${totalPages} pages, ${text.length} chars`)
      }
    }
  } catch (err) {
    console.error('[PDF] pdf-parse failed:', err instanceof Error ? err.message : String(err))
  }

  // FALLBACK 1: If pdf-parse returned empty text, try pdfjs-dist directly
  // (with proper standardFontDataUrl configuration that pdf2json lacks)
  if (!text || text.trim().length === 0) {
    console.log('[PDF] pdf-parse returned empty text, trying pdfjs-dist fallback...')
    const result = await extractTextWithPdfjsDist(buffer)
    if (result.text.trim().length > 0) {
      text = result.text
      totalPages = result.totalPages || totalPages
    }
  }

  // FALLBACK 2: If pdfjs-dist also failed, try pdf2json as last resort
  // Note: pdf2json v4 bundles its own PDF.js without standardFontDataUrl support,
  // so it may fail with UnknownErrorException on PDFs using standard fonts.
  if (!text || text.trim().length === 0) {
    console.log('[PDF] pdfjs-dist also failed, trying pdf2json as last resort...')
    try {
      const PDFParser = (await import('pdf2json')).default
      // pdf2json v4 constructor: PDFParser(needRawText) — only ONE argument
      // Passing true/1 enables raw text mode for better text extraction
      const pdfParser = new (PDFParser as any)(1)

      await Promise.race([
        new Promise<void>((resolve, reject) => {
          pdfParser.on('pdfParser_dataReady', () => {
            try {
              text = pdfParser.getRawTextContent() || ''
              totalPages = pdfParser.data?.Pages?.length || totalPages
              resolve()
            } catch (err) {
              reject(err)
            }
          })
          pdfParser.on('pdfParser_dataError', (errData: any) => {
            reject(new Error(errData?.parserError?.message || 'PDF parse error'))
          })
          pdfParser.parseBuffer(buffer)
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('pdf2json timeout (60s)')), 60_000)
        ),
      ])
      if (text.trim().length > 0) {
        console.log(`[PDF] pdf2json last resort succeeded: ${totalPages} pages, ${text.length} chars`)
      }
    } catch (err) {
      console.error('[PDF] pdf2json last resort also failed:', err instanceof Error ? err.message : String(err))
    }
  }

  if (!text || text.trim().length === 0) return { chunks: [], totalPages, totalTokens: 0 }

  const cleanedText = text
    .replace(/\f/g, '\n\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\t+/g, '  ')
    .replace(/  +/g, ' ')
    // Sanitize invalid Unicode: remove surrogates, non-characters, and other invalid code points
    .replace(/[\u0000-\u0008\u000B\u000E-\u001F\u007F\uFFFE\uFFFF]/g, '')
    // Remove lone surrogates (unpaired high/low surrogates)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .trim()
  const chunks = chunkText(cleanedText, domain)
  const totalTokens = chunks.reduce((sum, c) => sum + c.tokenCount, 0)
  return { chunks, totalPages, totalTokens }
}

/** Extract raw text from PDF without chunking — used for domain classification before chunking */
async function extractPDFText(buffer: Buffer): Promise<{ text: string; totalPages: number }> {
  let text = ''
  let totalPages = 0

  // PRIMARY: pdf-parse v2 (modern, handles standard fonts natively, no timeout issues)
  try {
    const pdfParseModule = await import('pdf-parse')
    if (pdfParseModule.PDFParse) {
      // v2: PDFParse class — constructor expects { data: Uint8Array } config object
      const parser = new pdfParseModule.PDFParse({ data: new Uint8Array(buffer) })
      try {
        const textResult = await parser.getText()
        text = textResult.text || ''
        totalPages = textResult.total || 0
      } finally {
        await parser.destroy().catch(() => {})
      }
    } else if (typeof pdfParseModule.default === 'function') {
      // v1: default export is a function
      const data = await pdfParseModule.default(buffer)
      text = data.text || ''
      totalPages = data.numpages || data.total || 0
    }
  } catch (err) {
    console.error('[PDF] pdf-parse text extraction failed:', err instanceof Error ? err.message : String(err))
  }

  // FALLBACK 1: pdfjs-dist (with proper standardFontDataUrl)
  if (!text || text.trim().length === 0) {
    const result = await extractTextWithPdfjsDist(buffer)
    if (result.text.trim().length > 0) {
      text = result.text
      totalPages = result.totalPages || totalPages
    }
  }

  // FALLBACK 2: pdf2json as last resort
  if (!text || text.trim().length === 0) {
    try {
      const PDFParser = (await import('pdf2json')).default
      const pdfParser = new (PDFParser as any)(1) // needRawText=true
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          pdfParser.on('pdfParser_dataReady', () => {
            try { text = pdfParser.getRawTextContent() || ''; totalPages = pdfParser.data?.Pages?.length || totalPages; resolve() }
            catch (err) { reject(err) }
          })
          pdfParser.on('pdfParser_dataError', (errData: any) => { reject(new Error(errData?.parserError?.message || 'PDF parse error')) })
          pdfParser.parseBuffer(buffer)
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('pdf2json timeout (60s)')), 60_000)),
      ])
    } catch (err) {
      console.error('[PDF] pdf2json text extraction also failed:', err instanceof Error ? err.message : String(err))
    }
  }

  if (!text || text.trim().length === 0) return { text: '', totalPages: 0 }

  const cleanedText = text
    .replace(/\f/g, '\n\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n').replace(/\t+/g, '  ').replace(/  +/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000E-\u001F\u007F\uFFFE\uFFFF]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .trim()

  return { text: cleanedText, totalPages }
}

// ==================== DOCUMENT CLASSIFICATION ====================

/**
 * Keyword-based domain classification fallback.
 * Used when LLM classification fails or returns unparseable results.
 * Scans text for domain-specific keywords and returns the domain with highest score.
 */
function classifyDomainByKeywords(textSample: string): DocumentDomain {
  const lower = textSample.toLowerCase()
  const scores: Record<Exclude<DocumentDomain, 'mixed'>, number> = {
    programming: 0, algorithm: 0, ml: 0, meta_cognitive: 0, linux: 0, security: 0, ux_ui: 0,
  }

  // Programming keywords (weighted by specificity)
  const progKeywords = [
    ['function', 1], ['class ', 1], ['import ', 1], ['export ', 1], ['return ', 1],
    ['const ', 1], ['async ', 1], ['await ', 1], ['interface ', 1.5], ['api', 1],
    ['framework', 1], ['component', 1], ['module', 0.5], ['library', 0.5],
    ['typescript', 2], ['javascript', 2], ['python', 2], ['react', 2], ['node', 1],
    ['dockerfile', 1.5], ['websocket', 1.5], ['endpoint', 1.5], ['middleware', 1.5],
    ['decorator', 1.5], ['callback', 1.5], ['promise', 1.5], ['generic', 1],
    ['compile', 1], ['debug', 1], ['refactor', 1.5], ['deploy', 0.5],
    ['constructor', 1.5], ['inheritance', 1.5], ['polymorphism', 1.5],
    ['mvc', 1.5], ['rest api', 2], ['graphql', 2], ['microservice', 2],
  ]
  for (const [kw, weight] of progKeywords) {
    if (lower.includes(kw as string)) scores.programming += weight as number
  }

  // Algorithm keywords
  const algoKeywords = [
    ['algorithm', 2], ['complexity', 1.5], ['big o', 2], ['o(n', 2], ['o(log', 2],
    ['sorting', 1.5], ['searching', 1.5], ['binary tree', 2], ['graph traversal', 2],
    ['dynamic programming', 2], ['greedy', 1.5], ['divide and conquer', 2],
    ['recursion', 1], ['backtracking', 2], ['hash table', 1.5], ['linked list', 2],
    ['stack', 0.5], ['queue', 0.5], ['heap', 1], ['bfs', 1.5], ['dfs', 1.5],
    ['dijkstra', 2], ['bellman', 2], ['floyd', 1.5], ['knapsack', 2],
    ['traveling salesman', 2], ['time complexity', 2], ['space complexity', 2],
    ['data structure', 2], ['avl', 2], ['red-black', 2], ['b-tree', 2],
  ]
  for (const [kw, weight] of algoKeywords) {
    if (lower.includes(kw as string)) scores.algorithm += weight as number
  }

  // ML keywords
  const mlKeywords = [
    ['neural network', 2], ['machine learning', 2], ['deep learning', 2],
    ['training', 1], ['gradient', 1.5], ['loss function', 2], ['optimizer', 1.5],
    ['backpropagation', 2], ['convolutional', 2], ['recurrent', 2],
    ['transformer', 2], ['attention mechanism', 2], ['bert', 2], ['gpt', 2],
    ['classification', 1], ['regression', 1.5], ['clustering', 1.5],
    ['supervised', 1.5], ['unsupervised', 1.5], ['reinforcement learning', 2],
    ['epoch', 1.5], ['batch size', 1.5], ['learning rate', 2],
    ['overfitting', 2], ['regularization', 2], ['dropout', 1.5],
    ['feature extraction', 1.5], ['embedding', 1], ['fine-tuning', 2],
    ['pre-training', 1.5], ['tokeniz', 1.5], ['sentiment analysis', 2],
    ['computer vision', 2], ['object detection', 2], ['image recognition', 2],
    ['nlp', 1.5], ['natural language', 2], ['inference', 1],
    ['dataset', 1], ['model architecture', 2], ['hyperparameter', 2],
    ['cross-entropy', 2], ['softmax', 2], ['sigmoid', 1.5], ['relu', 2],
    ['latent', 1.5], ['autoencoder', 2], ['gan', 1.5], ['diffusion', 2],
    ['reward', 0.5], ['q-learning', 2], ['policy', 0.5],
  ]
  for (const [kw, weight] of mlKeywords) {
    if (lower.includes(kw as string)) scores.ml += weight as number
  }

  // Meta-cognitive keywords
  const metaKeywords = [
    ['meta-cogni', 2], ['metacogni', 2], ['cognitive science', 2], ['reasoning', 1],
    ['philosophy of mind', 2], ['critical thinking', 2], ['epistemology', 2],
    ['consciousness', 1.5], ['introspection', 2], ['self-regulation', 2],
    ['belief', 1], ['rationality', 1.5], ['heuristics and biases', 2],
    ['decision theory', 2], ['logic', 0.5], ['argumentation', 1.5],
    ['cognitive bias', 2], ['mental model', 2], ['thinking process', 1.5],
  ]
  for (const [kw, weight] of metaKeywords) {
    if (lower.includes(kw as string)) scores.meta_cognitive += weight as number
  }

  // Linux keywords
  const linuxKeywords = [
    ['sudo ', 2], ['apt ', 1.5], ['yum ', 1.5], ['systemctl', 2], ['shell script', 2],
    ['bash', 1], ['/etc/', 1.5], ['/var/', 1], ['/usr/', 0.5], ['kernel', 1],
    ['docker', 1], ['kubernetes', 1.5], ['k8s', 1.5], ['container', 1],
    ['nginx', 1.5], ['apache', 1], ['ssh', 1.5], ['cron', 1.5], ['systemd', 2],
    ['linux', 1.5], ['ubuntu', 1.5], ['debian', 1.5], ['centos', 1.5],
    ['devops', 1.5], ['ci/cd', 2], ['jenkins', 1.5], ['terraform', 2],
    ['ansible', 2], ['iptables', 2], ['chmod', 2], ['chown', 2],
    ['pipe', 0.3], ['grep', 1.5], ['awk', 1.5], ['sed ', 1],
    ['mount', 1], ['fdisk', 2], ['lvm', 2],
  ]
  for (const [kw, weight] of linuxKeywords) {
    if (lower.includes(kw as string)) scores.linux += weight as number
  }

  // Security keywords
  const secKeywords = [
    ['vulnerability', 2], ['exploit', 2], ['cve-', 2], ['penetration testing', 2],
    ['cryptography', 2], ['encryption', 1.5], ['firewall', 1.5], ['malware', 2],
    ['phishing', 2], ['sql injection', 2], ['xss', 2], ['csrf', 2],
    ['authentication', 1], ['authorization', 1], ['owasp', 2], ['nmap', 2],
    ['wireshark', 2], ['ids', 0.5], ['ips', 0.5], ['zero-day', 2],
    ['ransomware', 2], ['backdoor', 2], ['privilege escalation', 2],
    ['security', 1], ['breach', 1.5], ['threat', 1], ['incident response', 2],
    ['forensic', 2], ['pentest', 2], ['hash', 0.5], ['certificate', 0.5],
    ['tls', 1.5], ['ssl', 1], ['mitm', 2], ['ddos', 2],
  ]
  for (const [kw, weight] of secKeywords) {
    if (lower.includes(kw as string)) scores.security += weight as number
  }

  // UX/UI Design keywords
  const uxuiKeywords = [
    ['user experience', 2], ['ux design', 2], ['ui design', 2], ['user interface', 2],
    ['usability', 2], ['wireframe', 2], ['prototype', 1.5], ['mockup', 1.5],
    ['design system', 2], ['design thinking', 2], ['user research', 2], ['persona', 1.5],
    ['user journey', 2], ['customer journey', 2], ['information architecture', 2],
    ['interaction design', 2], ['visual design', 1.5], ['responsive design', 1.5],
    ['accessibility', 1.5], ['a11y', 2], ['wcag', 2], ['heuristic', 1.5],
    ['figma', 2], ['sketch ', 1.5], ['adobe xd', 2], ['invision', 2],
    ['user testing', 2], ['a/b test', 2], ['usability testing', 2],
    ['affinity diagram', 2], ['card sorting', 2], ['task analysis', 1.5],
    ['cognitive load', 2], ['mental model', 1.5], ['user flow', 2], ['user story', 1.5],
    ['sprint', 0.5], ['agile', 0.3], ['scrum', 0.3],
    ['material design', 2], ['flat design', 1.5], ['gestalt', 2],
    ['color theory', 2], ['typography', 1.5], ['layout', 0.5], ['spacing', 0.5],
    ['hierarchy', 0.5], ['consistency', 0.5], ['feedback', 0.3],
    ['component library', 2], ['style guide', 2], ['pattern library', 2],
    ['empathy map', 2], ['stakeholder', 0.5], ['mood board', 2],
  ]
  for (const [kw, weight] of uxuiKeywords) {
    if (lower.includes(kw as string)) scores.ux_ui += weight as number
  }

  // Find the domain with the highest score
  const entries = Object.entries(scores) as [Exclude<DocumentDomain, 'mixed'>, number][]
  const sorted = entries.sort((a, b) => b[1] - a[1])
  const [bestDomain, bestScore] = sorted[0]

  // Only return a specific domain if the score is above a minimum threshold
  // Lowered thresholds to reduce "mixed" classification — most technical docs have a clear domain
  const secondBest = sorted[1]?.[1] ?? 0
  const MIN_SCORE = 2 // Need at least 2 keyword-weight hits
  const MIN_RATIO = 1.2 // Best domain must be 1.2x the second best

  if (bestScore >= MIN_SCORE && bestScore >= secondBest * MIN_RATIO) {
    return bestDomain
  }

  // If no clear winner, return 'mixed'
  return 'mixed'
}

/**
 * Classify a document's domain using LLM based on a text sample.
 *
 * This is called AFTER parsing (when we have text content) but BEFORE chunking,
 * so the correct domain-specific chunking config and extraction prompts are used.
 *
 * If the user explicitly selected a domain at upload time (not "auto"/"mixed"),
 * the existing domain is preserved — classification only overrides "mixed".
 *
 * Strategy: LLM classification first (up to 2 retries), then keyword-based fallback.
 *
 * @param textSample - A representative sample of the document's text (~2000-4000 chars)
 * @param documentTitle - The document's filename/title for additional context
 * @param slotIndex - The key index for LLM key assignment
 * @returns The classified domain (one of the 8 valid domains)
 */
async function classifyDocumentDomain(
  textSample: string,
  documentTitle: string,
  slotIndex: number = -1
): Promise<DocumentDomain> {
  const classifySystemPrompt = `You are a document domain classifier for a technical knowledge base. Classify the document into exactly ONE domain. Be SPECIFIC — "mixed" should be extremely rare. Even if a document mentions multiple topics, pick the DOMINANT one. A Python book that briefly mentions ML is "programming", not "mixed". An ML paper using Python code is "ml", not "mixed". Output ONLY the domain name in lowercase, nothing else.`

  const classifyPrompt = `Analyze the following text sample from a document and classify its domain.

Document title: "${documentTitle}"

Text sample:
${textSample.slice(0, 3000)}

Classify into exactly ONE of these domains:
- programming: Software development, programming languages, code, APIs, frameworks, web/mobile development
- algorithm: Algorithms, data structures, computational complexity, sorting, searching, graph algorithms
- ml: Machine learning, deep learning, neural networks, AI, data science, statistics, NLP, computer vision
- meta_cognitive: Meta-cognition, cognitive science, reasoning, logic, philosophy of mind, critical thinking
- linux: Linux system administration, DevOps, shell scripting, containers, server management, networking
- security: Cybersecurity, information security, penetration testing, cryptography, vulnerabilities, network security
- ux_ui: UX/UI design, user experience, user interface design, usability, design systems, interaction design, accessibility, prototyping, visual design
- mixed: VERY RARE — ONLY use if the document truly covers 3+ domains equally with NO dominant topic

Consider:
1. The main subject matter and terminology used
2. Whether code examples are present and what type (system code vs algorithm vs web)
3. Technical vocabulary and concepts discussed
4. The overall purpose of the document

Output ONLY the domain name in lowercase. For example: programming`

  // Map the LLM response to a valid domain (ordered by specificity to avoid partial match issues)
  const domainMap: Record<string, DocumentDomain> = {
    'programming': 'programming',
    'algorithm': 'algorithm',
    'algorithms': 'algorithm',
    'ml': 'ml',
    'machine learning': 'ml',
    'machine_learning': 'ml',
    'deep learning': 'ml',
    'ai': 'ml',
    'meta_cognitive': 'meta_cognitive',
    'meta-cognitive': 'meta_cognitive',
    'metacognitive': 'meta_cognitive',
    'cognitive': 'meta_cognitive',
    'linux': 'linux',
    'devops': 'linux',
    'security': 'security',
    'cybersecurity': 'security',
    'ux_ui': 'ux_ui',
    'ux/ui': 'ux_ui',
    'ux': 'ux_ui',
    'ui': 'ux_ui',
    'user experience': 'ux_ui',
    'user interface': 'ux_ui',
    'design': 'ux_ui',
    'mixed': 'mixed',
    'general': 'mixed',
  }

  // Try LLM classification with retries
  const MAX_RETRIES = 2
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = slotIndex >= 0
        ? await callLLMSlot(slotIndex, classifyPrompt, classifySystemPrompt, 'classification')
        : await callLLM(classifyPrompt, classifySystemPrompt, 'classification')

      const domainText = result.content.trim().toLowerCase()

      // Skip empty responses
      if (!domainText || domainText.length === 0) {
        console.log(`[Classification] Attempt ${attempt + 1}: LLM returned empty response, retrying...`)
        continue
      }

      // Try exact match first
      if (domainMap[domainText]) {
        console.log(`[Classification] Attempt ${attempt + 1}: LLM classified as "${domainMap[domainText]}" (raw: "${domainText}")`)
        return domainMap[domainText]
      }

      // Try partial match — use priority order to avoid incorrect matches
      const priorityOrder: DocumentDomain[] = ['meta_cognitive', 'security', 'ux_ui', 'linux', 'algorithm', 'ml', 'programming', 'mixed']
      for (const targetDomain of priorityOrder) {
        for (const [key, domain] of Object.entries(domainMap)) {
          if (domain === targetDomain && (domainText.includes(key) || key.includes(domainText))) {
            console.log(`[Classification] Attempt ${attempt + 1}: LLM classified as "${domain}" (partial match from "${domainText}")`)
            return domain
          }
        }
      }

      console.log(`[Classification] Attempt ${attempt + 1}: Could not parse domain from LLM response: "${domainText}", retrying...`)
    } catch (err) {
      console.error(`[Classification] Attempt ${attempt + 1} failed:`, err instanceof Error ? err.message : String(err))
    }
  }

  // LLM classification failed all retries — use keyword-based fallback
  console.log(`[Classification] LLM classification failed after ${MAX_RETRIES} attempts — using keyword-based fallback`)
  const keywordDomain = classifyDomainByKeywords(textSample)
  if (keywordDomain !== 'mixed') {
    console.log(`[Classification] Keyword fallback classified as "${keywordDomain}"`)
  } else {
    console.log(`[Classification] Keyword fallback also returned "mixed" — document may be truly multi-domain`)
  }
  return keywordDomain
}

// ==================== ENTITY EXTRACTION ====================

function buildSystemPrompt(domain: DocumentDomain): string {
  const domainDescription: Record<DocumentDomain, string> = {
    programming: 'programming and software development', algorithm: 'algorithms and data structures',
    ml: 'machine learning and artificial intelligence', meta_cognitive: 'meta-cognitive reasoning and cognitive science',
    linux: 'Linux system administration and operations', security: 'cybersecurity and information security',
    ux_ui: 'UX/UI design, user experience, and user interface design', mixed: 'computer science and technology',
  }
  return `You are a knowledge extraction system specializing in ${domainDescription[domain] || 'technology'} domain.
From the following text, extract:
1. ENTITIES: Each with name, type (one of: Concept/Technology/Framework/Vulnerability/Principle/Domain/Document/Person), description, and properties
2. RELATIONSHIPS: Each with source entity name, target entity name, type (one of: PART_OF/IMPLEMENTED_IN/USES/EXPLOITS/MITIGATES/RUNS_ON/DEPENDS_ON/CONTRASTS_WITH/ENABLES/CONTAINS/EXTENDS/APPLIES_TO/CREATED_BY/DOCUMENTED_IN/ALTERNATIVE_TO), and description

ENTITY TYPES (with examples — choose the BEST match, never default to Concept):
- Concept: abstract idea OR algorithm/technique — "Encapsulation", "Quick Sort", "TDD", "Backpropagation"
- Technology: tool/platform/runtime/OS — "Docker", "Linux", "AWS", "Kubernetes"
- Framework: software framework/library — "Next.js", "Express", "React", "PyTorch"
- Vulnerability: security flaw — "SQL Injection", "XSS", "CSRF"
- Principle: rule/practice — "DRY", "SOLID", "Least Privilege"
- Domain: knowledge area — "Cybersecurity", "DevOps", "Machine Learning"
- Document: source PDF being processed — "ML_Textbook.pdf"
- Person: human author/creator — "Linus Torvalds", "Geoffrey Hinton"

RELATIONSHIP TYPES (with direction — source → target):
- PART_OF: A is component of B (Controller → MVC Pattern)
- IMPLEMENTED_IN: A built with B (React → JavaScript)
- USES: A uses B at runtime (Next.js → Webpack)
- EXPLOITS: A attacks B (Malware → SQL Injection)
- MITIGATES: A prevents B (Prepared Statements → SQL Injection)
- RUNS_ON: A executes on B (Docker → Linux)
- DEPENDS_ON: A requires B (App → Database)
- CONTRASTS_WITH: A opposed to B (SQL → NoSQL)
- ENABLES: A makes B possible (Containers → Microservices)
- CONTAINS: A includes B (Document → Entity)
- EXTENDS: A inherits from B (TypeScript → JavaScript)
- APPLIES_TO: A is relevant to B (GDPR → Web Apps)
- CREATED_BY: A made by person B (Linux → Linus Torvalds)
- DOCUMENTED_IN: A described in B (API → API_Docs.pdf)
- ALTERNATIVE_TO: A substitutes B (React ↔ Vue)

CRITICAL RULES:
- In relationships, the "source" and "target" MUST use the EXACT same name as the entity's "name" field. Do NOT abbreviate, rephrase, or use synonyms.
- Example: If entity name is "Quick Sort", the relationship source/target MUST be "Quick Sort", NOT "Quicksort" or "QS".
- Every relationship must reference entities that exist in the entities list above.
- EVERY entity you extract MUST appear in at least one relationship (as source or target). If you cannot find a meaningful relationship for an entity, DO NOT extract it.
- Prefer extracting FEWER entities with RICHER relationships over MANY entities with FEW or NO relationships.
- Aim for a 1:1 or higher ratio of relationships to entities. Each entity should be connected to the knowledge graph.

CRITICAL OUTPUT FORMAT (FIX 2026-08-27 — suppress chain-of-thought):
- Output ONLY valid JSON. No other text, no markdown fences, no explanation.
- Do NOT include any chain-of-thought, reasoning, or analysis before/after the JSON.
- The very FIRST character of your response MUST be '{'.
- The very LAST character of your response MUST be '}'.
- If you need to think internally, do it silently — never emit that thinking in the response.

Output ONLY valid JSON: { "entities": [{ "name": "", "type": "", "description": "", "properties": {} }], "relationships": [{ "source": "", "target": "", "type": "", "description": "" }], "domain": "..." }`
}

function parseLLMResponse(text: string): { entities: Array<{ name: string; type: string; description: string; properties: Record<string, unknown> }>; relationships: Array<{ source: string; target: string; type: string; description: string }>; domain: string; truncatedBeforeRelationships?: boolean } | null {
  try {
    let rawJson: unknown = null
    // FIX #1: track when truncation recovery was used → detect truncated-before-relationships
    let recoveryUsed = false
    const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
    if (codeBlockMatch) try { rawJson = JSON.parse(codeBlockMatch[1].trim()) } catch { /* ignore */ }
    if (!rawJson) { const jsonMatch = text.match(/\{[\s\S]*\}/); if (jsonMatch) try { rawJson = JSON.parse(jsonMatch[0]) } catch { /* ignore */ } }

    // TRUNCATION RECOVERY (FIX 2026-08-27): nemotron-3-ultra-550b là reasoning
    // model — khi max_tokens cắt giữa chừng, JSON không có `}` kết thúc và cả 2
    // regex trên đều fail. Thử close braces còn thiếu để recover ít nhất các
    // entities/relationships đã emit trước khi bị cắt.
    if (!rawJson) {
      const start = text.indexOf('{')
      if (start >= 0) {
        let partial = text.slice(start).trim()
        // Cắt token cuối chưa hoàn chỉnh (sau dấu phẩy hoặc giữa string/value)
        // Bỏ phần cuối sau dấu phẩy cuối cùng để tránh lỗi "Unexpected token"
        partial = partial.replace(/,\s*$/, '')
        // Cắt đứt một string value đang mở — bỏ `"` cuối nếu số lượng quote lẻ
        const quoteCount = (partial.match(/"/g) || []).length
        if (quoteCount % 2 === 1) partial += '"'
        // Đếm số brace/bracket chưa đóng và auto-close
        const openBrace = (partial.match(/{/g) || []).length
        const closeBrace = (partial.match(/}/g) || []).length
        const openBracket = (partial.match(/\[/g) || []).length
        const closeBracket = (partial.match(/\]/g) || []).length
        partial += ']'.repeat(Math.max(0, openBracket - closeBracket))
        partial += '}'.repeat(Math.max(0, openBrace - closeBrace))
        try {
          rawJson = JSON.parse(partial)
          recoveryUsed = true
          console.log(`[Parse] Recovered truncated JSON: added ${Math.max(0, openBracket - closeBracket)} ']' + ${Math.max(0, openBrace - closeBrace)} '}' (original length=${text.length})`)
        } catch (recoverErr) {
          // JSON vẫn lỗi — ghi log ngắn để chẩn đoán thay vì nuốt im lặng
          console.warn(`[Parse] JSON truncation recovery failed: ${recoverErr instanceof Error ? recoverErr.message : String(recoverErr)}. Preview: ${partial.slice(0, 300)}...`)
        }
      }
    }
    if (!rawJson || typeof rawJson !== 'object') return null
    const parsed = rawJson as Record<string, unknown>

    const normalizedEntities: Array<{ name: string; type: string; description: string; properties: Record<string, unknown> }> = []
    if (Array.isArray(parsed.entities)) {
      for (const item of parsed.entities) {
        if (typeof item === 'string') {
          normalizedEntities.push({ name: item.trim(), type: 'Concept', description: '', properties: {} })
        } else if (typeof item === 'object' && item !== null) {
          const obj = item as Record<string, unknown>
          if (obj.name && typeof obj.name === 'string' && obj.name.trim()) {
            normalizedEntities.push({
              name: String(obj.name).trim(), type: String(obj.type || 'Concept').trim(),
              description: String(obj.description || '').trim(),
              properties: (obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties)) ? obj.properties as Record<string, unknown> : {},
            })
          } else {
            const name = obj.title || obj.label || obj.entity || obj.term || obj.value || obj.id || ''
            if (name && typeof name === 'string' && name.trim()) {
              normalizedEntities.push({
                name: name.trim(), type: String(obj.type || obj.category || obj.entity_type || 'Concept').trim(),
                description: String(obj.description || obj.desc || obj.about || '').trim(),
                properties: (obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties)) ? obj.properties as Record<string, unknown> : {},
              })
            }
          }
        }
      }
    }

    const normalizedRelationships: Array<{ source: string; target: string; type: string; description: string }> = []
    if (Array.isArray(parsed.relationships)) {
      for (const item of parsed.relationships) {
        if (typeof item === 'object' && item !== null) {
          const obj = item as Record<string, unknown>
          const source = String(obj.source || obj.from || obj.source_entity || '').trim()
          const target = String(obj.target || obj.to || obj.target_entity || '').trim()
          if (source && target) normalizedRelationships.push({ source, target, type: String(obj.type || obj.relationship_type || obj.relation || 'RELATED_TO').trim(), description: String(obj.description || '').trim() })
        }
      }
    }
    // FIX #1: detect truncation-before-relationships — the model output was cut at
    // max_tokens BEFORE it could emit the relationships array. The truncation
    // recovery "succeeded" (valid JSON) but silently produced relationships: [].
    // This is the root cause of Neo4j node count rising while relationship count
    // stays flat. The caller retries with a relationships-only prompt (Fix #1b).
    const truncatedBeforeRelationships = recoveryUsed && normalizedEntities.length > 0 && normalizedRelationships.length === 0
    if (truncatedBeforeRelationships) {
      console.warn(`[Parse] TRUNCATION-BEFORE-RELATIONSHIPS detected: recovered JSON has ${normalizedEntities.length} entities but 0 relationships (recoveryUsed=true). Caller will retry relationships-only extraction.`)
    }
    return { entities: normalizedEntities, relationships: normalizedRelationships, domain: typeof parsed.domain === 'string' ? parsed.domain : '', truncatedBeforeRelationships }
  } catch { return null }
}

function normalizeEntityType(type: string): EntityType {
  const match = VALID_ENTITY_TYPES.find(t => t.toLowerCase() === type.trim().toLowerCase())
  if (match) return match
  const partial = VALID_ENTITY_TYPES.find(t => t.toLowerCase().includes(type.trim().toLowerCase()) || type.trim().toLowerCase().includes(t.toLowerCase()))
  return partial || 'Concept'
}

function normalizeRelationshipType(type: string): RelationshipType {
  const normalized = type.trim().toUpperCase().replace(/\s+/g, '_')
  if (VALID_RELATIONSHIP_TYPES.includes(normalized as RelationshipType)) return normalized as RelationshipType
  const match = VALID_RELATIONSHIP_TYPES.find(t => t.includes(normalized) || normalized.includes(t))
  return match || 'RELATED_TO'
}

async function extractFromChunk(chunkContent: string, domain: DocumentDomain, chunkIndex: number, slotIndex: number = -1): Promise<{ entities: ExtractedEntity[]; relationships: ExtractedRelationship[]; provider: string; model: string }> {
  const systemPrompt = buildSystemPrompt(domain)
  const userPrompt = `Text to analyze (chunk ${chunkIndex}):\n\n${chunkContent}`
  let confidenceScore = 0.7
  let provider = 'unknown'
  let model = 'unknown'
  try {
    // Use key-based LLM call for extraction (each doc uses its own dedicated API key)
    // EXTRACTION MAX_TOKENS FIX 2026-08-27: truyền { maxTokens: 16384 } rõ ràng
    // để phòng ngược — nếu default trong llm.ts bị đổi về 4096 thì extract
    // vẫn dùng 16384, tránh JSON bị cắt giữa chừng.
    const result = slotIndex >= 0
      ? await callLLMSlot(slotIndex, userPrompt, systemPrompt, 'extraction', { maxTokens: 16384 })
      : await callLLM(userPrompt, systemPrompt, 'extraction', { maxTokens: 16384 })
    provider = result.provider; model = result.model

    // FINISH_REASON='length' WARNING (FIX 2026-08-27): model reasoning bị cắt
    // max_tokens — JSON chắc chắn chưa hoàn chỉnh, parse sẽ fail hoặc recover
    // không đầy đủ. Log để chẩn đoán gốc rễ của “dừng sớm sau vài nghìn token”.
    if (result.finish_reason === 'length') {
      console.warn(`[Extract] Chunk ${chunkIndex}: finish_reason=length — model output bị cắt tại max_tokens (provider=${provider}/${model}). JSON có thể truncated.`)
    }

    // EMPTY CONTENT WARNING (FIX 2026-08-27): trước đây trả im lặng 0 entities
    // mà không log — che giấu rate-limit/auth failures. Giờ log rõ để chẩn đoán.
    if (!result.content) {
      console.warn(`[Extract] Chunk ${chunkIndex}: LLM trả content rỗng (provider=${provider}/${model}, finish_reason=${result.finish_reason || 'none'}). Có thể rate-limit/auth error.`)
      return { entities: [], relationships: [], provider, model }
    }

    const parsed = parseLLMResponse(result.content)
    if (!parsed) {
      console.warn(`[Extract] Chunk ${chunkIndex}: parseLLMResponse trả null — JSON không parse được (content length=${result.content.length}, finish_reason=${result.finish_reason || 'none'}). Preview: ${result.content.slice(0, 200)}...`)
      confidenceScore = 0.3
      return { entities: [], relationships: [], provider, model }
    }
    const entities: ExtractedEntity[] = (parsed.entities || []).filter(e => e.name && e.name.trim()).map(e => ({
      name: e.name.trim(), type: normalizeEntityType(e.type || ''), description: (e.description || '').trim(),
      properties: (e.properties && typeof e.properties === 'object' && !Array.isArray(e.properties) ? e.properties : {}) as Record<string, string | number | boolean>,
      confidenceScore, source: `${provider}/${model}`, domain,
    }))
    let relationships: ExtractedRelationship[] = (parsed.relationships || []).filter(r => r.source && r.target && r.source.trim() && r.target.trim()).map(r => ({
      source: r.source.trim(), target: r.target.trim(), type: normalizeRelationshipType(r.type || ''),
      description: (r.description || '').trim(), confidenceScore, source_provider: `${provider}/${model}`,
    }))

    // FIX #1b: If the JSON was truncated BEFORE relationships were emitted, the
    // relationships array is empty even though entities exist. Retry the LLM call
    // ONCE with a focused "relationships-only" prompt (listing the extracted
    // entities) to recover the lost relationship data. This is the primary fix
    // for the "entities increase but relationships stay flat" symptom.
    if (parsed.truncatedBeforeRelationships && entities.length > 0 && relationships.length === 0) {
      try {
        const entityList = entities.map((e, i) => `${i + 1}. ${e.name} (${e.type})`).join('\n')
        const retrySystem = `You are a relationship extractor. The previous extraction was truncated before relationships were emitted. Given the entities below, output ONLY a JSON array of relationships. Format: [{"source":"<exact entity name>","target":"<exact entity name>","type":"<RELATIONSHIP_TYPE>","description":"<short>"}]. Source and target MUST exactly match entity names from the list. Output ONLY the JSON array — no code fences, no explanation, no surrounding object.`
        const retryUser = `Entities extracted from chunk ${chunkIndex}:\n${entityList}\n\n--- Chunk text ---\n${chunkContent}`
        const retryResult = slotIndex >= 0
          ? await callLLMSlot(slotIndex, retryUser, retrySystem, 'extraction', { maxTokens: 8192 })
          : await callLLM(retryUser, retrySystem, 'extraction', { maxTokens: 8192 })
        if (retryResult.content) {
          // Parse the retry response — it's a bare JSON array (not the full object)
          const arrMatch = retryResult.content.match(/\[[\s\S]*\]/)
          if (arrMatch) {
            try {
              const parsedArr = JSON.parse(arrMatch[0])
              if (Array.isArray(parsedArr)) {
                const retryRels: ExtractedRelationship[] = parsedArr
                  .filter((r: Record<string, unknown>) => r && typeof r === 'object' && r.source && r.target)
                  .map((r: Record<string, unknown>) => ({
                    source: String(r.source).trim(),
                    target: String(r.target).trim(),
                    type: normalizeRelationshipType(String(r.type || r.relationship_type || r.relation || 'RELATED_TO')),
                    description: String(r.description || '').trim(),
                    confidenceScore, source_provider: `${provider}/${model}`,
                  }))
                  .filter((r: ExtractedRelationship) => r.source && r.target) as ExtractedRelationship[]
                if (retryRels.length > 0) {
                  console.log(`[Extract] Chunk ${chunkIndex}: truncation retry recovered ${retryRels.length} relationships (original parse had 0)`)
                  relationships = retryRels
                } else {
                  console.warn(`[Extract] Chunk ${chunkIndex}: truncation retry returned 0 parseable relationships (retry content length=${retryResult.content.length})`)
                }
              }
            } catch (retryParseErr) {
              console.warn(`[Extract] Chunk ${chunkIndex}: truncation retry JSON parse failed:`, retryParseErr instanceof Error ? retryParseErr.message : String(retryParseErr))
            }
          } else {
            console.warn(`[Extract] Chunk ${chunkIndex}: truncation retry produced no JSON array match (content preview: ${retryResult.content.slice(0, 200)}...)`)
          }
        } else {
          console.warn(`[Extract] Chunk ${chunkIndex}: truncation retry returned empty content`)
        }
      } catch (retryErr) {
        console.warn(`[Extract] Chunk ${chunkIndex}: truncation retry LLM call failed:`, retryErr instanceof Error ? retryErr.message : String(retryErr))
      }
    }

    // ORPHAN PREVENTION: Filter out entities that don't appear in any relationship.
    // The LLM prompt requires every entity to have a relationship, but LLMs don't always comply.
    // This enforcement ensures only connected entities are saved, preventing orphan accumulation.
    if (relationships.length > 0 && entities.length > 0) {
      const entityNamesInRels = new Set<string>()
      for (const rel of relationships) {
        entityNamesInRels.add(rel.source.toLowerCase().trim())
        entityNamesInRels.add(rel.target.toLowerCase().trim())
      }
      const connectedEntities = entities.filter(e => entityNamesInRels.has(e.name.toLowerCase().trim()))
      const droppedCount = entities.length - connectedEntities.length
      if (droppedCount > 0) {
        console.log(`[Extract] Chunk ${chunkIndex}: Dropped ${droppedCount} orphan entities (no relationships) out of ${entities.length}`)
      }
      return { entities: connectedEntities, relationships, provider, model }
    }

    return { entities, relationships, provider, model }
  } catch (extractErr) {
    // Log the error instead of silently swallowing — helps debugging provider failures
    console.warn(`[Extract] extractFromChunk FAILED for doc ${documentId?.slice(0, 8) || '?'} chunk ${chunkIndex}:`, extractErr instanceof Error ? extractErr.message : String(extractErr))
    return { entities: [], relationships: [], provider, model }
  }
}

// ==================== ENTITY RESOLUTION (delegated to @/lib/ingestion/entity-resolver) ====================
// Phase 5.5: Removed duplicate inline resolver code (levenshteinDistance, stringSimilarity,
// exactMatchResolution, fuzzyMatchResolution, resolveEntities).
// Now imports from @/lib/ingestion/entity-resolver for single source of truth.

/** Resolve and deduplicate entities using the shared entity-resolver module.
 *  Wraps the lib's resolveEntities to accept the local ExtractedEntity type
 *  (which has EntityType instead of string for the type field). */
function resolveEntities(entities: ExtractedEntity[]): { resolved: ResolvedEntity[]; duplicates: DuplicatePair[]; stats: { totalInput: number; afterExactMatch: number; afterFuzzyMatch: number; finalCount: number } } {
  // The lib's ExtractedEntity uses `type: string`, our local one uses `type: EntityType`.
  // They are structurally identical, so a simple cast works.
  return resolveEntitiesLib(entities as any)
}

// ==================== DOCUMENT PROGRESS HELPERS ====================

/** FIX #10: Verify Neo4j holds (nearly) all of this doc's relationships.
 *  Returns:
 *   - 'complete': nothing to write (SQLite 0 rels) OR Neo4j has ≥50% of SQLite's rels
 *   - 'missing':  SQLite has rels but Neo4j has 0 (write failed silently)
 *   - 'partial':  Neo4j has far fewer rels than SQLite (< 50%) — partial write,
 *                 e.g. 9 rels in Neo4j vs 500 in SQLite from a crashed batch
 *   - 'unknown':  the COUNT query itself failed — caller should be conservative
 *
 *  Why 50% and not an exact match? A successful write lands ~90%+ of SQLite
 *  rels in Neo4j (dedup/resolve drops a few — e.g. 730 SQLite → 711 Neo4j).
 *  50% catches catastrophic partial writes without false-positives on dedup.
 *  Re-running the Neo4j step is always safe — writes use MERGE (no duplicates). */
async function verifyNeo4jRelCoverage(documentId: string): Promise<'complete' | 'missing' | 'partial' | 'unknown'> {
  try {
    const sqliteRelCount = await db.localRelationship.count({ where: { documentId } })
    if (sqliteRelCount === 0) return 'complete' // extraction produced no relationships — nothing to write
    const neo4jCountResult = await readCypher<{ cnt: number }>(
      `MATCH ()-[r]->() WHERE r.documentId = $documentId AND type(r) <> 'CONTAINS' RETURN count(r) AS cnt`,
      { documentId }
    )
    const neo4jRelCount = neo4jCountResult[0]?.cnt ?? 0
    if (neo4jRelCount === 0) return 'missing'
    if (neo4jRelCount * 2 < sqliteRelCount) return 'partial'
    return 'complete'
  } catch {
    return 'unknown'
  }
}

/** FIX #9 (BUG B): Ensure the SQLite Document row exists before updating it.
 *  Docs restored from R2 via the POST handler's R2 fallback got a Qdrant record
 *  but NO SQLite row — every subsequent db.document.update() failed with
 *  "No record was found for an update", so the doc's status/progress was never
 *  persisted to SQLite (doc list flips back to 'uploaded', stats miss the doc).
 *  This helper creates the missing row from the Qdrant payload (source of truth). */
async function ensureSqliteDocumentRow(documentId: string): Promise<boolean> {
  try {
    const existing = await db.document.findUnique({ where: { id: documentId }, select: { id: true } })
    if (existing) return true // row already exists

    const docPayload = await getDocument(documentId)
    if (!docPayload) return false // nothing to source from — give up quietly

    // title is @unique in the schema. R2-restored docs use "<docId>_<filename>"
    // as the title (naturally unique). For any other path, fall back to
    // "<title>-<docId8>" if the plain title is already taken by another doc.
    let title = (docPayload.title as string) || `document-${documentId.slice(0, 8)}`
    const titleTaken = await db.document.findUnique({ where: { title }, select: { id: true } })
    if (titleTaken && titleTaken.id !== documentId) {
      title = `${title}-${documentId.slice(0, 8)}`
    }

    await db.document.create({
      data: {
        id: documentId,
        title,
        filePath: (docPayload.file_path as string) || '',
        domain: (docPayload.domain as string) || 'mixed',
        pageCount: (docPayload.page_count as number | null) ?? null,
        status: (docPayload.status as string) || 'uploaded',
        errorMessage: (docPayload.error_message as string | null) ?? null,
        processingSteps: JSON.stringify(docPayload.processing_steps || []),
        processingPercent: (docPayload.processing_percent as number) || 0,
        createdAt: docPayload.created_at ? new Date(docPayload.created_at) : new Date(),
      },
    })
    console.log(`[Process] FIX #9: Created missing SQLite Document row for ${documentId.slice(0, 8)}... (title="${title.slice(0, 40)}", status=${docPayload.status})`)
    return true
  } catch (err) {
    console.warn(`[Process] FIX #9: Failed to create SQLite Document row for ${documentId.slice(0, 8)}...:`, err instanceof Error ? err.message : String(err))
    return false
  }
}

async function updateDocProgress(
  documentId: string,
  updates: {
    status?: string
    errorMessage?: string
    steps?: ProcessingStepRecord[]
    extractProgress?: { processed: number; total: number }
    pageCount?: number
    domain?: string
  }
): Promise<void> {
  // PAUSE GUARD: If the document is paused, do NOT overwrite the 'partial' status
  // with any other status (e.g., 'extracting'). Only allow status='partial' updates
  // (e.g., from the pause handler itself) or updates that don't change status.
  // This prevents the running pipeline from reverting the pause status.
  if (isDocPaused(documentId) && updates.status && updates.status !== 'partial') {
    console.log(`[Process] Skipping status update '${updates.status}' for paused doc ${documentId.slice(0, 8)}... — keeping 'partial'`)
    // Still update steps/progress if provided, but don't change status
    const safeUpdates = { ...updates }
    delete safeUpdates.status
    if (Object.keys(safeUpdates).length === 0) return // Nothing to update
    const qdrantUpdates: Record<string, unknown> = {}
    if (safeUpdates.errorMessage) qdrantUpdates.error_message = safeUpdates.errorMessage
    if (safeUpdates.steps) {
      qdrantUpdates.processing_steps = safeUpdates.steps as DocumentPayload['processing_steps']
      qdrantUpdates.processing_percent = calcPercentFromSteps(safeUpdates.steps, safeUpdates.extractProgress)
    }
    if (safeUpdates.pageCount) qdrantUpdates.page_count = safeUpdates.pageCount
    if (safeUpdates.domain) qdrantUpdates.domain = safeUpdates.domain
    if (Object.keys(qdrantUpdates).length > 0) {
      await updateDocumentStatus(documentId, qdrantUpdates)
      // SYNC to SQLite (same as main path below)
      try {
        const sqliteData: Record<string, unknown> = {}
        if (qdrantUpdates.processing_steps) sqliteData.processingSteps = JSON.stringify(qdrantUpdates.processing_steps)
        if (qdrantUpdates.processing_percent !== undefined) sqliteData.processingPercent = qdrantUpdates.processing_percent as number
        if (qdrantUpdates.error_message) sqliteData.errorMessage = qdrantUpdates.error_message as string
        if (qdrantUpdates.page_count) sqliteData.pageCount = qdrantUpdates.page_count as number
        if (qdrantUpdates.domain) sqliteData.domain = qdrantUpdates.domain as string
        if (Object.keys(sqliteData).length > 0) {
          await db.document.update({ where: { id: documentId }, data: sqliteData })
        }
      } catch { /* non-fatal */ }
    }
    return
  }

  const qdrantUpdates: Record<string, unknown> = {}
  if (updates.status) qdrantUpdates.status = updates.status
  if (updates.errorMessage) qdrantUpdates.error_message = updates.errorMessage
  else if (updates.status && updates.status !== 'error') qdrantUpdates.error_message = null
  if (updates.steps) {
    qdrantUpdates.processing_steps = updates.steps as DocumentPayload['processing_steps']
    qdrantUpdates.processing_percent = calcPercentFromSteps(updates.steps, updates.extractProgress)
  }
  if (updates.pageCount) qdrantUpdates.page_count = updates.pageCount
  if (updates.domain) qdrantUpdates.domain = updates.domain
  await updateDocumentStatus(documentId, qdrantUpdates)

  // SYNC to SQLite — keep SQLite in sync with Qdrant so that fetchAllDocuments()
  // returns fresh data. Without this, the GET handler reads stale SQLite data
  // and the document appears to "revert" to its old status in the UI.
  try {
    const sqliteData: Record<string, unknown> = {}
    if (qdrantUpdates.status) sqliteData.status = qdrantUpdates.status
    if (qdrantUpdates.error_message !== undefined) sqliteData.errorMessage = qdrantUpdates.error_message as string | null
    if (qdrantUpdates.processing_steps) sqliteData.processingSteps = JSON.stringify(qdrantUpdates.processing_steps)
    if (qdrantUpdates.processing_percent !== undefined) sqliteData.processingPercent = qdrantUpdates.processing_percent as number
    if (qdrantUpdates.page_count) sqliteData.pageCount = qdrantUpdates.page_count as number
    if (qdrantUpdates.domain) sqliteData.domain = qdrantUpdates.domain as string
    if (Object.keys(sqliteData).length > 0) {
      await db.document.update({ where: { id: documentId }, data: sqliteData })
    }
  } catch (sqliteErr) {
    // FIX #9 (BUG B): the row may not exist yet (doc restored from R2 via the POST
    // fallback path created only a Qdrant record). Create it from the Qdrant
    // payload, then retry the update once — status/progress now persists.
    const created = await ensureSqliteDocumentRow(documentId)
    if (created) {
      try {
        const sqliteData: Record<string, unknown> = {}
        if (qdrantUpdates.status) sqliteData.status = qdrantUpdates.status
        if (qdrantUpdates.error_message !== undefined) sqliteData.errorMessage = qdrantUpdates.error_message as string | null
        if (qdrantUpdates.processing_steps) sqliteData.processingSteps = JSON.stringify(qdrantUpdates.processing_steps)
        if (qdrantUpdates.processing_percent !== undefined) sqliteData.processingPercent = qdrantUpdates.processing_percent as number
        if (qdrantUpdates.page_count) sqliteData.pageCount = qdrantUpdates.page_count as number
        if (qdrantUpdates.domain) sqliteData.domain = qdrantUpdates.domain as string
        if (Object.keys(sqliteData).length > 0) {
          await db.document.update({ where: { id: documentId }, data: sqliteData })
        }
      } catch (retryErr) {
        console.warn(`[Process] SQLite sync retry failed for ${documentId.slice(0, 8)}:`, retryErr instanceof Error ? retryErr.message : String(retryErr))
      }
    } else {
      // Non-fatal — Qdrant is the source of truth, SQLite is a cache
      console.warn(`[Process] SQLite sync failed for ${documentId.slice(0, 8)}:`, sqliteErr instanceof Error ? sqliteErr.message : String(sqliteErr))
    }
  }
}

/** Pipeline step definition for progress tracking */
interface PipelineStep {
  name: string
  label: string    // Vietnamese display label
  weight: number   // percentage weight (should sum to 100)
}

const PIPELINE_STEPS: PipelineStep[] = [
  { name: 'download', label: 'Tải PDF', weight: 5 },
  { name: 'parse', label: 'Phân tích PDF', weight: 10 },
  { name: 'chunk', label: 'Chia chunks', weight: 5 },
  { name: 'extract', label: 'Trích xuất entities', weight: 50 },
  { name: 'resolve', label: 'Hợp nhất entities', weight: 10 },
  { name: 'neo4j', label: 'Ghi Neo4j', weight: 10 },
  { name: 'embeddings', label: 'Tạo embeddings', weight: 10 },
]

interface ProcessingStepRecord {
  name: string
  label: string
  status: 'pending' | 'running' | 'completed' | 'error'
  startedAt: string | null
  completedAt: string | null
  detail: string | null
}

/** Get default processing steps (all pending) */
function getDefaultSteps(): ProcessingStepRecord[] {
  return PIPELINE_STEPS.map(s => ({
    name: s.name, label: s.label, status: 'pending' as const,
    startedAt: null, completedAt: null, detail: null,
  }))
}

/** Calculate percentage from steps */
function calcPercentFromSteps(steps: ProcessingStepRecord[], extractProgress?: { processed: number; total: number }): number {
  let percent = 0
  for (let i = 0; i < PIPELINE_STEPS.length; i++) {
    const step = steps[i]
    const weight = PIPELINE_STEPS[i].weight
    if (step.status === 'completed') {
      percent += weight
    } else if (step.status === 'running' && step.name === 'extract' && extractProgress) {
      // For extraction, calculate partial progress
      const partial = extractProgress.total > 0 ? (extractProgress.processed / extractProgress.total) : 0
      percent += weight * partial
    }
  }
  return Math.min(100, Math.round(percent))
}

/** Mark a step as running */
function markStepRunning(steps: ProcessingStepRecord[], stepName: string, detail?: string): ProcessingStepRecord[] {
  return steps.map(s => s.name === stepName
    ? { ...s, status: 'running' as const, startedAt: new Date().toISOString(), completedAt: null, detail: detail || s.detail }
    : s
  )
}

/** Mark a step as completed */
function markStepCompleted(steps: ProcessingStepRecord[], stepName: string, detail?: string): ProcessingStepRecord[] {
  return steps.map(s => s.name === stepName
    ? { ...s, status: 'completed' as const, completedAt: new Date().toISOString(), detail: detail || s.detail }
    : s
  )
}

/** Mark a step as error */
function markStepError(steps: ProcessingStepRecord[], stepName: string, detail: string): ProcessingStepRecord[] {
  return steps.map(s => s.name === stepName
    ? { ...s, status: 'error' as const, completedAt: new Date().toISOString(), detail }
    : s
  )
}

/** Mark a step as pending (not yet started) with optional detail message */
function markStepPending(steps: ProcessingStepRecord[], stepName: string, detail?: string): ProcessingStepRecord[] {
  return steps.map(s => s.name === stepName
    ? { ...s, status: 'pending' as const, startedAt: null, completedAt: null, detail: detail || null }
    : s
  )
}

async function deleteOldDocumentData(documentId: string): Promise<void> {
  // Step 5: Delete old chunks (which also contain embeddings) from Qdrant
  await deleteChunksByDocument(documentId)
  // Delete old relationships from SQLite buffer
  await db.localRelationship.deleteMany({ where: { documentId } })
  // Delete old entities from SQLite buffer
  await db.localEntity.deleteMany({ where: { documentId } })
  // Delete old resolved entities from SQLite buffer — only for this document
  await db.localResolvedEntity.deleteMany({ where: { documentId } })
}

// ==================== NEO4J WRITING ====================

/** Check if an error is a Neo4j timeout or transient error that warrants a retry */
function isNeo4jRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  // Neo4j driver timeout errors
  if (msg.includes('connection acquisition timed out')) return true
  if (msg.includes('connection timed out')) return true
  if (msg.includes('transaction timed out')) return true
  if (msg.includes('session expired')) return true
  if (msg.includes('connection pool closed')) return true
  if (msg.includes('no longer available')) return true
  if (msg.includes('service unavailable')) return true
  if (msg.includes('transient error')) return true
  if (msg.includes('failed to acquire connection')) return true
  // Neo4j error codes for transient errors
  if (msg.includes('neo4jerror') && msg.includes('transient')) return true
  return false
}

/** Wrap a Neo4j session operation with a timeout and retry logic.
 *  Retries up to `maxRetries` times with exponential backoff on retryable errors.
 *  Returns the result or throws the last error if all retries are exhausted.
 */
async function withNeo4jRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries: number = 3,
  baseDelayMs: number = 2000
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation()
    } catch (err) {
      lastError = err
      if (attempt < maxRetries && isNeo4jRetryableError(err)) {
        const delay = baseDelayMs * Math.pow(2, attempt)
        console.warn(`[Neo4j] ${operationName} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms:`, err instanceof Error ? err.message : String(err))
        await new Promise(r => setTimeout(r, delay))
      } else {
        break
      }
    }
  }
  throw lastError
}

async function writeEntitiesToNeo4j(
  entities: Array<{ id: string; name: string; type: string; domain: string; description: string; confidence: number }>,
  relationships: Array<{ sourceId: string; targetId: string; sourceName: string; targetName: string; type: string; description?: string; confidence?: number }>,
  documentId: string,
  skipDeletion: boolean = false
): Promise<{ nodesCreated: number; relationshipsCreated: number }> {
  // ========================================================================
  // CROSS-DOCUMENT ENTITY DEDUPLICATION:
  //
  // Global Entity IDs: `global__${normalized_name}__${type}`
  // - Same entity across documents → same node → MERGE naturally deduplicates.
  // - "Python" in 10 documents → 1 node with CONTAINS from 10 Document nodes.
  //
  // This replaces the old per-document ID scheme (`docId__name__type`) which
  // created duplicate nodes for the same entity across documents.
  //
  // Within-document dedup is still done first (same entity in 50 chunks → 1 canonical),
  // then Neo4j MERGE handles cross-document dedup.
  // ========================================================================

  // Step 1: Deduplicate entities by (name, type) within this document's extraction
  const entityByKey = new Map<string, { name: string; type: string; domain: string; description: string; confidence: number; originalIds: string[] }>()
  for (const entity of entities) {
    const key = `${entity.name.toLowerCase().trim()}||${entity.type}`
    const existing = entityByKey.get(key)
    if (existing) {
      // Merge: keep longest description, highest confidence, collect all original IDs
      if (entity.description.length > existing.description.length) existing.description = entity.description
      if (entity.confidence > existing.confidence) existing.confidence = entity.confidence
      existing.originalIds.push(entity.id)
    } else {
      entityByKey.set(key, {
        name: entity.name, type: entity.type, domain: entity.domain,
        description: entity.description, confidence: entity.confidence,
        originalIds: [entity.id],
      })
    }
  }

  // Step 2: Create GLOBAL deterministic node IDs based on (name, type) — NO documentId.
  // Cross-document dedup: "Python" in doc A and doc B → same `global__python__concept` ID → MERGE creates 1 node.
  const deduplicatedEntities = Array.from(entityByKey.values()).map(e => ({
    id: `global__${e.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}__${e.type.toLowerCase()}`,
    name: e.name, type: e.type, domain: e.domain,
    description: e.description, confidence: e.confidence,
  }))

  // Step 3: Build a map from original entity IDs → deduplicated entity IDs
  const originalToDedupedId = new Map<string, string>()
  for (const e of entityByKey.values()) {
    const dedupedId = `global__${e.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}__${e.type.toLowerCase()}`
    for (const origId of e.originalIds) {
      originalToDedupedId.set(origId, dedupedId)
    }
  }

  // Step 4: Remap relationships to deduplicated entity IDs and deduplicate by (source, target, type)
  const relByKey = new Map<string, { sourceId: string; targetId: string; sourceName: string; targetName: string; type: string; description: string; confidence: number }>()
  for (const rel of relationships) {
    const dedupedSourceId = originalToDedupedId.get(rel.sourceId) || rel.sourceId
    const dedupedTargetId = originalToDedupedId.get(rel.targetId) || rel.targetId
    // Skip self-relationships (same deduplicated source and target)
    if (dedupedSourceId === dedupedTargetId) continue
    const key = `${dedupedSourceId}||${dedupedTargetId}||${rel.type}`
    if (!relByKey.has(key)) {
      relByKey.set(key, {
        sourceId: dedupedSourceId, targetId: dedupedTargetId,
        sourceName: rel.sourceName, targetName: rel.targetName, type: rel.type,
        description: rel.description || '', confidence: rel.confidence || 0,
      })
    }
  }
  const deduplicatedRels = Array.from(relByKey.values())

  console.log(`[Neo4j] Deduplication: ${entities.length} raw entities → ${deduplicatedEntities.length} canonical nodes, ${relationships.length} raw rels → ${deduplicatedRels.length} canonical edges`)

  // Step 5: Write deduplicated data to Neo4j
  // Use safeSession for zombie driver recovery
  let session: import('neo4j-driver').Session | null = null
  try {
    session = await safeSession()
  } catch (err: any) {
    console.error(`[Neo4j] Failed to acquire session for ${documentId}:`, err instanceof Error ? err.message : String(err))
    return { nodesCreated: 0, relationshipsCreated: 0 }
  }
  const NEO4J_SESSION_TIMEOUT_MS = 60_000 // 60s per session operation timeout
  let nodesCreated = 0; let relationshipsCreated = 0
  let neo4jTimedOut = false
  try {
    // ========================================================================
    // CROSS-DOCUMENT SAFE DELETION:
    //
    // With global entity IDs, nodes are shared across documents. We CANNOT
    // delete nodes by documentId because other documents may reference them.
    //
    // Instead, we:
    // 1. Delete CONTAINS relationships for this document (Document→Entity links)
    // 2. Delete entity-to-entity relationships for this document
    // 3. After writing new data, delete orphaned nodes (no CONTAINS from ANY document)
    //
    // For fresh processing (!skipDeletion): full cleanup + orphan removal
    // For re-extract (skipDeletion): only delete relationships, keep nodes
    // ========================================================================

    // Step 5a: Delete CONTAINS relationships for this document
    // This removes the link from Document node to Entity nodes without deleting the entities.
    try {
      await session.executeWrite(tx =>
        tx.run(
          `MATCH (d:Document {id: $documentId})-[r:CONTAINS]->(e) DELETE r RETURN count(r) AS deleted`,
          { documentId }
        )
      )
    } catch (err) {
      console.warn(`[Neo4j] CONTAINS relationship deletion failed:`, err instanceof Error ? err.message : String(err))
    }

    // Step 5b: Delete entity-to-entity relationships for this document
    // These have documentId property, so we can target them precisely.
    try {
      const relDeleteResult = await session.executeWrite(tx =>
        tx.run(
          `MATCH ()-[r]->() WHERE (r.documentId = $documentId OR r.document_id = $documentId) AND NOT type(r) = 'CONTAINS' DELETE r RETURN count(r) AS deleted`,
          { documentId }
        )
      )
      const relsDeleted = relDeleteResult.records.length > 0 ? relDeleteResult.records[0].get('deleted') : 0
      console.log(`[Neo4j] Deleted CONTAINS + entity relationships for document ${documentId} (${typeof relsDeleted === 'object' && relsDeleted?.toNumber ? relsDeleted.toNumber() : relsDeleted} entity rels)`)
    } catch (err) {
      console.warn(`[Neo4j] Relationship deletion failed:`, err instanceof Error ? err.message : String(err))
    }

    // Step 5c: For fresh processing, also delete old per-document nodes that used the
    // `documentId__name__type` ID scheme (legacy migration). These old-format nodes
    // have IDs starting with the documentId prefix.
    if (!skipDeletion) {
      try {
        const idPrefix = `${documentId}__`
        let legacyDeleted = 0
        let hasMore = true
        let maxBatches = 100
        while (hasMore && maxBatches > 0) {
          const result = await Promise.race([
            session.executeWrite(tx =>
              tx.run(
                'MATCH (n) WHERE n.id STARTS WITH $idPrefix WITH n LIMIT 5000 DETACH DELETE n RETURN count(n) as deleted',
                { idPrefix }
              )
            ),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Legacy node deletion timed out`)), 60_000)
            ),
          ])
          const deleted = result.records.length > 0 ? result.records[0].get('deleted').toNumber() : 0
          legacyDeleted += deleted
          hasMore = deleted >= 5000
          maxBatches--
        }
        if (legacyDeleted > 0) {
          console.log(`[Neo4j] Deleted ${legacyDeleted} legacy per-document nodes (old ID scheme) for document ${documentId}`)
        }
      } catch (err) {
        console.warn(`[Neo4j] Legacy node cleanup failed:`, err instanceof Error ? err.message : String(err))
      }
    } else {
      console.log(`[Neo4j] Re-extract mode: using MERGE for incremental update (no node deletion)`)
    }

    // BATCH WRITE ENTITIES using UNWIND (much faster than individual queries)
    // Group entities by type label for efficient MERGE
    const entitiesByLabel = new Map<string, Array<{ id: string; name: string; domain: string; description: string; confidence: number }>>()
    for (const entity of deduplicatedEntities) {
      const safeLabel = (entity.type || 'Concept').replace(/[^a-zA-Z0-9_]/g, '_')
      if (!entitiesByLabel.has(safeLabel)) entitiesByLabel.set(safeLabel, [])
      entitiesByLabel.get(safeLabel)!.push({
        id: entity.id, name: entity.name, domain: entity.domain,
        description: entity.description, confidence: entity.confidence,
      })
    }

    for (const [label, labelEntities] of entitiesByLabel) {
      try {
        // Batch entities in chunks of 500 to avoid Cypher parameter limits
        for (let i = 0; i < labelEntities.length; i += 500) {
          const batch = labelEntities.slice(i, i + 500)
          await withNeo4jRetry(
            () => Promise.race([
              session.executeWrite(tx =>
                tx.run(
                  `UNWIND $entities AS e
                   MERGE (n:${label} {id: e.id})
                   ON CREATE SET n.name = e.name, n.entity_name = e.name, n.entity_type = e.entityType,
                                 n.domain = e.domain, n.description = e.description,
                                 n.confidence = e.confidence, n.confidence_score = e.confidence,
                                 n.source = e.source, n.occurrence_count = 1,
                                 n.created_at = e.createdAt, n.updated_at = $updatedAt
                   ON MATCH SET  n.name = e.name, n.entity_name = e.name, n.entity_type = e.entityType,
                                 n.domain = CASE WHEN e.domain <> '' THEN e.domain ELSE n.domain END,
                                 n.description = CASE WHEN e.description <> '' AND size(e.description) > size(COALESCE(n.description, '')) THEN e.description ELSE n.description END,
                                 n.confidence = CASE WHEN e.confidence > COALESCE(n.confidence, 0) THEN e.confidence ELSE n.confidence END,
                                 n.confidence_score = CASE WHEN e.confidence > COALESCE(n.confidence_score, 0) THEN e.confidence ELSE n.confidence_score END,
                                 n.occurrence_count = COALESCE(n.occurrence_count, 1) + 1,
                                 n.updated_at = $updatedAt`,
                  { entities: batch.map(e => ({ ...e, entityType: e.type || label, source: 'llm', createdAt: new Date().toISOString() })), updatedAt: new Date().toISOString() }
                )
              ),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`Neo4j entity batch write timed out after ${NEO4J_SESSION_TIMEOUT_MS / 1000}s`)), NEO4J_SESSION_TIMEOUT_MS)
              ),
            ]),
            `entityBatchWrite:${label}:${i}`
          )
          nodesCreated += batch.length
        }
      } catch (err) {
        // Check if this is a retryable timeout that exhausted retries
        if (isNeo4jRetryableError(err)) neo4jTimedOut = true
        console.error(`[Neo4j] Batch entity write failed for label "${label}":`, err instanceof Error ? err.message : String(err))
        // Fallback: write entities one by one (only if not timed out)
        if (!neo4jTimedOut) {
          for (const entity of labelEntities) {
            try {
              await session.executeWrite(tx =>
                tx.run(
                  `MERGE (n:${label} {id: $id})
                   ON CREATE SET n.name = $name, n.entity_name = $name, n.entity_type = $entityType,
                                 n.domain = $domain, n.description = $description,
                                 n.confidence = $confidence, n.confidence_score = $confidence,
                                 n.source = 'llm', n.occurrence_count = 1,
                                 n.created_at = $createdAt, n.updated_at = $updatedAt
                   ON MATCH SET  n.name = $name, n.entity_name = $name, n.entity_type = $entityType,
                                 n.domain = CASE WHEN $domain <> '' THEN $domain ELSE n.domain END,
                                 n.description = CASE WHEN $description <> '' AND size($description) > size(COALESCE(n.description, '')) THEN $description ELSE n.description END,
                                 n.confidence = CASE WHEN $confidence > COALESCE(n.confidence, 0) THEN $confidence ELSE n.confidence END,
                                 n.confidence_score = CASE WHEN $confidence > COALESCE(n.confidence_score, 0) THEN $confidence ELSE n.confidence_score END,
                                 n.occurrence_count = COALESCE(n.occurrence_count, 1) + 1,
                                 n.updated_at = $updatedAt`,
                  { id: entity.id, name: entity.name, entityType: entity.type || label, domain: entity.domain, description: entity.description, confidence: entity.confidence, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
                )
              )
              nodesCreated++
            } catch (innerErr) { console.error(`[Neo4j] Entity write failed for "${entity.name}":`, innerErr instanceof Error ? innerErr.message : String(innerErr)) }
          }
        }
      }
    }
    console.log(`[Neo4j] Wrote ${nodesCreated} deduplicated entity nodes for document ${documentId}`)

    // BATCH WRITE RELATIONSHIPS using UNWIND
    // CRITICAL FIX: Use deduplicated entity IDs for precise 1:1 matching.
    // Each canonical entity has exactly one node in Neo4j, so MATCH by ID
    // returns exactly one source and one target node, creating exactly 1 relationship.

    // Group relationships by type for efficient batch writing
    const relsByType = new Map<string, Array<{ sourceId: string; targetId: string; sourceName: string; targetName: string; description: string; confidence: number }>>()
    for (const rel of deduplicatedRels) {
      const relType = (rel.type || 'RELATED_TO').replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase()
      if (!relsByType.has(relType)) relsByType.set(relType, [])
      relsByType.get(relType)!.push({
        sourceId: rel.sourceId, targetId: rel.targetId,
        sourceName: rel.sourceName, targetName: rel.targetName,
        description: rel.description || '', confidence: rel.confidence || 0,
      })
    }

    for (const [relType, typeRels] of relsByType) {
      if (neo4jTimedOut) break // Stop writing if session has timed out
      try {
        // Batch relationships in chunks of 500
        for (let i = 0; i < typeRels.length; i += 500) {
          const batch = typeRels.slice(i, i + 500)
          await withNeo4jRetry(
            () => Promise.race([
              session.executeWrite(tx =>
                tx.run(
                  `UNWIND $rels AS r MATCH (a {id: r.sourceId}), (b {id: r.targetId}) MERGE (a)-[rel:${relType}]->(b) SET rel.documentId = $documentId, rel.document_id = $documentId, rel.relationship_type = $relType, rel.source_entity_id = r.sourceId, rel.target_entity_id = r.targetId, rel.description = r.description, rel.confidence = r.confidence, rel.confidence_score = r.confidence, rel.source = 'llm', rel.created_at = $createdAt`,
                  { rels: batch, documentId, relType, createdAt: new Date().toISOString() }
                )
              ),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`Neo4j relationship batch write timed out after ${NEO4J_SESSION_TIMEOUT_MS / 1000}s`)), NEO4J_SESSION_TIMEOUT_MS)
              ),
            ]),
            `relBatchWrite:${relType}:${i}`
          )
          relationshipsCreated += batch.length
        }
      } catch (err) {
        if (isNeo4jRetryableError(err)) neo4jTimedOut = true
        console.error(`[Neo4j] Batch relationship write failed for type "${relType}":`, err instanceof Error ? err.message : String(err))
        // Fallback: write relationships one by one (only if not timed out)
        if (!neo4jTimedOut) {
          for (const rel of typeRels) {
            try {
              await session.executeWrite(tx =>
                tx.run(`MATCH (a {id: $sourceId}), (b {id: $targetId}) MERGE (a)-[r:${relType}]->(b) SET r.documentId = $documentId, r.document_id = $documentId, r.relationship_type = $relType, r.source_entity_id = $sourceId, r.target_entity_id = $targetId, r.description = $description, r.confidence = $confidence, r.confidence_score = $confidence, r.source = 'llm', r.created_at = $createdAt`, { sourceId: rel.sourceId, targetId: rel.targetId, documentId, relType, description: rel.description || '', confidence: rel.confidence || 0, createdAt: new Date().toISOString() })
              )
              relationshipsCreated++
            } catch (innerErr) { console.error(`[Neo4j] Relationship write failed for "${rel.sourceName}"-${relType}->"${rel.targetName}":`, innerErr instanceof Error ? innerErr.message : String(innerErr)) }
          }
        }
      }
    }
    console.log(`[Neo4j] Wrote ${relationshipsCreated} deduplicated relationships for document ${documentId}`)

    // Step 6: Create CONTAINS relationships from Document → Entity nodes.
    // This is how we track which documents reference which entities — essential for:
    // - getEntitiesByDocument(): find all entities for a document
    // - Safe document deletion: know which entities to detach
    // - Cross-document analytics: which entities are shared across documents
    if (deduplicatedEntities.length > 0) {
      try {
        // Batch CONTAINS relationships in chunks of 500
        const entityIds = deduplicatedEntities.map(e => e.id)
        for (let i = 0; i < entityIds.length; i += 500) {
          const batch = entityIds.slice(i, i + 500)
          await session.executeWrite(tx =>
            tx.run(
              `UNWIND $entityIds AS eid
               MATCH (d:Document {id: $documentId}), (e {id: eid})
               MERGE (d)-[r:CONTAINS]->(e)
               SET r.documentId = $documentId, r.document_id = $documentId`,
              { documentId, entityIds: batch }
            )
          )
        }
        console.log(`[Neo4j] Created CONTAINS relationships: Document ${documentId.slice(0, 8)}... → ${entityIds.length} entities`)
      } catch (err) {
        console.warn(`[Neo4j] CONTAINS relationship creation failed:`, err instanceof Error ? err.message : String(err))
      }
    }

    // Step 7: Clean up orphaned entity nodes (no CONTAINS from ANY document).
    // With global entity IDs, a node becomes orphaned when ALL documents that referenced
    // it have been deleted or re-processed without including it. This is a slow operation,
    // so we only do it for fresh processing (not re-extract) and limit the batch size.
    if (!skipDeletion) {
      try {
        const orphanResult = await session.executeWrite(tx =>
          tx.run(
            `MATCH (n) WHERE n.entity_type IS NOT NULL AND n.entity_type <> 'Document' AND NOT (n)<-[:CONTAINS]-(:Document)
             WITH n LIMIT 1000 DETACH DELETE n RETURN count(n) AS deleted`
          )
        )
        const orphanDeleted = orphanResult.records.length > 0 ? orphanResult.records[0].get('deleted').toNumber() : 0
        if (orphanDeleted > 0) {
          console.log(`[Neo4j] Cleaned up ${orphanDeleted} orphaned entity nodes (no document references them)`)
        }
      } catch (err) {
        console.warn(`[Neo4j] Orphan cleanup failed:`, err instanceof Error ? err.message : String(err))
      }
    }
  } finally { await session?.close().catch(() => {}) }
  // If Neo4j timed out during writes, throw so the caller can mark the document as 'partial'
  if (neo4jTimedOut) {
    const partialError = new Error(`Neo4j write timed out for document ${documentId}: wrote ${nodesCreated}/${deduplicatedEntities.length} nodes, ${relationshipsCreated}/${deduplicatedRels.length} relationships`)
    partialError.name = 'Neo4jTimeoutError'
    throw partialError
  }
  return { nodesCreated, relationshipsCreated }
}

// ==================== EMBEDDING GENERATION (batch) ====================

async function generateAndSaveEmbeddings(chunks: Array<{ id: string; content: string }>, documentId: string, _skipDeletion = false): Promise<number> {
  if (chunks.length === 0) return 0
  try {
    // IMPORTANT: We NO LONGER delete existing chunks before generating embeddings.
    // Previous approach (delete → recreate) had two critical problems:
    //   1. Race condition: delete might not complete before upsert, causing stale zero-vector data
    //   2. Data loss: delete removes payload fields (heading_path, token_count, domain) from Step 4
    // Instead, we simply UPSERT chunks with real vectors, overwriting only the vector field.
    // Qdrant's upsert is atomic and preserves any payload fields not explicitly overwritten.
    // If you need to update payload too, use qdrant.setPayload() separately.

    const texts = chunks.map(c => c.content)
    const embeddingResults = await generateEmbeddingBatch(texts)
    let saved = 0

    // Build Qdrant chunk points with real vectors
    // We update ONLY the vector — Qdrant upsert will keep existing payload fields
    const chunkPoints: Array<{ id: string; vector: number[]; payload: ChunkPayload }> = []
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const embedding = embeddingResults[i]
      if (embedding && embedding.vector && embedding.vector.length === EMBEDDING_DIMENSION) {
        chunkPoints.push({
          id: chunk.id,
          vector: embedding.vector,
          payload: {
            document_id: documentId,
            chunk_index: i,
            content: chunk.content,
            created_at: new Date().toISOString(),
          },
        })
        saved++
      }
    }

    // Batch upsert chunks with embeddings to Qdrant
    if (chunkPoints.length > 0) {
      const upsertResult = await upsertChunks(chunkPoints)
      if (!upsertResult) {
        console.error('[Process] upsertChunks returned false — embeddings may not have been saved')
      }
    }
    return saved
  } catch (error) {
    console.error('[Process] Embedding batch error:', error)
    return 0
  }
}

// ==================== MAIN PIPELINE ====================

/**
 * FIX #6: Restore Qdrant + SQLite document metadata from R2 cloud backup.
 *
 * Handles the case where a document exists in R2 (the canonical PDF backup)
 * but has no Qdrant metadata point and no SQLite Document row. This happens
 * when:
 *   - PDFs were uploaded to R2 from another instance (e.g. cloud sync) and the
 *     Qdrant/SQLite metadata was never replicated locally.
 *   - Sandbox reset wiped local state but R2 persisted (cloud survives resets).
 *   - User imported a corpus of PDFs directly into R2 without going through
 *     the upload endpoint.
 *
 * Without this fix, POST /api/ingestion/process fails with "Document not found"
 * for any R2-only PDF — even though GET /api/ingestion/upload lists it (the
 * list endpoint reads from R2 directly). The user clicks "Xử lý" on a
 * legitimately uploaded PDF and nothing happens — no Neo4j nodes, no rels,
 * no error visible in the UI (the error only appears in server logs).
 *
 * After restore: Qdrant has a 'uploaded'-status doc with r2_key set. The
 * pipeline's Step 2 (Download PDF) will then auto-pull the PDF bytes from
 * R2 when the local file is missing — so the rest of the pipeline (parse,
 * chunk, extract, resolve, neo4j, embeddings) runs normally.
 *
 * Returns true on successful restore, false if the doc is not in R2 either.
 */
async function restoreDocumentMetadataFromR2(documentId: string): Promise<boolean> {
  try {
    if (!isR2Configured()) {
      console.warn(`[Process] FIX #6: R2 not configured — cannot restore metadata for doc ${documentId.slice(0, 8)}...`)
      return false
    }

    // List all R2 PDFs and find the one matching this docId.
    // R2 key format: "pdfs/<docId>_<filename>.pdf"  (or "pdfs/<docId>.pdf" edge case)
    const r2List = await listR2Objects('pdfs/', 500)
    if (!r2List.success || r2List.objects.length === 0) {
      console.warn(`[Process] FIX #6: R2 list empty or failed (${r2List.error || 'no objects'}) — cannot restore doc ${documentId.slice(0, 8)}...`)
      return false
    }

    const match = r2List.objects.find(o => {
      const basename = o.key.split('/').pop() || o.key
      const underscoreIdx = basename.indexOf('_')
      const id = underscoreIdx > 0
        ? basename.substring(0, underscoreIdx)
        : basename.replace(/\.pdf$/i, '')
      return id === documentId
    })

    if (!match) {
      console.warn(`[Process] FIX #6: No R2 object matches docId ${documentId.slice(0, 8)}... (scanned ${r2List.objects.length} R2 objects)`)
      return false
    }

    // Parse filename from the R2 key.
    const basename = match.key.split('/').pop() || match.key
    const underscoreIdx = basename.indexOf('_')
    const filename = underscoreIdx > 0 ? basename.substring(underscoreIdx + 1) : basename
    const title = filename.replace(/\.pdf$/i, '')
    const localPath = `${UPLOAD_DIR}/${basename}`
    const createdAt = match.lastModified ? match.lastModified.toISOString() : new Date().toISOString()
    const updatedAt = new Date().toISOString()

    // Build payload — status='uploaded' so the pipeline treats this as a fresh doc.
    // The processing_steps array is empty (no work done yet); the pipeline will
    // populate it as each step runs. r2_key is critical: Step 2 uses it to
    // auto-download the PDF bytes from R2 when the local file is missing.
    const payload: DocumentPayload = {
      title,
      file_path: localPath,
      domain: 'mixed',
      page_count: undefined,
      status: 'uploaded',
      error_message: undefined,
      processing_steps: [],
      processing_percent: 0,
      created_at: createdAt,
      updated_at: updatedAt,
      // r2_key is not part of the strict DocumentPayload type but qdrantDocToRecord
      // reads it via Record<string, unknown> — preserve it so Step 2 can download.
      ...({ r2_key: match.key, r2_uploaded: true } as Record<string, unknown>),
    } as DocumentPayload

    // Upsert Qdrant document metadata.
    await upsertDocument(documentId, payload)
    console.log(`[Process] FIX #6: Upserted Qdrant metadata for doc ${documentId.slice(0, 8)}... (title="${title}", r2_key="${match.key}", size=${match.size} bytes)`)

    // Upsert SQLite Document row (mirror of reconcile route.ts).
    try {
      await db.document.upsert({
        where: { id: documentId },
        create: {
          id: documentId,
          title,
          filePath: localPath,
          domain: 'mixed',
          status: 'uploaded',
          userPaused: false,
          processingSteps: '[]',
          processingPercent: 0,
          createdAt: new Date(createdAt),
          updatedAt: new Date(updatedAt),
        },
        update: {
          title,
          filePath: localPath,
          domain: 'mixed',
          status: 'uploaded',
          errorMessage: null,
          userPaused: false,
          processingSteps: '[]',
          processingPercent: 0,
          updatedAt: new Date(updatedAt),
        },
      })
      console.log(`[Process] FIX #6: Upserted SQLite Document row for doc ${documentId.slice(0, 8)}...`)
    } catch (dbErr) {
      // SQLite failure is non-fatal — Qdrant is the canonical source for the
      // pipeline. The SQLite row will be created later by updateDocProgress.
      console.warn(`[Process] FIX #6: SQLite upsert failed for ${documentId.slice(0, 8)}... (non-fatal):`, dbErr instanceof Error ? dbErr.message : String(dbErr))
    }

    // Invalidate any cached document list so GET /api/ingestion/upload reflects
    // the new Qdrant point immediately (otherwise the cache may serve the
    // pre-restore view for up to the cache TTL).
    try { invalidateDocumentCache() } catch { /* non-fatal */ }

    return true
  } catch (err) {
    console.error(`[Process] FIX #6: Restore from R2 failed for doc ${documentId.slice(0, 8)}...:`, err instanceof Error ? err.message : String(err))
    return false
  }
}

async function runIngestionPipeline(documentId: string, slotIndex: number = -1): Promise<Record<string, unknown>> {
  const startTime = Date.now()
  let lastProvider = 'unknown'
  let lastModel = 'unknown'
  let steps = getDefaultSteps()

  // Track pipeline stats that are computed during extraction and used in the final return.
  // These must be declared at the top scope so they're accessible in the return statement.
  let pipelineNeo4jNodes = 0
  let pipelineNeo4jRelationships = 0
  let pipelineResolvedCount = 0
  let pipelineDuplicatesFound = 0
  let pipelineResolutionStats = { totalInput: 0, afterExactMatch: 0, afterFuzzyMatch: 0, finalCount: 0 }

  try {
    // PAUSE GUARD: Check if the document was paused BEFORE starting the pipeline.
    // This prevents the race condition where the user clicks "Pause" while the
    // POST handler is starting the pipeline — the pipeline must not overwrite
    // the 'partial' status set by the PATCH handler.
    if (isDocPaused(documentId)) {
      console.log(`[Process] Document ${documentId.slice(0, 8)}... is PAUSED at pipeline start — aborting without any status updates`)
      return {
        documentId, totalPages: 0, totalChunks: 0, totalTokens: 0,
        totalEntities: 0, totalRelationships: 0, resolvedEntities: 0, duplicatesFound: 0,
        resolutionStats: { totalInput: 0, afterExactMatch: 0, afterFuzzyMatch: 0, finalCount: 0 },
        successfulChunks: 0, failedChunks: 0, wasTimedOut: true, warning: 'Document was paused before pipeline started',
        embeddingsSaved: 0, provider: 'none', model: 'none', durationMs: Date.now() - startTime,
        status: 'partial' as const, neo4jNodes: 0, neo4jRelationships: 0,
      }
    }

    // Step 1: Get document from Qdrant
    // Retry up to 3 times with progressive delay — handles edge case where
    // write hasn't committed yet (even with wait:true) or Qdrant index lag.
    let docPayload = await getDocument(documentId)
    for (let attempt = 0; !docPayload && attempt < 3; attempt++) {
      console.warn(`[Process] Document ${documentId} not found, retry ${attempt + 1}/3...`)
      await new Promise(r => setTimeout(r, (attempt + 1) * 500)) // 500ms, 1000ms, 1500ms
      docPayload = await getDocument(documentId)
    }
    // FIX #6: If still not in Qdrant after retries, attempt to restore metadata
    // from R2 cloud backup. This handles PDFs that exist in R2 (the canonical
    // cloud backup) but have no Qdrant/SQLite metadata — e.g., uploaded to R2
    // from another instance, or local state was wiped during sandbox reset
    // while R2 persisted. Without this, POST /api/ingestion/process silently
    // returns "Document not found" for legitimately uploaded PDFs — the UI
    // shows the doc (because GET /api/ingestion/upload reads R2 directly) but
    // processing it never starts, so Neo4j nodes + rels never increase.
    if (!docPayload) {
      console.log(`[Process] Document ${documentId.slice(0, 8)}... not found in Qdrant after 3 retries — attempting restore from R2 (FIX #6)`)
      const restored = await restoreDocumentMetadataFromR2(documentId)
      if (restored) {
        // Restore created the Qdrant point — fetch it now so the pipeline
        // proceeds normally (Step 2 will auto-download the PDF from R2).
        docPayload = await getDocument(documentId)
        if (docPayload) {
          console.log(`[Process] FIX #6: Successfully restored metadata for doc ${documentId.slice(0, 8)}... from R2 — pipeline continuing with fresh 'uploaded' status`)
        } else {
          console.error(`[Process] FIX #6: Restore reported success but getDocument() still returned null — Qdrant may be lagging. Will throw "Document not found".`)
        }
      }
    }
    if (!docPayload) throw new Error(`Document not found: ${documentId} (after 3 retries + R2 restore attempt — verify the docId is correct and that R2 has a matching PDF)`)
    const document = qdrantDocToRecord(docPayload, documentId)

    // EARLY-EXIT GUARD #1: If the document is already fully indexed with ALL steps completed,
    // AND has embeddings AND resolved entities, return immediately without re-processing.
    // This prevents the pipeline from unnecessarily re-running when reconciliation or
    // auto-chain triggers a re-process of an already-complete document.
    //
    // FIX #7: Also verify Neo4j actually has data for this document. The old guard trusted
    // the neo4j step's 'completed' status — but pre-Fix-#3 buggy runs marked the step
    // 'completed' even when Neo4j writes failed silently. Without this verification, a
    // stale 'indexed' doc with no Neo4j data would silently no-op on every "Tiếp tục"
    // click. By comparing SQLite relationships vs Neo4j semantic-edge count, we detect
    // stale step status and let the pipeline proceed to re-write Neo4j (Fix #4 will gate).
    if (document.status === 'indexed' && document.processing_steps &&
        Array.isArray(document.processing_steps) &&
        document.processing_steps.length > 0 &&
        document.processing_steps.every((s: { status: string }) => s.status === 'completed')) {
      // Double-check: verify embeddings and resolved entities actually exist
      const docChunkCount = await getChunkCount(documentId)
      let hasEmbeddings = docChunkCount > 0
      let hasResolved = false
      try {
        const resolvedCount = await db.localResolvedEntity.count({
          where: { documentId }
        })
        hasResolved = resolvedCount > 0
      } catch {}

      // FIX #7 + FIX #10: Re-verify Neo4j has semantic relationships for this document.
      // FIX #10 strengthens the check: not just COUNT > 0, but coverage vs SQLite —
      // a partial write (e.g. 9 rels in Neo4j vs 500 in SQLite) is ALSO treated as
      // stale so the pipeline re-writes the missing data.
      let hasNeo4jDataVerified = false
      const neo4jCoverage = await verifyNeo4jRelCoverage(documentId)
      if (neo4jCoverage === 'complete') {
        hasNeo4jDataVerified = true
      } else if (neo4jCoverage === 'missing') {
        console.warn(`[Process] FIX #7: Document ${documentId.slice(0, 8)}... marked 'indexed' with all steps completed, but SQLite has relationships while Neo4j has 0 — stale 'completed' status. Pipeline will proceed to re-write Neo4j.`)
      } else if (neo4jCoverage === 'partial') {
        console.warn(`[Process] FIX #10: Document ${documentId.slice(0, 8)}... marked 'indexed', but Neo4j holds far fewer relationships than SQLite (partial write from a crashed batch) — pipeline will proceed to re-write the missing Neo4j data.`)
      } else {
        // Neo4j verification failed — be conservative and DON'T early-exit.
        console.warn(`[Process] FIX #7: Neo4j COUNT verification failed for 'indexed' doc ${documentId.slice(0, 8)}... — pipeline will proceed.`)
      }

      if (hasEmbeddings && hasResolved && hasNeo4jDataVerified) {
        console.log(`[Process] Document ${documentId} is already fully indexed — skipping (embeddings=${hasEmbeddings}, resolved=${hasResolved}, neo4j=verified)`)
        return {
          documentId, totalPages: document.page_count || 0, totalChunks: 0, totalTokens: 0,
          totalEntities: 0, totalRelationships: 0, resolvedEntities: 0, duplicatesFound: 0,
          resolutionStats: { totalInput: 0, afterExactMatch: 0, afterFuzzyMatch: 0, finalCount: 0 },
          successfulChunks: 0, failedChunks: 0, wasTimedOut: false, warning: undefined,
          embeddingsSaved: 0, provider: 'unknown', model: 'unknown', durationMs: Date.now() - startTime,
          status: 'indexed' as const, neo4jNodes: 0, neo4jRelationships: 0,
        }
      } else {
        console.log(`[Process] Document ${documentId} marked 'indexed' with all steps completed, but missing data (embeddings=${hasEmbeddings}, resolved=${hasResolved}, neo4j=${hasNeo4jDataVerified ? 'verified' : 'missing'}) — re-processing`)
      }
    }

    // Detect resume mode: reuse existing chunks/entities from DB instead of starting from scratch.
    // This prevents data loss when the pipeline is re-triggered for documents that already have
    // chunks or entities saved (e.g., after a server crash, recovery, or manual re-trigger).
    //
    // CRITICAL SAFETY RULE: If a document has existing chunks in the DB, ALWAYS resume.
    // Never delete existing chunks — that would destroy hours of extraction work.
    // The only exception is when there are truly no chunks (fresh document or intentional reset).
    //
    // Previous versions had complex status-based checks that missed important cases:
    // - 'indexed' with chunks → isResuming=false → deleteOldDocumentData() destroyed all data
    // - 'error' with chunks → isResuming=false → data deleted
    // - 'uploaded' with chunks but no entities → isResuming=false → data deleted
    // All of these caused catastrophic data loss (e.g., 445 chunks → 0 chunks).
    //
    // Now we simply check: does this document have chunks in the DB? If yes, RESUME.
    // If the user truly wants to re-process from scratch, they must delete and re-upload.
    const hasExistingChunks = await getChunkCount(documentId).then(count => count > 0).catch(() => true) // Assume chunks exist on error for safety

    const hasExistingEntities = await db.localEntity.count({ where: { documentId } }).then(count => count > 0).catch(() => true)

    const isResuming = hasExistingChunks
      // Additional check: even if chunk count query failed, also check entities
      // This provides double protection against accidental data deletion
      || hasExistingEntities

    // Set the appropriate processing status based on whether we're resuming or starting fresh.
    // CRITICAL: Do NOT reset a fresh doc back to 'uploaded' — the POST handler already set it
    // to 'parsing', and resetting causes the UI to briefly show the "Xử lý" button again.
    // With 300+ documents, reconciliation may also see the 'uploaded' status and interfere.
    // For fresh docs (no existing data), keep 'parsing' status (already set by POST handler).
    // For resuming docs (have existing data), set to 'extracting'.
    // PAUSE GUARD: Don't change status if the document was paused while the
    // pipeline was starting up (race condition with PATCH handler).
    if (!isDocPaused(documentId) && ['parsing', 'chunked', 'extracting', 'extracted', 'partial', 'indexed', 'error'].includes(document.status)) {
      const newStatus = isResuming ? 'extracting' : 'parsing'
      // Only update if the status actually changes (avoid unnecessary Qdrant writes)
      if (document.status !== newStatus) {
        await updateDocProgress(documentId, { status: newStatus })
      }
    }
    let domain = (document.domain || 'mixed') as DocumentDomain

    let savedChunks: Array<{ id: string; chunk_index: number; content: string; domain: string | null }>
    // Set when the resume path had to REBUILD chunks from the PDF (Qdrant lost
    // its chunk points while SQLite still has entities — e.g. sandbox reset).
    // Effects: skip LLM extraction entirely (entities already in buffer), bypass
    // early-exit Guard #2, and force embedding regeneration (rebuilt chunks carry
    // placeholder zero vectors).
    let rebuiltChunksFromPdf = false

    if (isResuming) {
      // RESUME MODE: Skip download/parse/chunk — chunks already exist in DB
      // Just load existing chunks and continue extraction from where we left off
      console.log(`[Process] Resuming — skipping download/parse/chunk steps (status was '${document.status}', hasExistingChunks=${hasExistingChunks}, hasExistingEntities=${hasExistingEntities})`)

      // Preserve existing processing_steps if they exist and have useful detail
      // Otherwise create fresh steps for the resume
      const existingSteps = document.processing_steps as ProcessingStepRecord[] | null
      if (existingSteps && Array.isArray(existingSteps) && existingSteps.length === PIPELINE_STEPS.length) {
        // Reuse existing steps but fix them:
        // - Reset extract step to running (it will be set properly below)
        // - Ensure download/parse/chunk are marked as completed (they were done before the document was saved)
        steps = existingSteps.map(s => {
          if (s.name === 'extract') {
            return { ...s, status: 'running' as const, completedAt: null }
          }
          if (['download', 'parse', 'chunk'].includes(s.name) && s.status !== 'completed') {
            // These steps were completed before the document was chunked — mark them as completed
            return {
              ...s, status: 'completed' as const,
              startedAt: s.startedAt || document.created_at,
              completedAt: s.completedAt || document.updated_at,
              detail: s.detail || `${s.label} (resume)`,
            }
          }
          return s
        })
      } else {
        steps = [
          { name: 'download', label: 'Tải PDF', status: 'completed' as const, startedAt: document.created_at, completedAt: document.updated_at, detail: 'Đã tải (resume)' },
          { name: 'parse', label: 'Phân tích PDF', status: 'completed' as const, startedAt: document.created_at, completedAt: document.updated_at, detail: `${document.page_count || '?'} trang (resume)` },
          { name: 'chunk', label: 'Chia chunks', status: 'completed' as const, startedAt: document.created_at, completedAt: document.updated_at, detail: 'Đã chia (resume)' },
          { name: 'extract', label: 'Trích xuất entities', status: 'pending' as const, startedAt: null, completedAt: null, detail: null },
          { name: 'resolve', label: 'Hợp nhất entities', status: 'pending' as const, startedAt: null, completedAt: null, detail: null },
          { name: 'neo4j', label: 'Ghi Neo4j', status: 'pending' as const, startedAt: null, completedAt: null, detail: null },
          { name: 'embeddings', label: 'Tạo embeddings', status: 'pending' as const, startedAt: null, completedAt: null, detail: null },
        ]
      }
      await updateDocProgress(documentId, { steps })

      const existingChunks = await fetchAllChunksForDoc(documentId)
      if (!existingChunks || existingChunks.length === 0) {
        // FIX (reset trap): SQLite still has entities for this document, but Qdrant
        // lost its chunks (e.g. sandbox reset wiped local Qdrant while the SQLite
        // backup was restored). Previously this threw 'Failed to fetch existing
        // chunks for resume' and marked the document 'error' forever. Instead,
        // rebuild the chunks from the PDF (re-parse + re-chunk, NO LLM re-extraction
        // — the extraction step below skips chunks that already have entities in
        // SQLite, and embeddings/Neo4j steps run cheaply from the buffer).
        if (!hasExistingEntities) {
          throw new Error('Failed to fetch existing chunks for resume (no entities in buffer either)')
        }
        console.log(`[Process] Resume: Qdrant chunks lost but SQLite entities exist — rebuilding chunks from PDF (no LLM re-extraction)`)
        rebuiltChunksFromPdf = true

        // --- Re-download PDF (local filesystem first, then R2 cloud backup) ---
        if (!document.file_path) throw new Error('Document has no file_path for chunk rebuild')
        let rebuildBuffer: Buffer | null = null
        try {
          rebuildBuffer = await downloadFromFilesystem(document.file_path as string)
          if (!rebuildBuffer && isR2Configured()) {
            const r2Key = (document as { r2_key?: string }).r2_key
              || `pdfs/${documentId}_${(document.title || '').replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf`
            console.log(`[Process] Chunk rebuild: local file missing — pulling from R2: ${r2Key}`)
            const r2Result = await downloadFileFromR2(r2Key, document.file_path as string)
            if (r2Result.success) {
              rebuildBuffer = await readFile(document.file_path as string)
            }
          }
          if (!rebuildBuffer) throw new Error('PDF not found on filesystem and R2 restore failed')
        } catch (dlErr) {
          throw new Error(`Chunk rebuild failed — could not obtain PDF: ${dlErr instanceof Error ? dlErr.message : String(dlErr)}`)
        }

        // --- Re-parse + re-chunk (same logic as fresh path) ---
        const { text: rebuildText } = await extractPDFText(rebuildBuffer)
        if (!rebuildText || rebuildText.trim().length === 0) {
          throw new Error('Chunk rebuild failed: PDF parsing returned no text')
        }
        const rebuildChunks = chunkText(rebuildText, domain)
        if (rebuildChunks.length === 0) throw new Error('Chunk rebuild failed: chunking returned no chunks')

        // --- Upsert chunks to Qdrant with placeholder vectors (embeddings come later) ---
        const rebuildPoints = rebuildChunks.map(chunk => ({
          id: randomUUID(),
          vector: new Array(EMBEDDING_DIMENSION).fill(0),
          payload: {
            document_id: documentId,
            chunk_index: chunk.chunkIndex,
            content: sanitizeForDB(chunk.content),
            heading_path: sanitizeForDB(chunk.headingPath),
            token_count: chunk.tokenCount,
            domain: chunk.domain,
            created_at: new Date().toISOString(),
          } as ChunkPayload,
        }))
        const rebuildUpserted = await upsertChunks(rebuildPoints)
        if (!rebuildUpserted) throw new Error('Chunk rebuild failed: Qdrant upsert error')

        if (rebuildPoints.length > 500) {
          await new Promise(resolve => setTimeout(resolve, 2000)) // let Qdrant index
        }
        const rebuiltChunks = await fetchAllChunksForDoc(documentId)
        if (!rebuiltChunks || rebuiltChunks.length === 0) throw new Error('Chunk rebuild failed: fetch after insert empty')
        savedChunks = rebuiltChunks
        steps = markStepCompleted(steps, 'chunk', `${savedChunks.length} chunks (rebuilt from PDF)`)
        await updateDocProgress(documentId, { steps })
      } else {
        savedChunks = existingChunks
      }

      // Auto-classify domain if "mixed" — use a sample of existing chunk content
      // This ensures resumed documents also get proper domain classification
      if (domain === 'mixed' && savedChunks.length > 0) {
        const sampleText = savedChunks.slice(0, 5).map(c => c.content).join('\n\n').slice(0, 3000)
        console.log(`[Process] Resume: Domain is "mixed" — auto-classifying document "${document.title}"...`)
        const classifiedDomain = await classifyDocumentDomain(sampleText, document.title || 'Untitled', slotIndex)
        if (classifiedDomain !== 'mixed') {
          console.log(`[Process] Resume: Document classified as "${classifiedDomain}" (was "mixed") — updating domain`)
          domain = classifiedDomain
          await updateDocProgress(documentId, { domain: classifiedDomain })
        }
      }
    } else {
      // FRESH PROCESSING: Full pipeline from scratch
      // Initialize progress tracking
      steps = getDefaultSteps()
      await updateDocProgress(documentId, { steps })

      // Delete old data before re-processing
      await deleteOldDocumentData(documentId)

      // Step 2: Download PDF — try local filesystem first, then R2 cloud backup
      // (R2-restored documents don't have local files yet — auto-pull from R2)
      steps = markStepRunning(steps, 'download')
      await updateDocProgress(documentId, { status: 'parsing', steps })
      if (!document.file_path) throw new Error('Document has no file_path')

      let pdfBuffer: Buffer
      try {
        // First attempt: local filesystem
        let fileData: Buffer | null = await downloadFromFilesystem(document.file_path as string)

        // Fallback: pull from R2 cloud backup (for documents restored from R2
        // that don't have a local copy yet — e.g. after sandbox reset)
        if (!fileData && isR2Configured()) {
          // r2_key was preserved by qdrantDocToRecord when the doc was created from R2 metadata
          const r2Key = (document as { r2_key?: string }).r2_key
            || `pdfs/${documentId}_${(document.title || '').replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf`
          console.log(`[Process] Local file missing — restoring from R2: ${r2Key}`)
          const r2Result = await downloadFileFromR2(r2Key, document.file_path as string)
          if (r2Result.success) {
            fileData = await readFile(document.file_path as string)
            console.log(`[Process] Restored ${r2Result.size} bytes from R2 → ${document.file_path}`)
          } else {
            throw new Error(`Local file not found AND R2 download failed for key "${r2Key}": ${r2Result.error || 'unknown'}`)
          }
        }

        if (!fileData) throw new Error('PDF not found on local filesystem and R2 not configured')
        pdfBuffer = fileData
      } catch (downloadErr) { throw new Error(`Failed to download PDF: ${downloadErr instanceof Error ? downloadErr.message : String(downloadErr)}`) }
      steps = markStepCompleted(steps, 'download', `${(pdfBuffer.length / 1024).toFixed(0)} KB`)
      await updateDocProgress(documentId, { steps })

      // Step 3: Parse PDF — extract raw text first (chunking happens after classification)
      steps = markStepRunning(steps, 'parse')
      await updateDocProgress(documentId, { steps })
      const { text: rawText, totalPages: parsedPages } = await extractPDFText(pdfBuffer)
      if (!rawText || rawText.trim().length === 0) throw new Error('PDF parsing returned no text - document may be empty or unreadable. Possible causes: (1) Scanned/image PDF without OCR text layer, (2) Encrypted/password-protected PDF, (3) Corrupted or malformed PDF file. Please ensure the PDF contains selectable text.')

      // Step 3.5: Auto-classify domain if set to "mixed" (the default/auto selection)
      // Classification happens AFTER text extraction but BEFORE chunking,
      // so the correct domain-specific chunking config (maxTokens, overlap, patterns)
      // and extraction prompts are used for the rest of the pipeline.
      if (domain === 'mixed') {
        console.log(`[Process] Domain is "mixed" — auto-classifying document "${document.title}"...`)
        const classifiedDomain = await classifyDocumentDomain(rawText, document.title || 'Untitled', slotIndex)
        if (classifiedDomain !== 'mixed') {
          console.log(`[Process] Document classified as "${classifiedDomain}" (was "mixed") — updating domain`)
          domain = classifiedDomain
          // Update the document's domain in Qdrant
          await updateDocProgress(documentId, { domain: classifiedDomain })
        } else {
          console.log(`[Process] Document remains "mixed" after classification — multi-domain content detected`)
        }
      }

      // Step 4: Chunk text with the (potentially updated) domain config and save to Qdrant
      const parseChunks = chunkText(rawText, domain)
      const parseTotalTokens = parseChunks.reduce((sum, c) => sum + c.tokenCount, 0)
      if (parseChunks.length === 0) throw new Error('Chunking returned no chunks - document text could not be segmented')

      // Save page count + mark parse step completed
      steps = markStepCompleted(steps, 'parse', `${parsedPages} trang, ${parseTotalTokens} tokens, domain: ${domain}`)
      await updateDocProgress(documentId, { steps, pageCount: parsedPages })

      // Step 4: Chunk text and save to Qdrant chunks collection
      steps = markStepRunning(steps, 'chunk')
      await updateDocProgress(documentId, { status: 'chunked', steps })
      // Save chunks to Qdrant with zero vectors (embeddings added later)
      const chunkPoints = parseChunks.map(chunk => ({
        id: randomUUID(),
        vector: new Array(EMBEDDING_DIMENSION).fill(0), // Placeholder — real vectors added in Step 11
        payload: {
          document_id: documentId,
          chunk_index: chunk.chunkIndex,
          content: sanitizeForDB(chunk.content),
          heading_path: sanitizeForDB(chunk.headingPath),
          token_count: chunk.tokenCount,
          domain: chunk.domain,
          created_at: new Date().toISOString(),
        } as ChunkPayload,
      }))
      const chunksUpserted = await upsertChunks(chunkPoints)
      if (!chunksUpserted) throw new Error('Failed to save chunks to Qdrant')

      // Brief delay before fetching — Qdrant's scroll API may need a moment
      // to index the newly upserted points, especially for large documents (2500+ chunks).
      // Even with wait:true on upsert, the scroll index can lag slightly.
      if (chunkPoints.length > 500) {
        console.log(`[Process] Large chunk insert (${chunkPoints.length} chunks) — waiting 2s for Qdrant indexing...`)
        await new Promise(resolve => setTimeout(resolve, 2000))
      }

      const fetchedChunks = await fetchAllChunksForDoc(documentId)
      if (!fetchedChunks || fetchedChunks.length === 0) throw new Error('Failed to fetch saved chunks after insert')
      savedChunks = fetchedChunks
      steps = markStepCompleted(steps, 'chunk', `${savedChunks.length} chunks`)
      await updateDocProgress(documentId, { steps })
    }

    // Step 5: Delete old embeddings (already done in deleteOldDocumentData for fresh processing)

    // Skip chunks that already have extracted entities (resume from partial)
    let chunksToProcess = savedChunks
    if (isResuming) {
      if (rebuiltChunksFromPdf) {
        // Rebuilt chunks got NEW UUIDs that cannot match the old entity chunkIds —
        // the filter below would miss everything and re-run the FULL LLM extraction
        // (creating duplicates). The entities already live in the SQLite buffer, so
        // skip extraction entirely and continue with resolve/Neo4j/embeddings.
        chunksToProcess = []
        console.log(`[Process] Chunk rebuild mode: skipping LLM extraction (${savedChunks.length} chunks rebuilt, entities preserved in buffer)`)
      } else {
      // PAGINATED: Fetch ALL entity chunk_ids to avoid the 1000-row limit.
      // Without pagination, only the first 1000 entities are returned,
      // causing the pipeline to miss already-processed chunks and create duplicates.
      const existingEntityChunks = await db.localEntity.findMany({
        where: { documentId },
        select: { chunkId: true },
      })
      // Filter out empty chunk_ids from placeholder entities for accurate counting.
      const processedChunkIds = new Set(existingEntityChunks.map(e => e.chunkId).filter(id => id && id.trim()))
      chunksToProcess = savedChunks.filter(c => !processedChunkIds.has(c.id))
      console.log(`[Process] Resuming from partial: ${savedChunks.length} total chunks, ${processedChunkIds.size} already processed, ${chunksToProcess.length} remaining`)
      }
    }

    // EARLY-EXIT GUARD #2: If ALL chunks are already processed AND all post-extraction steps
    // (resolve, neo4j, embeddings) are completed, mark as 'indexed' and return immediately.
    // This prevents the auto-chain from looping endlessly when reconciliation keeps resetting
    // the status to 'partial' even though all work is actually done.
    //
    // FIX #7: Previously this guard TRUSTED the step status — if the neo4j step was marked
    // 'completed' (from a buggy pre-Fix-#3 run that marked 'completed' even on non-timeout
    // errors), the guard fired prematurely and the pipeline returned WITHOUT writing to Neo4j.
    // Now we re-verify against actual Neo4j data: if SQLite has relationships but Neo4j has 0
    // semantic edges for this document, the early-exit is BLOCKED so the pipeline proceeds to
    // the Neo4j write step (which Fix #4 will properly gate via hasNeo4jData). This closes the
    // last loop hole where "Tiếp tục" on a stale 'indexed' doc silently no-op'd.
    if (chunksToProcess.length === 0 && isResuming && !rebuiltChunksFromPdf) {
      const existingSteps = document.processing_steps as ProcessingStepRecord[] | null
      const allStepsDone = existingSteps && Array.isArray(existingSteps) &&
        existingSteps.length === PIPELINE_STEPS.length &&
        existingSteps.every(s => s.status === 'completed')

      if (allStepsDone) {
        // FIX #7 + FIX #10: Re-verify Neo4j actually has data — don't trust the step
        // status alone. If SQLite has relationships for this doc but Neo4j has 0
        // semantic edges (missing) or far fewer than expected (partial write from a
        // crashed batch), the neo4j step's 'completed' status is stale and we must
        // NOT early-exit. Letting the pipeline continue lets the post-extraction
        // neo4j step (gated by Fix #4's hasNeo4jData) re-write the missing data.
        let neo4jVerifiedComplete = true
        const coverage = await verifyNeo4jRelCoverage(documentId)
        if (coverage === 'missing') {
          // Stale 'completed' status — Neo4j write actually failed silently before.
          neo4jVerifiedComplete = false
          console.warn(`[Process] FIX #7: Document ${documentId.slice(0, 8)}... has relationships in SQLite but 0 in Neo4j — stale 'completed' step status detected. Blocking EARLY-EXIT GUARD #2 so the Neo4j step re-runs (chunks already extracted, will skip extraction).`)
        } else if (coverage === 'partial') {
          neo4jVerifiedComplete = false
          console.warn(`[Process] FIX #10: Document ${documentId.slice(0, 8)}... has far fewer relationships in Neo4j than in SQLite (partial write) — blocking EARLY-EXIT GUARD #2 so the Neo4j step re-writes the missing data.`)
        } else if (coverage === 'unknown') {
          // Neo4j COUNT query failed — be conservative and BLOCK early-exit so the
          // pipeline proceeds. The post-extraction Neo4j step will retry the write.
          neo4jVerifiedComplete = false
          console.warn(`[Process] FIX #7: Neo4j COUNT verification failed for doc ${documentId.slice(0, 8)}... — blocking early-exit to be safe.`)
        } else {
          console.log(`[Process] FIX #7: Document ${documentId.slice(0, 8)}... verified — Neo4j relationship coverage matches SQLite, early-exit is safe.`)
        }

        if (neo4jVerifiedComplete) {
          console.log(`[Process] All chunks processed and all steps completed — marking as 'indexed' immediately`)
          await updateDocProgress(documentId, { status: 'indexed', steps: existingSteps })
          invalidateDocumentCache()
          // SQLite is permanent storage — preserve entities and relationships for this document
          console.log(`[Process] Document ${documentId.slice(0, 8)}... already indexed — SQLite data preserved (permanent storage)`)
          return {
            documentId, totalPages: document.page_count || 0, totalChunks: savedChunks.length, totalTokens: 0,
            totalEntities: 0, totalRelationships: 0, resolvedEntities: 0, duplicatesFound: 0,
            resolutionStats: { totalInput: 0, afterExactMatch: 0, afterFuzzyMatch: 0, finalCount: 0 },
            successfulChunks: 0, failedChunks: 0, wasTimedOut: false, warning: undefined,
            embeddingsSaved: 0, provider: 'unknown', model: 'unknown', durationMs: Date.now() - startTime,
            status: 'indexed' as const, neo4jNodes: 0, neo4jRelationships: 0,
          }
        }
        // else: fall through — pipeline will skip extraction (chunksToProcess=0) and
        // proceed to resolve/neo4j/embeddings steps. Fix #4 will detect hasNeo4jData=false
        // (SQLite rels > 0, Neo4j rels = 0) and re-run the Neo4j write.
      }
    }

    // Step 6: Extract entities & relationships using callLLM (loop through chunks)
    const alreadyProcessedCount = chunksToProcess.length < savedChunks.length ? savedChunks.length - chunksToProcess.length : 0
    steps = markStepRunning(steps, 'extract', `[Key ${slotIndex + 1}/${MAX_KEYS}] ${alreadyProcessedCount}/${savedChunks.length} chunks`)
    await updateDocProgress(documentId, { status: 'extracting', steps, extractProgress: { processed: alreadyProcessedCount, total: savedChunks.length } })

    // LOCAL-FIRST EXTRACTION: Accumulate entities/relationships in memory + SQLite during
    // extraction. After extraction loop completes, batch write ALL to Neo4j in one go
    // (1 batch instead of 80+ incremental inserts).
    let totalEntitiesThisBatch = 0
    let totalRelationshipsThisBatch = 0

    // Lightweight name-to-ID map for relationship resolution.
    // Maps entity_name (lowercased) → pre-generated UUID (same ID used in SQLite + Neo4j).
    const entityNameToIdMap = new Map<string, string>()

    // FIX: Cache for the full entity list from DB — loaded once, updated incrementally.
    // Avoids N+1 query pattern where selectAllForDoc was called for every chunk group.
    let entityListCache: Array<{ id: string; entity_name: string }> | null = null

    // LOCAL-FIRST: Accumulate entities/relationships for batch write to Neo4j after extraction.
    const allLocalEntities: Array<{ id: string; documentId: string; chunkId: string; entityName: string; entityType: string; description: string; properties: string; confidenceScore: number; source: string; domain: string }> = []
    const allLocalRelationships: Array<{ id: string; documentId: string; sourceEntityId: string; targetEntityId: string; sourceEntityName: string; targetEntityName: string; relationshipType: string; description: string; confidenceScore: number; source: string }> = []

    // When resuming, seed the name-to-ID map with previously saved entities
    // so that relationships referencing existing entities can be resolved immediately.
    if (isResuming) {
      // PAGINATED: Fetch ALL entity names to avoid the 1000-row limit.
      // Without pagination, only the first 1000 entities are loaded,
      // causing relationships to fail resolution for entities beyond the first 1000.
      const existingEntities = await db.localEntity.findMany({
        where: { documentId },
        select: { id: true, entityName: true },
      })
      for (const e of existingEntities) {
        entityNameToIdMap.set(e.entityName.toLowerCase().trim(), e.id)
      }
      console.log(`[Process] Seeded entity name-to-ID map with ${entityNameToIdMap.size} existing entities`)
    }

    // Reset the extraction timer after all loading is done.
    // The loading phase (fetching chunks, entities, relationships from SQLite/Qdrant) can take significant time
    // for documents with many already-processed chunks. We don't want loading time to count against
    // the extraction timeout — only the actual LLM extraction time should be measured.
    let extractionStartTime = Date.now()

    let successfulChunks = 0
    let failedChunks = 0
    let wasTimedOut = false

    // ===== SLIDING WINDOW CONCURRENCY =====
    // Instead of processing chunks in fixed groups (where each group must wait for the
    // slowest chunk before starting the next group), we use a worker pool where each
    // worker takes the next chunk from the queue as soon as it finishes the current one.
    //
    // Benefits:
    //   - When a fast chunk finishes (~3s), its LLM key is immediately reused for
    //     the next chunk — no idle time waiting for slow chunks in the same group.
    //   - RPM utilization is maximized: all CONCURRENT_CHUNKS workers are always busy.
    //   - No 100ms inter-group delay needed — workers pick up work continuously.
    //   - With 60s per-call timeout, a single slow call doesn't block 7 other workers.

    let chunksCompleted = 0 // Atomic-ish counter for progress tracking
    let shouldStop = false  // Signal all workers to stop (pause/timeout)

    // Shared iterator — workers pull chunks from this
    const chunkIterator = chunksToProcess[Symbol.iterator]()

    // Result processing function — handles entity/relationship extraction results
    // This is called sequentially for each completed chunk (no race conditions on shared state)
    async function processExtractionResult(
      chunk: { id: string; content: string; chunk_index: number; domain?: string },
      extractionResult: { entities: ExtractedEntity[]; relationships: ExtractedRelationship[]; provider: string; model: string } | null,
    ): Promise<void> {
      if (!extractionResult) {
        failedChunks++
        return
      }

      if (extractionResult.entities.length === 0 && extractionResult.relationships.length === 0) {
        failedChunks++
      } else {
        successfulChunks++
        // FIX #2: When entities exist but relationships are empty, the chunk is
        // counted as "successful" but the relationship-save block below is
        // silently skipped (relationships.length === 0 guard). This hides the
        // data loss — most often caused by JSON truncation (Fix #1) not
        // recovered by the retry (Fix #1b). Log a warning so the operator can
        // see why Neo4j node count rises but relationship count stays flat.
        if (extractionResult.entities.length > 0 && extractionResult.relationships.length === 0) {
          console.warn(`[Process] Chunk ${chunk.chunk_index}: ${extractionResult.entities.length} entities but 0 relationships — relationship-save block will be SKIPPED. Likely JSON truncation not recovered by Fix #1b retry.`)
        }
      }
      lastProvider = extractionResult.provider; lastModel = extractionResult.model
      chunksCompleted++

      // LOCAL-FIRST: Pre-generate UUIDs and accumulate entities locally + SQLite
      if (extractionResult.entities.length > 0) {
        const localEntitiesForSqlite: Array<{ id: string; documentId: string; chunkId: string; entityName: string; entityType: string; description: string; properties: string; confidenceScore: number; source: string; domain: string }> = []
        for (const entity of extractionResult.entities) {
          const entityId = randomUUID()
          const localEntity = {
            id: entityId,
            documentId: documentId,
            chunkId: chunk.id,
            entityName: entity.name,
            entityType: entity.type,
            description: sanitizeForDB(entity.description),
            properties: JSON.stringify(entity.properties),
            confidenceScore: entity.confidenceScore,
            source: entity.source,
            domain: entity.domain,
          }
          allLocalEntities.push(localEntity)
          localEntitiesForSqlite.push(localEntity)
          entityNameToIdMap.set(entity.name.toLowerCase().trim(), entityId)
        }
        try {
          await db.localEntity.createMany({ data: localEntitiesForSqlite })
        } catch (sqliteErr) {
          console.warn('[Process] SQLite entity write failed (non-fatal):', sqliteErr instanceof Error ? sqliteErr.message : String(sqliteErr))
        }
        if (entityListCache) {
          entityListCache.push(...localEntitiesForSqlite.map(e => ({ id: e.id, entity_name: e.entityName })))
        }
        totalEntitiesThisBatch += extractionResult.entities.length
      }

      // LOCAL-FIRST: Accumulate relationships locally + SQLite
      if (extractionResult.relationships.length > 0) {
        const missingEntityNames = new Set<string>()
        for (const rel of extractionResult.relationships) {
          const sourceKey = rel.source.toLowerCase().trim()
          const targetKey = rel.target.toLowerCase().trim()
          if (!entityNameToIdMap.has(sourceKey)) missingEntityNames.add(rel.source.trim())
          if (!entityNameToIdMap.has(targetKey)) missingEntityNames.add(rel.target.trim())
        }
        if (missingEntityNames.size > 0) {
          if (!entityListCache) {
            const sqliteEntities = await db.localEntity.findMany({
              where: { documentId },
              select: { id: true, entityName: true },
            })
            entityListCache = [
              ...sqliteEntities.map(e => ({ id: e.id, entity_name: e.entityName })),
              ...allLocalEntities.map(e => ({ id: e.id, entity_name: e.entityName })),
            ]
          }
          const foundEntities = entityListCache
          if (foundEntities) {
            for (const missingName of missingEntityNames) {
              const missingLower = missingName.toLowerCase().trim()
              if (entityNameToIdMap.has(missingLower)) continue
              let bestMatch: { id: string; entity_name: string } | null = null
              let bestScore = 0
              for (const e of foundEntities) {
                const existingLower = e.entity_name.toLowerCase().trim()
                if (existingLower === missingLower) {
                  bestMatch = e
                  bestScore = 1
                  break
                }
                if (existingLower.includes(missingLower) || missingLower.includes(existingLower)) {
                  const score = Math.min(missingLower.length, existingLower.length) / Math.max(missingLower.length, existingLower.length)
                  if (score > bestScore && score > 0.7) {
                    bestScore = score
                    bestMatch = e
                  }
                }
              }
              if (bestMatch) {
                entityNameToIdMap.set(missingLower, bestMatch.id)
              }
            }
          }

          // Create placeholder entities for missing relationship endpoints
          const stillMissingNames = new Set<string>()
          for (const rel of extractionResult.relationships) {
            const sourceKey = rel.source.toLowerCase().trim()
            const targetKey = rel.target.toLowerCase().trim()
            if (!entityNameToIdMap.has(sourceKey)) stillMissingNames.add(rel.source.trim())
            if (!entityNameToIdMap.has(targetKey)) stillMissingNames.add(rel.target.trim())
          }
          if (stillMissingNames.size > 0) {
            for (const missingName of stillMissingNames) {
              const matchingEntities = await db.localEntity.findMany({
                where: { documentId, entityName: { contains: missingName.substring(0, 200) } },
                select: { id: true, entityName: true },
              })
              const exactMatch = matchingEntities.find(e => e.entityName.toLowerCase().trim() === missingName.toLowerCase().trim())
              if (exactMatch) {
                entityNameToIdMap.set(missingName.toLowerCase().trim(), exactMatch.id)
              }
            }

            const remainingMissing = new Set<string>()
            for (const rel of extractionResult.relationships) {
              const sourceKey = rel.source.toLowerCase().trim()
              const targetKey = rel.target.toLowerCase().trim()
              if (!entityNameToIdMap.has(sourceKey)) remainingMissing.add(rel.source.trim())
              if (!entityNameToIdMap.has(targetKey)) remainingMissing.add(rel.target.trim())
            }
            if (remainingMissing.size > 0) {
              const placeholderEntitiesForSqlite: Array<{ id: string; documentId: string; chunkId: string; entityName: string; entityType: string; description: string; properties: string; confidenceScore: number; source: string; domain: string }> = []
              for (const name of remainingMissing) {
                const placeholderId = randomUUID()
                const placeholderEntity = {
                  id: placeholderId,
                  documentId: documentId,
                  chunkId: '',
                  entityName: name,
                  entityType: 'Concept',
                  description: sanitizeForDB(`Auto-generated entity placeholder from relationship context`),
                  properties: JSON.stringify({ auto_generated: true }),
                  confidenceScore: 0.5,
                  source: 'auto-placeholder',
                  domain: domain,
                }
                allLocalEntities.push(placeholderEntity)
                placeholderEntitiesForSqlite.push(placeholderEntity)
                entityNameToIdMap.set(name.toLowerCase().trim(), placeholderId)
              }
              try {
                await db.localEntity.createMany({ data: placeholderEntitiesForSqlite })
              } catch (sqliteErr) {
                console.warn('[Process] SQLite placeholder entity write failed (non-fatal):', sqliteErr instanceof Error ? sqliteErr.message : String(sqliteErr))
              }
              if (entityListCache) {
                entityListCache.push(...placeholderEntitiesForSqlite.map(e => ({ id: e.id, entity_name: e.entityName })))
              }
              console.log(`[Process] Created ${placeholderEntitiesForSqlite.length} placeholder entities for missing relationship endpoints`)
            }
          }
        }

        const relationshipRecords = extractionResult.relationships
          .filter(rel => entityNameToIdMap.has(rel.source.toLowerCase().trim()) && entityNameToIdMap.has(rel.target.toLowerCase().trim()))

        const droppedRels = extractionResult.relationships.length - relationshipRecords.length
        if (droppedRels > 0) {
          console.warn(`[Process] Dropped ${droppedRels}/${extractionResult.relationships.length} relationships due to unresolvable entity names`)
        }

        if (relationshipRecords.length > 0) {
          const localRelsForSqlite: Array<{ id: string; documentId: string; sourceEntityId: string; targetEntityId: string; sourceEntityName: string; targetEntityName: string; relationshipType: string; description: string; confidenceScore: number; source: string }> = []
          for (const rel of relationshipRecords) {
            const relId = randomUUID()
            const sourceId = entityNameToIdMap.get(rel.source.toLowerCase().trim())!
            const targetId = entityNameToIdMap.get(rel.target.toLowerCase().trim())!
            const localRel = {
              id: relId,
              documentId: documentId,
              sourceEntityId: sourceId,
              targetEntityId: targetId,
              sourceEntityName: rel.source.trim(),
              targetEntityName: rel.target.trim(),
              relationshipType: rel.type,
              description: sanitizeForDB(rel.description),
              confidenceScore: rel.confidenceScore,
              source: rel.source_provider,
            }
            allLocalRelationships.push(localRel)
            localRelsForSqlite.push(localRel)
          }
          try {
            await db.localRelationship.createMany({ data: localRelsForSqlite })
          } catch (sqliteErr) {
            console.warn('[Process] SQLite relationship write failed (non-fatal):', sqliteErr instanceof Error ? sqliteErr.message : String(sqliteErr))
          }
          totalRelationshipsThisBatch += relationshipRecords.length
        }
      }

      // Update progress periodically (every few chunks or at batch checkpoint intervals)
      const currentProcessedCount = alreadyProcessedCount + chunksCompleted
      if (chunksCompleted % 4 === 0 || chunksCompleted === chunksToProcess.length) {
        const cumulativeEntityCount = await db.localEntity.count({ where: { documentId } }).catch(() => 0)
        const cumulativeRelCount = await db.localRelationship.count({ where: { documentId } }).catch(() => 0)
        steps = markStepRunning(steps, 'extract', `[Key ${slotIndex + 1}/${MAX_KEYS}] Chunk ${currentProcessedCount}/${savedChunks.length} — ${cumulativeEntityCount} entities, ${cumulativeRelCount} quan hệ`)
        await updateDocProgress(documentId, { steps, extractProgress: { processed: currentProcessedCount, total: savedChunks.length } })

        // Batch checkpoint: every CHUNKS_PER_BATCH chunks, log detailed progress
        if (chunksCompleted % CHUNKS_PER_BATCH === 0) {
          const prevEntityCount = await db.localEntity.count({ where: { documentId } })
          const prevRelCount = await db.localRelationship.count({ where: { documentId } })
          console.log(`[Process] Batch checkpoint: ${currentProcessedCount}/${savedChunks.length} chunks processed, ${prevEntityCount} entities, ${prevRelCount} relationships`)
          if (entityNameToIdMap.size > 100000) {
            console.warn(`[Process] entityNameToIdMap has ${entityNameToIdMap.size} entries — consider reducing concurrent documents`)
          }
          if (typeof globalThis.gc === 'function') {
            try { globalThis.gc() } catch { /* ignore */ }
          }
        }
      }
    }

    // Worker function: pulls chunks from the shared iterator and processes them
    async function extractionWorker(): Promise<void> {
      while (!shouldStop) {
        // PAUSE CHECK
        if (isDocPaused(documentId)) {
          console.log(`[Process] Document ${documentId.slice(0, 8)}... was PAUSED — worker stopping`)
          shouldStop = true
          wasTimedOut = true
          break
        }

        // TIMEOUT CHECK
        if (Date.now() - extractionStartTime > EXTRACTION_TIMEOUT_MS) {
          console.warn(`[Process] Extraction timeout after ${alreadyProcessedCount + chunksCompleted}/${savedChunks.length} chunks (${Date.now() - startTime}ms elapsed)`)
          shouldStop = true
          wasTimedOut = true
          break
        }

        // BACKPRESSURE CHECK: When provider availability is critically low (<25%),
        // pause chunk dispatch to prevent cascading key exhaustion. Without this,
        // 8 workers keep pulling chunks and every failed attempt increases failureCount,
        // accelerating key exhaustion across all providers.
        // BUG FIX: Backpressure wait does NOT count against extraction timeout.
        // Previously, repeated 10s backpressure waits could consume the entire
        // 500s timeout budget with zero chunks processed.
        const availability = getOverallAvailability()
        if (availability < 0.25) {
          console.warn(`[Process] Provider availability at ${(availability * 100).toFixed(0)}%, pausing chunk dispatch for 10s to let keys recover...`)
          const backpressureStart = Date.now()
          await new Promise(r => setTimeout(r, 10_000))
          // Extend extraction start time by the backpressure wait duration
          // so the timeout budget is not consumed by waiting for keys to recover
          extractionStartTime += (Date.now() - backpressureStart)
        }

        // Get next chunk from iterator
        const { value: chunk, done } = chunkIterator.next()
        if (done) break // No more chunks to process

        try {
          const result = await extractFromChunk(
            chunk.content,
            (chunk.domain || domain) as DocumentDomain,
            chunk.chunk_index,
            slotIndex,
          )
          // Process the result sequentially (awaited — no race conditions)
          await processExtractionResult(chunk, result)
        } catch (err) {
          failedChunks++
          chunksCompleted++
          console.warn(`[Process] Chunk ${chunk.chunk_index} extraction failed:`, err instanceof Error ? err.message : String(err))
        }
      }
    }

    // ADAPTIVE CONCURRENCY: When NVIDIA availability is low (<50%),
    // reduce concurrency to prevent key exhaustion.
    let effectiveConcurrency = SLIDING_WINDOW_CONCURRENCY
    const providerAvail = getProviderAvailability()
    const nvidiaAvail = providerAvail.nvidia ?? 1
    if (nvidiaAvail < 0.5) {
      effectiveConcurrency = Math.max(2, Math.floor(SLIDING_WINDOW_CONCURRENCY / 2))
      console.warn(`[Process] NVIDIA availability low (${(nvidiaAvail * 100).toFixed(0)}%), reducing concurrency from ${SLIDING_WINDOW_CONCURRENCY} → ${effectiveConcurrency}`)
    }

    // Launch effectiveConcurrency workers — each independently pulls chunks
    // and processes them. When one finishes a chunk, it immediately takes the next.
    const workers = Array.from(
      { length: Math.min(effectiveConcurrency, chunksToProcess.length) },
      () => extractionWorker(),
    )
    await Promise.allSettled(workers)

    // ===== Batch write all accumulated entities/relationships to SQLite (Neo4j sync happens in Step 10) =====
    // All data stays in SQLite buffer — it will be synced to Neo4j during the Neo4j step.
    console.log(`[Process] Accumulated ${allLocalEntities.length} local entities and ${allLocalRelationships.length} local relationships in SQLite buffer`)

    // Query SQLite for final entity/relationship counts for this batch
    let finalEntityCount = await db.localEntity.count({ where: { documentId } }).catch(() => 0)
    let finalRelCount = await db.localRelationship.count({ where: { documentId } }).catch(() => 0)
    steps = markStepCompleted(steps, 'extract', `${finalEntityCount || 0} entities, ${finalRelCount || 0} quan hệ từ ${alreadyProcessedCount + successfulChunks + failedChunks}/${savedChunks.length} chunks`)
    try {
      await updateDocProgress(documentId, { steps })
    } catch (progressErr) {
      // Non-fatal: if Qdrant/SQLite is temporarily down, don't crash the entire pipeline.
      // The extraction results are already saved to SQLite, so no data loss.
      console.warn('[Process] updateDocProgress failed after extraction (non-fatal):', progressErr instanceof Error ? progressErr.message : String(progressErr))
    }

    // ALL-FAIL PROTECTION: If every chunk failed extraction (all LLM providers down),
    // mark the document as 'error' instead of continuing to resolve/Neo4j/embeddings
    // which would produce an empty, useless "indexed" document.
    const totalChunksAttempted = successfulChunks + failedChunks
    if (totalChunksAttempted > 0 && successfulChunks === 0 && failedChunks === totalChunksAttempted) {
      const errorMsg = `All ${totalChunksAttempted} chunks failed extraction — all LLM providers unavailable. Will auto-retry when providers recover.`
      console.error(`[Process] ${errorMsg}`)
      steps = steps.map(s => s.name === 'extract' ? { ...s, status: 'error' as const, detail: errorMsg } : s)
      await updateDocProgress(documentId, { status: 'error', steps, errorMessage: errorMsg })
      const durationMs = Date.now() - startTime
      return {
        documentId, totalPages: document.page_count || 0, totalChunks: savedChunks.length, totalTokens: 0,
        totalEntities: 0, totalRelationships: 0,
        resolvedEntities: 0, duplicatesFound: 0, resolutionStats: { exactMatches: 0, fuzzyMatches: 0, llmResolutions: 0 },
        successfulChunks: 0, failedChunks, wasTimedOut: false,
        warning: errorMsg,
        embeddingsSaved: 0,
        provider: 'none', model: 'none', durationMs, status: 'error',
        neo4jNodes: 0, neo4jRelationships: 0,
      }
    }

    // Determine if this is the final batch (all chunks processed) or an intermediate batch (partial)
    const totalChunksProcessed = alreadyProcessedCount + successfulChunks + failedChunks
    const hasUnprocessedChunks = totalChunksProcessed < savedChunks.length
    const isFinalBatch = !wasTimedOut && !hasUnprocessedChunks

    if (!isFinalBatch) {
      // INTERMEDIATE BATCH: extraction timed out or more chunks remain.
      // Relationships are already saved incrementally during extraction — no need to save them here.
      // Just mark as 'partial' and return. The frontend will auto-trigger the next batch.
      console.log(`[Process] Intermediate batch: ${totalChunksProcessed}/${savedChunks.length} chunks done. Marking as 'partial' for auto-continue.`)

      steps = markStepPending(steps, 'resolve', 'Sẽ thực hiện khi hoàn tất trích xuất')
      steps = markStepPending(steps, 'neo4j', 'Sẽ thực hiện khi hoàn tất trích xuất')
      steps = markStepPending(steps, 'embeddings', 'Sẽ thực hiện khi hoàn tất trích xuất')
      try {
        await updateDocProgress(documentId, { status: 'partial', steps })
      } catch (progressErr) {
        // Non-fatal: if Qdrant/SQLite is down, still return 'partial' so the auto-chain
        // can re-trigger the next batch. Without this, the pipeline throws and the
        // auto-chain marks the doc as 'error' even though extraction succeeded.
        console.warn('[Process] updateDocProgress(partial) failed (non-fatal):', progressErr instanceof Error ? progressErr.message : String(progressErr))
        // Try a simpler status update as fallback
        try { await updateDocumentStatus(documentId, { status: 'partial' }) } catch { /* give up */ }
        try { await db.document.update({ where: { id: documentId }, data: { status: 'partial' } }) } catch { /* give up */ }
      }
      const durationMs = Date.now() - startTime
      return {
        documentId, totalPages: document.page_count || 0, totalChunks: savedChunks.length, totalTokens: 0,
        totalEntities: finalEntityCount || 0, totalRelationships: finalRelCount || 0,
        resolvedEntities: 0, duplicatesFound: 0, resolutionStats: { exactMatches: 0, fuzzyMatches: 0, llmResolutions: 0 },
        successfulChunks, failedChunks, wasTimedOut,
        warning: undefined,
        embeddingsSaved: 0,
        provider: lastProvider, model: lastModel, durationMs, status: 'partial',
        neo4jNodes: 0, neo4jRelationships: 0,
      }
    }

    // FINAL BATCH: all chunks processed — now run resolve, Neo4j, and embeddings
    // PAUSE CHECK: Even if extraction completed, if the user paused the document
    // (e.g., right after extraction finished but before resolve started), we must stop.
    // This prevents the expensive resolve/Neo4j/embeddings steps from running on a
    // document the user explicitly wanted to pause.
    if (isDocPaused(documentId)) {
      console.log(`[Process] Document ${documentId.slice(0, 8)}... was PAUSED after extraction completed — stopping before resolve/Neo4j/embeddings`)
      steps = markStepPending(steps, 'resolve', 'Đã tạm dừng bởi người dùng')
      steps = markStepPending(steps, 'neo4j', 'Đã tạm dừng bởi người dùng')
      steps = markStepPending(steps, 'embeddings', 'Đã tạm dừng bởi người dùng')
      await updateDocProgress(documentId, { status: 'partial', steps })
      const durationMs = Date.now() - startTime
      return {
        documentId, totalPages: document.page_count || 0, totalChunks: savedChunks.length, totalTokens: 0,
        totalEntities: finalEntityCount || 0, totalRelationships: finalRelCount || 0,
        resolvedEntities: pipelineResolvedCount, duplicatesFound: pipelineDuplicatesFound, resolutionStats: pipelineResolutionStats,
        successfulChunks, failedChunks, wasTimedOut: true,
        warning: 'Document was paused by user after extraction completed',
        embeddingsSaved: 0,
        provider: lastProvider, model: lastModel, durationMs, status: 'partial',
        neo4jNodes: pipelineNeo4jNodes, neo4jRelationships: pipelineNeo4jRelationships,
      }
    }
    // Load data from DB just-in-time (zero-memory approach — no accumulated arrays)
    console.log(`[Process] Final batch: all ${savedChunks.length} chunks processed. Loading data from DB for resolve+Neo4j+embeddings.`)

    // CHECK WHICH STEPS ARE ALREADY COMPLETED (to avoid re-running them on pipeline re-trigger)
    // This prevents the infinite re-processing loop where Neo4j writing times out, the pipeline
    // re-runs, and tries to do resolve+Neo4j+embeddings all over again.
    const resolveStep = steps.find(s => s.name === 'resolve')
    const neo4jStep = steps.find(s => s.name === 'neo4j')
    const embeddingsStep = steps.find(s => s.name === 'embeddings')

    const resolveCompleted = resolveStep?.status === 'completed'
    const neo4jCompleted = neo4jStep?.status === 'completed'
    const embeddingsCompleted = embeddingsStep?.status === 'completed'

    // Verify completion claims against actual DB data (prevent stale step status)
    let hasResolvedEntities = resolveCompleted
    let hasNeo4jData = neo4jCompleted
    let hasEmbeddingsData = embeddingsCompleted

    // FIX #4 + FIX #10: Re-verify hasNeo4jData against actual Neo4j data — mirroring the
    // resolve + embeddings COUNT() checks. Previously this just copied
    // the step status: once the neo4j step was wrongly marked 'completed' (via
    // Fix #3's old fall-through on non-timeout errors), hasNeo4jData stayed true
    // forever and the Neo4j write was skipped on EVERY subsequent re-run. Now we
    // count semantic relationship edges (excluding CONTAINS doc→entity links)
    // stored in Neo4j for this document, and compare with the SQLite buffer.
    // FIX #10 strengthens the comparison: 'missing' (SQLite rels > 0, Neo4j = 0)
    // AND 'partial' (Neo4j < 50% of SQLite — e.g. 9 rels written of 500 before a
    // crash) both force a re-run. 'unknown' (COUNT query failed) also forces a
    // re-run to be safe. The re-write is idempotent (MERGE, no duplicates).
    if (neo4jCompleted) {
      const coverage = await verifyNeo4jRelCoverage(documentId)
      if (coverage === 'missing') {
        hasNeo4jData = false
        console.warn(`[Process] Neo4j step marked completed but 0 semantic relationships in Neo4j while SQLite has some — re-running Neo4j step (Fix #4 caught a stale 'completed' status)`)
      } else if (coverage === 'partial') {
        hasNeo4jData = false
        console.warn(`[Process] Fix #10: Neo4j step marked completed but Neo4j holds far fewer relationships than SQLite (partial write from a crashed batch) — re-running Neo4j step to write the missing data`)
      } else if (coverage === 'unknown') {
        hasNeo4jData = false
        console.warn(`[Process] Neo4j COUNT verification failed for doc ${documentId.slice(0, 8)}... — forcing re-run to be safe (not trusting stale 'completed' status)`)
      }
    }

    if (resolveCompleted) {
      const resolvedCount = await db.localResolvedEntity.count({
        where: { documentId }
      })
      hasResolvedEntities = resolvedCount > 0
      if (!hasResolvedEntities) console.log(`[Process] Resolve step marked completed but no resolved entities found — re-running`)
    }

    if (embeddingsCompleted && !rebuiltChunksFromPdf) {
      const embChunkCount = await getChunkCount(documentId)
      hasEmbeddingsData = embChunkCount > 0
      if (!hasEmbeddingsData) console.log(`[Process] Embeddings step marked completed but no embeddings found — re-running`)
    } else if (rebuiltChunksFromPdf) {
      // Chunk rebuild mode: the "embeddings completed" step status is stale (from
      // reconcile/pre-reset) — the rebuilt chunks only have placeholder zero vectors.
      hasEmbeddingsData = false
      console.log(`[Process] Chunk rebuild mode: forcing embedding regeneration for ${savedChunks.length} rebuilt chunks`)
    }

    // Step 7: Load ALL entities from DB for resolution
    if (!hasResolvedEntities) {
      steps = markStepRunning(steps, 'resolve')
      await updateDocProgress(documentId, { steps })

      // PAGINATED: Fetch ALL entities from SQLite to avoid data truncation.
      const allEntitiesFromSqlite = await db.localEntity.findMany({
        where: { documentId },
      })
      const loadedEntities: Array<ExtractedEntity & { chunkId: string }> = allEntitiesFromSqlite.map(e => ({
        name: e.entityName || '',
        type: (e.entityType || 'Concept') as EntityType,
        description: e.description || '',
        properties: (() => { try { return e.properties ? JSON.parse(e.properties) : {} } catch { return {} } })() as Record<string, string | number | boolean>,
        confidenceScore: e.confidenceScore || 0.7,
        source: e.source || 'previous',
        domain: (e.domain || domain) as DocumentDomain,
        chunkId: e.chunkId || '',
      }))
      console.log(`[Process] Loaded ${loadedEntities.length} entities from DB for resolution`)

      // FIX Bug 2: Clear old resolved_entity_id in SQLite and delete stale resolved entities
      try {
        await db.localEntity.updateMany({
          where: { documentId, resolvedEntityId: { not: null } },
          data: { resolvedEntityId: null },
        })
        console.log(`[Process] Cleared old resolved_entity_id for document ${documentId}`)
      } catch (err) {
        console.warn(`[Process] Failed to clear old resolved_entity_id:`, err instanceof Error ? err.message : String(err))
      }

      // Delete stale resolved_entities that were created from this document's entities.
      // Phase 5.4 + AUDIT FIX: Normalize case so cleanup catches ALL case variants.
      // "Python", "python", "PYTHON" should all be cleaned up.
      // We generate lowercase + title-case variants for each entity name.
      try {
        const docEntityNames = await db.localEntity.findMany({
          where: { documentId },
          select: { entityName: true },
        })
        if (docEntityNames && docEntityNames.length > 0) {
          const uniqueNames = [...new Set(docEntityNames.map(e => e.entityName.trim()))]
          // For each name, generate case variants and delete them all
          for (const name of uniqueNames) {
            const variants = [...new Set([
              name,
              name.toLowerCase(),
              name.charAt(0).toUpperCase() + name.slice(1).toLowerCase(),
            ])]
            await db.localResolvedEntity.deleteMany({
              where: { canonicalName: { in: variants } },
            })
          }
          console.log(`[Process] Deleted stale resolved_entities for document ${documentId} (case-insensitive)`)
        }
      } catch (err) {
        console.warn(`[Process] Failed to clean stale resolved_entities:`, err instanceof Error ? err.message : String(err))
      }

      const resolutionResult = resolveEntities(loadedEntities)

      // Capture resolution stats for the final pipeline return value.
      pipelineResolvedCount = resolutionResult.resolved.length
      pipelineDuplicatesFound = resolutionResult.duplicates.length
      pipelineResolutionStats = {
        totalInput: resolutionResult.stats.totalInput,
        afterExactMatch: resolutionResult.stats.afterExactMatch,
        afterFuzzyMatch: resolutionResult.stats.afterFuzzyMatch,
        finalCount: resolutionResult.stats.finalCount,
      }

      steps = markStepCompleted(steps, 'resolve', `${resolutionResult.resolved.length} entities sau hợp nhất`)
      await updateDocProgress(documentId, { steps })

      // Clear loaded entities from memory — they're no longer needed after resolution
      loadedEntities.length = 0

      // Step 8: Save resolved entities to SQLite buffer
      if (resolutionResult.resolved.length > 0) {
        // Smart upsert for resolved entities — only overwrite existing data
        // if the new data is more complete.
        const canonicalNames = resolutionResult.resolved.map(e => e.canonicalName)
        // AUDIT FIX: SQLite's `IN` clause is case-sensitive, so "Python" won't match "python".
        // Add lowercase + title-case variants to ensure we find all existing records.
        const caseVariants = [...new Set(canonicalNames.flatMap(name => [
          name,
          name.toLowerCase(),
          name.charAt(0).toUpperCase() + name.slice(1).toLowerCase(),
        ]))]
        const existingResolved = await db.localResolvedEntity.findMany({
          where: { canonicalName: { in: caseVariants } },
        })
        // Use lowercase keys for case-insensitive lookup — "Python" should match "python"
        const existingMap = new Map(existingResolved.map(e => [e.canonicalName.toLowerCase(), e]))

        const toInsert: Array<{
          canonicalName: string; entityType: string; description: string;
          properties: string; avgConfidence: number; occurrenceCount: number; domains: string;
        }> = []
        const toUpdate: Array<{ id: string; data: Record<string, unknown> }> = []

        for (const entity of resolutionResult.resolved) {
          const existing = existingMap.get(entity.canonicalName.toLowerCase())
          const newDesc = sanitizeForDB(entity.description)
          if (existing) {
            const newIsBetter = (newDesc.length > (existing.description || '').length) ||
              (entity.avgConfidence > existing.avgConfidence) ||
              (entity.occurrenceCount > existing.occurrenceCount)
            if (newIsBetter) {
              toUpdate.push({
                id: existing.id,
                data: {
                  description: newDesc.length > (existing.description || '').length ? newDesc : existing.description,
                  avgConfidence: Math.max(entity.avgConfidence, existing.avgConfidence),
                  occurrenceCount: Math.max(entity.occurrenceCount, existing.occurrenceCount),
                  domains: JSON.stringify([...new Set([...(entity.domains || []), ...(JSON.parse(existing.domains || '[]') as string[])])]),
                },
              })
            }
          } else {
            toInsert.push({
              documentId,
              canonicalName: entity.canonicalName, entityType: entity.entityType,
              description: newDesc, properties: JSON.stringify(entity.properties),
              avgConfidence: entity.avgConfidence, occurrenceCount: entity.occurrenceCount,
              domains: JSON.stringify(entity.domains),
            })
          }
        }

        // Insert new resolved entities — 3-layer protection against pipeline abort:
        // Layer 1: skipDuplicates to handle race condition (2 docs inserting same canonicalName)
        // Layer 2: Fallback to individual upsert if skipDuplicates still fails
        // Layer 3: Log but DO NOT abort pipeline on individual entity errors
        if (toInsert.length > 0) {
          try {
            for (let i = 0; i < toInsert.length; i += 100) {
              await db.localResolvedEntity.createMany({
                data: toInsert.slice(i, i + 100),
                skipDuplicates: true, // Layer 1: Skip rows that violate unique constraints
              })
            }
          } catch (createManyErr: any) {
            // Layer 2: Fallback to individual upserts
            console.warn(`[Process] createMany with skipDuplicates failed, falling back to individual upserts:`, createManyErr instanceof Error ? createManyErr.message : String(createManyErr))
            for (const entity of toInsert) {
              try {
                await db.localResolvedEntity.upsert({
                  where: { canonicalName: entity.canonicalName },
                  create: entity,
                  update: {
                    occurrenceCount: { increment: entity.occurrenceCount || 1 },
                    avgConfidence: entity.avgConfidence,
                    description: entity.description || undefined,
                    properties: entity.properties || undefined,
                    domains: entity.domains || undefined,
                    documentId: entity.documentId || undefined,
                  },
                })
              } catch (upsertErr: any) {
                // Layer 3: Log but DO NOT abort pipeline — Neo4j write step must still run
                console.warn(`[Process] Resolved entity upsert failed for "${entity.canonicalName}":`, upsertErr instanceof Error ? upsertErr.message : String(upsertErr))
              }
            }
          }
          console.log(`[Process] Processed ${toInsert.length} new resolved entities`)
        }

        // Update existing resolved entities with better data
        if (toUpdate.length > 0) {
          for (const { id, data } of toUpdate) {
            await db.localResolvedEntity.update({ where: { id }, data: data as { description?: string; avgConfidence?: number; occurrenceCount?: number; domains?: string } })
          }
          console.log(`[Process] Updated ${toUpdate.length} existing resolved entities with richer data`)
        }

        // Link extracted entities to their resolved_entity
        const resolvedFromDb = await db.localResolvedEntity.findMany({
          where: { canonicalName: { in: resolutionResult.resolved.map(e => e.canonicalName) } },
        })
        if (resolvedFromDb.length > 0) {
          const resolvedNameToId = new Map(resolvedFromDb.map(e => [e.canonicalName, e.id]))
          for (const resolved of resolutionResult.resolved) {
            const resolvedId = resolvedNameToId.get(resolved.canonicalName)
            if (resolvedId) for (const sourceName of resolved.sourceNames) {
              // Update SQLite LocalEntity records with resolved_entity_id
              try {
                await db.localEntity.updateMany({
                  where: { documentId, entityName: sourceName },
                  data: { resolvedEntityId: resolvedId },
                })
              } catch (sqliteErr) {
                console.warn('[Process] SQLite resolved_entity_id update failed:', sqliteErr instanceof Error ? sqliteErr.message : String(sqliteErr))
              }
              // Also try case-insensitive match
              try {
                const docLocalEntities = await db.localEntity.findMany({
                  where: { documentId },
                  select: { id: true, entityName: true },
                })
                const ciMatchIds = docLocalEntities
                  .filter(e => e.entityName.toLowerCase().trim() === sourceName.toLowerCase().trim() && e.entityName !== sourceName)
                  .map(e => e.id)
                if (ciMatchIds.length > 0) {
                  await db.localEntity.updateMany({
                    where: { id: { in: ciMatchIds } },
                    data: { resolvedEntityId: resolvedId },
                  })
                }
              } catch (sqliteErr) {
                console.warn('[Process] SQLite case-insensitive resolved_entity_id update failed:', sqliteErr instanceof Error ? sqliteErr.message : String(sqliteErr))
              }
            }
          }
        }
      }

      // POST-RESOLUTION ENTITY CONSOLIDATION: Merge duplicate entities and reconcile relationships.
      // After resolution, multiple extracted_entities may point to the same resolved_entity.
      // The relationships table still references the original entity IDs, causing orphans:
      //   - Entity "Python" (id=A, has relationships) and "python" (id=B, orphan) both → resolved_entity X
      //   - Relationships reference A but not B, so B is counted as orphan
      // FIX: For each resolved_entity group, pick one canonical entity, re-map all relationships
      // to it, and delete the duplicates. This eliminates orphans caused by name variations.
      console.log(`[Process] Running post-resolution entity consolidation...`)
      const consolidationStart = Date.now()

      // Load ALL entities for this document from SQLite
      const allDocEntities = await db.localEntity.findMany({
        where: { documentId },
        select: { id: true, entityName: true, resolvedEntityId: true, confidenceScore: true, source: true },
      })

      // Group entities by resolved_entity_id
      const entitiesByResolved = new Map<string, Array<{ id: string; name: string; confidence: number; source: string }>>()
      const unresolvedEntities: Array<{ id: string; name: string; confidence: number; source: string }> = []
      for (const e of allDocEntities) {
        const resolvedId = e.resolvedEntityId || null
        const entityInfo = {
          id: e.id,
          name: e.entityName || '',
          confidence: e.confidenceScore || 0.5,
          source: e.source || '',
        }
        if (resolvedId) {
          if (!entitiesByResolved.has(resolvedId)) entitiesByResolved.set(resolvedId, [])
          entitiesByResolved.get(resolvedId)!.push(entityInfo)
        } else {
          unresolvedEntities.push(entityInfo)
        }
      }

      // Also group unresolved entities by name (case-insensitive) for dedup
      const unresolvedByName = new Map<string, Array<{ id: string; name: string; confidence: number; source: string }>>()
      for (const e of unresolvedEntities) {
        const key = e.name.toLowerCase().trim()
        if (!unresolvedByName.has(key)) unresolvedByName.set(key, [])
        unresolvedByName.get(key)!.push(e)
      }

      let totalMerged = 0
      let totalRelsRemapped = 0
      const entityIdsToDelete: string[] = []

      // Process resolved entity groups (entities that were merged by resolution)
      for (const [, entities] of entitiesByResolved) {
        if (entities.length <= 1) continue // No duplicates to consolidate

        // Pick canonical entity: prefer highest confidence, longest name, non-placeholder
        entities.sort((a, b) => {
          // Prefer non-placeholder entities
          const aPlaceholder = a.source === 'auto-placeholder' ? 0 : 1
          const bPlaceholder = b.source === 'auto-placeholder' ? 0 : 1
          if (aPlaceholder !== bPlaceholder) return bPlaceholder - aPlaceholder
          // Then prefer higher confidence
          if (b.confidence !== a.confidence) return b.confidence - a.confidence
          // Then prefer longer name (more descriptive)
          return b.name.length - a.name.length
        })
        const canonical = entities[0]
        const duplicates = entities.slice(1)

        // Re-map relationships from duplicates to canonical
        for (const dup of duplicates) {
          // Update relationships where sourceEntityId = dup.id → canonical.id
          const sourceCount = await db.localRelationship.updateMany({
            where: { documentId, sourceEntityId: dup.id },
            data: { sourceEntityId: canonical.id },
          })
          // Update relationships where targetEntityId = dup.id → canonical.id
          const targetCount = await db.localRelationship.updateMany({
            where: { documentId, targetEntityId: dup.id },
            data: { targetEntityId: canonical.id },
          })
          totalRelsRemapped += sourceCount.count + targetCount.count
          entityIdsToDelete.push(dup.id)
        }
        totalMerged += duplicates.length
      }

      // Process unresolved entity groups (same name, no resolved_entity_id)
      for (const [, entities] of unresolvedByName) {
        if (entities.length <= 1) continue

        // Pick canonical entity: prefer highest confidence, non-placeholder
        entities.sort((a, b) => {
          const aPlaceholder = a.source === 'auto-placeholder' ? 0 : 1
          const bPlaceholder = b.source === 'auto-placeholder' ? 0 : 1
          if (aPlaceholder !== bPlaceholder) return bPlaceholder - aPlaceholder
          if (b.confidence !== a.confidence) return b.confidence - a.confidence
          return b.name.length - a.name.length
        })
        const canonical = entities[0]
        const duplicates = entities.slice(1)

        for (const dup of duplicates) {
          const sourceCount = await db.localRelationship.updateMany({
            where: { documentId, sourceEntityId: dup.id },
            data: { sourceEntityId: canonical.id },
          })
          const targetCount = await db.localRelationship.updateMany({
            where: { documentId, targetEntityId: dup.id },
            data: { targetEntityId: canonical.id },
          })
          totalRelsRemapped += sourceCount.count + targetCount.count
          entityIdsToDelete.push(dup.id)
        }
        totalMerged += duplicates.length
      }

      // CRITICAL FIX: DO NOT delete duplicate entities from SQLite!
      // Previously, consolidation deleted duplicate entities after remapping relationships.
      // This caused massive data loss — e.g., 2,728 extracted → 424 remaining.
      // The correct approach: keep ALL raw entities in SQLite (per-chunk),
      // only deduplicate when writing to Neo4j.
      // The remapped relationships ensure the graph is correct in both SQLite and Neo4j.
      // Duplicate entities in SQLite are NOT a problem — they represent different
      // extractions from different chunks, each with unique descriptions and context.
      if (entityIdsToDelete.length > 0) {
        console.log(`[Process] Kept ${entityIdsToDelete.length} duplicate entities in SQLite (dedup only in Neo4j) — relationships remapped to canonical entities`)
      }

      // Remove self-referencing relationships (same source and target after consolidation)
      const allRelsForSelfRef = await db.localRelationship.findMany({
        where: { documentId },
        select: { id: true, sourceEntityId: true, targetEntityId: true },
      })
      const selfRefIds = allRelsForSelfRef
        .filter(r => r.sourceEntityId === r.targetEntityId)
        .map(r => r.id)
      if (selfRefIds.length > 0) {
        for (let i = 0; i < selfRefIds.length; i += 100) {
          await db.localRelationship.deleteMany({
            where: { id: { in: selfRefIds.slice(i, i + 100) } },
          })
        }
        console.log(`[Process] Deleted ${selfRefIds.length} self-referencing relationships after consolidation`)
      }

      // DISABLED: Automatic orphan cleanup after consolidation.
      // Previously, this deleted entities without relationships. But after we stopped
      // deleting duplicates in consolidation (see fix above), the "orphan" count is now
      // much higher because many raw entities (per-chunk) don't have direct relationships.
      // These entities are still valuable — they have descriptions and properties from
      // their specific chunk context. Deleting them causes massive data loss.
      // Orphan cleanup is available manually via /api/query?action=reconcile-orphans.
      console.log(`[Process] Skipping automatic orphan cleanup (kept all entities for data integrity)`)

      const consolidationMs = Date.now() - consolidationStart
      console.log(`[Process] Consolidation complete: merged ${totalMerged} duplicate entities, remapped ${totalRelsRemapped} relationships in ${consolidationMs}ms`)

      // Update resolve step description
      const resolveStepObj = steps.find(s => s.name === 'resolve')
      if (resolveStepObj) {
        steps = markStepCompleted(steps, 'resolve', `${resolutionResult.resolved.length} entities sau hợp nhất (${totalMerged} bản sao đã gộp)`)
        await updateDocProgress(documentId, { steps })
      }
    } else {
      console.log(`[Process] Skipping resolve step — already completed`)
    }

    // Step 9: Relationships are already saved incrementally during extraction — no need to save again.
    // Just load them from DB for Neo4j writing.

    // PAUSE CHECK: Before the expensive Neo4j step, check if the document was paused.
    // Resolve may take a long time, and the user may have paused during that time.
    if (isDocPaused(documentId)) {
      console.log(`[Process] Document ${documentId.slice(0, 8)}... was PAUSED before Neo4j step — stopping`)
      steps = markStepPending(steps, 'neo4j', 'Đã tạm dừng bởi người dùng')
      steps = markStepPending(steps, 'embeddings', 'Đã tạm dừng bởi người dùng')
      await updateDocProgress(documentId, { status: 'partial', steps })
      const durationMs = Date.now() - startTime
      return {
        documentId, totalPages: document.page_count || 0, totalChunks: savedChunks.length, totalTokens: 0,
        totalEntities: finalEntityCount || 0, totalRelationships: finalRelCount || 0,
        resolvedEntities: pipelineResolvedCount, duplicatesFound: pipelineDuplicatesFound, resolutionStats: pipelineResolutionStats,
        successfulChunks, failedChunks, wasTimedOut: true,
        warning: 'Document was paused by user before Neo4j step',
        embeddingsSaved: 0,
        provider: lastProvider, model: lastModel, durationMs, status: 'partial',
        neo4jNodes: pipelineNeo4jNodes, neo4jRelationships: pipelineNeo4jRelationships,
      }
    }

    // Step 10: Write to Neo4j (create entity nodes + relationship edges)
    // CRITICAL FIX: When re-running, check if Neo4j data already exists for this document.
    // If the step was previously completed successfully, skip it to prevent the infinite
    // re-processing loop (where Neo4j writing times out → pipeline re-runs → Neo4j again → timeout).
    if (!hasNeo4jData) {
      steps = markStepRunning(steps, 'neo4j')
      await updateDocProgress(documentId, { steps })
      let neo4jNodes = 0; let neo4jRelationships = 0
      try {
        // LOCAL-FIRST: Read from SQLite buffer for entities to write to Neo4j.
        // All entity data is in SQLite buffer after the extraction step.
        let savedEntities = await db.localEntity.findMany({
          where: { documentId },
          select: { id: true, entityName: true, entityType: true, description: true, confidenceScore: true, domain: true },
        })

        let neo4jEntities: Array<{ id: string; name: string; type: string; domain: string; description: string; confidence: number }>
        let neo4jRels: Array<{ sourceId: string; targetId: string; sourceName: string; targetName: string; type: string; description?: string; confidence?: number }>

        if (savedEntities.length > 0) {
          // ✅ SQLite has data (document was processed with local-first pipeline)
          neo4jEntities = savedEntities.map(e => ({
            id: e.id, name: e.entityName,
            type: e.entityType || 'Concept',
            domain: e.domain || domain,
            description: e.description || '',
            confidence: e.confidenceScore || 0.5,
          }))

          const savedRels = await db.localRelationship.findMany({
            where: { documentId },
            select: { sourceEntityId: true, targetEntityId: true, relationshipType: true, description: true, confidenceScore: true },
          })
          const entityIdToName = new Map(savedEntities.map(e => [e.id, e.entityName]))
          neo4jRels = savedRels
            .filter(r => entityIdToName.has(r.sourceEntityId || '') && entityIdToName.has(r.targetEntityId || ''))
            .map(r => ({
              sourceId: r.sourceEntityId!,
              targetId: r.targetEntityId!,
              sourceName: entityIdToName.get(r.sourceEntityId!)!,
              targetName: entityIdToName.get(r.targetEntityId!)!,
              type: r.relationshipType || 'RELATED_TO',
              description: r.description || '',
              confidence: r.confidenceScore || 0,
            }))
          console.log(`[Process] Neo4j: loaded ${savedEntities.length} entities + ${savedRels.length} rels from SQLite`)
        } else {
          // SQLite buffer only
          const sqliteEntities = await db.localEntity.findMany({
            where: { documentId },
            select: { id: true, entityName: true, entityType: true, description: true, confidenceScore: true, domain: true },
          })
          neo4jEntities = sqliteEntities.map(e => ({
            id: e.id, name: e.entityName,
            type: e.entityType || 'Concept',
            domain: e.domain || domain,
            description: e.description || '',
            confidence: e.confidenceScore || 0.5,
          }))

          const sqliteRels = await db.localRelationship.findMany({
            where: { documentId },
            select: { sourceEntityId: true, targetEntityId: true, relationshipType: true, description: true, confidenceScore: true },
          })
          const entityIdToName = new Map(sqliteEntities.map(e => [e.id, e.entityName]))
          neo4jRels = sqliteRels
            .filter(r => entityIdToName.has(r.sourceEntityId || '') && entityIdToName.has(r.targetEntityId || ''))
            .map(r => ({
              sourceId: r.sourceEntityId!,
              targetId: r.targetEntityId!,
              sourceName: entityIdToName.get(r.sourceEntityId!)!,
              targetName: entityIdToName.get(r.targetEntityId!)!,
              type: r.relationshipType || 'RELATED_TO',
              description: r.description || '',
              confidence: r.confidenceScore || 0,
            }))
          console.log(`[Process] Neo4j: loaded ${sqliteEntities.length} entities + ${sqliteRels.length} rels from SQLite`)
        }

        // ======================================================================
        // CRITICAL FIX (data-loss bug): Create/update the Document node BEFORE
        // writeEntitiesToNeo4j. Its Step 6 creates CONTAINS rels via
        //   MATCH (d:Document {id: $documentId}), (e {id: eid}) MERGE (d)-[:CONTAINS]->(e)
        // If the Document node doesn't exist, MATCH silently returns nothing →
        // no CONTAINS created → Step 7 orphan cleanup (LIMIT 1000 DETACH DELETE)
        // then treats ALL entities as orphans and deletes up to 1000 of them
        // on EVERY fresh document processing (ongoing graph bleed).
        // ======================================================================
        const docNowIso = new Date().toISOString()
        await upsertDocumentNode({
          id: documentId,
          title: (document.title as string) || documentId,
          domain: (document.domain as string) || domain || 'mixed',
          status: (document.status as string) || 'extracted',
          page_count: (document.page_count as number) || undefined,
          created_at: (document.created_at as string) || docNowIso,
          updated_at: docNowIso,
        })

        // FIX: Pass skipDeletion=isResuming to avoid destroying all Neo4j data on re-extract.
        // When re-extracting, we use MERGE for incremental updates instead of delete-all-then-recreate.
        const neo4jResult = await writeEntitiesToNeo4j(neo4jEntities, neo4jRels, documentId, isResuming)
        neo4jNodes = neo4jResult.nodesCreated; neo4jRelationships = neo4jResult.relationshipsCreated
        pipelineNeo4jNodes = neo4jNodes; pipelineNeo4jRelationships = neo4jRelationships
      } catch (neo4jErr) {
        const isNeo4jTimeout = neo4jErr instanceof Error && neo4jErr.name === 'Neo4jTimeoutError'
        if (isNeo4jTimeout) {
          // Neo4j timed out — mark document as 'partial' so it can be retried later.
          // Do NOT mark as 'error' because the data is partially written (not lost).
          // Do NOT continue to embeddings/indexed because Neo4j data is incomplete.
          console.warn(`[Process] Neo4j write timed out for document ${documentId}: ${neo4jNodes} nodes, ${neo4jRelationships} edges written. Marking as 'partial' for retry.`)
          steps = markStepCompleted(steps, 'neo4j', `${neo4jNodes} nodes, ${neo4jRelationships} edges (timed out — partial)`)
          await updateDocProgress(documentId, { status: 'partial', steps })
          return {
            documentId, totalPages: document.page_count || 0, totalChunks: savedChunks.length, totalTokens: 0,
            totalEntities: finalEntityCount || 0, totalRelationships: finalRelCount || 0,
            resolvedEntities: pipelineResolvedCount, duplicatesFound: pipelineDuplicatesFound,
            resolutionStats: pipelineResolutionStats,
            successfulChunks, failedChunks, wasTimedOut: true,
            provider: lastProvider, model: lastModel, durationMs: Date.now() - startTime,
            status: 'partial' as const, neo4jNodes, neo4jRelationships,
          }
        }
        // FIX #3: NON-TIMEOUT Neo4j error (auth, connection, syntax, etc.).
        // Previously this fell through to markStepCompleted() below — marking the
        // step 'completed' with 0 nodes/0 edges. Combined with Fix #4 (hasNeo4jData
        // not re-verifying with COUNT), this made Neo4j get skipped FOREVER on
        // every subsequent re-run. Now: mark the step as 'error' (total failure)
        // or 'partial' (some data written) and return early, so the document
        // stays retryable instead of being wrongly marked 'completed'.
        const neo4jErrMsg = neo4jErr instanceof Error ? neo4jErr.message : String(neo4jErr)
        console.error(`[Process] Neo4j write FAILED (non-timeout) for document ${documentId}: ${neo4jErrMsg}`)
        if (neo4jNodes === 0 && neo4jRelationships === 0) {
          // Total failure — mark 'error' so the pipeline can retry (and Fix #4
          // will also catch it if it ever gets wrongly marked 'completed' again).
          steps = markStepError(steps, 'neo4j', `Neo4j write failed: ${neo4jErrMsg.slice(0, 150)}`)
          await updateDocProgress(documentId, { status: 'error', steps, errorMessage: `Neo4j write failed: ${neo4jErrMsg}` })
          return {
            documentId, totalPages: document.page_count || 0, totalChunks: savedChunks.length, totalTokens: 0,
            totalEntities: finalEntityCount || 0, totalRelationships: finalRelCount || 0,
            resolvedEntities: pipelineResolvedCount, duplicatesFound: pipelineDuplicatesFound,
            resolutionStats: pipelineResolutionStats,
            successfulChunks, failedChunks, wasTimedOut: false,
            warning: `Neo4j write failed: ${neo4jErrMsg}`,
            embeddingsSaved: 0,
            provider: lastProvider, model: lastModel, durationMs: Date.now() - startTime, status: 'error' as const,
            neo4jNodes, neo4jRelationships,
          }
        }
        // Partial data written despite the error — mark 'partial' (retryable) and return early.
        // Do NOT continue to embeddings because Neo4j data is incomplete.
        steps = markStepCompleted(steps, 'neo4j', `${neo4jNodes} nodes, ${neo4jRelationships} edges (partial — non-timeout error)`)
        await updateDocProgress(documentId, { status: 'partial', steps })
        return {
          documentId, totalPages: document.page_count || 0, totalChunks: savedChunks.length, totalTokens: 0,
          totalEntities: finalEntityCount || 0, totalRelationships: finalRelCount || 0,
          resolvedEntities: pipelineResolvedCount, duplicatesFound: pipelineDuplicatesFound,
          resolutionStats: pipelineResolutionStats,
          successfulChunks, failedChunks, wasTimedOut: false,
          warning: `Neo4j write partial: ${neo4jErrMsg}`,
          embeddingsSaved: 0,
          provider: lastProvider, model: lastModel, durationMs: Date.now() - startTime, status: 'partial' as const,
          neo4jNodes, neo4jRelationships,
        }
      }
      // Reaching here means the Neo4j write SUCCEEDED (no error thrown) — safe to mark completed
      steps = markStepCompleted(steps, 'neo4j', `${neo4jNodes} nodes, ${neo4jRelationships} edges`)
      await updateDocProgress(documentId, { steps })

      // Phase 5.2 FIX: Mark resolved entities + relationships as synced after successful Neo4j write.
      // Previously, the synced flag was never set to true in the pipeline — only via the separate
      // /api/sync-neo4j endpoint. This caused the Phase 5.2 verification check to always report
      // unsynced entities (false positive), making it impossible to detect truly missing data.
      if (neo4jNodes > 0 || neo4jRelationships > 0) {
        try {
          const [entitySyncResult, relSyncResult] = await Promise.all([
            db.localResolvedEntity.updateMany({
              where: { documentId, synced: false },
              data: { synced: true },
            }),
            db.localRelationship.updateMany({
              where: { documentId, synced: false },
              data: { synced: true },
            }),
          ])
          console.log(`[Process] Marked ${entitySyncResult.count} resolved entities + ${relSyncResult.count} relationships as synced to Neo4j`)
        } catch (syncErr) {
          // Non-fatal — Neo4j data was written successfully, just the flag update failed
          console.warn('[Process] Failed to mark entities as synced:', syncErr instanceof Error ? syncErr.message : String(syncErr))
        }
      }

      // Phase 5.2: Verify Neo4j sync — now this check is meaningful because synced=true
      // is set above. If any entities remain unsynced, they genuinely failed to sync.
      try {
        const unsyncedCount = await db.localResolvedEntity.count({
          where: { documentId, synced: false },
        })
        if (unsyncedCount > 0) {
          console.warn(`[Process] ${unsyncedCount} resolved entities genuinely not synced to Neo4j for doc ${documentId.slice(0, 8)}... — these can be retried via PUT ?action=recover`)
        }
      } catch (countErr) {
        // Non-fatal — just a diagnostic check
        console.warn('[Process] Failed to count unsynced entities:', countErr instanceof Error ? countErr.message : String(countErr))
      }
    } else {
      console.log(`[Process] Skipping Neo4j step — already completed`)
    }

    // Step 11: Generate embeddings using generateEmbeddingBatch
    // Step 12: Save embeddings to Qdrant chunks
    // When resuming, only generate embeddings for chunks that don't already have one

    // PAUSE CHECK: Before the embeddings step, check if the document was paused.
    // Neo4j writing can take a long time, and the user may have paused during that time.
    if (isDocPaused(documentId)) {
      console.log(`[Process] Document ${documentId.slice(0, 8)}... was PAUSED before embeddings step — stopping`)
      steps = markStepPending(steps, 'embeddings', 'Đã tạm dừng bởi người dùng')
      await updateDocProgress(documentId, { status: 'partial', steps })
      const durationMs = Date.now() - startTime
      return {
        documentId, totalPages: document.page_count || 0, totalChunks: savedChunks.length, totalTokens: 0,
        totalEntities: finalEntityCount || 0, totalRelationships: finalRelCount || 0,
        resolvedEntities: pipelineResolvedCount, duplicatesFound: pipelineDuplicatesFound, resolutionStats: pipelineResolutionStats,
        successfulChunks, failedChunks, wasTimedOut: true,
        warning: 'Document was paused by user before embeddings step',
        embeddingsSaved: 0,
        provider: lastProvider, model: lastModel, durationMs, status: 'partial',
        neo4jNodes: pipelineNeo4jNodes, neo4jRelationships: pipelineNeo4jRelationships,
      }
    }

    if (!hasEmbeddingsData) {
      steps = markStepRunning(steps, 'embeddings')
      await updateDocProgress(documentId, { steps })

      let chunksNeedingEmbeddings = savedChunks
      if (isResuming && !rebuiltChunksFromPdf) {
        // Find chunks that already have embeddings (Qdrant chunks with non-zero vectors)
        const embeddedChunkIds = new Set<string>()
        const allChunksForEmb = await getChunksByDocument(documentId, { limit: 10000 })
        // Check which chunks have non-zero vectors (indicating real embeddings)
        for (const chunk of allChunksForEmb) {
          // In Qdrant, chunks with real embeddings have vectors; we assume all existing chunks have embeddings
          // if they were upserted with real vectors during a previous run
          embeddedChunkIds.add(chunk.id)
        }
        chunksNeedingEmbeddings = savedChunks.filter(c => !embeddedChunkIds.has(c.id))
        console.log(`[Process] Embeddings: ${embeddedChunkIds.size} already exist, ${chunksNeedingEmbeddings.length} need generation`)
      }

      const embeddingsSaved = chunksNeedingEmbeddings.length > 0
        ? await generateAndSaveEmbeddings(
            chunksNeedingEmbeddings.map(c => ({ id: c.id, content: c.content })),
            documentId,
            !!isResuming // skipDeletion=true when resuming — only new chunks, no need to delete
          )
        : savedChunks.length // All already have embeddings
      steps = markStepCompleted(steps, 'embeddings', `${embeddingsSaved}/${savedChunks.length} embeddings`)
      await updateDocProgress(documentId, { steps })
    } else {
      console.log(`[Process] Skipping embeddings step — already completed`)
    }

    // Step 13: Update document status — this is the final batch, so mark as 'indexed'
    // (Intermediate batches already return early with 'partial' status above)
    await updateDocProgress(documentId, { status: 'indexed' })
    invalidateDocumentCache()

    // FIX (backup gap): auto-push extraction results to Supabase after successful
    // indexing. Previously pushToSupabase only ran when manually triggered (or
    // piggybacked on agent-memory saves) — so extraction results (Document status,
    // LocalEntity/LocalRelationship/LocalResolvedEntity) were NOT backed up to the
    // cloud automatically after each document completed. Fire-and-forget: backup
    // must never block or fail the pipeline response.
    try {
      const { pushToSupabase } = await import('@/lib/supabase-sync')
      void pushToSupabase().catch((pushErr) => {
        console.warn('[Process] Supabase auto-backup failed (non-fatal):', pushErr instanceof Error ? pushErr.message : String(pushErr))
      })
      console.log('[Process] Supabase auto-backup triggered (fire-and-forget)')
    } catch { /* dynamic import failure — non-fatal */ }

    // Clear userPaused flag since the document is now fully indexed
    clearDocPaused(documentId)
    try {
      await db.document.update({ where: { id: documentId }, data: { userPaused: false } })
    } catch { /* non-fatal */ }

    // SQLite is permanent storage — preserve entities and relationships for this document.
    // Data also exists in Qdrant (chunks/embeddings) and Neo4j (entities/relationships),
    // but SQLite serves as the persistent source of truth, NOT a temporary buffer.
    console.log(`[Process] Document ${documentId.slice(0, 8)}... fully indexed — SQLite data preserved (permanent storage)`)

    const durationMs = Date.now() - startTime

    // Build warning if more than 50% of chunks failed LLM extraction
    let warning: string | undefined
    const totalProcessedChunks = successfulChunks + failedChunks
    if (totalProcessedChunks > 0 && failedChunks / totalProcessedChunks > 0.5) {
      warning = `High LLM failure rate: ${failedChunks}/${totalProcessedChunks} chunks returned empty results`
      console.warn(`[Process] ${warning}`)
    }

    // Step 14: Return pipeline stats — use DB counts + captured pipeline variables
    return {
      documentId, totalPages: document.page_count || 0, totalChunks: savedChunks.length, totalTokens: 0,
      totalEntities: finalEntityCount || 0, totalRelationships: finalRelCount || 0,
      resolvedEntities: pipelineResolvedCount, duplicatesFound: pipelineDuplicatesFound,
      resolutionStats: pipelineResolutionStats,
      successfulChunks, failedChunks, wasTimedOut,
      warning,
      embeddingsSaved: 0,
      provider: lastProvider, model: lastModel, durationMs, status: 'indexed' as const,
      neo4jNodes: pipelineNeo4jNodes, neo4jRelationships: pipelineNeo4jRelationships,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    // Mark the current running step as error
    const runningStep = steps.find(s => s.status === 'running')
    if (runningStep) {
      steps = markStepError(steps, runningStep.name, errorMessage.slice(0, 200))
    }
    await updateDocProgress(documentId, { status: 'error', errorMessage, steps })
    invalidateDocumentCache()
    return { documentId, status: 'error', error: errorMessage, durationMs: Date.now() - startTime }
  }
}

// ==================== EMBED-ONLY PIPELINE ====================

/**
 * Re-generate embeddings ONLY — skips the expensive LLM extraction step.
 *
 * This is for documents that have entities in Neo4j (from a prior extraction
 * session, restored via /api/ingestion/reconcile) but NO chunks in Qdrant
 * (local store was wiped). The reconciled docs have status='extracted' and
 * 90% processing_percent, but the "Embed %" badge shows 0% because Qdrant
 * chunks (which hold the embedding vectors) are empty.
 *
 * Pipeline: download PDF from R2 → parse → chunk → save chunks to Qdrant
 *           → generate embeddings (NVIDIA) → save embeddings to Qdrant.
 *
 * Skipped steps: extract (LLM), resolve, neo4j — because Neo4j already has
 * the entities (from the prior session) and re-running extraction would burn
 * LLM tokens for no benefit (Neo4j MERGE would just match existing nodes).
 *
 * After success: doc status → 'indexed', processing_percent → 100%.
 */
async function runEmbedOnlyPipeline(documentId: string): Promise<Record<string, unknown>> {
  const startTime = Date.now()
  const EMBED_DIM = getEmbeddingDimension()
  try {
    // 1. Get document metadata from Qdrant (must exist — reconcile created it)
    const docPayload = await getDocument(documentId)
    if (!docPayload) throw new Error(`Document not found in Qdrant: ${documentId}`)
    const document = qdrantDocToRecord(docPayload, documentId)

    console.log(`[EmbedOnly] Starting for doc ${documentId.slice(0, 8)}... ("${document.title}", status=${document.status})`)

    // Build steps: download/parse/chunk/embeddings run; extract/resolve/neo4j marked completed (done in prior session)
    const steps: ProcessingStepRecord[] = [
      { name: 'download', label: 'Tải PDF', status: 'running', startedAt: new Date().toISOString(), completedAt: null, detail: null },
      { name: 'parse', label: 'Phân tích PDF', status: 'pending', startedAt: null, completedAt: null, detail: null },
      { name: 'chunk', label: 'Chia chunks', status: 'pending', startedAt: null, completedAt: null, detail: null },
      { name: 'extract', label: 'Trích xuất entities', status: 'completed', startedAt: 'prior-session', completedAt: 'prior-session', detail: 'Entities đã có trong Neo4j (reconciled) — bỏ qua LLM' },
      { name: 'resolve', label: 'Hợp nhất entities', status: 'completed', startedAt: 'prior-session', completedAt: 'prior-session', detail: 'Đã resolve trong phiên trước' },
      { name: 'neo4j', label: 'Ghi Neo4j', status: 'completed', startedAt: 'prior-session', completedAt: 'prior-session', detail: 'Entities đã có trong Neo4j Aura' },
      { name: 'embeddings', label: 'Tạo embeddings', status: 'pending', startedAt: null, completedAt: null, detail: null },
    ]
    await updateDocumentStatus(documentId, {
      status: 'parsing',
      processing_steps: steps as DocumentPayload['processing_steps'],
      processing_percent: 5,
      error_message: null,
    })
    try {
      await db.document.update({
        where: { id: documentId },
        data: { status: 'parsing', processingSteps: JSON.stringify(steps), processingPercent: 5, errorMessage: null },
      })
    } catch { /* non-fatal */ }

    // 2. Download PDF (local FS first, then R2 — matches main pipeline)
    if (!document.file_path) throw new Error('Document has no file_path')
    let pdfBuffer: Buffer | null = await downloadFromFilesystem(document.file_path as string)
    if (!pdfBuffer && isR2Configured()) {
      const r2Key = (document as { r2_key?: string }).r2_key
        || `pdfs/${documentId}_${(document.title || '').replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf`
      console.log(`[EmbedOnly] Local file missing — restoring from R2: ${r2Key}`)
      const r2Result = await downloadFileFromR2(r2Key, document.file_path as string)
      if (r2Result.success) {
        pdfBuffer = await readFile(document.file_path as string)
        console.log(`[EmbedOnly] Restored ${r2Result.size} bytes from R2`)
      } else {
        throw new Error(`PDF not found locally and R2 download failed: ${r2Result.error || 'unknown'}`)
      }
    }
    if (!pdfBuffer) throw new Error('PDF not found on local filesystem and R2 not configured')

    steps[0] = { ...steps[0], status: 'completed', completedAt: new Date().toISOString(), detail: `${(pdfBuffer.length / 1024).toFixed(0)} KB` }
    steps[1] = { ...steps[1], status: 'running' }
    await updateDocumentStatus(documentId, {
      status: 'parsing',
      processing_steps: steps as DocumentPayload['processing_steps'],
      processing_percent: 10,
    })

    // 3. Parse PDF
    const { text: rawText, totalPages: parsedPages } = await extractPDFText(pdfBuffer)
    if (!rawText || rawText.trim().length === 0) {
      throw new Error('PDF parsing returned no text — document may be scanned/image-only')
    }

    const domain = (document.domain || 'mixed') as DocumentDomain
    steps[1] = { ...steps[1], status: 'completed', completedAt: new Date().toISOString(), detail: `${parsedPages} trang` }
    steps[2] = { ...steps[2], status: 'running' }
    await updateDocumentStatus(documentId, {
      status: 'chunked',
      processing_steps: steps as DocumentPayload['processing_steps'],
      processing_percent: 15,
      ...(parsedPages ? { page_count: parsedPages } : {}),
    })
    try {
      await db.document.update({
        where: { id: documentId },
        data: { pageCount: parsedPages || null, status: 'chunked', processingPercent: 15 },
      })
    } catch { /* non-fatal */ }

    // 4. Chunk + save to Qdrant (zero-vector placeholders — real vectors added after)
    const parseChunks = chunkText(rawText, domain)
    if (parseChunks.length === 0) throw new Error('Chunking returned no chunks')
    console.log(`[EmbedOnly] Chunked into ${parseChunks.length} chunks (domain=${domain})`)

    const chunkPoints = parseChunks.map(chunk => ({
      id: randomUUID(),
      vector: new Array(EMBED_DIM).fill(0),
      payload: {
        document_id: documentId,
        chunk_index: chunk.chunkIndex,
        content: sanitizeForDB(chunk.content),
        heading_path: sanitizeForDB(chunk.headingPath),
        token_count: chunk.tokenCount,
        domain: chunk.domain,
        created_at: new Date().toISOString(),
      } as ChunkPayload,
    }))
    const chunksUpserted = await upsertChunks(chunkPoints)
    if (!chunksUpserted) throw new Error('Failed to save chunks to Qdrant')

    steps[2] = { ...steps[2], status: 'completed', completedAt: new Date().toISOString(), detail: `${parseChunks.length} chunks` }
    steps[6] = { ...steps[6], status: 'running' }
    await updateDocumentStatus(documentId, {
      status: 'extracting',
      processing_steps: steps as DocumentPayload['processing_steps'],
      processing_percent: 20,
    })
    try {
      await db.document.update({
        where: { id: documentId },
        data: { status: 'extracting', processingPercent: 20 },
      })
    } catch { /* non-fatal */ }

    // 5. Generate embeddings (NVIDIA) — the actual work
    const texts = chunkPoints.map(c => (c.payload as ChunkPayload).content)
    const embeddingResults = await generateEmbeddingBatch(texts)
    let embeddingsSaved = 0
    const realVectorPoints: Array<{ id: string; vector: number[]; payload: ChunkPayload }> = []
    for (let i = 0; i < chunkPoints.length; i++) {
      const emb = embeddingResults[i]
      if (emb && emb.vector && emb.vector.length === EMBED_DIM) {
        realVectorPoints.push({
          id: chunkPoints[i].id,
          vector: emb.vector,
          payload: chunkPoints[i].payload as ChunkPayload,
        })
        embeddingsSaved++
      }
    }
    if (realVectorPoints.length > 0) {
      const ok = await upsertChunks(realVectorPoints)
      if (!ok) console.error('[EmbedOnly] upsertChunks returned false — embeddings may not have saved')
    }
    console.log(`[EmbedOnly] Saved ${embeddingsSaved}/${parseChunks.length} embeddings to Qdrant`)

    // 6. Mark complete
    const finalSteps = steps.map(s => ({ ...s, status: 'completed' as const, completedAt: s.completedAt || new Date().toISOString() }))
    const finalPercent = 100
    await updateDocumentStatus(documentId, {
      status: 'indexed',
      processing_steps: finalSteps as DocumentPayload['processing_steps'],
      processing_percent: finalPercent,
      error_message: null,
    })
    try {
      await db.document.update({
        where: { id: documentId },
        data: {
          status: 'indexed',
          processingSteps: JSON.stringify(finalSteps),
          processingPercent: finalPercent,
          errorMessage: null,
        },
      })
    } catch { /* non-fatal */ }

    return {
      documentId,
      totalChunks: parseChunks.length,
      embeddingsSaved,
      provider: 'nvidia-embed-only',
      model: 'nvidia/llama-nemotron-embed-1b-v2',
      durationMs: Date.now() - startTime,
      status: 'indexed' as const,
      totalPages: parsedPages,
      skippedExtraction: true,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error(`[EmbedOnly] FAILED for ${documentId.slice(0, 8)}...:`, errorMessage)
    try {
      await updateDocumentStatus(documentId, { status: 'error', error_message: `Embed-only: ${errorMessage}` })
      await db.document.update({
        where: { id: documentId },
        data: { status: 'error', errorMessage: `Embed-only: ${errorMessage}` },
      })
    } catch { /* non-fatal */ }
    return {
      documentId,
      error: errorMessage,
      durationMs: Date.now() - startTime,
      status: 'error' as const,
    }
  }
}

// ==================== POST HANDLER ====================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    let documentIds: string[] = []
    const isReExtract = body.reExtract === true
    const isEmbedOnly = body.embedOnly === true

    // EMBED-ONLY MODE: for reconciled docs (status='extracted', entities in Neo4j,
    // Qdrant chunks empty). Generates embeddings without re-running LLM extraction.
    // Accepts: documentId | documentIds | all (picks 'extracted' status docs).
    if (isEmbedOnly) {
      if (body.all === true) {
        const embedDocs = await fetchDocsByStatuses(['extracted'], { limit: 500, orderBy: 'created_at', orderDir: 'asc' })
        documentIds = embedDocs.map(d => d.id)
      } else if (body.documentId) {
        documentIds = [body.documentId]
      } else if (body.documentIds && Array.isArray(body.documentIds)) {
        documentIds = body.documentIds
      } else {
        return NextResponse.json({ error: 'embedOnly requires documentId, documentIds, or all=true' }, { status: 400 })
      }
      if (documentIds.length === 0) {
        return NextResponse.json({ message: 'No documents to embed (need status=extracted)', results: [] })
      }
      console.log(`[Process] embedOnly request: ${documentIds.length} doc(s)`)
      // Run embed-only pipeline for each doc. Sequentially — embeddings are
      // rate-limited by NVIDIA (40 RPM/key), and concurrent calls would
      // trip rate limiting. Each doc is independent so no shared state.
      const results: Record<string, unknown>[] = []
      for (const docId of documentIds) {
        const r = await runEmbedOnlyPipeline(docId)
        results.push(r)
      }
      const ok = results.filter(r => r.status === 'indexed').length
      const failed = results.filter(r => r.status === 'error').length
      return NextResponse.json({
        message: `embedOnly complete: ${ok} indexed, ${failed} failed`,
        embedOnly: true,
        total: results.length,
        indexed: ok,
        failed,
        results,
      })
    }

    if (body.all === true) {
      const pendingDocs = await fetchDocsByStatuses(['uploaded', 'error', 'partial'], { orderBy: 'created_at', orderDir: 'asc' })
      documentIds = pendingDocs.map(d => d.id)
    } else if (body.documentId) {
      documentIds = [body.documentId]
    } else if (body.documentIds && Array.isArray(body.documentIds)) {
      documentIds = body.documentIds
    } else {
      return NextResponse.json({ error: 'Missing documentId, documentIds, or all=true' }, { status: 400 })
    }

    if (documentIds.length === 0) {
      return NextResponse.json({ message: 'No documents to process', results: [] })
    }

    // DIAGNOSTIC: Log key state for debugging 300+ doc issues
    console.log(`[Process] POST request: ${documentIds.length} doc(s), async=${body.async}, autoNext=${body.autoNext}, reExtract=${isReExtract}, activeKeys=${getActiveDocCount()}/${MAX_TOTAL_CONCURRENT}, freeKeys=${getFreeKeyCount()}`)

    // RE-EXTRACT MODE: Reset the document's extract step to 'pending' while keeping
    // download/parse/chunk completed. The pipeline will detect isResuming=true and
    // skip chunks that already have entities, only extracting missing ones.
    if (isReExtract) {
      const skippedDocIds: string[] = []
      for (const docId of documentIds) {
        const docPayload = await getDocument(docId)
        if (!docPayload) continue
        const doc = qdrantDocToRecord(docPayload, docId)

        // Only allow re-extract for completed or partially-extracted docs
        if (!['indexed', 'extracted', 'partial'].includes(doc.status as string)) continue

        // FIX: Check if there are actually missing chunks before proceeding.
        const totalChunks = await getChunkCount(docId)
        const entityChunkIds = await db.localEntity.findMany({ where: { documentId: docId }, select: { chunkId: true } })
        const extractedChunkCount = new Set(entityChunkIds.map(e => e.chunkId).filter(id => id && id.trim())).size
        if (totalChunks && extractedChunkCount >= totalChunks) {
          console.log(`[Process] Re-extract skipped for doc ${docId}: all ${totalChunks} chunks already extracted`)
          skippedDocIds.push(docId)
          continue
        }

        // Build new processing steps: keep download/parse/chunk completed, reset extract and after
        const existingSteps = doc.processing_steps as ProcessingStepRecord[] | null
        const reExtractSteps: ProcessingStepRecord[] = existingSteps && Array.isArray(existingSteps) && existingSteps.length === PIPELINE_STEPS.length
          ? existingSteps.map((s: ProcessingStepRecord) => {
              if (['download', 'parse', 'chunk'].includes(s.name)) {
                return { ...s, status: 'completed' as const }
              }
              if (s.name === 'extract') {
                return { ...s, status: 'pending' as const, startedAt: null, completedAt: null, detail: null }
              }
              // resolve, neo4j, embeddings — also reset so they re-run after extraction
              return { ...s, status: 'pending' as const, startedAt: null, completedAt: null, detail: null }
            })
          : [
              { name: 'download', label: 'Tải PDF', status: 'completed' as const, startedAt: (existingSteps as ProcessingStepRecord[])?.[0]?.startedAt || null, completedAt: (existingSteps as ProcessingStepRecord[])?.[0]?.completedAt || null, detail: (existingSteps as ProcessingStepRecord[])?.[0]?.detail || null },
              { name: 'parse', label: 'Phân tích PDF', status: 'completed' as const, startedAt: (existingSteps as ProcessingStepRecord[])?.[1]?.startedAt || null, completedAt: (existingSteps as ProcessingStepRecord[])?.[1]?.completedAt || null, detail: (existingSteps as ProcessingStepRecord[])?.[1]?.detail || null },
              { name: 'chunk', label: 'Chia chunks', status: 'completed' as const, startedAt: (existingSteps as ProcessingStepRecord[])?.[2]?.startedAt || null, completedAt: (existingSteps as ProcessingStepRecord[])?.[2]?.completedAt || null, detail: (existingSteps as ProcessingStepRecord[])?.[2]?.detail || null },
              { name: 'extract', label: 'Trích xuất entities', status: 'pending' as const, startedAt: null, completedAt: null, detail: null },
              { name: 'resolve', label: 'Hợp nhất entities', status: 'pending' as const, startedAt: null, completedAt: null, detail: null },
              { name: 'neo4j', label: 'Ghi Neo4j', status: 'pending' as const, startedAt: null, completedAt: null, detail: null },
              { name: 'embeddings', label: 'Tạo embeddings', status: 'pending' as const, startedAt: null, completedAt: null, detail: null },
            ]

        await updateDocumentStatus(docId, {
          status: 'partial',
          processing_steps: reExtractSteps as DocumentPayload['processing_steps'],
          processing_percent: 60,
          error_message: null,
        })
        try { await db.document.update({ where: { id: docId }, data: { status: 'partial', processingSteps: JSON.stringify(reExtractSteps), processingPercent: 60, errorMessage: null } }) } catch { /* non-fatal */ }

        console.log(`[Process] Re-extract mode: reset doc ${docId} to 'partial' with extract step pending`)
      }

      // Remove skipped docs (all chunks already extracted) from processing list
      if (skippedDocIds.length > 0) {
        documentIds = documentIds.filter(id => !skippedDocIds.includes(id))
        console.log(`[Process] Re-extract: skipped ${skippedDocIds.length} docs (all chunks already extracted)`)
        if (documentIds.length === 0) {
          return NextResponse.json({ message: 'All documents already fully extracted — no re-extract needed', skipped: skippedDocIds.length })
        }
      }
    }

    // Max 16 concurrent documents: 4 API keys × 4 docs/key (auto mode).
    // When a doc finishes, the key capacity frees and auto-assigned to the next doc.
    // Priority: partial (trích xuất dở) → error → uploaded (tài liệu mới).
    // This limit applies to BOTH initial processing AND re-extract.
    const MAX_CONCURRENT = MAX_TOTAL_CONCURRENT
    // Count docs that are ACTIVELY being processed (not just waiting/idle).
    // Note: 'partial' status = paused/incomplete but NOT actively processing.
    // For re-extract requests, the docs were just set to 'partial' — we add them
    // explicitly below so the check accounts for them without counting ALL 'partial' docs
    // (which would cause deadlocks when 4+ docs are 'partial' but no keys are in use).
    const extractingDocs = await fetchDocsByStatuses(['extracting', 'parsing', 'chunked'])
    const extractingCount = extractingDocs.length
    // Also check in-memory key availability (more accurate than DB status alone)
    const activeDocs = getActiveDocCount()
    // For re-extract: add the number of docs being re-extracted to the busy count,
    // since they were just reset to 'partial' and are about to start processing.
    const reExtractPending = isReExtract ? documentIds.length : 0
    // BUG FIX: Trust in-memory key count (activeDocs) over potentially stale DB count.
    // After server restart, DB may show extracting docs but no keys are actually in use.
    // The recovery mechanism resets stale docs to 'partial', but there can be a brief window.
    // Using activeDocs as the primary source avoids false 503 errors.
    const effectiveBusy = activeDocs + reExtractPending
    // Only use DB count as a soft warning — don't block on it
    if (effectiveBusy > MAX_CONCURRENT) {
      return NextResponse.json({
        message: `Too many documents being processed concurrently (max ${MAX_CONCURRENT})`,
        busy: true,
        extractingCount: extractingCount || 0,
        activeDocs,
        maxConcurrent: MAX_CONCURRENT,
      }, { status: 503 })
    }
    // Soft warning: DB says there are processing docs but no keys are in use (stale after restart)
    if (extractingCount && extractingCount > 0 && activeDocs === 0 && reExtractPending === 0) {
      console.warn(`[Process] DB shows ${extractingCount} docs in processing state but no keys are in use — likely stale after restart. Running recovery.`)
      // Trigger recovery in the background to clean up stale states
      recoverKeys().catch(() => {})
    }

    // Fire-and-forget mode: start processing in background and return immediately
    // This prevents HTTP timeout on large documents (processing can take minutes)
    if (body.async === true) {
      // Filter out documents that are already being actively processed.
      // This prevents double auto-chain when the frontend triggers a new POST
      // while the backend auto-chain is still running for the same document.
      const activeDocIds: string[] = []
      // FIX #9 (BUG C): track WHY each doc was skipped so the response (and the
      // frontend toast) can tell the user the real reason instead of the
      // misleading "All documents are already being processed".
      const skippedDocs: Array<{ id: string; reason: string }> = []
      for (const docId of documentIds) {
        const docPayload = await getDocument(docId)
        if (!docPayload) {
          // Document not in Qdrant — try SQLite fallback (may have been uploaded when Qdrant was down)
          try {
            const sqliteDoc = await db.document.findUnique({ where: { id: docId } })
            if (sqliteDoc) {
              console.log(`[Process] Document ${docId.slice(0, 8)}... not in Qdrant but found in SQLite — syncing to Qdrant`)
              // Sync to Qdrant so the pipeline can process it
              const syncPayload: Record<string, unknown> = {
                title: sqliteDoc.title,
                file_path: sqliteDoc.filePath,
                domain: sqliteDoc.domain,
                page_count: sqliteDoc.pageCount,
                status: sqliteDoc.status,
                error_message: sqliteDoc.errorMessage,
                processing_steps: JSON.parse(sqliteDoc.processingSteps || '[]'),
                processing_percent: sqliteDoc.processingPercent,
                created_at: sqliteDoc.createdAt.toISOString(),
                updated_at: sqliteDoc.updatedAt.toISOString(),
              }
              await upsertDocument(docId, syncPayload as DocumentPayload)
              // Re-read from Qdrant
              const retryPayload = await getDocument(docId)
              if (!retryPayload) {
                console.warn(`[Process] Document ${docId.slice(0, 8)}... still not in Qdrant after sync — skipping`)
                continue
              }
              const currentDoc = qdrantDocToRecord(retryPayload, docId)
              // Fall through to normal processing below
              const isActivelyExtractingCheck = currentDoc.status === 'extracting' &&
                currentDoc.updated_at > new Date(Date.now() - 2 * 60 * 1000).toISOString()
              if (isActivelyExtractingCheck) {
                console.log(`[Process] Skipping doc ${docId} — already being actively extracted`)
                skippedDocs.push({ id: docId, reason: 'already_extracting' })
                continue
              }
              // Process this doc normally — re-enter the loop logic below
              const isPartialCheck = currentDoc.status === 'partial'
              const hasExistingDataCheck = currentDoc.status === 'partial' || currentDoc.status === 'indexed' || currentDoc.status === 'error'
              const existingStepsCheck = (currentDoc.processing_steps || []) as ProcessingStepRecord[]
              const cleanedStepsCheck = hasExistingDataCheck
                ? existingStepsCheck.map((s: ProcessingStepRecord) => s.detail?.includes('tạm dừng bởi người dùng')
                  ? { ...s, detail: null }
                  : s)
                : getDefaultSteps()
              await updateDocumentStatus(docId, {
                status: isPartialCheck ? 'extracting' : 'parsing',
                processing_steps: cleanedStepsCheck as DocumentPayload['processing_steps'],
                processing_percent: isPartialCheck ? undefined : 0,
              })
              try {
                await db.document.update({
                  where: { id: docId },
                  data: {
                    status: isPartialCheck ? 'extracting' : 'parsing',
                    processingSteps: JSON.stringify(cleanedStepsCheck),
                    ...(isPartialCheck ? {} : { processingPercent: 0 }),
                  },
                })
              } catch { /* non-fatal */ }
              const slotIndex = acquireKey(docId)
              if (slotIndex < 0) {
                console.log(`[Process] No free key for doc ${docId} — will be picked up when a key frees`)
              }
              clearDocPaused(docId)
              activeDocIds.push(docId)
              continue
            }
          } catch (sqliteErr) {
            console.warn(`[Process] SQLite fallback failed for ${docId.slice(0, 8)}:`, sqliteErr instanceof Error ? sqliteErr.message : String(sqliteErr))
          }

          // R2 FALLBACK: Document not in Qdrant or SQLite — check R2 cloud backup.
          // This handles documents restored from R2 (after sandbox reset) that show in
          // the UI list but have no Qdrant metadata yet. Create the Qdrant record from
          // R2 metadata so the pipeline can process them.
          if (isR2Configured()) {
            try {
              const { listR2Objects } = await import('@/lib/r2-storage')
              const r2List = await listR2Objects('pdfs/', 500)
              if (r2List.success) {
                // Find the R2 object matching this docId (key prefix = docId)
                const r2Obj = r2List.objects.find(o => {
                  const basename = o.key.split('/').pop() || o.key
                  const underscoreIdx = basename.indexOf('_')
                  const prefix = underscoreIdx > 0 ? basename.substring(0, underscoreIdx) : basename.replace(/\.pdf$/i, '')
                  return prefix === docId
                })
                if (r2Obj) {
                  const basename = r2Obj.key.split('/').pop() || r2Obj.key
                  const filename = basename.indexOf('_') > 0 ? basename.substring(basename.indexOf('_') + 1) : basename
                  const filePath = `${UPLOAD_DIR}/${basename}`
                  console.log(`[Process] Document ${docId.slice(0, 8)}... found in R2 (${r2Obj.key}) — creating Qdrant record`)
                  // Create Qdrant document record from R2 metadata
                  const newPayload: Record<string, unknown> = {
                    title: filename.replace(/\.pdf$/i, ''),
                    file_path: filePath,
                    domain: 'mixed',
                    page_count: null,
                    status: 'uploaded',
                    error_message: null,
                    processing_steps: [],
                    processing_percent: 0,
                    r2_key: r2Obj.key,
                    created_at: r2Obj.lastModified.toISOString(),
                    updated_at: r2Obj.lastModified.toISOString(),
                  }
                  await upsertDocument(docId, newPayload as DocumentPayload)
                  // FIX #9 (BUG B): also create the SQLite Document row NOW — previously
                  // this path only created the Qdrant record, so every later
                  // db.document.update() failed ("No record was found for an update")
                  // and the doc's status never persisted to SQLite.
                  await ensureSqliteDocumentRow(docId)
                  // Re-read from Qdrant
                  const retryPayload = await getDocument(docId)
                  if (retryPayload) {
                    const currentDoc = qdrantDocToRecord(retryPayload, docId)
                    const isPartialCheck = false // fresh doc
                    const cleanedStepsCheck = getDefaultSteps()
                    await updateDocumentStatus(docId, {
                      status: 'parsing',
                      processing_steps: cleanedStepsCheck as DocumentPayload['processing_steps'],
                      processing_percent: 0,
                    })
                    const slotIndex = acquireKey(docId)
                    if (slotIndex < 0) {
                      console.log(`[Process] No free key for doc ${docId} — will be picked up when a key frees`)
                    }
                    clearDocPaused(docId)
                    activeDocIds.push(docId)
                    continue
                  }
                }
              }
            } catch (r2Err) {
              console.warn(`[Process] R2 fallback failed for ${docId.slice(0, 8)}:`, r2Err instanceof Error ? r2Err.message : String(r2Err))
            }
          }

          console.warn(`[Process] Document ${docId} not found in Qdrant, SQLite, or R2 — skipping`)
          skippedDocs.push({ id: docId, reason: 'not_found' })
          continue
        }
        const currentDoc = qdrantDocToRecord(docPayload, docId)

        // Skip docs that are actively being extracted (updated recently)
        const isActivelyExtracting = currentDoc.status === 'extracting' &&
          currentDoc.updated_at > new Date(Date.now() - 2 * 60 * 1000).toISOString()

        if (isActivelyExtracting) {
          console.log(`[Process] Skipping doc ${docId} — already being actively extracted (updated_at=${currentDoc.updated_at})`)
          skippedDocs.push({ id: docId, reason: 'already_extracting' })
          continue
        }

        // Mark documents as processing immediately so the UI shows them as processing
        // and the concurrency check works properly.
        // For documents that already have data (partial/indexed/error), don't reset processing_steps
        const isPartial = currentDoc.status === 'partial'
        const hasExistingData = currentDoc.status === 'partial' || currentDoc.status === 'indexed' || currentDoc.status === 'error'
        // Clear the pause marker from processing_steps when resuming
        // This prevents the auto-continue from incorrectly excluding this doc
        const existingSteps = (currentDoc.processing_steps || []) as ProcessingStepRecord[]
        const cleanedSteps = hasExistingData
          ? existingSteps.map(s => s.detail?.includes('tạm dừng bởi người dùng')
            ? { ...s, detail: null }  // Clear pause marker
            : s)
          : getDefaultSteps()

        await updateDocumentStatus(docId, {
          status: isPartial ? 'extracting' : 'parsing',
          processing_steps: cleanedSteps as DocumentPayload['processing_steps'],
          processing_percent: isPartial ? undefined : 0,
        })
        // SYNC to SQLite immediately — before background pipeline starts.
        // This ensures the frontend sees 'parsing'/'extracting' right away
        // instead of stale 'uploaded' on the next poll.
        try {
          await db.document.update({
            where: { id: docId },
            data: {
              status: isPartial ? 'extracting' : 'parsing',
              processingSteps: JSON.stringify(cleanedSteps),
              ...(isPartial ? {} : { processingPercent: 0 }),
            },
          })
        } catch { /* non-fatal */ }

        // Acquire a key for this document (Key 0-3, auto mode: least-loaded-first)
        const slotIndex = acquireKey(docId)
        if (slotIndex < 0) {
          console.log(`[Process] No free key for doc ${docId} — will be picked up when a key frees`)
        }

        // Clear the paused flag so the pipeline can run for this document
        clearDocPaused(docId)

        // Clear userPaused flag in SQLite so auto-continue/auto-recovery can pick it up again
        try {
          await db.document.update({ where: { id: docId }, data: { userPaused: false } })
        } catch { /* non-fatal — clearDocPaused in memory is the primary guard */ }

        activeDocIds.push(docId)
      }

      if (activeDocIds.length === 0) {
        // FIX #9 (BUG C): report the REAL reason nothing was started. Previously
        // this always said "All documents are already being processed" even when
        // the docs were simply not found anywhere (Qdrant/SQLite/R2) — a silent
        // no-op that looked like "nothing changed" to the user.
        const notFound = skippedDocs.filter(s => s.reason === 'not_found').length
        const alreadyRunning = skippedDocs.filter(s => s.reason === 'already_extracting').length
        return NextResponse.json({
          message: notFound > 0
            ? `Không tìm thấy ${notFound} tài liệu trong Qdrant/SQLite/R2 — không thể xử lý`
            : alreadyRunning > 0
              ? `${alreadyRunning} tài liệu đang được xử lý (backend auto-chain đang chạy)`
              : 'All documents are already being processed',
          documentIds: [],
          async: true,
          autoChain: true,
          skipped: true,
          skippedDocs,
        })
      }

      // === AUTO-FILL FREE KEYS ===
      // When autoNext is enabled, fill remaining key capacity with eligible documents.
      // This ensures all 4 keys × 4 docs are utilized from the start.
      // Priority: partial (trích xuất dở) → error → uploaded (tài liệu mới).
      if (body.autoNext === true) {
        const freeKeysAvailable = getFreeKeyCount()
        if (freeKeysAvailable > 0) {
          // Fetch docs by priority groups — partial first (resume interrupted), then error, then uploaded (new).
          // This ensures partially-extracted docs are resumed BEFORE new docs are started.
          let remainingCapacity = freeKeysAvailable
          const priorityGroups: Array<['partial'] | ['error'] | ['uploaded']> = [['partial'], ['error'], ['uploaded']]
          const allEligibleDocs: typeof eligibleDocs = []

          for (const statusSet of priorityGroups) {
            if (remainingCapacity <= 0) break
            const docs = await fetchDocsByStatuses([...statusSet], { limit: remainingCapacity, orderBy: 'created_at', orderDir: 'asc' })
            if (docs && docs.length > 0) {
              allEligibleDocs.push(...docs)
              remainingCapacity -= docs.length
            }
          }

          const eligibleDocs = allEligibleDocs

          if (eligibleDocs && eligibleDocs.length > 0) {
            for (const docItem of eligibleDocs) {
              // Skip docs already in the active list
              if (activeDocIds.includes(docItem.id)) continue
              // Skip docs already being extracted (updated in last 2 min)
              const isActivelyExtracting = docItem.payload.status === 'extracting' &&
                docItem.payload.updated_at > new Date(Date.now() - 2 * 60 * 1000).toISOString()
              if (isActivelyExtracting) continue

              // Try to acquire a key for this doc
              const slotIdx = acquireKey(docItem.id)
              if (slotIdx < 0) break // No more free keys

              // Determine new status and steps
              const isPartial = docItem.payload.status === 'partial'
              const hasExistingData = docItem.payload.status === 'partial' || docItem.payload.status === 'error'
              const existingSteps = (docItem.payload.processing_steps || []) as ProcessingStepRecord[]
              const cleanedSteps = hasExistingData
                ? existingSteps.map(s => s.detail?.includes('tạm dừng bởi người dùng')
                  ? { ...s, detail: null }
                  : s)
                : getDefaultSteps()

              const newStatus = docItem.payload.status === 'error' ? 'extracting'
                : docItem.payload.status === 'partial' ? 'extracting' : 'parsing'
              const updated = await updateDocumentStatus(docItem.id, {
                status: newStatus,
                processing_steps: cleanedSteps as DocumentPayload['processing_steps'],
                processing_percent: hasExistingData ? undefined : 0,
              })
              // SYNC to SQLite
              try {
                await db.document.update({ where: { id: docItem.id }, data: {
                  status: newStatus,
                  processingSteps: JSON.stringify(cleanedSteps),
                  ...(hasExistingData ? {} : { processingPercent: 0 }),
                }})
              } catch { /* non-fatal */ }

              if (!updated) {
                // Another process claimed this doc — release key and skip
                releaseKey(docItem.id)
                continue
              }

              clearDocPaused(docItem.id)
              // Clear userPaused flag in SQLite so auto-continue/auto-recovery can pick it up
              try {
                await db.document.update({ where: { id: docItem.id }, data: { userPaused: false } })
              } catch { /* non-fatal */ }
              activeDocIds.push(docItem.id)
              console.log(`[Process] Auto-fill: doc ${docItem.id.slice(0, 8)}... (${docItem.payload.status}→${newStatus}) assigned to Key ${slotIdx + 1}`)
            }
          }
        }
      }

      // Start processing in the background with AUTO-CHAIN
      // Each document gets its own API key and runs independently.
      // When a doc finishes, its key is freed and the next queued doc takes it.
      const processWithAutoChain = async (docId: string, slotIndex: number): Promise<void> => {
        let batchNum = 1
        const maxBatches = 500 // Safety limit: 500 batches — enough for documents with 10,000+ chunks
        // BUG FIX: Track consecutive no-progress batches to prevent infinite loops
        // when all keys are rate-limited and every batch returns 'partial' with 0 chunks.
        let consecutiveNoProgressBatches = 0
        const MAX_NO_PROGRESS_BATCHES = 3 // Stop after 3 consecutive batches with 0 new chunks
        try {
          while (batchNum <= maxBatches) {
            // PAUSE CHECK: Before starting a new batch, check if the user paused this doc.
            // If paused, stop the auto-chain loop immediately.
            if (isDocPaused(docId)) {
              console.log(`[Process] Auto-chain: doc ${docId.slice(0, 8)}... was PAUSED — stopping auto-chain after ${batchNum} batch(es)`)
              return
            }

            // BACKPRESSURE CHECK: If overall key availability is critically low (<25%),
            // wait for keys to recover before starting a new batch. This prevents
            // wasting API calls that will fail and accelerate key exhaustion.
            const availBeforeBatch = getOverallAvailability()
            if (availBeforeBatch < 0.25) {
              console.warn(`[Process] Auto-chain: provider availability at ${(availBeforeBatch * 100).toFixed(0)}% before batch #${batchNum} — waiting 30s for keys to recover...`)
              await new Promise(resolve => setTimeout(resolve, 30_000))
              // Re-check after wait
              const availAfterWait = getOverallAvailability()
              if (availAfterWait < 0.25) {
                console.warn(`[Process] Auto-chain: availability still at ${(availAfterWait * 100).toFixed(0)}% after 30s wait — stopping chain for doc ${docId}`)
                try {
                  await updateDocProgress(docId, { status: 'partial', errorMessage: 'Tạm dừng — API keys đang bị giới hạn tốc độ' })
                } catch { /* non-fatal */ }
                return
              }
            }

            try {
              const result = await runIngestionPipeline(docId, slotIndex) as Record<string, unknown>
              const status = result.status as string

              // PAUSE CHECK: After each batch, re-check pause status.
              // The pipeline may have been paused during the batch execution.
              if (isDocPaused(docId)) {
                console.log(`[Process] Auto-chain: doc ${docId.slice(0, 8)}... was PAUSED during batch — stopping auto-chain`)
                return
              }

              if (status === 'partial') {
                // Batch timed out — auto-chain the next batch
                batchNum++
                const successfulChunks = (result.successfulChunks as number) || 0
                console.log(`[Process] Auto-chain: batch #${batchNum} starting for doc ${docId} key ${slotIndex + 1} (${successfulChunks} chunks in previous batch)`)

                // BUG FIX: Detect no-progress loops. If 3 consecutive batches produce 0 chunks,
                // all keys are likely rate-limited/exhausted. Stop the chain to prevent
                // wasting API calls and accelerating key exhaustion.
                if (successfulChunks === 0) {
                  consecutiveNoProgressBatches++
                  if (consecutiveNoProgressBatches >= MAX_NO_PROGRESS_BATCHES) {
                    console.warn(`[Process] Auto-chain: ${consecutiveNoProgressBatches} consecutive batches with 0 chunks — all keys likely rate-limited. Stopping chain for doc ${docId}`)
                    // Mark as partial so it can retry when keys recover
                    try {
                      await updateDocProgress(docId, { status: 'partial', errorMessage: 'Tạm dừng — tất cả API keys đang bị giới hạn tốc độ' })
                    } catch { /* non-fatal */ }
                    return
                  }
                  // Wait longer between no-progress batches to let keys recover
                  await new Promise(resolve => setTimeout(resolve, 15000)) // 15s instead of 2s
                } else {
                  consecutiveNoProgressBatches = 0 // Reset on progress
                  // Small delay between batches to avoid overwhelming the LLM API
                  await new Promise(resolve => setTimeout(resolve, 2000))
                }

                // Re-trigger the pipeline — it will detect 'partial' status and resume from where it left off
                continue
              } else if (status === 'indexed') {
                console.log(`[Process] Auto-chain: doc ${docId} key ${slotIndex + 1} fully indexed after ${batchNum} batch(es)`)
                invalidateDocumentCache()
                return
              } else if (status === 'error') {
                console.error(`[Process] Auto-chain: doc ${docId} key ${slotIndex + 1} errored after ${batchNum} batch(es): ${result.error}`)
                return
              } else {
                console.warn(`[Process] Auto-chain: unexpected status '${status}' for doc ${docId} key ${slotIndex + 1}, stopping chain`)
                return
              }
            } catch (err) {
              console.error(`[Process] Auto-chain error for doc ${docId} key ${slotIndex + 1} (batch #${batchNum}):`, err)
              // CRITICAL: Update doc status so it's not left in a transitional state.
              // Without this, the doc stays in 'parsing'/'extracting' forever.
              // Use 'partial' for transient errors (Qdrant/SQLite timeout) so the doc
              // can auto-retry when the system recovers. Use 'error' only for
              // permanent failures (invalid document, no LLM providers, etc.).
              const errMsg = err instanceof Error ? err.message : String(err)
              const isTransientError = errMsg.includes('timeout') || errMsg.includes('ECONNREFUSED') ||
                errMsg.includes('ECONNRESET') || errMsg.includes('fetch') || errMsg.includes('Qdrant') ||
                errMsg.includes('SQLite') || errMsg.includes('Prisma') || errMsg.includes('FATAL')
              const targetStatus = isTransientError ? 'partial' : 'error'
              try {
                await updateDocProgress(docId, { status: targetStatus, errorMessage: isTransientError ? null : errMsg })
              } catch (updateErr) {
                console.error(`[Process] Failed to update ${targetStatus} status for doc ${docId}:`, updateErr)
                // Last resort: try direct Qdrant + SQLite update
                try { await updateDocumentStatus(docId, { status: targetStatus }) } catch { /* give up */ }
                try { await db.document.update({ where: { id: docId }, data: { status: targetStatus } }) } catch { /* give up */ }
              }
              return
            }
          }
          console.warn(`[Process] Auto-chain: reached max batches (${maxBatches}) for doc ${docId} key ${slotIndex + 1}`)
        } finally {
          // Release the key and flush token count when this document is done.
          // If the doc was paused, ensure its status is 'partial' in Qdrant
          // (safety net in case the pipeline's updateDocProgress was skipped).
          releaseKey(docId)
          if (isDocPaused(docId)) {
            // Ensure the doc is marked 'partial' in Qdrant
            const currentDocPayload = await getDocument(docId)
            if (currentDocPayload && currentDocPayload.status !== 'partial') {
              await updateDocumentStatus(docId, { status: 'partial' })
              try { await db.document.update({ where: { id: docId }, data: { status: 'partial' } }) } catch { /* non-fatal */ }
              invalidateDocumentCache()
              console.log(`[Process] Auto-chain finally: doc ${docId.slice(0, 8)}... was paused but status was '${currentDocPayload.status}' — corrected to 'partial'`)
            }
            // DO NOT clear the paused flag here! The pause flag must persist until
            // the user explicitly clicks "Tiếp tục" (Continue), which calls clearDocPaused()
            // at the start of the POST handler (line ~2683). Clearing it here causes
            // the auto-next/auto-continue to immediately re-start the paused document.
          } else {
            // SAFETY NET: If the auto-chain finishes but the doc is still in a transitional
            // state (e.g., 'extracting', 'parsing'), it means the pipeline exited without
            // properly updating the status. This can happen if updateDocProgress() failed
            // or if an unhandled error occurred. Mark as 'partial' so it can be resumed.
            try {
              const currentDocPayload = await getDocument(docId)
              if (currentDocPayload && ['parsing', 'chunked', 'extracting', 'extracted'].includes(currentDocPayload.status)) {
                await updateDocumentStatus(docId, { status: 'partial' })
                try { await db.document.update({ where: { id: docId }, data: { status: 'partial' } }) } catch { /* non-fatal */ }
                invalidateDocumentCache()
                console.warn(`[Process] Auto-chain finally: doc ${docId.slice(0, 8)}... was in '${currentDocPayload.status}' after auto-chain finished — corrected to 'partial'`)
              }
            } catch (statusCheckErr) {
              console.warn(`[Process] Auto-chain finally: failed to check/correct status for ${docId.slice(0, 8)}:`, statusCheckErr instanceof Error ? statusCheckErr.message : String(statusCheckErr))
            }
          }
          // Persist key state change for crash recovery
          persistKeyAssignments().catch(() => {})
          await flushTokenCount().catch(() => {})
        }
      }

      // CONCURRENT PROCESSING: Start up to 16 documents simultaneously (4 keys × 4 docs/key).
      // Docs without a key will wait until one becomes available.
      // AUTO-NEXT: After a doc finishes, its key capacity frees → pick up the next queued doc.
      // Priority: partial (trích xuất dở) → error → uploaded (tài liệu mới).
      const autoNext = body.autoNext === true
      // Track ALL doc IDs that have been assigned a key (including auto-next docs).
      // Defined OUTSIDE the IIFE so the catch handler can access it for key leak recovery.
      const allDocIdsWithKeys = new Set(activeDocIds)
      // BUG FIX: In-process claimed doc IDs — prevents double-claiming when multiple keys
      // finish simultaneously and both try to claim the same next doc.
      const claimedDocIds = new Set<string>(activeDocIds)
      const bgPromise = (async () => {
        // Queue of doc IDs to process (starts with explicitly requested ones)
        const queue = [...activeDocIds]
        // Track running promises (up to MAX_TOTAL_CONCURRENT concurrent)
        const running: Promise<void>[] = []

        const startDocIfKeyFree = async (): Promise<void> => {
          while (queue.length > 0 && running.length < MAX_TOTAL_CONCURRENT) {
            const docId = queue.shift()!
            // Try to acquire a key
            let slotIndex = acquireKey(docId)
            if (slotIndex < 0) {
              // No free key — put it back at the front of the queue and wait
              queue.unshift(docId)
              break
            }
            console.log(`[Process] Starting doc ${docId.slice(0, 8)}... on key ${slotIndex + 1}`)
            allDocIdsWithKeys.add(docId) // Track for crash recovery key release
            const promise = processWithAutoChain(docId, slotIndex).then(async () => {
              // When this doc finishes, remove from running and try to start next
              const idx = running.indexOf(promise)
              if (idx >= 0) running.splice(idx, 1)

              // AUTO-NEXT: if enabled, find next eligible doc and add to queue.
              // Uses ATOMIC CLAIM to prevent race conditions when multiple keys finish simultaneously.
              // 'error' docs are retried because providers may have recovered since the failure.
              // 'partial' docs are included so interrupted docs from prior sessions auto-resume.
              // Priority: partial (trích xuất dở) → error → uploaded (tài liệu mới).
              if (autoNext) {
                let claimed = false
                // Priority: partial first (resume interrupted), then error, then uploaded (new docs)
                for (const statusSet of [
                  ['partial'] as const,
                  ['error'] as const,
                  ['uploaded'] as const,
                ]) {
                  if (claimed) break
                  const nextDocs = await fetchDocsByStatuses([...statusSet], { limit: 5, orderBy: 'created_at', orderDir: 'asc' })
                  if (!nextDocs || nextDocs.length === 0) continue

                  // Find the first eligible doc (not paused, not already claimed, not mid-batch)
                  for (const nextDoc of nextDocs) {
                    // BUG FIX: Skip docs already claimed by another key's auto-next callback
                    if (claimedDocIds.has(nextDoc.id)) continue

                    // BUG FIX: Skip docs that are paused by the user.
                    if (isDocPaused(nextDoc.id)) {
                      console.log(`[Process] Auto-next: skipping paused doc "${nextDoc.payload.title}" (${nextDoc.payload.status})`)
                      continue
                    }

                    // BUG FIX: Skip docs that are already assigned to a key (mid-batch in another auto-chain)
                    if (getActiveDocIds().includes(nextDoc.id)) {
                      continue
                    }

                    // Also check SQLite userPaused flag (for docs paused before server restart)
                    try {
                      const sqliteDoc = await db.document.findUnique({ where: { id: nextDoc.id }, select: { userPaused: true } })
                      if (sqliteDoc?.userPaused) {
                        console.log(`[Process] Auto-next: skipping userPaused doc "${nextDoc.payload.title}" (SQLite userPaused=true)`)
                        markDocPaused(nextDoc.id)
                        continue
                      }
                    } catch { /* non-fatal */ }

                    // Claim the document by updating its status
                    const newStatus = nextDoc.payload.status === 'error' ? 'extracting'
                      : nextDoc.payload.status === 'partial' ? 'extracting' : 'parsing'
                    const claimSuccess = await updateDocumentStatus(nextDoc.id, {
                      status: newStatus,
                      error_message: null,
                      processing_steps: (nextDoc.payload.status === 'error' || nextDoc.payload.status === 'partial')
                        ? nextDoc.payload.processing_steps : stepsToQdrantFormat(getDefaultSteps()),
                      processing_percent: (nextDoc.payload.status === 'error' || nextDoc.payload.status === 'partial')
                        ? undefined : 0,
                    })
                    if (claimSuccess) {
                      // Mark as claimed IMMEDIATELY to prevent race condition
                      claimedDocIds.add(nextDoc.id)
                      try {
                        clearDocPaused(nextDoc.id)
                        await db.document.update({ where: { id: nextDoc.id }, data: {
                          status: newStatus,
                          errorMessage: null,
                          userPaused: nextDoc.payload.status === 'partial' ? undefined : false,
                          processingSteps: JSON.stringify((nextDoc.payload.status === 'error' || nextDoc.payload.status === 'partial')
                            ? nextDoc.payload.processing_steps : stepsToQdrantFormat(getDefaultSteps())),
                        }})
                      } catch { /* non-fatal */ }

                      console.log(`[Process] Auto-next: claimed "${nextDoc.payload.title}" (${nextDoc.payload.status}→${newStatus}) for key ${slotIndex + 1}`)
                      queue.push(nextDoc.id)
                      claimed = true
                      break // Found and claimed a doc, stop searching
                    } else {
                      // Claim failed — doc was grabbed by another key
                      console.log(`[Process] Auto-next: claim failed for "${nextDoc.payload.title}" — likely claimed by another key`)
                      continue // Try next doc in this status group
                    }
                  }
                }
              }

              // Try to start more docs from the queue
              await startDocIfKeyFree()
            })
            running.push(promise)
          }
        }

        // Initial start: process all queued docs (up to MAX_TOTAL_CONCURRENT concurrently)
        await startDocIfKeyFree()

        // Wait for all running docs to finish, then check for newly-uploaded docs.
        // When autoNext is enabled, keep polling for new docs instead of exiting immediately.
        // This ensures that documents uploaded AFTER the auto-chain starts still get processed.
        const AUTO_NEXT_POLL_INTERVAL = 5_000 // Check for new docs every 5 seconds
        const AUTO_NEXT_MAX_IDLE = 120_000 // Exit after 2 minutes of no new docs
        let lastActivityTime = Date.now()

        while (running.length > 0 || (autoNext && (Date.now() - lastActivityTime) < AUTO_NEXT_MAX_IDLE)) {
          if (running.length > 0) {
            await Promise.race(running)
            lastActivityTime = Date.now() // Activity = doc finished processing
          }

          // If autoNext and all keys are free, check for newly-uploaded docs
          // BUG FIX: Fetch multiple docs to fill ALL free keys at once (not 1 per poll)
          if (autoNext && running.length === 0 && queue.length === 0) {
            const freeKeys = getFreeKeyCount()
            const newDocs = await fetchDocsByStatuses(['uploaded', 'error', 'partial'], { limit: Math.max(freeKeys, 4), orderBy: 'created_at', orderDir: 'asc' })
            if (newDocs && newDocs.length > 0) {
              for (const nextDoc of newDocs) {
                // BUG FIX: Skip already-claimed docs (prevents race condition)
                if (claimedDocIds.has(nextDoc.id)) continue

                // BUG FIX: Skip paused docs — same checks as auto-next callback
                if (isDocPaused(nextDoc.id)) continue
                try {
                  const sqliteDoc = await db.document.findUnique({ where: { id: nextDoc.id }, select: { userPaused: true } })
                  if (sqliteDoc?.userPaused) { markDocPaused(nextDoc.id); continue }
                } catch { /* non-fatal */ }

                // BUG FIX: Skip docs already assigned to a key
                if (getActiveDocIds().includes(nextDoc.id)) continue

                const newStatus = nextDoc.payload.status === 'uploaded' ? 'parsing' : 'extracting'
                const claimSuccess = await updateDocumentStatus(nextDoc.id, {
                  status: newStatus,
                  error_message: nextDoc.payload.status === 'error' ? null : undefined,
                  processing_steps: (nextDoc.payload.status === 'error' || nextDoc.payload.status === 'partial')
                    ? nextDoc.payload.processing_steps : stepsToQdrantFormat(getDefaultSteps()),
                  processing_percent: (nextDoc.payload.status === 'error' || nextDoc.payload.status === 'partial')
                    ? undefined : 0,
                })
                if (claimSuccess) {
                  claimedDocIds.add(nextDoc.id)
                  try {
                    clearDocPaused(nextDoc.id)
                    await db.document.update({ where: { id: nextDoc.id }, data: {
                      status: newStatus,
                      errorMessage: nextDoc.payload.status === 'error' ? null : undefined,
                      // BUG FIX: Don't unconditionally clear userPaused —
                      // if doc was user-paused, we already skipped it above
                      userPaused: nextDoc.payload.status === 'partial' ? undefined : false,
                      processingSteps: JSON.stringify((nextDoc.payload.status === 'error' || nextDoc.payload.status === 'partial')
                        ? nextDoc.payload.processing_steps : stepsToQdrantFormat(getDefaultSteps())),
                    }})
                  } catch { /* non-fatal */ }
                  const slotIdx = acquireKey(nextDoc.id)
                  if (slotIdx >= 0) {
                    console.log(`[Process] Auto-next pickup: claimed "${nextDoc.payload.title}" (${nextDoc.payload.status}→${newStatus}) for key ${slotIdx + 1}`)
                    allDocIdsWithKeys.add(nextDoc.id)
                    queue.push(nextDoc.id)
                    lastActivityTime = Date.now()
                  } else {
                    console.warn(`[Process] Auto-next pickup: no free key for "${nextDoc.payload.title}"`)
                    releaseKey(nextDoc.id)
                  }
                }
                // If queue is filling up, stop fetching more
                if (queue.length >= MAX_TOTAL_CONCURRENT) break
              }
            }
            if (queue.length === 0) {
              // No new docs found — wait before checking again
              await new Promise(resolve => setTimeout(resolve, AUTO_NEXT_POLL_INTERVAL))
            }
          }

          // Try to start docs from the queue
          await startDocIfKeyFree()

          // Small delay to avoid tight loop
          await new Promise(resolve => setTimeout(resolve, 500))
        }

        if (autoNext) {
          console.log(`[Process] Auto-next idle timeout (${AUTO_NEXT_MAX_IDLE / 1000}s no new docs) — background task complete`)
        } else {
          console.log('[Process] All documents processed, background task complete')
        }
      })().catch(err => {
        console.error('[Process] Auto-chain error:', err)
        // Safety: release any keys that might have been acquired but not released
        // (e.g., if the bgPromise IIFE crashed before processWithAutoChain's finally ran)
        // Use allDocIdsWithKeys — includes auto-next docs that were NOT in activeDocIds.
        for (const docId of allDocIdsWithKeys) {
          releaseKey(docId)
        }
        persistKeyAssignments().catch(() => {})
      })

      // Don't await — let it run in the background
      // The client polls for progress via GET /api/ingestion/process?action=progress
      void bgPromise

      return NextResponse.json({
        message: `Processing ${activeDocIds.length} document(s) in background (up to ${MAX_TOTAL_CONCURRENT} concurrent, ${MAX_KEYS} keys × ${MAX_DOCS_PER_KEY} docs/key)`,
        documentIds: activeDocIds,
        async: true,
        autoChain: true,
        maxConcurrent: MAX_TOTAL_CONCURRENT,
      })
    }

    // Synchronous mode (original behavior): wait for all documents to finish
    // This can timeout for large documents — prefer async mode
    const results: Record<string, unknown>[] = []
    for (const docId of documentIds) {
      const slotIndex = acquireKey(docId)
      if (slotIndex < 0) {
        // No free key — can't process this document in sync mode
        results.push({
          documentId,
          status: 'error',
          error: `No free key available — all ${MAX_TOTAL_CONCURRENT} key assignments are busy (${MAX_KEYS} keys × ${MAX_DOCS_PER_KEY} docs/key). Use async mode for queuing.`,
        })
        continue
      }
      try {
        const result = await runIngestionPipeline(docId, slotIndex)
        results.push(result)
      } finally {
        releaseKey(docId)
        await flushTokenCount().catch(() => {})
      }
    }

    return NextResponse.json({ results, totalProcessed: results.length })
  } catch (error) {
    console.error('[Process] Error:', error)
    const errorResponse: Record<string, unknown> = { error: error instanceof Error ? error.message : 'Processing failed' }
    if (process.env.NODE_ENV !== 'production' && error instanceof Error) {
      errorResponse.stack = error.stack
    }
    return NextResponse.json(errorResponse, { status: 500 })
  }
}

// ==================== GET HANDLER ====================

/** Restore pausedDocIds from SQLite on server restart.
 *  When the server restarts, the in-memory pausedDocIds set is empty.
 *  Without this, auto-recovery would re-trigger user-paused documents.
 *  Called lazily on the first GET request to avoid blocking server startup. */
let hasRestoredPausedDocs = false
async function restorePausedDocsFromDB(): Promise<void> {
  if (hasRestoredPausedDocs) return
  hasRestoredPausedDocs = true
  try {
    const pausedDocs = await db.document.findMany({
      where: { userPaused: true },
      select: { id: true },
    })
    if (pausedDocs.length > 0) {
      for (const doc of pausedDocs) {
        markDocPaused(doc.id)
      }
      console.log(`[Process] Restored ${pausedDocs.length} user-paused document(s) from SQLite`)
    }
  } catch (err) {
    console.warn('[Process] Failed to restore paused docs from SQLite:', err instanceof Error ? err.message : String(err))
  }
}

export async function GET(request: NextRequest) {
  try {
    // Restore user-paused docs from SQLite on first request after restart
    await restorePausedDocsFromDB()

    const { searchParams } = new URL(request.url)
    const documentId = searchParams.get('documentId')
    const action = searchParams.get('action')

    // AUTO-RECOVERY: On every GET request, check for docs stuck in transitional states.
    // This handles the case where the server restarts/hot-reloads and kills the auto-chain process.
    // The pipeline updates `updated_at` on every chunk, so if it hasn't changed in 5+ minutes,
    // the process is dead and the doc needs recovery.
    // Only run recovery ~5% of the time to avoid excessive DB queries on every poll.
    if (Math.random() < 0.05) {
      void autoRecoverStuckDocs().catch(err => {
        console.error('[GET] Auto-recovery error:', err instanceof Error ? err.message : String(err))
      })

      // Phase 5.3: Active retry for error documents.
      // When LLM providers have recovered (availability >= 50%), automatically
      // retry documents in 'error' status so they don't sit idle until the user
      // manually clicks "Tiếp tục". This runs alongside the existing auto-recovery
      // check (~5% of GET requests) to avoid excessive load.
      void autoRetryErrorDocs().catch(err => {
        console.error('[GET] Auto-retry error docs error:', err instanceof Error ? err.message : String(err))
      })
    }

    // action=batch-progress: return progress for ALL documents currently being processed
    if (action === 'batch-progress') {
      const processingDocs = await fetchDocsByStatuses(['parsing', 'chunked', 'extracting', 'extracted'], { orderBy: 'updated_at', orderDir: 'asc' })

      return NextResponse.json({
        documents: processingDocs.map(doc => ({
          id: doc.id,
          title: doc.payload.title,
          status: doc.payload.status,
          steps: Array.isArray(doc.payload.processing_steps) ? doc.payload.processing_steps : [],
          percent: doc.payload.processing_percent || 0,
          updatedAt: doc.payload.updated_at,
        })),
      })
    }

    // action=progress: return document processing progress with chunk/embedding counts
    if (action === 'progress' && documentId) {
      const docPayload = await getDocument(documentId)
      if (!docPayload) return NextResponse.json({ error: 'Document not found' }, { status: 404 })
      const document = qdrantDocToRecord(docPayload, documentId)

      // Count chunks for this document
      const totalChunks = await getChunkCount(documentId)
      const chunksTotal = totalChunks

      // Count embeddings — all chunks in Qdrant have vectors
      let embeddingsTotal = totalChunks
      let embeddingsProcessed = totalChunks

      // Determine chunks processed by counting distinct chunk_ids that have entities.
      let chunksProcessed = 0
      if (totalChunks > 0) {
        const allEntities = await db.localEntity.findMany({
          where: { documentId },
          select: { chunkId: true },
        })
        const uniqueChunkIds = new Set(allEntities.map(e => e.chunkId).filter(id => id && id.trim()))
        chunksProcessed = uniqueChunkIds.size
      }

      // Calculate overall percent complete with weighted stages:
      // Stage 1: Download & Parse PDF → 0-10%
      // Stage 2: Chunk text → 10-15%
      // Stage 3: Entity extraction (per chunk) → 15-75%
      // Stage 4: Entity resolution → 75-80%
      // Stage 5: Save to DB & Neo4j → 80-90%
      // Stage 6: Embeddings → 90-100%
      let percentComplete = 0
      if (document.status === 'uploaded') percentComplete = 0
      else if (document.status === 'parsing') {
        if (totalChunks === 0) percentComplete = 5  // Still parsing PDF
        else percentComplete = 15 + Math.round((chunksProcessed / totalChunks) * 60)
      } else if (document.status === 'chunked') {
        percentComplete = 15 + Math.round((chunksProcessed / totalChunks) * 60)
      } else if (document.status === 'extracting') {
        percentComplete = 15 + Math.round((chunksProcessed / totalChunks) * 60)
      } else if (document.status === 'indexed') {
        percentComplete = 100
      } else if (document.status === 'partial') {
        // 'partial' means extraction is incomplete — show extraction progress, not embeddings
        // The extraction step is 50% weight (15-65%), so partial progress reflects extraction state
        percentComplete = 15 + Math.round((chunksProcessed / Math.max(1, totalChunks)) * 60)
      } else if (document.status === 'error') {
        percentComplete = 0
      }

      // Count entities and relationships for this document
      const entityCount = await db.localEntity.count({ where: { documentId } }).catch(() => 0)
      const relationshipCount = await db.localRelationship.count({ where: { documentId } }).catch(() => 0)

      return NextResponse.json({
        document,
        progress: {
          chunksTotal: totalChunks,
          chunksProcessed,
          embeddingsTotal,
          embeddingsProcessed,
          percentComplete,
          entityCount,
          relationshipCount,
        },
      })
    }

    // action=cleanup-embeddings: deduplicate embeddings (keep latest per chunk)
    if (action === 'cleanup-embeddings') {
      const targetDocId = documentId // optional: limit to specific document
      console.log(`[Cleanup] Starting embedding deduplication${targetDocId ? ` for doc ${targetDocId}` : ' for ALL docs'}`)

      // With Qdrant, each chunk is a single point with one vector — no duplication possible
      // Just return a success response indicating no cleanup is needed
      const chunkCount = targetDocId ? await getChunkCount(targetDocId) : 0

      console.log(`[Cleanup] Qdrant architecture prevents chunk duplication — no cleanup needed (${chunkCount} chunks)`)
      return NextResponse.json({
        success: true,
        chunksProcessed: chunkCount,
        embeddingsKept: chunkCount,
        duplicatesRemoved: 0,
      })
    }

    if (documentId) {
      const docPayload = await getDocument(documentId)
      if (!docPayload) return NextResponse.json({ error: 'Document not found' }, { status: 404 })
      const document = qdrantDocToRecord(docPayload, documentId)
      return NextResponse.json({ document })
    }

    // Return recent documents with their status
    const recentDocs = await listDocuments({ limit: 20, orderBy: 'created_at', orderDir: 'desc' })
    return NextResponse.json({ documents: recentDocs.documents.map(d => ({
      id: d.id, title: d.payload.title, domain: d.payload.domain, status: d.payload.status,
      page_count: d.payload.page_count, created_at: d.payload.created_at, updated_at: d.payload.updated_at,
    })) })
  } catch (error) {
    console.error('[Process] GET error:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to get status' }, { status: 500 })
  }
}

// ==================== PUT HANDLER (Stuck Document Recovery) ====================

/** Stuck threshold — documents in transitional states that haven't been updated recently.
 *  With auto-chain, the pipeline updates `updated_at` on every chunk (not just batch checkpoints).
 *  If `updated_at` hasn't changed in 5 minutes, the process has likely died and needs recovery.
 *  This handles: server restart/hot-reload killing the auto-chain, Vercel function timeout, etc.
 *  The frontend auto-continue also triggers recovery for 'partial' docs.
 *
 *  NOTE: For 'partial' status, we use a longer threshold (20 minutes) because:
 *  - 'partial' is a valid state between auto-chain batches
 *  - Neo4j writing can take a long time for large documents (batch processing)
 *  - The frontend auto-continue runs every few seconds, so there may be a brief 'partial' state
 *  - We don't want to prematurely recover a doc that's just waiting for the next batch
 */
const STUCK_THRESHOLD_MS = 5 * 60 * 1000
const PARTIAL_STUCK_THRESHOLD_MS = 20 * 60 * 1000

/** Phase 5.3: Active retry for error documents.
 *  When LLM providers have recovered (availability >= 50%), automatically
 *  reset documents in 'error' status so the frontend auto-continue can
 *  pick them up and re-process them. This avoids the situation where error
 *  docs sit idle until the user manually clicks "Tiếp tục".
 *
 *  Key design decisions:
 *  - Only runs when provider availability is >= 50% (providers have recovered)
 *  - Limits to 2 docs per run to avoid overloading
 *  - Respects userPaused flag — never auto-retry user-paused docs
 *  - Docs WITH existing data → 'partial' (preserves chunks/entities)
 *  - Docs WITHOUT data → 'uploaded' (fresh start)
 */
async function autoRetryErrorDocs(): Promise<{ retried: number }> {
  // Check if providers have recovered enough to warrant retrying
  const overallAvailability = getOverallAvailability()
  if (overallAvailability < 0.5) {
    return { retried: 0 } // Providers still struggling — don't retry yet
  }

  try {
    const errorDocs = await fetchDocsByStatuses(['error'])
    if (errorDocs.length === 0) return { retried: 0 }

    let retriedCount = 0
    // Limit to 2 docs per cycle to avoid overwhelming the system
    for (const doc of errorDocs.slice(0, 2)) {
      // PAUSE CHECK: Skip error docs that were intentionally paused by the user.
      const processingSteps = doc.payload.processing_steps as Array<{ detail?: string }> | undefined
      const wasPausedByUserSteps = processingSteps?.some(s => s.detail?.includes('tạm dừng bởi người dùng'))
      let wasPausedByUserDB = false
      try {
        const sqliteDoc = await db.document.findUnique({ where: { id: doc.id }, select: { userPaused: true } })
        wasPausedByUserDB = sqliteDoc?.userPaused === true
      } catch { /* non-fatal */ }
      if (wasPausedByUserSteps || wasPausedByUserDB) {
        if (!isDocPaused(doc.id)) markDocPaused(doc.id)
        continue
      }

      // Check if document has existing data
      const chunkCount = await getChunkCount(doc.id)

      if (chunkCount > 0) {
        // Error docs WITH data → 'partial' (preserves existing chunks/entities)
        await updateDocumentStatus(doc.id, { status: 'partial', error_message: null })
        try { await db.document.update({ where: { id: doc.id }, data: { status: 'partial', errorMessage: null } }) } catch { /* non-fatal */ }
      } else {
        // Error docs WITHOUT data → 'uploaded' (fresh start)
        await updateDocumentStatus(doc.id, { status: 'uploaded', processing_steps: [], processing_percent: 0, error_message: null })
        try { await db.document.update({ where: { id: doc.id }, data: { status: 'uploaded', processingSteps: '[]', processingPercent: 0, errorMessage: null } }) } catch { /* non-fatal */ }
      }

      retriedCount++
      console.log(`[Auto-Retry] Error doc "${doc.payload.title}" (${doc.id.slice(0, 8)}...) auto-retried — providers recovered (${(overallAvailability * 100).toFixed(0)}% availability)`)
    }

    if (retriedCount > 0) {
      invalidateDocumentCache()
    }
    return { retried: retriedCount }
  } catch (err) {
    console.warn('[Auto-Retry] Error during auto-retry of error docs:', err instanceof Error ? err.message : String(err))
    return { retried: 0 }
  }
}

/** Auto-recover stuck documents in transitional states.
 *  Called by GET handler (on frontend poll) and PUT handler (explicit recovery).
 *  Returns the number of docs recovered.
 */
async function autoRecoverStuckDocs(): Promise<{ recovered: number; smartRecovered: number }> {
  const now = new Date()
  const stuckThreshold = new Date(now.getTime() - STUCK_THRESHOLD_MS).toISOString()
  const partialStuckThreshold = new Date(now.getTime() - PARTIAL_STUCK_THRESHOLD_MS).toISOString()
  let recoveredCount = 0
  let smartRecoveredCount = 0

  const transitionalStatuses = ['parsing', 'chunked', 'extracting', 'extracted', 'partial']

  try {
    // Fetch docs in transitional statuses from Qdrant — use higher limit for 300+ doc systems
    const stuckDocs = await fetchDocsByStatuses(transitionalStatuses, { limit: 500, orderBy: 'updated_at', orderDir: 'asc' })

    // Filter by threshold — Qdrant doesn't support lt/gt filters, so we do it client-side
    const filteredDocs = stuckDocs.filter(doc => doc.payload.updated_at < partialStuckThreshold)

    if (filteredDocs.length === 0) {
      return { recovered: recoveredCount, smartRecovered: smartRecoveredCount }
    }

    // Get all currently active doc IDs from key assignments — these must NOT be recovered
    let keyActiveDocIds: Set<string> = new Set()
    try {
      keyActiveDocIds = new Set(getActiveDocIds())
    } catch { /* getActiveDocIds() may fail if llm module not initialized */ }

    for (const doc of filteredDocs) {
      const threshold = doc.payload.status === 'partial' ? partialStuckThreshold : stuckThreshold
      if (doc.payload.updated_at >= threshold) continue  // Skip docs still within threshold

      // KEY CHECK: Skip docs that have an active key assignment — they are being processed
      if (keyActiveDocIds.has(doc.id)) {
        console.log(`[Recovery] Skipping doc "${doc.payload.title}" — has active key assignment`)
        continue
      }

      // PAUSE CHECK: Skip docs that were intentionally paused by the user.
      // Check both the userPaused flag in SQLite and the processing_steps for the pause detail.
      const processingSteps = doc.payload.processing_steps as Array<{ detail?: string }> | undefined
      const wasPausedByUserSteps = processingSteps?.some(s => s.detail?.includes('tạm dừng bởi người dùng'))
      let wasPausedByUserDB = false
      try {
        const sqliteDoc = await db.document.findUnique({ where: { id: doc.id }, select: { userPaused: true } })
        wasPausedByUserDB = sqliteDoc?.userPaused === true
      } catch { /* non-fatal */ }
      if (wasPausedByUserSteps || wasPausedByUserDB) {
        // Ensure the in-memory pausedDocIds is also set for this doc
        if (!isDocPaused(doc.id)) markDocPaused(doc.id)
        console.log(`[Recovery] Skipping doc "${doc.payload.title}" — was paused by user (not auto-recovering)`)
        continue
      }

      // Check if document has entities
      const entityCount = await db.localEntity.count({ where: { documentId: doc.id } })

      // Check if document has chunks
      const chunkCount = await getChunkCount(doc.id)

      // Check how many chunks have been extracted
      const distinctChunkIds = await db.localEntity.findMany({
        where: { documentId: doc.id },
        select: { chunkId: true },
      })
      const chunksExtracted = new Set(distinctChunkIds.map(e => e.chunkId).filter(id => id && id.trim())).size

      const hasEntities = entityCount > 0
      const hasChunks = chunkCount > 0

      // CRITICAL: Release the key for this doc if it still has one.
      // Without this, key capacity leaks over time (especially with 300+ docs) and
      // getActiveDocCount() returns inflated values, causing 503 "too busy" errors.
      releaseKey(doc.id)

      if (hasEntities && hasChunks) {
        const completionRatio = chunkCount > 0 ? chunksExtracted / chunkCount : 0
        if (completionRatio >= 0.9) {
          const hasEmbeddings = chunkCount > 0 // In Qdrant, chunks exist = embeddings exist
          if (hasEmbeddings) {
            // AUDIT FIX: Don't reset processing_steps to [] — this destroys the user-visible
            // step history. Instead, preserve existing steps or create a completed set.
            const existingSteps = doc.payload.processing_steps as ProcessingStepRecord[] | null
            const completedSteps = existingSteps && Array.isArray(existingSteps) && existingSteps.length === PIPELINE_STEPS.length
              ? existingSteps.map(s => ({ ...s, status: 'completed' as const }))
              : getDefaultSteps().map(s => ({ ...s, status: 'completed' as const }))
            await updateDocumentStatus(doc.id, { status: 'indexed', error_message: null, processing_steps: completedSteps, processing_percent: 100 })
            try { await db.document.update({ where: { id: doc.id }, data: { status: 'indexed', errorMessage: null, processingPercent: 100 } }) } catch { /* non-fatal */ }
            smartRecoveredCount++
            console.log(`[Recovery] Smart-recovered doc "${doc.payload.title}" → 'indexed' (has data)`)
          } else {
            await updateDocumentStatus(doc.id, { status: 'partial', error_message: null })
            try { await db.document.update({ where: { id: doc.id }, data: { status: 'partial', errorMessage: null } }) } catch { /* non-fatal */ }
            recoveredCount++
            console.log(`[Recovery] Doc "${doc.payload.title}" has ≥90% extraction but no embeddings — keeping as 'partial'`)
          }
        } else {
          await updateDocumentStatus(doc.id, { status: 'partial', error_message: null })
          try { await db.document.update({ where: { id: doc.id }, data: { status: 'partial', errorMessage: null } }) } catch { /* non-fatal */ }
          recoveredCount++
          console.log(`[Recovery] Doc "${doc.payload.title}" has ${chunksExtracted}/${chunkCount} chunks — marking as 'partial'`)
        }
      } else if (hasChunks && !hasEntities) {
        await updateDocumentStatus(doc.id, { status: 'partial', error_message: null })
        try { await db.document.update({ where: { id: doc.id }, data: { status: 'partial', errorMessage: null } }) } catch { /* non-fatal */ }
        recoveredCount++
        console.log(`[Recovery] Doc "${doc.payload.title}" has ${chunkCount} chunks but 0 entities — marking as 'partial'`)
      } else {
        // No LOCAL chunks/entities. Before resetting, check whether Neo4j
        // (the durable cloud graph) still holds extraction results for this
        // document — the local SQLite/Qdrant buffers may have been wiped on a
        // fresh setup even though the cloud graph survived. Relationship edges
        // always carry a `documentId` property (set during extraction), so
        // counting them is the reliable signal that a doc was processed.
        let neo4jRelCount = 0
        try {
          const rows = await readCypher<{ cnt: number }>(
            `MATCH ()-[r]->() WHERE r.documentId = $docId RETURN count(r) AS cnt`,
            { docId: doc.id }
          )
          neo4jRelCount = (rows[0]?.cnt as number) ?? 0
        } catch { /* non-fatal — treat as 0 */ }

        if (neo4jRelCount > 0) {
          // Extraction result survives in Neo4j cloud graph — preserve as
          // 'extracted' (90%, embeddings pending re-run) instead of resetting.
          const preservedSteps = getDefaultSteps().map((s, i) =>
            i < 6
              ? { ...s, status: 'completed' as const, startedAt: 'reconciled', completedAt: 'reconciled', detail: 'Restored from Neo4j during recovery' }
              : s
          )
          await updateDocumentStatus(doc.id, {
            status: 'extracted',
            error_message: null,
            processing_steps: stepsToQdrantFormat(preservedSteps),
            processing_percent: 90,
          })
          try { await db.document.update({ where: { id: doc.id }, data: { status: 'extracted', errorMessage: null, processingSteps: JSON.stringify(preservedSteps), processingPercent: 90 } }) } catch { /* non-fatal */ }
          smartRecoveredCount++
          console.log(`[Recovery] Preserved doc "${doc.payload.title}" → 'extracted' (${neo4jRelCount} Neo4j rels; local buffers empty — likely reconciled)`)
        } else {
          // Genuinely no data anywhere — reset to 'uploaded' for fresh processing
          await updateDocumentStatus(doc.id, {
            status: 'uploaded',
            error_message: null,
            processing_steps: stepsToQdrantFormat(getDefaultSteps()),
            processing_percent: 0,
          })
          try { await db.document.update({ where: { id: doc.id }, data: { status: 'uploaded', errorMessage: null, processingSteps: '[]', processingPercent: 0 } }) } catch { /* non-fatal */ }
          recoveredCount++
          console.log(`[Recovery] Reset doc "${doc.payload.title}" → 'uploaded' (no data anywhere, ready for re-processing)`)
        }
      }
    }

    if (recoveredCount > 0 || smartRecoveredCount > 0) {
      // Persist slot state changes after recovery
      persistKeyAssignments().catch(() => {})
      console.log(`[Recovery] Auto-recovery complete: ${recoveredCount} docs recovered, ${smartRecoveredCount} smart-indexed, ${getActiveDocCount()} slots still in use`)
    }
  } catch (err) {
    console.warn('[Recovery] Query failed (timeout or error):', err instanceof Error ? err.message : err)
  }

  return { recovered: recoveredCount, smartRecovered: smartRecoveredCount }
}

export async function PUT(request: NextRequest) {
  try {
    // Parse optional request body for force-recovery
    let forceDocId: string | null = null
    let forceAll = false
    try {
      const body = await request.json()
      forceDocId = body.documentId || body.forceDocId || null
      forceAll = body.force === true && !forceDocId
    } catch { /* no body or invalid JSON — use default behavior */ }

    // FORCE-RECOVER: When a specific documentId is provided or force=true,
    // bypass the time threshold and directly mark 'extracting' docs as 'partial'.
    // This handles the case where the auto-chain process crashed but the document's
    // updated_at is still recent, causing the POST handler to skip it.
    if (forceDocId || forceAll) {
      let docsToForce: Array<{ id: string; title: string; status: string; processing_steps: unknown; updated_at: string }>
      if (forceDocId) {
        const docPayload = await getDocument(forceDocId)
        if (!docPayload) {
          return NextResponse.json({ error: 'Document not found' }, { status: 404 })
        }
        docsToForce = [{ id: forceDocId, title: docPayload.title, status: docPayload.status, processing_steps: docPayload.processing_steps, updated_at: docPayload.updated_at }]
      } else {
        const forceDocs = await fetchDocsByStatuses(['extracting', 'parsing', 'chunked'])
        docsToForce = forceDocs.map(d => ({ id: d.id, title: d.payload.title, status: d.payload.status, processing_steps: d.payload.processing_steps, updated_at: d.payload.updated_at }))
      }

      const forceResults: Array<{ id: string; title: string; fromStatus: string; toStatus: string }> = []

      for (const doc of docsToForce) {
        // Check if the document has data (chunks/entities) before force-recovering
        const chunkCount = await getChunkCount(doc.id)
        const entityCount = await db.localEntity.count({ where: { documentId: doc.id } })

        const hasData = chunkCount > 0 || entityCount > 0
        const newStatus = hasData ? 'partial' : 'uploaded'

        // Clear pause markers from processing_steps when force-recovering.
        const steps = (doc.processing_steps || []) as Array<{ name: string; label: string; status: string; startedAt: string | null; completedAt: string | null; detail: string | null }>
        const cleanedSteps = steps.map(s =>
          s.detail?.includes('tạm dừng bởi người dùng')
            ? { ...s, detail: null, status: s.name === 'extract' ? 'pending' : s.status }
            : s
        )

        await updateDocumentStatus(doc.id, {
          status: newStatus,
          error_message: null,
          processing_steps: cleanedSteps as DocumentPayload['processing_steps'],
        })

        // Clear userPaused flag and in-memory pause when force-recovering
        clearDocPaused(doc.id)
        try {
          await db.document.update({ where: { id: doc.id }, data: { userPaused: false } })
        } catch { /* non-fatal */ }

        forceResults.push({
          id: doc.id,
          title: doc.title,
          fromStatus: doc.status,
          toStatus: newStatus,
        })
        console.log(`[Force-Recovery] Doc "${doc.title}" force-recovered from '${doc.status}' → '${newStatus}' (chunks=${chunkCount}, entities=${entityCount})`)
      }

      return NextResponse.json({
        recovered: forceResults.length,
        forceRecovery: true,
        details: forceResults,
      })
    }

    const result = await autoRecoverStuckDocs()
    invalidateDocumentCache()

    // 2. Auto-retry documents in 'error' status
    const errorDocs = await fetchDocsByStatuses(['error'])
    let errorRetryCount = 0
    if (errorDocs.length > 0) {
      const docsToPartial: string[] = []
      const docsToUploaded: string[] = []

      for (const doc of errorDocs) {
        // PAUSE CHECK: Skip error docs that were intentionally paused by the user.
        const processingSteps = doc.payload.processing_steps as Array<{ detail?: string }> | undefined
        const wasPausedByUserSteps = processingSteps?.some(s => s.detail?.includes('tạm dừng bởi người dùng'))
        let wasPausedByUserDB = false
        try {
          const sqliteDoc = await db.document.findUnique({ where: { id: doc.id }, select: { userPaused: true } })
          wasPausedByUserDB = sqliteDoc?.userPaused === true
        } catch { /* non-fatal */ }
        if (wasPausedByUserSteps || wasPausedByUserDB) {
          if (!isDocPaused(doc.id)) markDocPaused(doc.id)
          console.log(`[Recovery] Skipping error doc "${doc.payload.title}" — was paused by user (not auto-recovering)`)
          continue
        }

        // Check if document has existing data
        const chunkCount = await getChunkCount(doc.id)

        if (chunkCount > 0) {
          docsToPartial.push(doc.id)
        } else {
          docsToUploaded.push(doc.id)
        }
      }

      // Error docs WITH data → 'partial' (preserves existing chunks/entities)
      if (docsToPartial.length > 0) {
        for (const id of docsToPartial) {
          await updateDocumentStatus(id, { status: 'partial', error_message: null })
          try { await db.document.update({ where: { id }, data: { status: 'partial', errorMessage: null } }) } catch { /* non-fatal */ }
        }
        errorRetryCount += docsToPartial.length
        console.log(`[Recovery] Reset ${docsToPartial.length} error docs with data → 'partial' (preserving data)`)
      }

      // Error docs WITHOUT data → 'uploaded' (fresh start)
      if (docsToUploaded.length > 0) {
        for (const id of docsToUploaded) {
          await updateDocumentStatus(id, { status: 'uploaded', processing_steps: [], processing_percent: 0, error_message: null })
          try { await db.document.update({ where: { id }, data: { status: 'uploaded', processingSteps: '[]', processingPercent: 0, errorMessage: null } }) } catch { /* non-fatal */ }
        }
        errorRetryCount += docsToUploaded.length
        console.log(`[Recovery] Reset ${docsToUploaded.length} error docs without data → 'uploaded' (fresh start)`)
      }
    }

    const totalRecovered = result.recovered + result.smartRecovered + errorRetryCount
    invalidateDocumentCache()
    return NextResponse.json({
      recovered: totalRecovered,
      details: {
        stuckToPartial: result.recovered,
        stuckToIndexed: result.smartRecovered,
        errorToUploaded: errorRetryCount,
        message: totalRecovered > 0
          ? `Recovered ${result.recovered} stuck → partial, ${result.smartRecovered} stuck → indexed (has data), ${errorRetryCount} error → uploaded`
          : 'No stuck documents found'
      }
    })
  } catch (error) {
    console.error('[Recovery] PUT error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Recovery failed' },
      { status: 500 }
    )
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json()
    const documentId = body.documentId

    if (!documentId) {
      return NextResponse.json({ error: 'Missing documentId parameter' }, { status: 400 })
    }

    // Look up the document from Qdrant
    const docPayload = await getDocument(documentId)
    if (!docPayload) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }
    const doc = qdrantDocToRecord(docPayload, documentId)

    // Only pause documents that are currently being processed.
    if (!['extracting', 'parsing', 'chunked', 'partial'].includes(doc.status as string)) {
      return NextResponse.json({
        error: `Cannot pause document with status '${doc.status}'. Only extracting/parsing/chunked/partial documents can be paused.`,
        status: doc.status
      }, { status: 400 })
    }

    // If doc is already 'partial', just mark it as paused in memory (no DB update needed)
    const isAlreadyPartial = doc.status === 'partial'

    // Update processing_steps: mark running steps as 'pending' with pause detail
    const steps = (doc.processing_steps || []) as ProcessingStepRecord[]
    const updatedSteps = steps.map((s: ProcessingStepRecord) => {
      if (s.name === 'extract' && s.status === 'running') {
        return { ...s, status: 'pending' as const, detail: 'Đã tạm dừng bởi người dùng' }
      }
      if (s.status === 'running') {
        return { ...s, status: 'pending' as const }
      }
      return s
    })

    // Only update Qdrant if the status actually changed (not already 'partial')
    if (!isAlreadyPartial) {
      await updateDocumentStatus(documentId, {
        status: 'partial',
        error_message: null,
        processing_steps: updatedSteps as DocumentPayload['processing_steps'],
      })
      try { await db.document.update({ where: { id: documentId }, data: { status: 'partial', errorMessage: null, processingSteps: JSON.stringify(updatedSteps) } }) } catch { /* non-fatal */ }

      console.log(`[Pause] Document "${doc.title}" paused from '${doc.status}' → 'partial'`)
    } else {
      // Already 'partial' — just update processing_steps if needed
      const hasRunningSteps = steps.some(s => s.status === 'running')
      if (hasRunningSteps) {
        await updateDocumentStatus(documentId, {
          processing_steps: updatedSteps as DocumentPayload['processing_steps'],
        })
        try { await db.document.update({ where: { id: documentId }, data: { processingSteps: JSON.stringify(updatedSteps) } }) } catch { /* non-fatal */ }
      }
      console.log(`[Pause] Document "${doc.title}" was already 'partial' — marked as paused in memory`)
    }

    // Mark the document as paused so the background pipeline stops at the next checkpoint.
    // DO NOT release the key here! The auto-chain's finally block handles key release.
    // If we release here, another doc could acquire the slot while the pipeline is still
    // using it (mid-LLM-call), causing key collisions and rate-limit cascades.
    // The pipeline checks isDocPaused() at each chunk group checkpoint and will stop,
    // at which point the auto-chain's finally block releases the slot safely.
    markDocPaused(documentId)

    // Persist userPaused flag in SQLite so it survives server restarts.
    // This prevents auto-continue and auto-recovery from re-triggering user-paused docs.
    try {
      await db.document.update({ where: { id: documentId }, data: { userPaused: true } })
    } catch { /* non-fatal — pausedDocIds in memory is the primary guard */ }

    invalidateDocumentCache()

    return NextResponse.json({
      success: true,
      documentId,
      fromStatus: doc.status,
      toStatus: 'partial',
      message: `Đã tạm dừng tài liệu "${doc.title}"`,
    })
  } catch (error) {
    console.error('[Process] PATCH error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Pause failed' },
      { status: 500 }
    )
  }
}
