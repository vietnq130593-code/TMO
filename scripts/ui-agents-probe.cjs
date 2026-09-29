/* eslint-disable @typescript-eslint/no-require-imports */
// UI evidence probe — module AGENTS (tab Tools & Skills).
// Cơ chế thật đọc từ mã nguồn:
//   - src/app/page.tsx:2754 sidebar button title={mod.label} -> module 'Agents'
//   - src/components/agents/agents-module.tsx:447 tablist [data-testid=agents-tabs]
//     :453 button agents-tab-agents · :463 button agents-tab-skills
//     :470 nhanh 'skills' render <SkillsTabContent />
//   - src/components/smolab/skills-tab.tsx mount -> GET /api/openclaw/skills?action=installed
//     + GET /api/tools/registry ; badge "{N} tools · {M} skills" va "{K} agents"
// PASS = moi assertion duoi deu dung; FAIL -> exit 1 (khong con pass rong kieu UI_PROBE_OK).
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
  const page = await ctx.newPage();
  const apiCalls = [];
  const errs = [];
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('/api/')) {
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

  // --- BƯỚC 1: module Agents co trong sidebar khong ---
  const mods = await page.$$eval('nav button.sidebar-module-btn', (els) => els.map((e) => e.getAttribute('title'))).catch(() => []);
  log('SIDEBAR_MODULES', JSON.stringify(mods));
  assert(mods.includes('Agents'), 'sidebar co module Agents', JSON.stringify(mods));
  const clicked = await page.click('nav button.sidebar-module-btn[title="Agents"]').then(() => true).catch((e) => { log('CLICK_ERR', String(e.message).split('\n')[0].slice(0, 120)); return false; });
  log('CLICK_MODULE_AGENTS', String(clicked));
  assert(clicked, 'click module Agents thanh cong');
  await page.waitForTimeout(2500);

  // --- BƯỚC 2: tablist Agents / Tools & Skills render trong module Agents ---
  const tabs = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="agents-tabs"]');
    const a = document.querySelector('[data-testid="agents-tab-agents"]');
    const s = document.querySelector('[data-testid="agents-tab-skills"]');
    return {
      hasBar: !!bar,
      agentsLabel: a ? (a.innerText || '').replace(/\s+/g, ' ').trim() : null,
      skillsLabel: s ? (s.innerText || '').replace(/\s+/g, ' ').trim() : null,
      agentsSelected: a ? a.getAttribute('aria-selected') : null,
    };
  });
  log('AGENTS_TABS', JSON.stringify(tabs));
  assert(tabs.hasBar, 'tablist [data-testid=agents-tabs] ton tai trong module Agents', JSON.stringify(tabs));
  assert(tabs.agentsLabel === 'Agents', 'tab 1 nhan "Agents"', String(tabs.agentsLabel));
  assert(tabs.skillsLabel === 'Tools & Skills', 'tab 2 nhan "Tools & Skills"', String(tabs.skillsLabel));
  assert(tabs.agentsSelected === 'true', 'mac dinh tab Agents dang active', String(tabs.agentsSelected));

  // Danh sach agent van render o tab mac dinh (khong mat noi dung)
  const agentCards = await page.evaluate(() => {
    const t = document.body.innerText.replace(/\s+/g, ' ');
    const m = t.match(/(\d+)\s+agents/);
    return { hasAgentsHeading: /Agents/.test(t), firstCount: m ? Number(m[1]) : -1 };
  });
  log('AGENTS_TAB_DEFAULT_CONTENT', JSON.stringify(agentCards));
  assert(agentCards.hasAgentsHeading, 'tab Agents render noi dung (khong trang rong)');

  // --- BUC 3: click tab Tools & Skills ---
  const clickedTab = await page.click('[data-testid="agents-tab-skills"]').then(() => true).catch((e) => { log('TAB_CLICK_ERR', String(e.message).split('\n')[0].slice(0, 120)); return false; });
  log('CLICK_TAB_SKILLS', String(clickedTab));
  assert(clickedTab, 'click tab Tools & Skills thanh cong');
  await page.waitForTimeout(4000);

  const after = await page.evaluate(() => {
    const s = document.querySelector('[data-testid="agents-tab-skills"]');
    return { skillsSelected: s ? s.getAttribute('aria-selected') : null };
  });
  log('TAB_SKILLS_ARIA', JSON.stringify(after));
  assert(after.skillsSelected === 'true', 'aria-selected=true tren tab Tools & Skills', String(after.skillsSelected));

  // --- BUC 4: SkillsTabContent tu nap du lieu 2 API ---
  const uniq = [];
  const seen = new Set();
  for (const c of apiCalls) { const k = c.status + ' ' + c.path + (c.query ? '?' + c.query : ''); if (!seen.has(k)) { seen.add(k); uniq.push(c); } }
  const skillsCall = uniq.find((c) => c.path === '/api/openclaw/skills' && /action=installed/.test(c.query));
  const regCall = uniq.find((c) => c.path === '/api/tools/registry');
  log('API_SKILLS_CALL', skillsCall ? skillsCall.status + ' ' + skillsCall.path + '?' + skillsCall.query : 'NOT_CALLED');
  log('API_REGISTRY_CALL', regCall ? String(regCall.status) : 'NOT_CALLED');
  assert(!!skillsCall && skillsCall.status === 200, '/api/openclaw/skills?action=installed tra 200', skillsCall ? String(skillsCall.status) : 'no call');
  assert(!!regCall && regCall.status === 200, '/api/tools/registry tra 200', regCall ? String(regCall.status) : 'no call');

  // Registry van nap tu API (khong phai du lieu hardcode)
  const agentsCall = uniq.find((c) => c.path === '/api/agents');
  log('API_AGENTS_CALL', agentsCall ? String(agentsCall.status) : 'NOT_CALLED');
  assert(!!agentsCall && agentsCall.status === 200, '/api/agents tra 200 (module Agents nap roster that)', agentsCall ? String(agentsCall.status) : 'no call');

  // --- BUC 5: panel SkillsTabContent render that ---
  const panels = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('h3').forEach((h) => {
      const t = (h.innerText || '').replace(/\s+/g, ' ').trim();
      if (/Tools Registry|SKILL\.md Guides/i.test(t)) out.push(t);
    });
    return out;
  });
  log('REGISTRY_PANELS', JSON.stringify(panels));
  assert(panels.some((p) => /Tools Registry/i.test(p)), 'co panel Tools Registry render trong tab Agents', JSON.stringify(panels));
  assert(panels.some((p) => /SKILL\.md Guides/i.test(p)), 'co panel SKILL.md Guides render trong tab Agents', JSON.stringify(panels));

  // --- BUC 6: DOM khop API registry ---
  const dom = await page.evaluate(() => {
    const txt = document.body.innerText.replace(/\s+/g, ' ');
    const m = txt.match(/(\d+)\s+tools\s*·\s*(\d+)\s+skills/);
    const a = txt.match(/(\d+)\s+agents/);
    return { toolsSkills: m ? m[0] : null, builtinPlusCustom: m ? Number(m[1]) : -1, fs: m ? Number(m[2]) : -1, agents: a ? Number(a[1]) : -1 };
  });
  log('DOM_BADGE', JSON.stringify(dom));
  assert(!!dom.toolsSkills, 'DOM co badge "{N} tools · {M} skills"', JSON.stringify(dom));
  assert(dom.builtinPlusCustom > 0 && dom.fs > 0, 'so tools/skills > 0 trong DOM', JSON.stringify(dom));
  assert(dom.agents > 0, 'DOM co badge "{N} agents" > 0', 'agents=' + dom.agents);

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

  // --- BUC 7: 0 console error + anh chung ---
  assert(errs.length === 0, '0 console error', errs.slice(0, 3).join(' | '));
  const png = path.join(OUT_DIR, 'ui-agents-tools-skills.png');
  await page.screenshot({ path: png, fullPage: false }).catch(() => {});
  if (fs.existsSync(png)) log('PNG', png + ' bytes=' + fs.statSync(png).size);

  log('API_UNIQUE', String(uniq.length));
  log('API_SAMPLE', uniq.slice(0, 20).map((c) => c.status + ' ' + c.path).join(' | '));
  await browser.close();

  console.log(lines.join('\n'));
  if (fails.length) { console.log('AGENTS_PROBE_RESULT FAIL (' + fails.length + '/' + fails.length + '): ' + fails.join('; ')); process.exit(1); }
  console.log('AGENTS_PROBE_RESULT PASS');
})().catch((e) => { console.log(lines.join('\n')); console.log('AGENTS_PROBE_FATAL ' + String(e && e.message).slice(0, 200)); process.exit(1); });
