import { fileURLToPath } from "url";
const pw = await import(process.env.OP_PW || "/tmp/op-test/node_modules/playwright/index.js");
const { chromium } = pw.default || pw;
const EXT = process.env.OP_EXT || fileURLToPath(new URL("./.builds/unlocked", import.meta.url));
const BASE = (process.env.OP_BASE || "http://127.0.0.1:8799") + "/adversarial";
const results = [];
const ok = (n,c,d) => { results.push({n,c}); console.log(`${c?"PASS":"FAIL"} ${n}${c?"":" -> "+d}`); };

const ctx = await chromium.launchPersistentContext("/tmp/op-adv-"+Date.now(), {
  headless:false, args:[`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,"--headless=new","--no-first-run"],
});
ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker",{timeout:10000}).catch(()=>null);
const box = (page) => page.locator('[data-open-passwords="suggestions"]');

// these fields must not trigger the dropdown
const negatives = [
  ["search-bar", ["#header-search","#inline-search","#form-search"]],
  ["social-tag", ["#tag-search","#tag-combobox"]],
  ["compose-message", ["#dm-input","#compose-textarea","#compose-editable"]],
  ["comment-box", ["#comment-input","#reply-input"]],
  ["checkout-address", ["#first-name","#last-name","#address","#city","#postal-code","#email"]],
  ["newsletter", ["input[type=email]"]],
  ["profile-edit", ["#display-name","#profile-email","#profile-phone"]],
];
for (const [pg, sels] of negatives) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/${pg}.html`, {waitUntil:"domcontentloaded"});
  await page.waitForTimeout(250);
  for (const sel of sels) {
    const el = page.locator(sel).first();
    if (await el.count() === 0) { ok(`${pg} ${sel}: field exists`, false, "selector not found"); continue; }
    await el.focus().catch(()=>{});
    await page.waitForTimeout(300);
    const shown = await box(page).count() > 0;
    ok(`${pg} ${sel}: no dropdown`, !shown, "DROPDOWN APPEARED (false positive)");
    await page.click("body").catch(()=>{});
  }
  await page.close();
}

// mixed page: dropdown only on login fields, not the search box
{
  const page = await ctx.newPage();
  await page.goto(`${BASE}/mixed-page.html`, {waitUntil:"domcontentloaded"});
  await page.waitForTimeout(250);
  const searchSel = await page.evaluate(() => {
    const s = document.querySelector('input[type=search], [role=searchbox], input[name=q], input[placeholder*="Search" i]');
    return s ? (s.id ? "#"+s.id : "input[type=search]") : null;
  });
  const userSel = await page.evaluate(() => {
    const u = document.querySelector('input[autocomplete*=username], input[name*=user i], input[type=text]');
    const p = document.querySelector('input[type=password]');
    return p ? (u && u.id ? "#"+u.id : "input[type=text]") : null;
  });
  if (searchSel) {
    await page.locator(searchSel).first().focus().catch(()=>{});
    await page.waitForTimeout(300);
    ok("mixed-page search: no dropdown", await box(page).count()===0, "dropdown on search box");
    await page.click("body").catch(()=>{});
  } else ok("mixed-page search selector", false, "no search field found");
  const pwd = page.locator('input[type=password]').first();
  if (await pwd.count()) {
    await pwd.focus(); await page.waitForTimeout(300);
    ok("mixed-page password: dropdown shows", await box(page).count()>0, "no dropdown on real password field");
  }
  await page.close();
}

await ctx.close();
const failed = results.filter(r=>!r.c);
console.log(`\n==== ${results.length-failed.length}/${results.length} PASS ====`);
process.exit(failed.length?1:0);
