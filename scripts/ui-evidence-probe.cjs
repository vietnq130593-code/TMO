/* eslint-disable @typescript-eslint/no-require-imports */
// UI evidence probe v5 — assertion CỨNG cho tab Tools/Skills (Smolab).
// Cơ chế thật đọc từ mã nguồn:
//   - smolab-module.tsx:1015-1032 hydrate tab từ localStorage 'graphrag-smolab-tab'
//   - skills-tab.tsx:339 mount -> loadSkills() -> GET /api/openclaw/skills?action=installed
//   - skills-tab.tsx tự gọi /api/tools/registry khi mount (không cần click nút)
//   - skills-tab.tsx:405 badge "{builtin+custom} tools · {fs} skills", :415 badge "{agentCount} agents"
// PASS = mọi assertion dưới đều đúng; FAIL -> exit 1 (không còn pass rộng kiểu UI_PROBE_OK).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL_ = process.env.PROBE_URL || 'http://127.0.0.1:3000/';
const OUT_DIR = process.env.PROBE_OUT || '/tmp';
const lines = [];
const log = (k, v) => { lines.push(k + ' ' + v); };
const fails = [];
function assert(cond, label, detail) {
  if (cond) log('PASS_ASSERT', label);
  else { log('FAIL_ASSERT', label + (detail ? ' :: ' + detail : '')); fails.push(label); }
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  // Chủ động ép tab Skills qua localStorage đúng key mà component dùng
  await ctx.addInitScript(() => {
    try { window.localStorage.setItem('graphrag-smolab-tab', 'skills'); } catch (e) { /* ignore */ }
  });

  const page = await ctx.newPage();
  const apiCalls = [];
  const errs = [];
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('/api/')) {
      // FIX v5: dung URL chuan de lay pathname — u.replace(URL_,'') lam mat dau '/' khi URL_ ket thuc bang '/'
      let p = u, q = '';
      try { const pu = new URL(u); p = pu.pathname; q = pu.search.replace(/^\?/, ''); } catch (e) { /* ignore */ }
      apiCalls.push({ status: r.status(), path: p, query: q });
    }
  });
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().replace(/\s+/g, ' ').slice(0, 160)); });
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e.message).slice(0, 160)));

  try { await page.goto(URL_, { waitUntil: 'networkidle', timeout: 60000 }); log('GOTO', 'networkidle'); }
  catch (e) { await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}); log('GOTO_FALLBACK', String(e.message).split('\n')[0].slice(0, 90)); }
  await page.waitForTimeout(1500);
  log('TITLE', await page.title());

  // --- BƯỚC 1: điều hướng tới module Smolab bằng selector ổn định ---
  const mods = await page.$$eval('nav button.sidebar-module-btn', (els) => els.map((e) => e.getAttribute('title'))).catch(() => []);
  log('SIDEBAR_MODULES', JSON.stringify(mods));
  assert(mods.includes('Smolab'), 'sidebar co module Smolab', JSON.stringify(mods));
  const clicked = await page.click('nav button.sidebar-module-btn[title="Smolab"]').then(() => true).catch((e) => { log('CLICK_ERR', String(e.message).split('\n')[0].slice(0, 120)); return false; });
  log('CLICK_MODULE_SMOLAB', String(clicked));
  assert(clicked, 'click module Smolab thanh cong');
  await page.waitForTimeout(3500);

  // --- BƯỚC 2: localStorage đã ép tab skills => tab bar phải đánh dấu active ---
  const storedTab = await page.evaluate(() => { try { return window.localStorage.getItem('graphrag-smolab-tab'); } catch (e) { return 'ERR'; } });
  log('LOCALSTORAGE_TAB', String(storedTab));
  const activeTabLabel = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const b = btns.find((x) => (x.innerText || '').replace(/\s+/g, ' ').trim() === 'Tools/Skills');
    if (!b) return 'TAB_NOT_FOUND';
    return (b.className || '').includes('border-b-cyan-400') ? 'ACTIVE' : 'NOT_ACTIVE';
  });
  log('TAB_SKILLS_STATE', activeTabLabel);
  assert(activeTabLabel === 'ACTIVE', 'tab Tools/Skills dang active (hydrated tu localStorage)', activeTabLabel);

  // --- BUC 3: Tools Registry + skills da tu nap luc mount (skills-tab.tsx:113,129).
  // Danh tinh khu vuc accordion Skills Registry / SKILL.md Guides de assert DOM, KHONG dua vao nut rieng.
  const panels = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('h3').forEach((h) => {
      const t = (h.innerText || '').replace(/\s+/g, ' ').trim();
      if (/Tools Registry|SKILL\.md Guides/i.test(t)) out.push(t);
    });
    return out;
  });
  log('REGISTRY_PANELS', JSON.stringify(panels));
  assert(panels.some((p) => /Tools Registry/i.test(p)), 'co panel Tools Registry render trong tab', JSON.stringify(panels));
  assert(panels.some((p) => /SKILL\.md Guides/i.test(p)), 'co panel SKILL.md Guides render trong tab', JSON.stringify(panels));
  await page.waitForTimeout(3000);

  // --- BƯỚC 4: ASSERT API calls (đây là bằng chứng cứng) ---
  const uniq = Array.from(new Map(apiCalls.map((c) => [c.status + ' ' + c.path + (c.query ? '?' + c.query : ''), c])).values());
  const skillsCall = uniq.find((c) => c.path === '/api/openclaw/skills' && /action=installed/.test(c.query)) || uniq.find((c) => c.path === '/api/openclaw/skills');
  const regCall = uniq.find((c) => c.path === '/api/tools/registry');
  log('API_SKILLS_INSTALLED', skillsCall ? skillsCall.status + ' ' + skillsCall.query : 'NONE');
  log('API_TOOLS_REGISTRY', regCall ? String(regCall.status) : 'NONE');
  assert(!!skillsCall, 'GET /api/openclaw/skills?action=installed da duoc goi');
  assert(!!skillsCall && skillsCall.status === 200, 'skills installed tra 200', skillsCall ? String(skillsCall.status) : 'no call');
  assert(!!regCall, 'GET /api/tools/registry da duoc goi');
  assert(!!regCall && regCall.status === 200, 'tools registry tra 200', regCall ? String(regCall.status) : 'no call');

  // --- BƯỚC 5: ASSERT DOM — số liệu thật từ registry phải hiện ra ---
  const dom = await page.evaluate(() => {
    const txt = document.body.innerText.replace(/\s+/g, ' ');
    const m = txt.match(/(\d+)\s+tools\s*·\s*(\d+)\s+skills/);
    const a = txt.match(/(\d+)\s+agents/);
    return { toolsSkills: m ? m[0] : null, builtinPlusCustom: m ? Number(m[1]) : -1, fs: m ? Number(m[2]) : -1, agents: a ? Number(a[1]) : -1, len: txt.length };
  });
  log('DOM_TOOLS_SKILLS_BADGE', JSON.stringify(dom));
  assert(!!dom.toolsSkills, 'DOM co badge "{N} tools · {M} skills" tu registry', JSON.stringify(dom));
  assert(dom.builtinPlusCustom > 0 && dom.fs > 0, 'so tools/skills > 0 trong DOM', JSON.stringify(dom));
  assert(dom.agents > 0, 'DOM co badge "{N} agents" > 0', 'agents=' + dom.agents);

  // registry data tra ve co that la khong (so sanh voi API)
  let regApi = null;
  try {
    const res = await page.request.get(URL_.replace(/\/$/, '') + '/api/tools/registry');
    regApi = await res.json();
  } catch (e) { log('REG_API_ERR', String(e.message).slice(0, 100)); }
  const summ = regApi && regApi.summary;
  log('REGISTRY_SUMMARY', JSON.stringify(summ || null));
  if (summ) {
    log('REGISTRY_CUSTOM_TOOLS', JSON.stringify((regApi.customTools || []).map((c) => c.name)));
    assert(Number(summ.builtinToolCount) + Number(summ.customToolCount) === dom.builtinPlusCustom,
      'DOM tools count khop API (builtin+custom)', 'api=' + (Number(summ.builtinToolCount) + Number(summ.customToolCount)) + ' dom=' + dom.builtinPlusCustom);
    assert(Number(summ.filesystemSkillCount) === dom.fs,
      'DOM skills count khop API (filesystemSkillCount)', 'api=' + summ.filesystemSkillCount + ' dom=' + dom.fs);
    assert(Number(summ.agentCount) === dom.agents,
      'DOM agents count khop API (agentCount)', 'api=' + summ.agentCount + ' dom=' + dom.agents);
  } else {
    assert(false, 'lay duoc registry summary tu API de doi chieu');
  }

  // --- BƯỚC 6: 0 console error + anh chung ---
  assert(errs.length === 0, '0 console error', errs.slice(0, 3).join(' | '));
  const png = path.join(OUT_DIR, 'ui-tools-skills.png');
  await page.screenshot({ path: png, fullPage: false }).catch(() => {});
  if (fs.existsSync(png)) log('PNG', png + ' bytes=' + fs.statSync(png).size);

  log('API_UNIQUE', String(uniq.length));
  log('API_SAMPLE', uniq.slice(0, 20).map((c) => c.status + ' ' + c.path).join(' | '));
  await browser.close();

  console.log(lines.join('\n'));
  if (fails.length) { console.log('UI_PROBE_RESULT FAIL (' + fails.length + '/' + fails.length + '): ' + fails.join('; ')); process.exit(1); }
  console.log('UI_PROBE_RESULT PASS');
})().catch((e) => { console.log(lines.join('\n')); console.log('UI_PROBE_FATAL ' + String(e && e.message).slice(0, 200)); process.exit(1); });
