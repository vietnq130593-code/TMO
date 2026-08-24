/**
 * Chunking Module — Recursive Text Splitter (Phase 6 SMOLAB P0.3)
 *
 * Replaces the naive `text.slice(0, 2000)` pattern in auto-learn + writeback
 * which caused 5-15% recall degradation (long answers truncated → semantic
 * content beyond char 2000 lost).
 *
 * Strategy: recursive splitter that tries sentence boundaries first, then
 * word boundaries, then character fallback. Overlap of 50 chars preserves
 * cross-chunk context (entity mentioned at chunk end + start of next chunk).
 *
 * Spec: docs/SMOLAB_LEARNING_PROPOSALS.md Phase Pre-1 Proposal P0.3.
 */

// ==================== CONFIG ====================

/** Target chunk size in characters (NVIDIA embed supports up to 8K chars, 400 is sweet spot for recall) */
const DEFAULT_CHUNK_SIZE = 400

/** Overlap between adjacent chunks to preserve cross-boundary context */
const DEFAULT_CHUNK_OVERLAP = 50

/** Hard minimum — chunks smaller than this get merged into neighbors */
const MIN_CHUNK_SIZE = 50

// ==================== TYPES ====================

export interface Chunk {
  /** The chunk text content */
  text: string
  /** Position in the original text (0-indexed) */
  index: number
  /** Character offset where this chunk starts in the original text */
  startOffset: number
  /** Character offset where this chunk ends (exclusive) */
  endOffset: number
}

// ==================== SPLITTERS ====================

/**
 * Split a long text into overlapping chunks using recursive splitting.
 *
 * Strategy:
 *   1. Try splitting on paragraph boundaries (\\n\\n)
 *   2. If a piece is still > chunkSize, split on sentence boundaries (.!?\\s)
 *   3. If a piece is still > chunkSize, split on word boundaries (\\s)
 *   4. As last resort, hard-split on character count
 *
 * Then merge small chunks and apply overlap.
 *
 * @param text - Input text (any length)
 * @param chunkSize - Target size in chars (default 400)
 * @param overlap - Overlap between adjacent chunks in chars (default 50)
 * @returns Array of Chunk objects with text + position metadata
 */
export function chunkText(
  text: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  overlap: number = DEFAULT_CHUNK_OVERLAP,
): Chunk[] {
  if (!text || text.trim().length === 0) return []
  if (text.length <= chunkSize) {
    return [{ text, index: 0, startOffset: 0, endOffset: text.length }]
  }

  // Cap overlap to 30% of chunkSize to avoid excessive duplication
  const safeOverlap = Math.min(overlap, Math.floor(chunkSize * 0.3))
  const targetSize = Math.max(chunkSize, MIN_CHUNK_SIZE)

  // Step 1: Recursive split — get atomic pieces smaller than targetSize
  const pieces: string[] = []
  const splitRecursive = (input: string) => {
    if (input.length <= targetSize) {
      if (input.trim().length > 0) pieces.push(input)
      return
    }

    // Try paragraph boundary first
    let separators: RegExp[]
    if (/\n\n/.test(input)) {
      separators = [/\n\n+/, /\n+/, /(?<=[.!?])\s+/, /\s+/]
    } else if (/[.!?]\s/.test(input)) {
      separators = [/(?<=[.!?])\s+/, /\n+/, /\s+/]
    } else {
      separators = [/\s+/]
    }

    for (const sep of separators) {
      const parts = input.split(sep)
      if (parts.length > 1) {
        let current = ''
        for (const part of parts) {
          if (current.length === 0) {
            current = part
          } else if (current.length + part.length + 1 <= targetSize) {
            current += (sep.source.includes('\\n') ? '\n' : ' ') + part
          } else {
            // Current piece is full — push and start new
            if (current.length > 0) {
              splitRecursive(current)
              current = part
            } else {
              // Single part bigger than targetSize — recurse with different separator
              splitRecursive(part)
              current = ''
            }
          }
        }
        if (current.length > 0) splitRecursive(current)
        return
      }
    }

    // Last resort: hard character split
    for (let i = 0; i < input.length; i += targetSize) {
      pieces.push(input.slice(i, i + targetSize))
    }
  }

  splitRecursive(text)

  // Step 2: Merge small pieces + apply overlap
  const chunks: Chunk[] = []
  let currentText = ''
  let currentStart = 0
  let chunkIndex = 0

  for (const piece of pieces) {
    if (currentText.length === 0) {
      currentText = piece
      currentStart = text.indexOf(piece, currentStart) // approximate
    } else if (currentText.length + piece.length + 1 <= targetSize) {
      currentText += ' ' + piece
    } else {
      // Flush current chunk
      chunks.push({
        text: currentText,
        index: chunkIndex++,
        startOffset: currentStart,
        endOffset: currentStart + currentText.length,
      })
      // Start next chunk with overlap (last `safeOverlap` chars of previous chunk)
      const overlapText = currentText.slice(-safeOverlap)
      currentText = overlapText + ' ' + piece
      currentStart = currentStart + currentText.length - overlapText.length - 1
    }
  }
  if (currentText.trim().length > 0) {
    chunks.push({
      text: currentText,
      index: chunkIndex,
      startOffset: currentStart,
      endOffset: currentStart + currentText.length,
    })
  }

  // Step 3: Filter out tiny chunks (merge into previous)
  const finalChunks: Chunk[] = []
  for (const c of chunks) {
    if (c.text.length < MIN_CHUNK_SIZE && finalChunks.length > 0) {
      const prev = finalChunks[finalChunks.length - 1]
      prev.text += ' ' + c.text
      prev.endOffset = c.endOffset
    } else {
      finalChunks.push({ ...c, index: finalChunks.length })
    }
  }

  return finalChunks
}

/**
 * Convenience: chunk + return just the texts (for callers that don't need metadata)
 */
export function chunkTexts(text: string, chunkSize?: number, overlap?: number): string[] {
  return chunkText(text, chunkSize, overlap).map(c => c.text)
}

/**
 * Get chunk count without actually chunking (cheap preview)
 */
export function estimateChunkCount(text: string, chunkSize: number = DEFAULT_CHUNK_SIZE): number {
  if (!text || text.length === 0) return 0
  return Math.max(1, Math.ceil(text.length / chunkSize))
}

// ==================== EXPORT CONFIG ====================

export const CHUNKING_CONFIG = {
  defaultChunkSize: DEFAULT_CHUNK_SIZE,
  defaultOverlap: DEFAULT_CHUNK_OVERLAP,
  minChunkSize: MIN_CHUNK_SIZE,
}
