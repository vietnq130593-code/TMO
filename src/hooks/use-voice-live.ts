'use client'

/**
 * LIVE VOICE — Engine cho nút Live cạnh nút Gửi (user request 2026-08-28)
 * ==========================================================================
 *
 * Luồng hoạt động (vòng lặp đàm thoại tiếng Việt):
 *
 *  1. Bấm nút Live  → bật micro, trạng thái "ĐANG NGHE".
 *  2. Nói tiếng Việt → VAD (phát hiện giọng nói bằng năng lượng RMS) tách
 *     từng "câu nói" (utterance): mỗi câu kết thúc khi NGỪNG NÓI ≥ 1 giây.
 *  3. Mỗi câu nói → POST /api/voice/asr → văn bản → nối vào khung nhập tin nhắn.
 *  4. TỰ ĐỘNG GỬI khi thỏa CẢ HAI điều kiện:
 *       (1) đã ngừng nói ≥ 1 giây (điểm kết thúc câu nói trước đó), VÀ
 *       (2) câu nói TIẾP THEO là đúng 2 chữ "xin hết" (so khớp bỏ dấu,
 *           bỏ dấu câu, không phân biệt hoa thường).
 *     → Gửi toàn bộ nội dung TRƯỚC "xin hết"; bản thân "xin hết" KHÔNG gửi.
 *     → Chỉ thỏa 1 trong 2 điều kiện → KHÔNG gửi (tiếp tục nối chữ).
 *  5. Agent trả lời → đọc thành giọng nói TỪNG CÂU (speechSynthesis vi-VN,
 *     "đến đâu phát đến đấy"). Trong lúc agent trả lời + đang đọc thì TẮT
 *     mic (tránh mic thu lại tiếng TTS của agent).
 *  6. Đọc xong → mở lại mic → vòng lặp tiếp tục.
 *  7. Bấm nút Live lần nữa → tắt hẳn (dừng mic, hủy TTS, bỏ request chờ).
 *
 * Thiết kế:
 *  - ASR: server-side NVIDIA Riva — model parakeet-ctc-0.6b-vi (Việt-Anh,
 *    có dấu câu) qua gRPC NVCF, dùng pool key NVIDIA_API_KEY_1..4 — KHÔNG
 *    dùng z-ai SDK (user request 2026-08-28: phải chạy được trên local).
 *    Gửi WAV 16kHz mono base64, ≤ 28s mỗi câu nói.
 *  - TTS: giọng đọc tiếng Việt của TRÌNH DUYỆT (speechSynthesis vi-VN —
 *    Chrome/Edge trên Windows có sẵn; miễn phí, tức thì, không tốn quota,
 *    chạy được local). z-ai TTS chỉ có giọng Trung → không đọc được tiếng
 *    Việt (đã test).
 *  - So khớp lệnh "xin hết" có dung sai ASR (bỏ dấu, bỏ dấu câu, sai 1 ký
 *    tự — vd ASR nghe "xin kết" vẫn tính) — tăng độ tin cậy tự gửi.
 *  - Toàn bộ engine gói trong 1 controller (plain object) tạo 1 lần —
 *    tránh ref write trong render & stale closure; React state chỉ giữ
 *    trạng thái hiển thị (isLive/status/error).
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export type VoiceLiveStatus =
  | 'off'
  | 'starting'
  | 'listening'
  | 'transcribing'
  | 'sending'
  | 'speaking'
  | 'error'

export interface UseVoiceLiveOptions {
  /** Nối thêm 1 đoạn văn bản đã nhận diện vào khung nhập tin nhắn */
  onTranscriptAppend?: (text: string) => void
  /**
   * Tự động gửi nội dung khung nhập (đã thỏa 2 điều kiện "xin hết").
   * Trả về nội dung câu trả lời của agent để đọc thành tiếng — hoặc
   * null/undefined nếu không có gì để đọc.
   */
  onAutoSend?: () => Promise<string | null | undefined>
  /** Thời gian ngừng nói (ms) để kết thúc 1 câu nói — mặc định 1000ms */
  pauseSilenceMs?: number
  /** Các cụm từ lệnh kết thúc (mặc định: 'xin hết') */
  commandPhrases?: string[]
}

// ============================== Tiện ích thuần ==============================

/** RMS energy của 1 frame audio */
function frameRms(data: Float32Array): number {
  let sum = 0
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
  return Math.sqrt(sum / data.length)
}

