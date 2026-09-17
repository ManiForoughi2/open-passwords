// verification codes on one-time-code fields: the dropdown offers the vault's TOTP entry, a
// click fills a split six-box widget one digit per box and a single field whole; a login
// field never shows a code row; the shortcut message reopens/focuses; findTotpUri reads an
// otpauth:// link off the page
import { fileURLToPath } from "url";
const pw = await import(process.env.OP_PW || "/tmp/op-test/node_modules/playwright/index.js");
const { chromium } = pw.default || pw;
const BASE = process.env.OP_BASE || "http://127.0.0.1:8799";
const EXT = process.env.OP_EXT || fileURLToPath(new URL("./.builds/otp", import.meta.url));
const results = [];
const ok = (n, c, d) => { results.push({ n, c }); console.log(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : " -> " + d}`); };

const ctx = await chromium.launchPersistentContext("/tmp/op-otp-" + Date.now(), {
  headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new", "--no-first-run"],
});
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }).catch(() => null));
const box = (page) => page.locator('[data-open-passwords="suggestions"]');
const txt = async (page) => (await box(page).count()) ? (await box(page).innerText()).replace(/\s+/g, " ").trim() : "";

// split widget: one digit per box
{
  const page = await ctx.newPage();
  await page.goto(`${BASE}/otp-multibox.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.focus('input[name="code1"]');
  await page.waitForTimeout(600);
  const t = await txt(page);
  ok("multibox: code row offered on focus", /Verification code for acme\.example/.test(t) && /alice@example\.com/.test(t), `got "${t}"`);
  await box(page).locator("text=Verification code").click();
  await page.waitForTimeout(600);
  const digits = [];
  for (let i = 1; i <= 6; i++) digits.push(await page.inputValue(`input[name="code${i}"]`));
  ok("multibox: one digit per box", digits.join("") === "246810", `boxes="${digits.join(",")}"`);
  ok("multibox: dropdown closed after fill", (await box(page).count()) === 0, "still open");
  await page.close();
}

// single field: the whole code
{
  const page = await ctx.newPage();
  await page.goto(`${BASE}/otp-singlefield.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.focus('input[name="otp"]');
  await page.waitForTimeout(600);
  ok("singlefield: code row offered on focus", /Verification code/.test(await txt(page)), await txt(page));
  await box(page).locator("text=Verification code").click();
  await page.waitForTimeout(600);
  const v = await page.inputValue('input[name="otp"]');
  ok("singlefield: whole code filled", v === "246810", `value="${v}"`);
  await page.close();
}

// a login field gets logins, never a code row
{
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.focus('input[name="username"]');
  await page.waitForTimeout(600);
  const t = await txt(page);
  ok("login field: no code row", /test@example\.com/.test(t) && !/Verification code/.test(t), `got "${t}"`);
  await page.close();
}

// shortcut with nothing focused puts focus on the login field, whose offer then appears
if (sw) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.click("body");
  await page.waitForTimeout(200);
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: "*://127.0.0.1/login-standard.html" });
    await chrome.tabs.sendMessage(tab.id, { type: "shortcut" });
  });
  await page.waitForTimeout(600);
  const focused = await page.evaluate(() => document.activeElement?.name || "");
  ok("shortcut: focuses the login field", focused === "username", `active="${focused}"`);
  ok("shortcut: offer appears", /test@example\.com/.test(await txt(page)), await txt(page));
  await page.close();

  // otpauth link on a 2FA setup page is found for the popup's set-up row
  const setup = await ctx.newPage();
  await setup.goto(`${BASE}/totp-setup.html`, { waitUntil: "domcontentloaded" });
  await setup.waitForTimeout(300);
  const found = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: "*://127.0.0.1/totp-setup.html" });
    return chrome.tabs.sendMessage(tab.id, { type: "findTotpUri" }, { frameId: 0 });
  });
  ok("findTotpUri: link found", found?.uris?.[0] === "otpauth://totp/Acme:alice%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Acme", JSON.stringify(found));
  ok("findTotpUri: text copy deduped, second uri from text", found?.uris?.length === 2 && /issuer=Other/.test(found.uris[1]), JSON.stringify(found));
  await setup.close();
} else {
  ok("service worker available for shortcut/findTotpUri checks", false, "no service worker");
}

await ctx.close();
const failed = results.filter((r) => !r.c);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
