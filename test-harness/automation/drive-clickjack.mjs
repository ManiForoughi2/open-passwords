import { fileURLToPath } from "url";
const pw = await import(process.env.OP_PW || "/tmp/op-test/node_modules/playwright/index.js");
const { chromium } = pw.default || pw;
const EXT = process.env.OP_EXT || fileURLToPath(new URL("./.builds/unlocked", import.meta.url));
const ctx=await chromium.launchPersistentContext("/tmp/op-cj-"+Date.now(),{headless:false,args:[`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,"--headless=new","--no-first-run"]});
ctx.serviceWorkers()[0]||await ctx.waitForEvent("serviceworker",{timeout:10000}).catch(()=>null);
const page=await ctx.newPage();
await page.goto("http://127.0.0.1:8799/clickjack.html",{waitUntil:"domcontentloaded"}); await page.waitForTimeout(300);
const box=()=>page.locator('[data-open-passwords="suggestions"]');
await page.focus('input[name=username]'); await page.waitForTimeout(400);
const offered = await box().count()>0;
if(offered){ await box().locator("text=Click to autofill").click(); await page.waitForTimeout(600); }
const pval=await page.inputValue('input[name=password]').catch(()=>"");
// pass if hidden password not filled - visibility guard blocks exfil
const pass = pval==="";
console.log(`offered on username: ${offered}; hidden password filled: ${pval?"YES (BAD)":"NO (good)"}`);
console.log(pass?"PASS #18 hidden password field not filled (clickjack defense)":"FAIL clickjack: hidden field got filled");
await ctx.close(); process.exit(pass?0:1);
