/**
 * PDF Parser - Extract text from PDF and chunk into segments
 * 
 * Domain-specific chunking strategies:
 * - programming/algorithm: 512 tokens, 64 overlap, preserve code blocks
 * - ml: 640 tokens, 96 overlap, preserve formulas
 * - meta_cognitive: 768 tokens, 128 overlap, preserve reasoning chains
 * - linux/security: 512 tokens, 64 overlap, preserve commands
 */

// pdf-parse may export as v1 (function) or v2 (PDFParse class) — handle both at runtime
// import type removed; we use dynamic import in parsePDF()

// ==================== TYPES ====================

export type DocumentDomain = 'programming' | 'algorithm' | 'ml' | 'meta_cognitive' | 'linux' | 'security' | 'ux_ui' | 'mixed'

export interface ChunkConfig {
  maxTokens: number
  overlapTokens: number
  preservePatterns: RegExp[]
}

export interface ParsedChunk {
  content: string
  chunkIndex: number
  headingPath: string
  tokenCount: number
  domain: DocumentDomain
}

export interface ParseResult {
  chunks: ParsedChunk[]
  totalPages: number
  totalTokens: number
}

// ==================== DOMAIN CHUNKING CONFIGS ====================

const DOMAIN_CONFIGS: Record<DocumentDomain, ChunkConfig> = {
  programming: {
    maxTokens: 512,
    overlapTokens: 64,
    preservePatterns: [
      /```[\s\S]*?```/g,  // code blocks
      /`[^`]+`/g,          // inline code
    ],
  },
  algorithm: {
    maxTokens: 512,
    overlapTokens: 64,
    preservePatterns: [
      /```[\s\S]*?```/g,  // code blocks
      /`[^`]+`/g,          // inline code
      /Step \d+[:.]/gi,    // algorithm steps
    ],
  },
  ml: {
    maxTokens: 640,
    overlapTokens: 96,
    preservePatterns: [
      /\$[^$]+\$/g,                          // inline math
      /\$\$[\s\S]*?\$\$/g,                   // display math
      /[a-zA-Z]\s*=\s*[a-zA-Z0-9+\-*/().]+/g, // formulas
      /L_\d+/g,                               // loss functions
    ],
  },
  meta_cognitive: {
    maxTokens: 768,
    overlapTokens: 128,
    preservePatterns: [
      /Therefore[,\.]/gi,
      /Thus[,\.]/gi,
      /Because/gi,
      /Since/gi,
      /This (implies|means|shows|demonstrates)/gi,
      /We can (conclude|infer|deduce)/gi,
    ],
  },
  linux: {
    maxTokens: 512,
    overlapTokens: 64,
    preservePatterns: [
      /\$\s+[a-zA-Z]/g,        // shell prompts
      /sudo\s+/g,               // sudo commands
      /apt|yum|dnf|pip|npm/g,   // package managers
      /#[^\n]*$/gm,             // comments
    ],
  },
  security: {
    maxTokens: 512,
    overlapTokens: 64,
    preservePatterns: [
      /CVE-\d{4}-\d+/g,        // CVE IDs
      /nmap|nikto|sqlmap|metasploit/gi, // tools
      /sudo\s+/g,
      /exploit/gi,
      /vulnerability/gi,
    ],
  },
  ux_ui: {
    maxTokens: 640,
    overlapTokens: 96,
    preservePatterns: [
      /```[\s\S]*?```/g,           // code blocks (HTML/CSS/JS snippets)
      /`[^`]+`/g,                   // inline code
      /Step \d+[:.]/gi,            // design process steps
      /\[[\s\S]*?\]\([\s\S]*?\)/g,  // markdown links (references)
    ],
  },
  mixed: {
    maxTokens: 512,
    overlapTokens: 64,
    preservePatterns: [],
  },
}

// ==================== TOKEN ESTIMATION ====================

/**
 * Estimate token count (~4 chars per token)
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4)
}

// ==================== HEADING EXTRACTION ====================

/**
 * Extract heading path from markdown-style headers in text
 * Returns a path like "Chapter 1 > Section 1.1 > Subsection"
 */
function extractHeadingPath(text: string): string {
  const headingPattern = /^(#{1,6})\s+(.+)$/gm
  const headings: { level: number; text: string }[] = []
  let match: RegExpExecArray | null

  while ((match = headingPattern.exec(text)) !== null) {
    headings.push({
      level: match[1].length,
      text: match[2].trim(),
    })
  }

  if (headings.length === 0) return ''

  // Build a path from the most specific heading hierarchy
  const path: string[] = []
  for (const h of headings) {
    while (path.length > 0 && path.length >= h.level) {
      path.pop()
    }
    path.push(h.text)
  }

  return path.join(' > ')
}

/**
 * Get the dominant heading in a chunk of text
 */
function getDominantHeading(text: string, previousHeading: string): string {
  const lines = text.split('\n')
  let lastHeading = previousHeading

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headerMatch) {
      lastHeading = headerMatch[2].trim()
    }
  }

  return lastHeading
}

// ==================== CODE BLOCK DETECTION ====================

/**
 * Check if a position is inside a code block
 */
function isInsideCodeBlock(text: string, position: number): boolean {
  const beforeText = text.substring(0, position)
  const codeBlockCount = (beforeText.match(/```/g) || []).length
  return codeBlockCount % 2 !== 0
}

