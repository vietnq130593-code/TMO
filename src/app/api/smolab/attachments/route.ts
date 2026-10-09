/**
 * Smolab Chat Attachments API (r73 — user request: nút "+" tải tệp cho agents)
 *
 * POST   /api/smolab/attachments           — upload 1 tệp (multipart formData
 *        field "file", tùy chọn "sessionId") → lưu file + chưng cất derivedText:
 *          - image → VLM mô tả nội dung (tiếng Việt, trích văn bản trong ảnh)
 *          - audio → ASR transcript toàn bộ lời nói
 *          - video → video-understand tóm tắt nội dung
 *          - text  → đọc thẳng UTF-8 (code/md/json/csv...)
 *          - pdf   → pdf-parse trích văn bản
 *          - docx  → mammoth trích văn bản
 *        Agent nhận nội dung qua manifest trong message (frontend ghép) +
 *        filePath để tool read_file/shell đọc bản gốc khi cần.
 * GET    /api/smolab/attachments?sessionId= — danh sách tệp của phiên
 * DELETE /api/smolab/attachments?id=         — xóa tệp (row + file trên đĩa)
 *
 * Hardcode limits (không dạy bằng prompt — chặn ở tầng route):
 *   - SMOLAB_UPLOAD_MAX_MB (default 30MB) — vượt → 413
 *   - Tên tệp sanitize: strip path traversal, giới hạn 120 ký tự
 *   - Đuôi file từ whitelist map (không tin MIME client một mình)
 */

import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import crypto from 'crypto'
import { db } from '@/lib/db'
import {
  classifySmolabAttachment,
  sanitizeSmolabAttachmentName,
  capSmolabAttachmentText,
} from '@/lib/smolab-attachments'

export const dynamic = 'force-dynamic'

const UPLOAD_DIR = process.env.SMOLAB_UPLOAD_DIR || '/tmp/theopus-smolab-uploads'
const MAX_BYTES = Math.max(1, parseInt(process.env.SMOLAB_UPLOAD_MAX_MB || '30', 10) || 30) * 1024 * 1024

// ==== Phân loại/sanitize — đã tách sang src/lib/smolab-attachments.ts (r73)
// để unit-test trực tiếp (route file Next.js không cho export tùy tiện) ====

// ==== z-ai SDK — singleton (config /etc/.z-ai-config do ZAI.create() tự đọc) ====
let zaiPromise: Promise<any> | null = null
async function getZai(): Promise<any> {
  if (!zaiPromise) {
    zaiPromise = (async () => {
      const mod = await import('z-ai-web-dev-sdk')
      const ZAI = (mod as any).default
      return ZAI.create()
    })()
  }
  return zaiPromise
}

async function describeImage(base64: string, mime: string): Promise<string | null> {
  try {
    const zai = await getZai()
    const res = await zai.chat.completions.createVision({
      model: 'glm-4.5v',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Mô tả chi tiết nội dung ảnh này bằng tiếng Việt: đối tượng chính, bối cảnh, mọi đoạn văn bản có trong ảnh (trích nguyên văn), biểu đồ/bảng biểu kèm số liệu nếu có. Viết thành đoạn văn ngắn gọn đầy đủ.',
          },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
        ],
      }],
    })
    const text = res?.choices?.[0]?.message?.content
    return typeof text === 'string' && text.trim() ? text : null
  } catch (err) {
    console.warn('[Smolab Attachments] VLM mô tả ảnh thất bại (tệp vẫn dùng được qua filePath):', err instanceof Error ? err.message : String(err))
    return null
  }
}

async function transcribeAudio(base64: string): Promise<string | null> {
  try {
    const zai = await getZai()
    const res = await zai.audio.asr.create({ file_base64: base64 })
    const text = res?.text ?? res?.content ?? res?.result
    if (typeof text === 'string' && text.trim()) return text
    // Shape lạ — stringify thu gọn thay vì mất trắng
    if (res && typeof res === 'object') return JSON.stringify(res).slice(0, 4000)
    return null
  } catch (err) {
    console.warn('[Smolab Attachments] ASR transcription thất bại (tệp vẫn dùng được qua filePath):', err instanceof Error ? err.message : String(err))
    return null
  }
}

async function describeVideo(base64: string, mime: string): Promise<string | null> {
  try {
    const zai = await getZai()
    const res = await zai.chat.completions.createVision({
      model: 'glm-4.5v',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Tóm tắt nội dung video này bằng tiếng Việt: bối cảnh, các cảnh chính theo trình tự, lời thoại/khẩu tự nếu có, thông tin đáng chú ý. Viết thành đoạn văn ngắn gọn.',
          },
          { type: 'video_url', video_url: { url: `data:${mime};base64,${base64}` } },
        ],
      }],
    })
    const text = res?.choices?.[0]?.message?.content
    return typeof text === 'string' && text.trim() ? text : null
  } catch (err) {
    console.warn('[Smolab Attachments] Video-understand thất bại (tệp vẫn dùng được qua filePath):', err instanceof Error ? err.message : String(err))
    return null
  }
}

