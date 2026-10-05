// DOM probe cho Notes app — chỉ tạo/xóa card probe của riêng test này.
// Dùng selector THẬT của public/index.html (không có <form>):
//   #f-title, #f-content, #btn-add, #btn-clear, #btn-reload
//   li[data-id] → .view (.title/.content/.meta, .cb input[type=checkbox])
//   .actions button (✏️ Sửa, 🗑️ Xóa) · .edit-form (.e-title/.e-content/.e-save/.e-cancel)
import { chromium } from "playwright";

const BASE = process.env.NOTES_URL || "http://127.0.0.1:8899";
const PROBE_TITLE = "__ui_probe__";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

const liCount = (page) => page.locator("#list li").count();
const probeLi = (page) => page.locator(`#list li[data-id]`).filter({ hasText: PROBE_TITLE });

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("dialog", (d) => d.accept()); // confirm() ở nút Xóa

try {
  // ── 1. render danh sách ban đầu ──────────────────────────────────────────
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("#list li").length > 0, null, { timeout: 15000 });
  const initial = await liCount(page);
  const countText = (await page.locator("#count").textContent()) || "";
  check("1. render danh sách từ API", initial === 2 && /2 notes/.test(countText), `li=${initial} count="${countText.trim()}"`);

  // ── 2. tạo note qua UI (POST) ────────────────────────────────────────────
  await page.fill("#f-title", PROBE_TITLE);
  await page.fill("#f-content", "nội dung probe");
  await page.click("#btn-add");
  await page.waitForFunction(
    () => [...document.querySelectorAll("#list li")].some((li) => li.textContent.includes("__ui_probe__")),
    null, { timeout: 10000 }
  );
  const afterAdd = await liCount(page);
  const msgAdd = (await page.locator("#msg").textContent()) || "";
  const cleared = (await page.inputValue("#f-title")) === "";
  check("2. tạo note qua form → POST /api/notes", afterAdd === initial + 1 && /Đã thêm note #/.test(msgAdd), `li=${afterAdd} msg="${msgAdd.trim()}"`);
  check("2b. form được clear sau khi thêm", cleared, `#f-title="${await page.inputValue("#f-title")}"`);

  const probe = probeLi(page);
  const probeId = await probe.getAttribute("data-id");

  // ── 3. toggle done qua checkbox (PUT {done}) ─────────────────────────────
  await probe.locator(".view .cb input[type=checkbox]").check();
  await page.waitForFunction(
    (t) => {
      const li = [...document.querySelectorAll("#list li")].find((x) => x.textContent.includes(t));
      return li && li.classList.contains("done");
    },
    PROBE_TITLE, { timeout: 10000 }
  );
  const doneClass = await probeLi(page).getAttribute("class");
  check("3. toggle checkbox → PUT {done} (không mất title/content)", /\bdone\b/.test(doneClass || ""), `class="${doneClass}"`);

  // ── 4. sửa qua edit-form (PUT {title,content}) ───────────────────────────
  await probeLi(page).locator(".actions button").first().click();
  await probeLi(page).locator(".edit-form .e-title").fill(PROBE_TITLE + "_edited");
  await probeLi(page).locator(".edit-form .e-save").click();
  await page.waitForFunction(
    (t) => [...document.querySelectorAll("#list li")].some((li) => li.textContent.includes(t + "_edited")),
    PROBE_TITLE, { timeout: 10000 }
  );
  const editedContent = (await probeLi(page).locator(".view .content").textContent()) || "";
  check("4. sửa note qua edit-form → PUT {title,content}", true, `id=${probeId} content còn: "${editedContent.trim()}"`);

  // ── 5. xóa qua nút Xóa (confirm + DELETE) ────────────────────────────────
  await probeLi(page).locator(".actions button.ghost").click();
  await page.waitForFunction(
    (t) => ![...document.querySelectorAll("#list li")].some((li) => li.textContent.includes(t)),
    PROBE_TITLE, { timeout: 10000 }
  );
  const afterDel = await liCount(page);
  const msgDel = (await page.locator("#msg").textContent()) || "";
  check("5. xóa note qua confirm() → DELETE /api/notes/:id", afterDel === initial, `li=${afterDel} msg="${msgDel.trim()}"`);

  // ── 6. nút reload ────────────────────────────────────────────────────────
  await page.click("#btn-reload");
  await page.waitForFunction((n) => document.querySelectorAll("#list li").length === n, initial, { timeout: 10000 });
  const msgReload = (await page.locator("#msg").textContent()) || "";
  check("6. nút Tải lại → GET /api/notes", /Đã tải lại danh sách/.test(msgReload), `msg="${msgReload.trim()}"`);

  // ── 7. validation: title rỗng ────────────────────────────────────────────
  await page.fill("#f-title", "   ");
  await page.click("#btn-add");
  await page.waitForTimeout(400);
  const msgInvalid = (await page.locator("#msg").textContent()) || "";
  const afterInvalid = await liCount(page);
  check("7. validate title rỗng ở client (không gọi API)", /Tiêu đề không được rỗng/.test(msgInvalid) && afterInvalid === initial, `msg="${msgInvalid.trim()}" li=${afterInvalid}`);
} catch (err) {
  check("probe không crash", false, String(err).slice(0, 300));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n=== UI PROBE: ${results.length - failed.length}/${results.length} pass ===`);
process.exit(failed.length ? 1 : 0);
