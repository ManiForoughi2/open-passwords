import { fileURLToPath } from "url";
const pw = await import(process.env.OP_PW || "/tmp/op-test/node_modules/playwright/index.js");
const { chromium } = pw.default || pw;
const EXT = process.env.OP_EXT || fileURLToPath(new URL("./.builds/unlocked", import.meta.url));
const ctx=await chromium.launchPersistentContext("/tmp/op-bench-"+Date.now(),{headless:false,args:[`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,"--headless=new","--no-first-run"]});
ctx.serviceWorkers()[0]||await ctx.waitForEvent("serviceworker",{timeout:10000}).catch(()=>null);
const page=await ctx.newPage(); await page.goto("http://127.0.0.1:8799/testbench.html",{waitUntil:"domcontentloaded"}); await page.waitForTimeout(300);
const box=()=>page.locator('[data-open-passwords="suggestions"]');
const r=[]; const ok=(n,c)=>{r.push(c);console.log((c?"PASS ":"FAIL ")+n);};
for(const [id,want] of [["#u1",true],["#u2",true],["#s1",false],["#tag1",false],["#c1",false],["#n1",false]]){
  await page.locator(id).focus().catch(()=>{}); await page.waitForTimeout(350);
  const shown=await box().count()>0;
  ok(`${id} dropdown=${shown} (want ${want})`, shown===want);
  await page.click("h1").catch(()=>{}); await page.waitForTimeout(150);
}
await ctx.close(); const f=r.filter(x=>!x).length; console.log(`\n${r.length-f}/${r.length} PASS`); process.exit(f?1:0);
