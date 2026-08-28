/**
 * NVIDIA Riva ASR — gRPC client qua NVIDIA Cloud Functions (NVCF)
 * =========================================================================
 * (user request 2026-08-28: Live voice KHÔNG dùng z-ai SDK — chạy được local)
 *
 * Engine: parakeet-ctc-0.6b-vi (Vietnamese-English ASR, streaming,
 * punctuation + word timestamps) — model Việt chuyên dụng trên NIM hosted.
 * Lưu ý quan trọng (verified 2026-08-28):
 *   - build.nvidia.com hosts "nemotron-asr-streaming" nhưng CHỈ TIẾNG ANH.
 *     Bản Nemotron 3.5 ASR đa ngôn ngữ (40 locale, gồm vi-VN) chỉ có trong
 *     NGC container (self-hosted) — không có endpoint hosted.
 *   - Model ASR hosted hỗ trợ TIẾNG VIỆT: parakeet-ctc-0.6b-vi
 *     (function-id f3dff2bb-99f9-403d-a5f1-f574a757deb0).
 *   - Endpoint hosted chỉ hỗ trợ StreamingRecognize (offline Recognize trả
 *     INVALID_ARGUMENT) — module này dùng streaming cho cả utterance chốt.
 *
 * API không đổi với frontend: nhận WAV (16kHz mono, ≤ ~30s) → trả text.
 * Xác thực: Bearer NVIDIA_API_KEY_1..4 (xoay vòng, cùng pool key với LLM).
 *
 * Proto: nhúng sẵn dạng JSON (riva-asr-protos.json, sinh từ riva-proto
 * "nvidia-riva/common") — không cần đọc file .proto lúc runtime.
 */

import { Buffer } from 'node:buffer'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

// ============================== Cấu hình ==============================

/** NVCF function-id của model parakeet-ctc-0.6b-vi (Vietnamese-English ASR) */
const RIVA_ASR_FUNCTION_ID = 'f3dff2bb-99f9-403d-a5f1-f574a757deb0'

/** NVCF gRPC endpoint (cùng hệ với integrate.api.nvidia.com, cùng API key) */
const NVCF_GRPC_ENDPOINT = 'grpc.nvcf.nvidia.com:443'

/** Ngôn ngữ nhận diện — BCP-47 */
const RIVA_LANGUAGE_CODE = 'vi-VN'

/** Timeout toàn bộ 1 lần nhận diện (ms) */
const RIVA_TIMEOUT_MS = 30_000

/** Kích thước chunk khi đẩy audio vào stream (~200ms @16kHz mono 16-bit) */
const CHUNK_BYTES = 6400

/** Số key NVIDIA xoay vòng */
const KEYS = [
  process.env.NVIDIA_API_KEY_1 || '',
  process.env.NVIDIA_API_KEY_2 || '',
  process.env.NVIDIA_API_KEY_3 || '',
  process.env.NVIDIA_API_KEY_4 || '',
].filter(Boolean)

// ============================== Singleton client ==============================

let clientPromise: Promise<any> | null = null
let keyIndex = 0

function nextKeyIndex(): number {
  keyIndex = (keyIndex + 1) % Math.max(KEYS.length, 1)
  return keyIndex
}

/** Load package definition từ JSON nhúng (1 lần) */
let pkgDefCache: any = null
function loadPackageDef(): any {
  if (pkgDefCache) return pkgDefCache
  const jsonPath = path.join(process.cwd(), 'src', 'lib', 'riva', 'riva-asr-protos.json')
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  pkgDefCache = protoLoader.fromJSON(json, {
    keepCase: false,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  })
  return pkgDefCache
}

/** Tạo (1 lần) gRPC client tới NVCF */
function getClient(): Promise<any> {
  if (!clientPromise) {
    clientPromise = new Promise((resolve, reject) => {
      try {
        // Package definition động từ JSON — không có type tĩnh
        const proto = grpc.loadPackageDefinition(loadPackageDef()) as any
        const Ctor = proto.nvidia.riva.asr.RivaSpeechRecognition as any
        const client = new Ctor(NVCF_GRPC_ENDPOINT, grpc.credentials.createSsl(), {
          'grpc.keepalive_time_ms': 10_000,
          'grpc.max_send_message_length': 8 * 1024 * 1024,
          'grpc.max_receive_message_length': 8 * 1024 * 1024,
        })
        resolve(client)
      } catch (e) {
        reject(e)
      }
    })
  }
  return clientPromise
}

// ============================== WAV parsing ==============================

export interface ParsedWav {
  pcm: Buffer
  sampleRate: number
  channels: number
  bitsPerSample: number
}

/** Parse header WAV PCM → PCM thô + thông tin (hỗ trợ chunk mở rộng) */
export function parseWav(buf: Buffer): ParsedWav {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('File không phải WAV hợp lệ')
  }
  let off = 12
  let sampleRate = 16000
  let channels = 1
  let bitsPerSample = 16
  let format = 1
  let pcm: Buffer | null = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      format = buf.readUInt16LE(off + 8)
      channels = buf.readUInt16LE(off + 10)
      sampleRate = buf.readUInt32LE(off + 12)
      bitsPerSample = buf.readUInt16LE(off + 22)
    } else if (id === 'data') {
      pcm = buf.subarray(off + 8, off + 8 + size)
      break
    }
    off += 8 + size + (size % 2)
  }
  if (!pcm) throw new Error('WAV thiếu chunk data')
  if (format !== 1) throw new Error('WAV phải là PCM (không nén)')
  if (bitsPerSample !== 16) throw new Error('WAV phải 16-bit')
  if (channels !== 1) throw new Error('WAV phải mono')
  return { pcm, sampleRate, channels, bitsPerSample }
}

