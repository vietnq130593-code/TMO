/**
 * LIVE VOICE — ASR (Speech-to-Text) cho nút Live cạnh nút Gửi
 * (user request 2026-08-28: nói tiếng Việt → văn bản trong khung nhập tin nhắn)
 *
 * POST /api/voice/asr
 *   Body:    { audio: string } — audio WAV 16kHz mono, base64 (≤ ~30 giây)
 *   Trả về:  { text: string }  — văn bản tiếng Việt đã nhận diện
 *
 * Engine (user request 2026-08-28 — KHÔNG dùng z-ai SDK để chạy được local):
 *   NVIDIA Riva ASR — model "parakeet-ctc-0.6b-vi" (Vietnamese-English,
 *   streaming, có dấu câu) qua gRPC NVCF (grpc.nvcf.nvidia.com:443).
 *   Lý do không phải "nemotron-3.5-asr": bản hosted của NVIDIA chỉ có
 *   tiếng Anh; model ASR hosted hỗ trợ tiếng Việt là parakeet-ctc-0.6b-vi.
 *   Xác thực bằng cùng pool key NVIDIA_API_KEY_1..4 (xoay vòng).
 *
 * Chi tiết triển khai: src/lib/riva/asr.ts
 */

import { NextRequest, NextResponse } from 'next/server'
import { transcribeVietnameseWav } from '@/lib/riva/asr'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    const audio = body?.audio

    if (!audio || typeof audio !== 'string' || audio.length < 100) {
      return NextResponse.json(
        { error: 'Thiếu dữ liệu audio (base64)' },
        { status: 400 },
      )
    }

    // Giới hạn ~15MB base64 (≈ 11MB audio ≈ nhiều hơn 30s WAV 16kHz mono).
    // Client đã tự tách câu nói ≤ 28s.
    if (audio.length > 15 * 1024 * 1024) {
      return NextResponse.json(
        { error: 'Audio quá lớn (giới hạn ~30 giây)' },
        { status: 413 },
      )
    }

    const wav = Buffer.from(audio, 'base64')
    const { text, durationMs } = await transcribeVietnameseWav(wav)

    console.log(`[Voice ASR] Riva parakeet-vi OK ${durationMs}ms: "${text.substring(0, 120)}"`)
    return NextResponse.json({ text })
  } catch (err: any) {
    console.error('[Voice ASR] Lỗi nhận diện:', err?.message || err)
    const msg = err instanceof Error ? err.message : 'Lỗi ASR không xác định'
    return NextResponse.json(
      { error: `Lỗi nhận diện (NVIDIA Riva): ${msg}` },
      { status: 500 },
    )
  }
}