/** Chuẩn hóa để so khớp lệnh "xin hết" (export để test) */
export function normalizeForCommand(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Khoảng cách Levenshtein ≤ 1 giữa 2 từ ngắn (dung sai lỗi ASR 1 ký tự) */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  if (long.length - short.length > 1) return false
  let i = 0, j = 0, diffs = 0
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i++; j++; continue }
    if (++diffs > 1) return false
    if (short.length === long.length) { i++; j++ } // substitution
    else j++ // insertion vào long
  }
  diffs += long.length - j + short.length - i
  return diffs <= 1
}

/**
 * Có phải câu nói là lệnh kết thúc (mặc định "xin hết")?
 * Dung sai ASR: đúng số từ, từ đầu phải khớp chính xác (vd "xin"), từ cuối
 * cho phép sai 1 ký tự ("het"~"ket"/"heb"…) — tăng độ tin cậy tự gửi.
 */
export function isEndCommand(transcript: string, commandPhrases: string[] = ['xin hết']): boolean {
  const norm = normalizeForCommand(transcript)
  if (!norm) return false
  const words = norm.split(' ')
  for (const phrase of commandPhrases) {
    const pw = normalizeForCommand(phrase).split(' ').filter(Boolean)
    if (pw.length === 0) continue
    if (pw.length !== words.length) continue
    // Từ đầu tiên phải chính xác; các từ còn lại dung sai 1 ký tự
    const firstOk = words[0] === pw[0]
    if (!firstOk) continue
    const restOk = pw.slice(1).every((target, k) => withinOneEdit(words[k + 1], target))
    if (restOk) return true
  }
  return false
}

/** Dọn chữ để đọc thành tiếng (bỏ code block, markdown, link…) (export để test) */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' liên kết ')
    .replace(/[#*_~>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Tách câu để đọc TTS từng câu một (chunk ≤ maxLen ký tự) (export để test) */
export function splitSentences(text: string, maxLen = 220): string[] {
  const raw = text.split(/(?<=[.!?…:;])\s+/).filter(Boolean)
  const out: string[] = []
  let cur = ''
  for (const s of raw) {
    if ((cur + ' ' + s).trim().length <= maxLen) {
      cur = cur ? `${cur} ${s}` : s
    } else {
      if (cur) out.push(cur)
      if (s.length <= maxLen) {
        cur = s
      } else {
        // Câu quá dài → cắt tại dấu phẩy / khoảng trắng
        let rest = s
        while (rest.length > maxLen) {
          let cut = rest.lastIndexOf(',', maxLen)
          if (cut < maxLen * 0.5) cut = rest.lastIndexOf(' ', maxLen)
          if (cut < maxLen * 0.5) cut = maxLen
          out.push(rest.slice(0, cut + 1).trim())
          rest = rest.slice(cut + 1)
        }
        cur = rest
      }
    }
  }
  if (cur) out.push(cur)
  return out.filter(s => s.trim().length > 0)
}

/**
 * Float32 frames (sampleRate) → WAV 16kHz mono → Blob.
 * Downsample bằng trung bình khối (chống aliasing thô — đủ tốt cho ASR).
 */
export function encodeWav16k(frames: Float32Array[], inputRate: number): Blob {
  let total = 0
  for (const f of frames) total += f.length
  const merged = new Float32Array(total)
  let off = 0
  for (const f of frames) {
    merged.set(f, off)
    off += f.length
  }

  const outRate = 16000
  const ratio = inputRate / outRate
  let samples: Float32Array
  if (ratio > 1.01 && merged.length > ratio) {
    const outLen = Math.floor(merged.length / ratio)
    samples = new Float32Array(outLen)
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio)
      const end = Math.min(Math.floor((i + 1) * ratio), merged.length)
      let sum = 0
      for (let j = start; j < end; j++) sum += merged[j]
      samples[i] = end > start ? sum / (end - start) : 0
    }
  } else {
    samples = merged
  }

  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }

  const buf = new ArrayBuffer(44 + pcm.length * 2)
  const v = new DataView(buf)
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  w(0, 'RIFF')
  v.setUint32(4, 36 + pcm.length * 2, true)
  w(8, 'WAVE')
  w(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, outRate, true)
  v.setUint32(28, outRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  w(36, 'data')
  v.setUint32(40, pcm.length * 2, true)
  new Int16Array(buf, 44).set(pcm)
  return new Blob([buf], { type: 'audio/wav' })
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result || '')
      resolve(s.slice(s.indexOf(',') + 1))
    }
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