// ============================== Streaming Recognize ==============================

/**
 * Nhận diện 1 utterance qua StreamingRecognize (endpoint hosted của
 * parakeet không hỗ trợ offline Recognize). Đẩy toàn bộ audio nhanh
 * (không cần pacing real-time), gom kết quả final, trả text.
 */
async function streamingRecognizeOnce(
  client: any,
  apiKey: string,
  pcm: Buffer,
  sampleRate: number,
  signal?: AbortSignal,
): Promise<string> {
  const meta = new grpc.Metadata()
  meta.set('function-id', RIVA_ASR_FUNCTION_ID)
  meta.set('authorization', `Bearer ${apiKey}`)

  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const timer = setTimeout(() => {
      try { stream.destroy(new Error(`Riva ASR timeout ${RIVA_TIMEOUT_MS}ms`)) } catch { /* ignore */ }
      reject(new Error(`Riva ASR timeout sau ${RIVA_TIMEOUT_MS / 1000}s`))
    }, RIVA_TIMEOUT_MS)

    const stream = client.streamingRecognize(meta)
    const finals: string[] = []
    let ended = false

    const cleanup = () => clearTimeout(timer)

    stream.on('data', (resp: any) => {
      for (const r of resp?.results || []) {
        const alt = (r.alternatives || [])[0]
        if (alt?.transcript && r.isFinal) finals.push(String(alt.transcript).trim())
      }
    })
    stream.on('error', (err: any) => {
      if (ended) return
      ended = true
      cleanup()
      reject(err)
    })
    stream.on('end', () => {
      if (ended) return
      ended = true
      cleanup()
      resolve(finals.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim())
    })
    stream.on('status', (status: any) => {
      // status OK khi end bình thường
      if (status?.code !== grpc.status.OK && !ended) {
        ended = true
        cleanup()
        reject(new Error(`Riva gRPC ${status?.code}: ${status?.details || 'lỗi không rõ'}`))
      }
    })

    const onAbort = () => {
      try { stream.destroy() } catch { /* ignore */ }
      if (!ended) {
        ended = true
        cleanup()
        reject(new Error('aborted'))
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      stream.write({
        streamingConfig: {
          config: {
            encoding: 'LINEAR_PCM',
            sampleRateHertz: sampleRate,
            languageCode: RIVA_LANGUAGE_CODE,
            maxAlternatives: 1,
            enableAutomaticPunctuation: true,
          },
          interimResults: false,
        },
      })
      for (let i = 0; i < pcm.length; i += CHUNK_BYTES) {
        stream.write({ audioContent: pcm.subarray(i, Math.min(i + CHUNK_BYTES, pcm.length)) })
      }
      stream.end()
    } catch (e) {
      if (!ended) {
        ended = true
        cleanup()
        reject(e as Error)
      }
    }
  })
}

/** Lỗi đáng để xoay key (auth / rate limit / tạm thời server-side) */
function shouldRotateKey(err: any): boolean {
  const code = Number(err?.code)
  return (
    code === grpc.status.UNAUTHENTICATED ||
    code === grpc.status.PERMISSION_DENIED ||
    code === grpc.status.RESOURCE_EXHAUSTED ||
    code === grpc.status.UNAVAILABLE ||
    code === grpc.status.INTERNAL ||
    code === grpc.status.DEADLINE_EXCEEDED
  )
}

// ============================== Public API ==============================

export interface TranscribeResult {
  text: string
  keyIndex: number
  durationMs: number
}

/**
 * Nhận diện tiếng Việt từ WAV PCM 16-bit mono.
 * Xoay vòng key NVIDIA; thử tối đa `maxKeys` key khác nhau khi gặp lỗi.
 */
export async function transcribeVietnameseWav(
  wav: Buffer,
  opts: { signal?: AbortSignal; maxKeys?: number } = {},
): Promise<TranscribeResult> {
  if (KEYS.length === 0) {
    throw new Error('Chưa cấu hình NVIDIA_API_KEY_1..4 cho Riva ASR')
  }
  const { pcm, sampleRate } = parseWav(wav)
  if (pcm.length < sampleRate * 2 * 0.1) {
    return { text: '', keyIndex: -1, durationMs: 0 } // < 0.1s — bỏ qua
  }
  const client = await getClient()
  const maxKeys = Math.min(opts.maxKeys ?? Math.min(KEYS.length, 3), KEYS.length)

  const t0 = Date.now()
  let firstIdx = keyIndex
  let lastErr: unknown = null
  for (let attempt = 0; attempt < maxKeys; attempt++) {
    const idx = (firstIdx + attempt) % KEYS.length
    try {
      const text = await streamingRecognizeOnce(client, KEYS[idx], pcm, sampleRate, opts.signal)
      nextKeyIndex() // lần sau dùng key kế tiếp (cân bằng tải)
      return { text, keyIndex: idx, durationMs: Date.now() - t0 }
    } catch (err: any) {
      // Abort từ client — không thử lại
      if (err?.message === 'aborted' || opts.signal?.aborted) throw err
      lastErr = err
      console.error(`[Riva ASR] key#${idx + 1} lỗi (code=${err?.code}): ${err?.message || err}`)
      if (!shouldRotateKey(err)) break
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
