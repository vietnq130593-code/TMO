// ============================================================================
// TEST SUITE — POST /api/tools/register (gọi route handler TRỰC TIẾP, không cần dev server)
//
// Vì sao gọi thẳng handler thay vì HTTP: tsconfig khai báo alias "@/* → ./src/*",
// Bun resolve được, và `bun -e` import được module route in ra "ROUTE_EXPORT_OK".
// Nhờ vậy khoá được message 400/409 CHÍNH XÁC của từng nhánh thay vì smoke test mờ.
//
// Bất biến khoá (khớp với src/app/api/tools/register/route.ts):
//  - thiếu field / sai định dạng tên / parameters sai / handlerCode rỗng hay sai cú pháp → 400
//  - tên trùng built-in (vd file_read) → 409 "conflicts with an existing built-in or gateway tool"
//  - tên trùng row CustomTool trong DB → 409 "already exists as a custom tool"
//  - body hợp lệ → 201 + row trong DB + registration.inMemory === true
//
// Cô lập DB: bunfig.toml khai báo preload = tests/db-isolation-preload.ts → copy
// db/custom.db ra /tmp rồi trỏ DATABASE_URL vào bản copy. Test có assert chặn
// để KHÔNG BAO GIỜ ghi vào DB của app đang chạy.
//
// Chạy: cd /home/z/tmo-app && bun test tests/tools-register-route.test.ts
// ============================================================================