// ============================== Engine (controller) ==============================

interface VoiceEngineState {
  stream: MediaStream
  ctx: AudioContext
  source: MediaStreamAudioSourceNode
  processor: ScriptProcessorNode
  sink: GainNode
  noiseFloor: number
  consecutiveSpeech: number
  inUtterance: boolean
  utteranceFrames: Float32Array[]
  utteranceMs: number
  speechFrames: number
  silenceMs: number
  preRoll: Float32Array[]
  paused: boolean
  stopped: boolean
}

const FRAME_SIZE = 4096
const PRE_ROLL_FRAMES = 4        // ~370ms @ 44.1kHz
const MIN_SPEECH_FRAMES = 2      // bỏ qua tạp âm ngắn
const MAX_UTTERANCE_MS = 28000   // engine ASR giới hạn 30s

interface ControllerReactApi {
  setStatus: (s: VoiceLiveStatus) => void
  setError: (e: string | null) => void
  setTtsVoiceMissing: (b: boolean) => void
  getCallbacks: () => UseVoiceLiveOptions
}

function createVoiceController(react: ControllerReactApi) {
  let engine: VoiceEngineState | null = null
  let queue: Promise<void> = Promise.resolve()
  let asrAbort: AbortController | null = null
  let speakAborted = false

  // ---------------- TTS (speechSynthesis vi-VN) ----------------

  function pickViVoice(): SpeechSynthesisVoice | null {
    if (typeof window === 'undefined' || !window.speechSynthesis) return null
    const voices = window.speechSynthesis.getVoices()
    return voices.find(v => v.lang?.toLowerCase().startsWith('vi')) || null
  }

  function speakChunk(text: string, voice: SpeechSynthesisVoice | null): Promise<void> {
    return new Promise(resolve => {
      if (typeof window === 'undefined' || !window.speechSynthesis) {
        resolve()
        return
      }
      const synth = window.speechSynthesis
      const u = new SpeechSynthesisUtterance(text)
      if (voice) u.voice = voice
      u.lang = voice?.lang || 'vi-VN'
      u.rate = 1.05
      u.pitch = 1
      let done = false
      const finish = () => {
        if (!done) {
          done = true
          clearTimeout(timer)
          resolve()
        }
      }
      // Một số trình duyệt thỉnh thoảng không fire onend — timeout bảo hiểm
      const timer = setTimeout(finish, 15000 + text.length * 150)
      u.onend = finish
      u.onerror = finish
      synth.speak(u)
    })
  }

  /** Đọc cả đoạn văn bản từng câu một; resolve khi đọc xong hoặc bị hủy */
  async function speakAll(text: string): Promise<void> {
    const cleaned = cleanForSpeech(text)
    if (!cleaned) return
    const chunks = splitSentences(cleaned)
    const voice = pickViVoice()
    if (!voice) react.setTtsVoiceMissing(true)
    for (const chunk of chunks) {
      if (speakAborted) return
      await speakChunk(chunk, voice)
    }
  }

  // ---------------- Xử lý 1 câu nói (ASR + lệnh) ----------------

  async function processUtterance(blob: Blob): Promise<void> {
    if (!engine || engine.stopped) return

    react.setStatus('transcribing')
    let transcript = ''
    try {
      const audio = await blobToBase64(blob)
      asrAbort?.abort()
      const ac = new AbortController()
      asrAbort = ac
      const res = await fetch('/api/voice/asr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio }),
        signal: ac.signal,
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j?.error || `HTTP ${res.status}`)
      }
      const data = await res.json()
      transcript = String(data?.text || '').trim()
    } catch (e: unknown) {
      const err = e as { name?: string; message?: string }
      if (err?.name === 'AbortError') return
      console.error('[Live Voice] ASR lỗi:', err?.message || err)
      react.setError(err?.message ? `Lỗi nhận diện: ${err.message}` : 'Lỗi nhận diện giọng nói')
      react.setStatus('listening')
      return
    }

    if (!engine || engine.stopped || engine.paused) return

    if (!transcript) {
      react.setStatus('listening')
      return
    }

    // So khớp lệnh "xin hết" (câu này theo sau điểm ngừng nói ≥1s — do VAD).
    // Dùng matcher dung sai (isEndCommand) — ASR có thể nghe nhầm 1 ký tự.
    const commands = react.getCallbacks().commandPhrases || ['xin hết']
    const isCommand = isEndCommand(transcript, commands)

    if (isCommand) {
      // Thỏa CẢ HAI điều kiện → tự động gửi nội dung TRƯỚC "xin hết"
      react.setStatus('sending')
      engine.paused = true // tắt mic trong lúc agent trả lời + đọc
      queue = Promise.resolve() // bỏ các câu nói đang chờ sau lệnh
      try {
        const reply = await react.getCallbacks().onAutoSend?.()
        if (!engine || engine.stopped) return
        if (reply && String(reply).trim()) {
          react.setStatus('speaking')
          speakAborted = false
          await speakAll(String(reply))
        }
      } catch (e) {
        console.error('[Live Voice] Gửi/đọc lỗi:', e)
      } finally {
        if (engine && !engine.stopped) {
          engine.paused = false
          resetVad(engine)
        }
        react.setStatus('listening')
      }
    } else {
      // Chưa phải lệnh → nối chữ vào khung nhập, tiếp tục nghe
      react.setError(null)
      react.getCallbacks().onTranscriptAppend?.(transcript)
      react.setStatus('listening')
    }
  }

  function resetVad(eng: VoiceEngineState) {
    eng.inUtterance = false
    eng.utteranceFrames = []
    eng.utteranceMs = 0
    eng.speechFrames = 0
    eng.silenceMs = 0
    eng.consecutiveSpeech = 0
    eng.preRoll = []
  }

  function finalizeUtterance() {
    if (!engine) return
    const frames = engine.utteranceFrames
    const speechFrames = engine.speechFrames
    // Reset VAD để nghe câu tiếp theo ngay
    engine.inUtterance = false
    engine.utteranceFrames = []
    engine.utteranceMs = 0
    engine.speechFrames = 0
    engine.silenceMs = 0
    engine.consecutiveSpeech = 0

    if (speechFrames < MIN_SPEECH_FRAMES || frames.length === 0) return // tạp âm

    const rate = engine.ctx.sampleRate
    const blob = encodeWav16k(frames, rate)
    // Xếp hàng tuần tự — giữ đúng thứ tự chữ
    queue = queue
      .then(() => processUtterance(blob))
      .catch(e => console.error('[Live Voice] queue:', e))
  }

  // ---------------- VAD trên từng frame audio ----------------

  function onFrame(data: Float32Array) {
    if (!engine || engine.stopped || engine.paused) return
    const eng = engine

    const rms = frameRms(data)
    const frameMs = (data.length / eng.ctx.sampleRate) * 1000
    const threshold = Math.min(0.05, Math.max(eng.noiseFloor * 3, 0.0045))
    const isSpeech = rms > threshold

    if (!eng.inUtterance) {
      // Cập nhật nền ồn khi im lặng (thích nghi môi trường)
      if (!isSpeech) {
        eng.noiseFloor = Math.min(0.02, eng.noiseFloor * 0.95 + rms * 0.05)
      }
      eng.preRoll.push(data)
      if (eng.preRoll.length > PRE_ROLL_FRAMES) eng.preRoll.shift()

      eng.consecutiveSpeech = isSpeech ? eng.consecutiveSpeech + 1 : 0
      if (eng.consecutiveSpeech >= 2) {
        // Bắt đầu câu nói mới (kèm pre-roll để không mất âm đầu)
        eng.inUtterance = true
        eng.utteranceFrames = [...eng.preRoll, data]
        eng.preRoll = []
        eng.utteranceMs = frameMs * 2
        eng.speechFrames = eng.consecutiveSpeech
        eng.silenceMs = 0
      }
    } else {
      eng.utteranceFrames.push(data)
      eng.utteranceMs += frameMs
      if (isSpeech) {
        eng.speechFrames++
        eng.silenceMs = 0
      } else {
        eng.silenceMs += frameMs
        // NGỪNG NÓI ≥ pauseSilenceMs → kết thúc câu nói
        if (eng.silenceMs >= (react.getCallbacks().pauseSilenceMs ?? 1000)) {
          finalizeUtterance()
          return
        }
      }
      // Câu nói quá dài (engine giới hạn 30s) → chốt cưỡng bức
      if (eng.utteranceMs >= MAX_UTTERANCE_MS) finalizeUtterance()
    }
  }

  // ---------------- Bật / Tắt ----------------

  function stop() {
    if (engine) {
      engine.stopped = true
      engine.paused = true
      try { engine.processor.disconnect() } catch { /* ignore */ }
      try { engine.source.disconnect() } catch { /* ignore */ }
      try { engine.sink.disconnect() } catch { /* ignore */ }
      try { engine.ctx.close() } catch { /* ignore */ }
      try { engine.stream.getTracks().forEach(t => t.stop()) } catch { /* ignore */ }
    }
    engine = null
    speakAborted = true
    try { window.speechSynthesis?.cancel() } catch { /* ignore */ }
    asrAbort?.abort()
    queue = Promise.resolve()
    react.setStatus('off')
  }

  async function start(): Promise<void> {
    if (engine) return
    react.setStatus('starting')
    react.setError(null)
    react.setTtsVoiceMissing(false)
    speakAborted = false

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      })
      const ctx = new AudioContext()
      const source = ctx.createMediaStreamSource(stream)
      const processor = ctx.createScriptProcessor(FRAME_SIZE, 1, 1)
      const sink = ctx.createGain()
      sink.gain.value = 0 // không phát tiếng mic ra loa
      source.connect(processor)
      processor.connect(sink)
      sink.connect(ctx.destination)

      engine = {
        stream,
        ctx,
        source,
        processor,
        sink,
        noiseFloor: 0.008,
        consecutiveSpeech: 0,
        inUtterance: false,
        utteranceFrames: [],
        utteranceMs: 0,
        speechFrames: 0,
        silenceMs: 0,
        preRoll: [],
        paused: false,
        stopped: false,
      }

      processor.onaudioprocess = e => {
        // copy frame — buffer được tái sử dụng bởi browser
        onFrame(new Float32Array(e.inputBuffer.getChannelData(0)))
      }

      // Kích hoạt tải danh sách giọng nói (Chrome tải async)
      try { window.speechSynthesis?.getVoices() } catch { /* ignore */ }

      queue = Promise.resolve()
      react.setStatus('listening')
    } catch (e: unknown) {
      const err = e as { name?: string; message?: string }
      const msg =
        err?.name === 'NotAllowedError'
          ? 'Không có quyền truy cập micro — hãy cho phép micro trong trình duyệt'
          : err?.name === 'NotFoundError'
            ? 'Không tìm thấy thiết bị micro'
            : `Không bật được micro: ${err?.message || err}`
      react.setError(msg)
      react.setStatus('error')
      if (engine) {
        try { engine.stream.getTracks().forEach(t => t.stop()) } catch { /* ignore */ }
        engine = null
      }
    }
  }

  return { start, stop }
}

