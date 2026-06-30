// run the headless suite in sequence and tally results
//   1. node build-test-extensions.mjs   # generate mock builds (once)
//   2. cd .. && python3 -m http.server 8799 --bind 127.0.0.1
//   3. node run-all.mjs
// each driver loads a mock ext in headless Chrome and exits 0 pass / non-0 fail

import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const HERE = dirname(fileURLToPath(import.meta.url));

const DRIVERS = [
  ["UI suite (login/OTP/forum, offer flow)", "drive.mjs"],
  ["Adversarial (false positives: search/tag/checkout)", "drive-adversarial.mjs"],
  ["Test bench (positive + negative on one page)", "drive-bench.mjs"],
  ["Anchor (fill the field you acted on)", "drive-anchor.mjs"],
  ["Click-back (dropdown reappears)", "drive-clickback.mjs"],
  ["Input events fire on fill (#9)", "drive-events.mjs"],
  ["Clickjacking: hidden field not filled (#18)", "drive-clickjack.mjs"],
  ["Multi-account chooser", "drive-multi.mjs"],
  ["PIN flow (wrong code errors, right code unlocks)", "drive-pin.mjs"],
  ["Iframe login (same-origin frame shows dropdown)", "drive-iframe.mjs"],
  ["Cross-origin iframe shows NO offer (leak closed)", "drive-xorigin.mjs"],
];

if (!existsSync(join(HERE, ".builds", "unlocked"))) {
  console.error("Mock builds missing. Run:  node build-test-extensions.mjs");
  process.exit(2);
}

function run(file) {
  return new Promise((resolve) => {
    const p = spawn("node", [join(HERE, file)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}

let passed = 0;
const failures = [];
console.log("Running Open Passwords headless suite\n" + "=".repeat(50));
for (const [name, file] of DRIVERS) {
  process.stdout.write(`\n▶ ${name}\n`);
  const { code, out } = await run(file);
  const summary = (out.match(/====.*====|PASS .*|FAIL .*/g) || []).slice(-1)[0] || "(no summary)";
  if (code === 0) {
    passed++;
    console.log(`  ✅ ${summary.trim()}`);
  } else {
    failures.push(name);
    console.log(`  ❌ FAILED (exit ${code})`);
    console.log(out.split("\n").filter((l) => /FAIL|Error|throw/.test(l)).slice(0, 5).map((l) => "     " + l).join("\n"));
  }
}

console.log("\n" + "=".repeat(50));
console.log(`${passed}/${DRIVERS.length} suites passed`);
if (failures.length) {
  console.log("FAILED: " + failures.join(", "));
  process.exit(1);
}
console.log("All green.");
