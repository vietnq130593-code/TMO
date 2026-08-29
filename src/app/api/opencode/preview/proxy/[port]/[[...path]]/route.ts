// ============================================
// /api/opencode/preview/proxy/[port]/[...path] — Same-origin preview proxy
// (user request 2026-09-10: "bấm preview hệ thống sẽ mở cổng 3005 nhưng
//  phải mở localhost:3005 bên ngoài, chứ phần Preview lại gặp lỗi hiển thị")
//
// VẤN ĐỀ CỐT LÕI: iframe trong panel Preview trỏ thẳng
// http://127.0.0.1:<port>. Khi người dùng xem TMO qua proxy HTTPS (preview
// panel của sandbox / tunnel):
//   1. 127.0.0.1 trong trình duyệt = máy NGƯỜI DÙNG — dev server không tồn
//      tại ở đó → "refused to connect".
//   2. HTTP iframe trong trang HTTPS → mixed-content block.
// → Panel Preview luôn lỗi; người dùng phải tự mở tab ngoài.
//
// GIẢI PHÁP: proxy cùng origin. iframe trỏ tới
//   /api/opencode/preview/proxy/<port>/...
// Route này (chạy SERVER-SIDE, cùng máy với dev server) forward request tới
// http://127.0.0.1:<port>/<path> rồi:
//   - HTML: rewrite URL tuyệt đối (/x → /api/opencode/preview/proxy/<port>/x)
//     cho href/src/action + CSS url() → subresource (JS/CSS/ảnh) cũng đi qua
//     proxy → hiển thị đầy đủ.
//   - CSS: rewrite url(/x).
//   - Khác: stream nguyên vẹn (status + content-type + body).
//   - Redirect 3xx: Location được rewrite + trả nguyên status để browser tự
//     điều hướng trong khuôn khổ proxy.
//   - Set-Cookie bị DROP (chống previewed-app ghi đè cookie auth tmo_api_token
//     của TMO).
//   - WebSocket/HMR không đi qua proxy (giới hạn chấp nhận — preview vẫn
//     hiển thị; bấm Làm mới để thấy thay đổi).
//
// BẢO MẬT (chống SSRF):
//   - Port PHẢI nằm trong allowlist (src/lib/preview-ports.ts) — chỉ port do
//     /preview/start khởi động hoặc /preview/detect scan thấy mới được forward.
//   - Đích luôn là 127.0.0.1 (loopback) — không thể forward ra ngoài.
//   - Route nằm dưới /api/opencode/** → middleware auth (cookie tmo_api_token
//     same-origin — iframe tự mang cookie, EventSource/fetch cũng vậy).
// ============================================

import { NextResponse } from 'next/server'
import { isPreviewPortAllowed } from '@/lib/preview-ports'

export const dynamic = 'force-dynamic'

const UPSTREAM_TIMEOUT_MS = 15_000

/** Header hop-by-hop không forward giữa proxy chains. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
])

/**
 * Rewrite URL tuyệt đối trong HTML/CSS để đi qua proxy prefix.
 * - href="/x" | src='/x' | action="/x" | poster="/x"  → prefix
 * - url(/x) | url('/x') | url("/x") trong CSS          → prefix
 * - Bỏ qua // (protocol-relative) và http(s):// (absolute) — không thuộc
 *   origin của dev server.
 */