/**
 * Find a safe split point that doesn't break code blocks or formulas
 */
function findSafeSplitPoint(text: string, targetPosition: number): number {
  const searchRange = 100
  let bestSplit = targetPosition

  // Try paragraph breaks first (double newline)
  for (let offset = 0; offset < searchRange; offset++) {
    for (const dir of [-1, 1]) {
      const pos = targetPosition + offset * dir
      if (pos <= 0 || pos >= text.length) continue

      if (text.substring(pos - 2, pos) === '\n\n' && !isInsideCodeBlock(text, pos)) {
        return pos
      }
    }
  }

  // Try single newline
  for (let offset = 0; offset < searchRange; offset++) {
    for (const dir of [-1, 1]) {
      const pos = targetPosition + offset * dir
      if (pos <= 0 || pos >= text.length) continue

      if (text[pos - 1] === '\n' && !isInsideCodeBlock(text, pos)) {
        return pos
      }
    }
  }

  // Try sentence boundary
  for (let offset = 0; offset < searchRange; offset++) {
    for (const dir of [-1, 1]) {
      const pos = targetPosition + offset * dir
      if (pos <= 0 || pos >= text.length) continue

      if ((text[pos - 1] === '.' || text[pos - 1] === '!' || text[pos - 1] === '?') && !isInsideCodeBlock(text, pos)) {
        return pos
      }
    }
  }

  return bestSplit
}

// ==================== CHUNKING ====================

/**
 * Split text into chunks based on domain-specific strategy
 */
// R24-a (D0): export cho scratch/r24-d0-measure.ts — đo số chunks thật/shard
// bằng đúng bộ chunking pipeline (giữ single-source, không copy sang script).
export function chunkText(text: string, domain: DocumentDomain): ParsedChunk[] {
  const config = DOMAIN_CONFIGS[domain] || DOMAIN_CONFIGS.mixed
  const chunks: ParsedChunk[] = []

  if (!text.trim()) return chunks

  const maxCharSize = config.maxTokens * 4 // ~4 chars per token
  const overlapCharSize = config.overlapTokens * 4

  let position = 0
  let chunkIndex = 0
  let currentHeading = ''

  while (position < text.length) {
    let endPosition = Math.min(position + maxCharSize, text.length)

    // If not at the end, find a safe split point
    if (endPosition < text.length) {
      endPosition = findSafeSplitPoint(text, endPosition)
    }

    const chunkContent = text.substring(position, endPosition).trim()

    if (chunkContent) {
      // Update heading for this chunk
      currentHeading = getDominantHeading(chunkContent, currentHeading)
      const headingPath = extractHeadingPath(chunkContent) || currentHeading

      chunks.push({
        content: chunkContent,
        chunkIndex,
        headingPath: headingPath || currentHeading,
        tokenCount: estimateTokenCount(chunkContent),
        domain,
      })

      chunkIndex++
    }

    // Move position with overlap
    if (endPosition >= text.length) break
    position = Math.max(position + 1, endPosition - overlapCharSize)

    // Prevent infinite loop
    if (position <= 0 && chunkIndex > 0) break
  }

  return chunks
}

