import { fileURLToPath } from "url";
const pw = await import(process.env.OP_PW || "/tmp/op-test/node_modules/playwright/index.js");
const { chromium } = pw.default || pw;
import { join } from "path";
const SHOTS = fileURLToPath(new URL("./shots", import.meta.url));
const EXT = process.env.OP_EXT || fileURLToPath(new URL("./.builds/pinflow", import.meta.url));
const results = [];
const ok = (n,c,d) => { results.push({n,c}); console.log(`${c?"PASS":"FAIL"} ${n}${c?"":" -> "+d}`); };

const ctx = await chromium.launchPersistentContext("/tmp/op-pin-"+Date.now(), {
  headless: false, args: [`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,"--headless=new","--no-first-run"],
});
ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker",{timeout:10000}).catch(()=>null);
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:8799/login-standard.html",{waitUntil:"domcontentloaded"});
await page.waitForTimeout(300);
const box = () => page.locator('[data-open-passwords="suggestions"]');
const txt = async () => (await box().count()) ? (await box().innerText()).replace(/\s+/g," ").trim() : "";

await page.focus('input[name="username"]'); await page.waitForTimeout(400);
ok("offer on focus", /Click to autofill/i.test(await txt()), await txt());

await box().locator("text=Click to autofill").click(); await page.waitForTimeout(600);
ok("PIN field appears after click", /Enter the|code shown|6-digit/i.test(await txt()), await txt());
await page.screenshot({path:join(SHOTS,"pin-1-field.png")});

const pinInput = box().locator('input');
await pinInput.fill("000000"); await pinInput.press("Enter");
await page.waitForTimeout(1200);
const wrongTxt = await txt();
ok("wrong code shows error (not stuck on Verifying)", /incorrect/i.test(wrongTxt) && !/verifying/i.test(wrongTxt), `got "${wrongTxt}"`);
await page.screenshot({path:join(SHOTS,"pin-2-wrong.png")});

const pin2 = box().locator('input');
await pin2.fill("123456"); await pin2.press("Enter");
await page.waitForTimeout(1500);
const val = await page.inputValue('input[name="username"]').catch(()=>"" );
ok("correct code unlocks + fills", val === "test@example.com", `username value="${val}", dropdown="${await txt()}"`);
await page.screenshot({path:join(SHOTS,"pin-3-filled.png")});

await ctx.close();
const failed = results.filter(r=>!r.c);
console.log(`\n==== ${results.length-failed.length}/${results.length} PASS ====`);
process.exit(failed.length?1:0);