function rewriteHtml(html: string, proxyPrefix: string): string {
  return html
    // (attr)="value" — value bắt đầu bằng / nhưng KHÔNG phải //
    .replace(
      /(\s(?:href|src|action|poster|data-src)\s*=\s*)"(\/(?!\/)[^"]*)"/g,
      `$1"${proxyPrefix}$2"`,
    )
    .replace(
      /(\s(?:href|src|action|poster|data-src)\s*=\s*)'(\/(?!\/)[^']*)'/g,
      `$1'${proxyPrefix}$2'`,
    )
    // CSS url(...) — trong <style> inline hoặc file CSS
    .replace(/url\(\s*(['"]?)(\/(?!\/)[^)'"]*)\s*\)/g, `url($1${proxyPrefix}$2)`)
    // srcset="a 1x, /b 2x" — rewrite từng URL bắt đầu bằng /
    .replace(/(\ssrcset\s*=\s*")([^"]*)"/g, (_m, attr: string, list: string) => {
      const rewritten = list
        .split(',')
        .map(part => {
          const t = part.trim()
          if (t.startsWith('/') && !t.startsWith('//')) return `${proxyPrefix}${t}`
          return t
        })
        .join(', ')
      return `${attr}${rewritten}"`
    })
}

function rewriteCss(css: string, proxyPrefix: string): string {
  return css.replace(/url\(\s*(['"]?)(\/(?!\/)[^)'"]*)\s*\)/g, `url($1${proxyPrefix}$2)`)
}

type ProxyCtx = { params: Promise<{ port: string; path?: string[] }> }

async function proxyRequest(request: Request, ctx: ProxyCtx): Promise<Response> {
  const { port: portRaw, path } = await ctx.params
  const port = parseInt(portRaw, 10)

  if (!Number.isInteger(port) || !isPreviewPortAllowed(port)) {
    return NextResponse.json(
      {
        error: `Port ${portRaw} không nằm trong danh sách preview dev server đang chạy.`,
        hint: 'Bấm nút Preview (hoặc làm mới) để app quét/khởi động lại dev server, rồi thử lại.',
      },
      { status: 403 },
    )
  }

  // Ghép lại path + query: /api/opencode/preview/proxy/3005/a/b?x=1
  // → http://127.0.0.1:3005/a/b?x=1
  const incoming = new URL(request.url)
  const subPath = (path ?? []).map(seg => encodeURIComponent(decodeURIComponent(seg))).join('/')
  const upstream = new URL(`http://127.0.0.1:${port}/${subPath}`)
  upstream.search = incoming.search

  // Forward method + body + headers (bỏ hop-by-hop + cookie auth của TMO)
  const headers = new Headers()
  request.headers.forEach((value, key) => {
    const k = key.toLowerCase()
    if (HOP_BY_HOP.has(k) || k === 'cookie') return
    headers.set(key, value)
  })
  headers.set('x-forwarded-host', incoming.host)
  headers.set('accept-encoding', 'identity') // tránh gzip — cần đọc/rewrite body

  const method = request.method
  const hasBody = method !== 'GET' && method !== 'HEAD'
  const body = hasBody ? await request.arrayBuffer() : undefined

  let upstreamRes: Response
  try {
    upstreamRes = await fetch(upstream.toString(), {
      method,
      headers,
      body: body && body.byteLength > 0 ? body : undefined,
      redirect: 'manual', // tự rewrite Location
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      {
        error: `Dev server :${port} không phản hồi (${msg}).`,
        hint: 'Dev server có thể đã tắt — bấm Preview để khởi động lại.',
      },
      { status: 502 },
    )
  }

  const proxyPrefix = `/api/opencode/preview/proxy/${port}`

  // Redirect 3xx → rewrite Location về prefix proxy rồi trả nguyên status
  const location = upstreamRes.headers.get('location')
  if (upstreamRes.status >= 300 && upstreamRes.status < 400 && location) {
    const res = new NextResponse(null, { status: upstreamRes.status })
    let target = location
    if (target.startsWith('/') && !target.startsWith('//')) target = proxyPrefix + target
    res.headers.set('location', target)
    return res
  }

  const contentType = upstreamRes.headers.get('content-type') || 'application/octet-stream'
  const isHtml = contentType.includes('text/html')
  const isCss = contentType.includes('text/css')

  // Response headers — chỉ giữ content-type cơ bản, DROP Set-Cookie (bảo mật)
  const resInit: ResponseInit = {
    status: upstreamRes.status,
    headers: {
      'content-type': contentType,
      'cache-control': 'no-store',
      'x-tmo-preview-proxy': `port:${port}`,
    },
  }

  if (isHtml || isCss) {
    const text = await upstreamRes.text()
    const rewritten = isHtml ? rewriteHtml(text, proxyPrefix) : rewriteCss(text, proxyPrefix)
    return new NextResponse(rewritten, resInit)
  }

  // Binary/other — stream nguyên vẹn
  const buf = await upstreamRes.arrayBuffer()
  return new NextResponse(buf, resInit)
}

export async function GET(request: Request, ctx: ProxyCtx) {
  return proxyRequest(request, ctx)
}

export async function HEAD(request: Request, ctx: ProxyCtx) {
  return proxyRequest(request, ctx)
}

export async function POST(request: Request, ctx: ProxyCtx) {
  return proxyRequest(request, ctx)
}

export async function PUT(request: Request, ctx: ProxyCtx) {
  return proxyRequest(request, ctx)
}

export async function PATCH(request: Request, ctx: ProxyCtx) {
  return proxyRequest(request, ctx)
}

export async function DELETE(request: Request, ctx: ProxyCtx) {
  return proxyRequest(request, ctx)
}
