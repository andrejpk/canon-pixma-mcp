// Live smoke test through a real MCP client. SAFE: read-only calls, the identify blink,
// dry runs, and no-op writes (re-applying current values). Never runs ink-consuming jobs.
//   node scripts/smoke.mjs <printer-ip>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const host = process.argv[2];
if (!host) {
  console.error("usage: node scripts/smoke.mjs <printer-ip>");
  process.exit(2);
}

async function connect(access) {
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: ["dist/index.js", "--access", access, "--host", host] }),
  );
  return client;
}
const text = (r) => r.content?.[0]?.text ?? "";
const parse = (r) => JSON.parse(text(r));
let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};

// Tool visibility per level
const expected = {
  "read-only": ["printer_status"],
  operator: ["printer_identify", "printer_nozzle_check"],
  danger: ["printer_head_cleaning", "printer_send_raw_bjl"],
};
const forbiddenAtReadOnly = ["printer_identify", "printer_head_cleaning", "printer_set_custom_settings"];
for (const level of Object.keys(expected)) {
  const c = await connect(level);
  const names = (await c.listTools()).tools.map((t) => t.name);
  check(expected[level].every((n) => names.includes(n)), `${level}: exposes ${expected[level].join(", ")} (${names.length} tools)`);
  if (level === "read-only") check(!forbiddenAtReadOnly.some((n) => names.includes(n)), "read-only: hides operator/danger tools");
  if (level === "operator") check(!names.includes("printer_head_cleaning"), "operator: hides danger tools");
  await c.close();
}

// Read-only calls
const ro = await connect("read-only");
const st = parse(await ro.callTool({ name: "printer_status", arguments: {} }));
check(typeof st.state === "string" && st.ink.length > 0, `status: ${st.state}, ${st.ink.length} tanks`);
const ink = parse(await ro.callTool({ name: "printer_ink_levels", arguments: {} }));
check(ink.ink.length > 0, `ink: ${ink.ink.map((t) => `${t.slot}=${t.percentRemaining}%`).join(" ")}`);
const cnt = parse(await ro.callTool({ name: "printer_counters", arguments: {} }));
check(!!cnt.product.PRODUCT_TOTAL, `counters: total ${cnt.product.PRODUCT_TOTAL}`);
const info = parse(await ro.callTool({ name: "printer_info", arguments: {} }));
check(!!info.model, `info: ${info.model}, fw ${info.firmware.current}`);
const raw = parse(await ro.callTool({ name: "printer_raw_status", arguments: {} }));
check(!!raw.fields.BST, "raw status has BST");
const ex = await ro.callTool({ name: "printer_explain_error", arguments: { code: "1688" } });
check(/run out/i.test(text(ex)), "explain_error 1688");
const disc = parse(await ro.callTool({ name: "printer_discover", arguments: {} }));
check(disc.printers.some((p) => p.ip === host), `discover finds ${host} (${disc.printers.length} found)`);
await ro.close();

// Operator: identify (blink), dry runs, no-op writes
const op = await connect("operator");
const id = parse(await op.callTool({ name: "printer_identify", arguments: {} }));
check(id.ok, `identify (status 0x${id.statusCode.toString(16)})`);
for (const name of ["printer_cancel_job", "printer_nozzle_check"]) {
  const r = parse(await op.callTool({ name, arguments: { dryRun: true } }));
  check(!!r.wouldPost, `${name} dryRun`);
}
const cs = parse(await op.callTool({ name: "printer_set_custom_settings", arguments: {} })); // no args = re-apply current
check(JSON.stringify(cs.before) === JSON.stringify(cs.after), `custom settings no-op write unchanged (${cs.printerResult})`);
await op.close();

// Danger: dry runs and confirm-guard only
const dz = await connect("danger");
for (const name of ["printer_head_cleaning", "printer_deep_cleaning", "printer_auto_head_alignment", "printer_platen_cleaning"]) {
  const r = parse(await dz.callTool({ name, arguments: { dryRun: true, confirm: true } }));
  check(!!r.wouldPost, `${name} dryRun -> ${r.wouldPost}`);
}
const noConfirm = await dz.callTool({ name: "printer_head_cleaning", arguments: { dryRun: true } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
check(noConfirm.isError === true, "head_cleaning without confirm is rejected");
const bjl = parse(await dz.callTool({ name: "printer_send_raw_bjl", arguments: { dryRun: true, confirm: true, lines: ["@TESTPRINT=NOZZLECHECK"] } }));
check(bjl.bytes.includes("BJLSTART"), "raw BJL dryRun framing");
await dz.close();

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