// ==================== MAIN PARSE FUNCTION ====================

// Compat shape cho 2 phiên bản pdf-parse:
//   v2: named export class PDFParse (bản đang cài) — không có default export
//   v1: module.exports = hàm pdf(buffer) → { text, numpages, total } (branch fallback)
type PdfParseV1Fn = (buffer: Buffer | Uint8Array) => Promise<{ text?: string; numpages?: number; total?: number }>

type PdfParseCompat = {
  PDFParse?: typeof import('pdf-parse')['PDFParse']
  default?: PdfParseV1Fn
} & PdfParseV1Fn

/**
 * Parse a PDF buffer and return chunks with domain-specific strategy
 */
export async function parsePDF(
  buffer: Buffer,
  domain: DocumentDomain = 'mixed'
): Promise<ParseResult> {
  // pdf-parse v1: default export is a function pdf(buffer)
  // pdf-parse v2: named export PDFParse class — we try both
  let text = ''
  let totalPages = 0

  try {
    // Cast compat (v2 type không khai báo default — branch v1 chỉ chạy khi cài v1)
    const pdfParseModule = (await import('pdf-parse')) as unknown as PdfParseCompat
    if (pdfParseModule.PDFParse) {
      // v2 style: PDFParse class — constructor expects { data: Uint8Array } config object
      const parser = new pdfParseModule.PDFParse({ data: new Uint8Array(buffer) })
      try {
        const textResult = await parser.getText()
        text = textResult.text
        totalPages = textResult.total
      } finally {
        await parser.destroy()
      }
    } else if (typeof pdfParseModule.default === 'function') {
      // v1 style: default export is a function
      const data = await pdfParseModule.default(buffer)
      text = data.text || ''
      totalPages = data.numpages || data.total || 0
    } else if (typeof pdfParseModule === 'function') {
      const data = await pdfParseModule(buffer)
      text = data.text || ''
      totalPages = data.numpages || data.total || 0
    }
  } catch (v2Error) {
    try {
      // Fallback pdf-parse v1 — default export là hàm (v2 không có → sẽ throw → log lỗi bên dưới)
      const pdf = ((await import('pdf-parse')) as unknown as PdfParseCompat).default!
      const data = await pdf(buffer)
      text = data.text || ''
      totalPages = data.numpages || data.total || 0
    } catch (v1Error) {
      console.error('[PDF] All parse methods failed:', v1Error instanceof Error ? v1Error.message : String(v1Error))
    }
  }

  if (!text || text.trim().length === 0) {
    return {
      chunks: [],
      totalPages,
      totalTokens: 0,
    }
  }

  // Pre-process text: clean up common PDF artifacts
  const cleanedText = text
    .replace(/\f/g, '\n\n')       // Form feed → paragraph break
    .replace(/\r\n/g, '\n')        // Normalize line endings
    .replace(/\r/g, '\n')          // Handle old Mac line endings
    .replace(/\n{3,}/g, '\n\n')    // Reduce multiple blank lines
    .replace(/\t+/g, '  ')         // Tabs → spaces
    .replace(/  +/g, ' ')          // Multiple spaces → single
    .trim()

  // Chunk the text
  const chunks = chunkText(cleanedText, domain)

  // Calculate total tokens
  const totalTokens = chunks.reduce((sum, c) => sum + c.tokenCount, 0)

  return {
    chunks,
    totalPages,
    totalTokens,
  }
}

/**
 * Get chunk config for a domain
 */
export function getChunkConfig(domain: DocumentDomain): ChunkConfig {
  return DOMAIN_CONFIGS[domain] || DOMAIN_CONFIGS.mixed
}
