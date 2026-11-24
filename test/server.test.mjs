// Offline: start the server over stdio with a real MCP client and check which tools each
// access level exposes. Listing tools never contacts the printer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

async function toolsFor(access) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [entry, "--access", access, "--host", "192.0.2.1"], stderr: "ignore" }),
  );
  const names = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  return names;
}

test("read-only exposes only inspection tools", async () => {
  const names = await toolsFor("read-only");
  assert.ok(names.includes("printer_status"));
  for (const n of names) assert.ok(!/identify|cancel|nozzle|clean|align|bjl|set_/.test(n), `unexpected ${n}`);
});

test("operator adds routine actions but no ink-heavy ones", async () => {
  const names = await toolsFor("operator");
  for (const n of ["printer_identify", "printer_cancel_job", "printer_nozzle_check", "printer_set_custom_settings"]) assert.ok(names.includes(n), n);
  assert.ok(!names.includes("printer_head_cleaning"));
});

test("danger adds cleaning and raw BJL", async () => {
  const names = await toolsFor("danger");
  for (const n of ["printer_head_cleaning", "printer_deep_cleaning", "printer_send_raw_bjl"]) assert.ok(names.includes(n), n);
});