import { describe, test, expect, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { POST } from '../src/app/api/tools/register/route'
import { db } from '../src/lib/db'
import { deleteCustomTool } from '../src/lib/custom-tool-registry'

const ENDPOINT = 'http://localhost:3000/api/tools/register'
const BUILTIN_NAME = 'file_read' // có trong ALL_TOOL_DEFINITIONS (tool-executor.ts:432)
const DUP_NAME = 'test_register_dup_probe'
const OK_NAME = 'test_register_ok_probe'

// Tên do test tự tạo trong DB — dọn sau khi hết suite.
const createdNames: string[] = []

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function validBody(name: string) {
  return {
    name,
    description: 'probe tool cho test route register',
    parameters: { type: 'object', properties: { a: { type: 'string' } } },
    handlerCode: 'function handler(args) { return { echo: args.a ?? null } }',
  }
}

async function callPost(body: Record<string, unknown>) {
  const res = await POST(makeRequest(body))
  const json = (await res.json()) as Record<string, any>
  return { status: res.status, json }
}

afterAll(async () => {
  for (const name of createdNames) {
    await deleteCustomTool(name)
  }
})

// ---------------------------------------------------------------------------
// Chặn an toàn: nếu preload không chạy, test sẽ ghi vào DB production.
// SENTINEL-FIX (round-7, sau gate 21:01 fail test_exit=1): assertion cũ chỉ
// chấp nhận '/tmp/' — mâu thuẫn với CẢ 2 runner chính thức đều dùng DB test
// repo-local (scripts/quality-gate.mjs → db/.quality-gate-test.db,
// audit-out/run-gate.sh → db/.audit-gate-test.db) ⇒ test fail mọi lần chạy
// gate dù DB đã cô lập đúng. Assertion mới: chấp nhận mọi DB test cô lập đã
// biết (whitelist), vẫn cứng tay chặn mọi URL đụng DB production custom.db.
// ---------------------------------------------------------------------------
describe('môi trường test — DB phải được cô lập', () => {
  test('DATABASE_URL trỏ vào DB test cô lập (không đụng custom.db)', () => {
    const url = process.env.DATABASE_URL || ''
    // Whitelist DB test hợp lệ:
    //   - '/tmp/...' — harness copy cũ
    //   - '.../db/.quality-gate-test.db' — scripts/quality-gate.mjs --stage=tests
    //   - '.../db/.audit-gate-test.db' — audit-out/run-gate.sh
    const isolated =
      url.includes('/tmp/') ||
      url.includes('.quality-gate-test.db') ||
      url.includes('.audit-gate-test.db')
    expect(isolated).toBe(true)
    expect(url).not.toContain('custom.db')
  })
})

// ---------------------------------------------------------------------------
// 400 — validate field bắt buộc
// ---------------------------------------------------------------------------
describe('POST /api/tools/register — 400 validate field bắt buộc', () => {
  test('thiếu name → 400 đúng message', async () => {
    const { name, ...rest } = validBody(OK_NAME)
    void name
    const { status, json } = await callPost(rest as Record<string, unknown>)
    expect(status).toBe(400)
    expect(json.error).toBe('Missing or invalid "name" field (must be a non-empty string)')
  })

  test('thiếu description → 400 đúng message', async () => {
    const { description, ...rest } = validBody(OK_NAME)
    void description
    const { status, json } = await callPost(rest as Record<string, unknown>)
    expect(status).toBe(400)
    expect(json.error).toBe('Missing or invalid "description" field (must be a non-empty string)')
  })

  test('thiếu parameters → 400 đúng message', async () => {
    const { parameters, ...rest } = validBody(OK_NAME)
    void parameters
    const { status, json } = await callPost(rest as Record<string, unknown>)
    expect(status).toBe(400)
    expect(json.error).toBe('Missing or invalid "parameters" field (must be a JSON object)')
  })

  test('thiếu handlerCode → 400 đúng message', async () => {
    const { handlerCode, ...rest } = validBody(OK_NAME)
    void handlerCode
    const { status, json } = await callPost(rest as Record<string, unknown>)
    expect(status).toBe(400)
    expect(json.error).toBe('Missing or invalid "handlerCode" field (must be a non-empty string)')
  })

  test('name sai định dạng (bắt đầu bằng số, có dấu gạch ngang) → 400', async () => {
    const { status, json } = await callPost(validBody('9bad-name'))
    expect(status).toBe(400)
    expect(json.error).toBe(
      'Invalid tool name. Must start with a letter or underscore, and contain only letters, digits, and underscores.'
    )
  })
})

// ---------------------------------------------------------------------------
// 400 — validate parameters + handlerCode
// ---------------------------------------------------------------------------
describe('POST /api/tools/register — 400 validate parameters/handlerCode', () => {
  test('parameters.type khác "object" → 400', async () => {
    const body = { ...validBody(OK_NAME), parameters: { properties: {} } }
    const { status, json } = await callPost(body)
    expect(status).toBe(400)
    expect(json.error).toBe('parameters.type must be "object"')
  })

  test('parameters thiếu properties → 400', async () => {
    const body = { ...validBody(OK_NAME), parameters: { type: 'object' } }
    const { status, json } = await callPost(body)
    expect(status).toBe(400)
    expect(json.error).toBe('parameters must have a "properties" object')
  })

  test('handlerCode chỉ khoảng trắng → 400', async () => {
    const body = { ...validBody(OK_NAME), handlerCode: '   ' }
    const { status, json } = await callPost(body)
    expect(status).toBe(400)
    expect(json.error).toBe('handlerCode must not be empty')
  })

  test('handlerCode sai cú pháp JS → 400 kèm lý do', async () => {
    const body = { ...validBody(OK_NAME), handlerCode: 'function handler(args) { return ' }
    const { status, json } = await callPost(body)
    expect(status).toBe(400)
    expect(String(json.error)).toContain('handlerCode has a syntax error')
  })
})

// ---------------------------------------------------------------------------
// 409 — collision tên
// ---------------------------------------------------------------------------
describe('POST /api/tools/register — 409 collision tên', () => {
  test('tên trùng tool built-in (file_read) → 409 built-in/gateway', async () => {
    const t0 = Date.now()
    const { status, json } = await callPost(validBody(BUILTIN_NAME))
    console.log(
      `[probe] builtin-collision status=${status} sau ${Date.now() - t0}ms — ${JSON.stringify(json).slice(0, 200)}`
    )
    expect(status).toBe(409)
    expect(json.error).toBe(
      `Tool name "${BUILTIN_NAME}" conflicts with an existing built-in or gateway tool`
    )
  })

  test('tên đã có row CustomTool trong DB → 409 already-exists', async () => {
    await db.customTool.create({
      data: {
        name: DUP_NAME,
        description: 'row giả lập để test collision DB',
        parameters: JSON.stringify({ type: 'object', properties: {} }),
        handlerCode: 'function handler() { return { ok: true } }',
        source: 'custom',
        category: 'Custom',
        enabled: true,
        isPublic: false,
      },
    })
    createdNames.push(DUP_NAME)

    const { status, json } = await callPost(validBody(DUP_NAME))
    expect(status).toBe(409)
    expect(json.error).toBe(`Tool name "${DUP_NAME}" already exists as a custom tool`)
  })
})

// ---------------------------------------------------------------------------
// Nhánh tạo mới — in ra bằng chứng thô trước khi assert
// ---------------------------------------------------------------------------
describe('POST /api/tools/register — nhánh tạo mới', () => {
  test('body hợp lệ → 201, có row trong DB, inMemory register = true', async () => {
    const t0 = Date.now()
    const { status, json } = await callPost(validBody(OK_NAME))
    const elapsed = Date.now() - t0
    createdNames.push(OK_NAME)
    console.log(`[probe] create-path status=${status} sau ${elapsed}ms — ${JSON.stringify(json).slice(0, 500)}`)

    expect(status).toBe(201)
    expect(json.tool.name).toBe(OK_NAME)
    expect(json.registration.inMemory).toBe(true)
    expect(json.tool.source).toBe('custom')

    const row = await db.customTool.findUnique({ where: { name: OK_NAME } })
    expect(row).not.toBeNull()
    expect(row!.handlerCode).toContain('function handler')
    expect(JSON.parse(row!.parameters).type).toBe('object')
  })
})
