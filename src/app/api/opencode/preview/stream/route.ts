import { NextResponse } from 'next/server'
import { readFile } from 'fs/promises'
import { resolve } from 'path'
import { runningProcesses } from '../start/route'

export const dynamic = 'force-dynamic'

/**
 * GET /api/opencode/preview/stream?root=xxx
 * Server-Sent Events tail of the dev-server log file for this workspace.
 * Frames:
 *   data: {"type":"init","data":"<full log so far>"}\n\n   (once, on connect)
 *   data: {"type":"chunk","data":"<new bytes>"}\n\n      (per poll increment)
 *   : heartbeat\n\n                              (keepalive comment each poll)
 * Auth: HttpOnly cookie from /api/auth/setup (EventSource cannot set headers).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const root = searchParams.get('root')

  if (!root) {
    return NextResponse.json({ error: 'root parameter is required' }, { status: 400 })
  }

  const resolvedRoot = resolve(root)
  const entry = runningProcesses.get(resolvedRoot)
  const logFile = entry?.logFile

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      let offset = 0 // character offset into the log file content
      let timer: ReturnType<typeof setInterval> | undefined

      const send = (payload: unknown): void => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
        } catch {
          closed = true
        }
      }

      const close = (): void => {
        if (closed) return
        closed = true
        if (timer !== undefined) clearInterval(timer)
        try {
          controller.close()
        } catch {
          // already closed
        }
      }

      // Initial frame: full log content so far
      if (logFile) {
        try {
          const init = await readFile(logFile, 'utf-8')
          offset = init.length
          send({ type: 'init', data: init })
        } catch {
          send({ type: 'init', data: '' })
        }
      } else {
        send({ type: 'init', data: '' })
      }

      timer = setInterval(() => {
        if (closed) return
        // Keepalive comment (spec-compliant SSE heartbeat)
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'))
        } catch {
          closed = true
          if (timer !== undefined) clearInterval(timer)
          return
        }
        if (!logFile) return
        void (async () => {
          try {
            const content = await readFile(logFile, 'utf-8')
            if (content.length < offset) {
              // Log file was truncated/rotated → reset baseline
              offset = content.length
              return
            }
            if (content.length > offset) {
              const chunk = content.slice(offset)
              offset = content.length
              send({ type: 'chunk', data: chunk })
            }
          } catch {
            // Log file disappeared — nothing to tail
          }
        })()
      }, 1000)

      // Client disconnect (navigated away, toggled preview off, ...)
      request.signal.addEventListener('abort', close)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