async function extractTextFile(buf: Buffer): Promise<string | null> {
  const text = buf.toString('utf-8')
  return capSmolabAttachmentText(text, 40_000)
}

async function extractPdf(buf: Buffer): Promise<string | null> {
  try {
    const mod = await import('pdf-parse')
    const pdfParse = (mod as any).default ?? mod
    const res = await pdfParse(buf)
    return capSmolabAttachmentText(typeof res?.text === 'string' ? res.text : null, 40_000)
  } catch (err) {
    console.warn('[Smolab Attachments] pdf-parse thất bại:', err instanceof Error ? err.message : String(err))
    return null
  }
}

async function extractDocx(buf: Buffer): Promise<string | null> {
  try {
    const mammoth = await import('mammoth')
    const res = await (mammoth as any).extractRawText({ buffer: buf })
    return capSmolabAttachmentText(typeof res?.value === 'string' ? res.value : null, 40_000)
  } catch (err) {
    console.warn('[Smolab Attachments] mammoth trích docx thất bại:', err instanceof Error ? err.message : String(err))
    return null
  }
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const file = formData.get('file')
    const sessionIdRaw = formData.get('sessionId')
    const sessionId = typeof sessionIdRaw === 'string' && sessionIdRaw.trim() ? sessionIdRaw.trim().slice(0, 120) : null

    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'Thiếu tệp (formData field "file")' }, { status: 400 })
    }

    const sizeBytes = file.size
    if (sizeBytes <= 0) {
      return NextResponse.json({ error: 'Tệp rỗng' }, { status: 400 })
    }
    if (sizeBytes > MAX_BYTES) {
      return NextResponse.json(
        { error: `Tệp ${sizeBytes} byte vượt giới hạn ${MAX_BYTES} byte (${Math.floor(MAX_BYTES / 1024 / 1024)}MB)` },
        { status: 413 },
      )
    }

    const fileName = sanitizeSmolabAttachmentName(file.name)
    const { kind, ext, mime } = classifySmolabAttachment(fileName, file.type || '')
    const buf = Buffer.from(await file.arrayBuffer())

    // Lưu file — tên cuid chống trùng/path-traversal
    await fs.mkdir(UPLOAD_DIR, { recursive: true })
    const storedName = `${crypto.randomUUID()}${ext ? `.${ext}` : ''}`
    const filePath = path.join(UPLOAD_DIR, storedName)
    await fs.writeFile(filePath, buf)

    // Chưng cất derivedText theo loại (fail-open: lỗi chưng cất KHÔNG làm upload
    // thất bại — agent vẫn đọc được bản gốc qua filePath bằng tool)
    let derivedText: string | null = null
    if (kind === 'image') derivedText = capSmolabAttachmentText(await describeImage(buf.toString('base64'), mime), 4_000)
    else if (kind === 'audio') derivedText = capSmolabAttachmentText(await transcribeAudio(buf.toString('base64')), 20_000)
    else if (kind === 'video') derivedText = capSmolabAttachmentText(await describeVideo(buf.toString('base64'), mime), 4_000)
    else if (kind === 'text') derivedText = await extractTextFile(buf)
    else if (kind === 'pdf') derivedText = await extractPdf(buf)
    else if (kind === 'docx') derivedText = await extractDocx(buf)

    const row = await db.chatAttachment.create({
      data: {
        sessionId,
        fileName,
        mimeType: mime,
        kind,
        sizeBytes,
        filePath,
        derivedText,
        status: 'ready',
      },
    })

    return NextResponse.json({
      attachment: {
        id: row.id,
        fileName: row.fileName,
        mimeType: row.mimeType,
        kind: row.kind,
        sizeBytes: row.sizeBytes,
        filePath: row.filePath,
        derivedText: row.derivedText,
        status: row.status,
      },
    })
  } catch (err) {
    console.error('[Smolab Attachments] POST thất bại:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Lỗi nội bộ khi tải tệp lên' },
      { status: 500 },
    )
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const sessionId = searchParams.get('sessionId')
    if (!sessionId) {
      return NextResponse.json({ error: 'Thiếu sessionId' }, { status: 400 })
    }
    const rows = await db.chatAttachment.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, fileName: true, mimeType: true, kind: true, sizeBytes: true,
        derivedText: true, status: true, messageId: true, createdAt: true,
      },
    })
    return NextResponse.json({ attachments: rows })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Lỗi nội bộ' },
      { status: 500 },
    )
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) {
      return NextResponse.json({ error: 'Thiếu id' }, { status: 400 })
    }
    const row = await db.chatAttachment.findUnique({ where: { id } })
    if (!row) {
      return NextResponse.json({ error: 'Không tìm thấy tệp' }, { status: 404 })
    }
    await db.chatAttachment.delete({ where: { id } })
    try {
      await fs.unlink(row.filePath)
    } catch {
      // File đã bị dọn sẵn / mất — không sao
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Lỗi nội bộ' },
      { status: 500 },
    )
  }
}