// ============================== Hook ==============================

export function useVoiceLive(options: UseVoiceLiveOptions = {}) {
  const [isLive, setIsLive] = useState(false)
  const [status, setStatus] = useState<VoiceLiveStatus>('off')
  const [error, setError] = useState<string | null>(null)
  const [ttsVoiceMissing, setTtsVoiceMissing] = useState(false)

  // Callbacks mới nhất (tránh stale closure) — cập nhật SAU render
  const cbRef = useRef(options)
  useEffect(() => { cbRef.current = options })

  // Controller engine — tạo 1 lần, không phụ thuộc render
  const ctrlRef = useRef<ReturnType<typeof createVoiceController> | null>(null)
  const liveRef = useRef(false)

  const getCtrl = useCallback(() => {
    if (!ctrlRef.current) {
      ctrlRef.current = createVoiceController({
        setStatus: s => {
          liveRef.current = s !== 'off' && s !== 'error'
          setStatus(s)
          setIsLive(liveRef.current)
        },
        setError,
        setTtsVoiceMissing,
        getCallbacks: () => cbRef.current,
      })
    }
    return ctrlRef.current
  }, [])

  const stop = useCallback(() => {
    getCtrl().stop()
  }, [getCtrl])

  const start = useCallback(() => {
    void getCtrl().start()
  }, [getCtrl])

  const toggle = useCallback(() => {
    if (liveRef.current) stop()
    else start()
  }, [start, stop])

  // Tắt sạch khi component unmount
  useEffect(() => {
    return () => { ctrlRef.current?.stop() }
  }, [])

  return { isLive, status, error, ttsVoiceMissing, toggle, stop }
}
