# FIX R8-1 — NIM RESCUE CHO UTILITY-CORE (TÁI ÁP SAU KHÔI PHỤC REPO)

> Fix này đã được áp vào `src/lib/llm.ts` trong phiên quan sát lượt 4 (R8) lúc ~07:16 ngày 14/10/2026 nhưng **CHƯA COMMIT** — container reset 08:18 làm mất file. Code dưới đây là bản lưu nguyên văn từ entry R8 trong `worklog.md`.
>
> **Bằng chứng gốc rễ** (từ R8): run `run_1791961389660_1` chết vì compression fail khi Zen 403 → context phình → RSS 2125MB ≥ HARD 2100MB → MemWatchdog self-exit → PM2 restart #115 giết run. Agent path CÓ NIM rescue nhưng utility-core KHÔNG.

## Vị trí áp

- File: `src/lib/llm.ts`
- Hàm: `callUtilityLLM`
- Vị trí: **THAY THẾ khối return lỗi cuối cùng của nhánh `isZenConfigured`**
- Chuỗi neo để tìm khối cũ (search): `Utility-core "${taskLabel}": Zen thất bại toàn chuỗi — caller sẽ fail-open (NIM removed — Task 33)`

## Code thay thế

```ts
    // R8 FIX (giao thức quan sát lượt 4 — 2026-10-14): NIM RESCUE cho utility-core
    // — bằng chứng run_1791961389660_1 chết vì compression fail → context phình
    //   → RSS 2125MB → restart #115 giết run
    const utilNimRescueModel = (process.env.NIM_RESCUE_MODEL ?? 'deepseek-ai/deepseek-v4.1-flash').trim()
    if (utilNimRescueModel) {
      console.warn(`[LLM] Utility-core NIM RESCUE (R8): toàn chuỗi Zen chết — thử NIM ${utilNimRescueModel} giữ utility sống — task: ${taskLabel}...`)
      const rescue = await callModelWithKeyRotation(utilNimRescueModel, prompt, systemPrompt, options, { taskLabel: `utility-nim-rescue:${taskLabel}` })
      if (rescue && rescue.content) {
        console.warn(`[LLM] Utility-core dùng NIM RESCUE ${utilNimRescueModel} ✓ (${rescue.tokensUsed ?? 0} tokens) — task: ${taskLabel} (Zen chết toàn chuỗi, R8)`)
        return rescue
      }
      console.warn(`[LLM] Utility-core NIM RESCUE ${utilNimRescueModel} thất bại: ${String(rescue?.error || 'null result').slice(0, 120)} — task: ${taskLabel}`)
    }
    console.warn(`[LLM] Utility-core "${taskLabel}": Zen thất bại toàn chuỗi${utilNimRescueModel ? ` + NIM rescue ${utilNimRescueModel}` : ''} — caller sẽ fail-open`)
    return { content: '', provider: 'zen', model: utilModel, error: `Utility-core "${taskLabel}" thất bại toàn chuỗi Zen (${utilModel} HTTP + CLI${utilModel !== zenFailoverModel ? ` + failover ${zenFailoverModel}` : ''})${utilNimRescueModel ? ` + NIM rescue ${utilNimRescueModel}` : ''}` }
```

## Ghi chú khi tái áp

1. Đặt khối trên **TRƯỚC** dòng `console.warn` cũ + `return` cũ (thay thế hoàn toàn 2 dòng cũ).
2. `NIM_RESCUE_MODEL` env override được; **rỗng = tắt rescue**.
3. Sau khi áp: gate `bunx tsc --noEmit` + `bun run lint` (theo giao thức fixbug.md C4).
4. **RESTART pm2 bắt buộc** — Turbopack HMR không thay module background worker đang sống (bài học R8: fix 07:16 nhưng worker 07:13 vẫn chạy module cũ).
5. Verify: tìm log `[LLM] Utility-core NIM RESCUE (R8)` khi Zen chết.
6. Sau verify: **COMMIT NGAY** (bài học mất fix do reset) + push cả 2 kho.
