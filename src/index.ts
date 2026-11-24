#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as bjnp from "./bjnp.js";
import { ruiGet, ruiPost, children, tag, result } from "./rui.js";
import { identifyPrinter } from "./ipp.js";
import { decodeStatus, parseFields, RUI_LEVELS, RUI_WARN } from "./decode.js";
import { ERROR_MESSAGES } from "./errors.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const LEVELS = ["read-only", "operator", "danger"] as const;
type Level = (typeof LEVELS)[number];

function argValue(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.findIndex((a) => a === flag || a.startsWith(flag + "="));
  if (i < 0) return undefined;
  return argv[i].includes("=") ? argv[i].split("=").slice(1).join("=") : argv[i + 1];
}

const accessRaw = (argValue("--access") ?? process.env.PIXMA_ACCESS ?? "read-only").toLowerCase();
if (!LEVELS.includes(accessRaw as Level)) {
  console.error(`Invalid access level "${accessRaw}". Use one of: ${LEVELS.join(", ")}`);
  process.exit(2);
}
const ACCESS = accessRaw as Level;
const rank = (l: Level) => LEVELS.indexOf(l);
const allowed = (l: Level) => rank(ACCESS) >= rank(l);
const CONFIGURED_HOST = argValue("--host") ?? process.env.PIXMA_HOST;

let cachedHost: string | undefined = CONFIGURED_HOST;
async function resolveHost(host?: string): Promise<string> {
  if (host) return host;
  if (cachedHost) return cachedHost;
  const found = (await bjnp.discover()).filter((p) => /canon/i.test(p.deviceId ?? "canon"));
  if (!found.length) throw new Error("No printer configured (PIXMA_HOST / --host) and none found by BJNP discovery.");
  cachedHost = found[0].ip;
  return cachedHost;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

async function status(host: string) {
  return decodeStatus(await bjnp.getStatusString(host));
}

/** Refuse to start a job unless the printer is idle with no errors. */
async function requireIdle(host: string) {
  const s = await status(host);
  if (s.stateCode !== "00" || s.hasError || s.busy || s.jobStatus) {
    throw new Error(`Printer is not idle/ready (state: ${s.state}; operatorCall: ${JSON.stringify(s.operatorCall)}; serviceCall: ${JSON.stringify(s.serviceCall)}). Refusing to start a job.`);
  }
  return s;
}

/** Kick one of the Remote UI maintenance jobs (same calls as the printer's own web page buttons). */
async function kickJob(host: string, cgi: string) {
  const before = await requireIdle(host);
  const xml = await ruiPost(host, cgi, "");
  const res = result(xml);
  await new Promise((r) => setTimeout(r, 2500));
  const after = await status(host).catch(() => null);
  return {
    accepted: res !== "RW_NG",
    printerResult: res ?? null,
    lowInkBefore: before.ink.filter((t) => t.low).map((t) => t.color),
    stateAfter: after?.state,
  };
}

const hostArg = { host: z.string().optional().describe("Printer IP/hostname. Defaults to PIXMA_HOST or auto-discovery.") };
const dryRunArg = { dryRun: z.boolean().optional().describe("If true, only describe what would be sent; do nothing.") };

const server = new McpServer({ name: "canon-pixma-mcp", version: "0.1.0" });

// ---------------------------------------------------------------------------
// Level: read-only  (always available; never changes printer state)
// ---------------------------------------------------------------------------
server.registerTool(
  "printer_discover",
  {
    title: "Discover Canon printers",
    description: "Broadcast a Canon BJNP discovery on all local IPv4 subnets and list printers that answer (IP, MAC, model).",
    inputSchema: { timeoutMs: z.number().int().min(500).max(10000).optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ timeoutMs }) => json({ printers: await bjnp.discover(timeoutMs ?? 2000), accessLevel: ACCESS }),
);

server.registerTool(
  "printer_status",
  {
    title: "Printer status",
    description: "Current state, any operator-call / service-call errors (with Canon's explanation), and per-tank ink levels.",
    inputSchema: hostArg,
    annotations: { readOnlyHint: true },
  },
  async ({ host }) => {
    const h = await resolveHost(host);
    return json({ host: h, ...(await status(h)) });
  },
);

server.registerTool(
  "printer_ink_levels",
  {
    title: "Ink levels",
    description: "Per-tank ink remaining (%) with cartridge part numbers, plus the printer's own low/out warning flags.",
    inputSchema: hostArg,
    annotations: { readOnlyHint: true },
  },
  async ({ host }) => {
    const h = await resolveHost(host);
    const s = await status(h);
    let ruiWarnings: Array<{ slotIndex: number; level: number | null; warning: string }> = [];
    try {
      const xml = await ruiGet(h, "prninfo_data.cgi");
      ruiWarnings = [...xml.matchAll(/<INKREST(\d)>(\d+),(\d+),(\d+)<\/INKREST\d>/g)].map((m) => ({
        slotIndex: Number(m[1]),
        level: RUI_LEVELS[Number(m[3])] ?? null,
        warning: RUI_WARN[Number(m[4])] ?? "unknown",
      }));
    } catch { /* RUI optional */ }
    return json({ host: h, ink: s.ink, webUiWarnings: ruiWarnings, note: s.notes });
  },
);

server.registerTool(
  "printer_counters",
  {
    title: "Page counters",
    description: "Lifetime page counts (total, plain paper vs photo/other). Copy/fax/scan counters are omitted (garbage on printer-only models).",
    inputSchema: hostArg,
    annotations: { readOnlyHint: true },
  },
  async ({ host }) => {
    const h = await resolveHost(host);
    const xml = await ruiGet(h, "ut_get_use_record.cgi");
    return json({ host: h, product: children(xml, "PRODUCT_PRINT_COUNT") });
  },
);

server.registerTool(
  "printer_info",
  {
    title: "Printer info & settings",
    description: "Model, firmware, network configuration and current device settings (dry level, quiet mode, power save, paper gap...).",
    inputSchema: hostArg,
    annotations: { readOnlyHint: true },
  },
  async ({ host }) => {
    const h = await resolveHost(host);
    const [deviceId, ut, fw, lan, s] = await Promise.all([
      bjnp.getDeviceId(h).catch((e) => `error: ${e}`),
      ruiGet(h, "ut_data.cgi").catch(() => ""),
      ruiGet(h, "firm_version.cgi").catch(() => ""),
      ruiGet(h, "ut_get_lan_setting_info.cgi").catch(() => ""),
      status(h),
    ]);
    return json({
      host: h,
      model: deviceId.match(/MDL:([^;]+)/)?.[1],
      firmware: { current: tag(fw, "FIRM_CURRENT_VER"), latestKnownToPrinter: tag(fw, "FIRM_LATEST_VER") },
      settings: children(ut, "PAGE_UTILITY"),
      settingsFromStatus: s.settings,
      network: children(lan, "CONFIRM_LAN_SETTINGS"),
      deviceId,
      accessLevel: ACCESS,
    });
  },
);

server.registerTool(
  "printer_raw_status",
  {
    title: "Raw status fields",
    description: "Undecoded Canon BSCCe status fields (BST, DOC, DSC, CIR, CTK, MSI, ...) for debugging.",
    inputSchema: hostArg,
    annotations: { readOnlyHint: true },
  },
  async ({ host }) => {
    const h = await resolveHost(host);
    return json({ host: h, fields: parseFields(await bjnp.getStatusString(h)) });
  },
);

server.registerTool(
  "printer_explain_error",
  {
    title: "Explain error code",
    description: "Look up a Canon error/support code (e.g. 1688, 1700, 5B00) in the printer's own message table. Offline.",
    inputSchema: { code: z.string().describe("Code such as 1688, 5B00, DOC_1688") },
    annotations: { readOnlyHint: true },
  },
  async ({ code }) => {
    const c = code.toUpperCase().replace(/^(DOC|DSC|DWS)_/, "");
    const hits = Object.entries(ERROR_MESSAGES).filter(([k]) => k.split("_")[1] === c);
    return hits.length ? json(Object.fromEntries(hits)) : fail(`No entry for code ${code}`);
  },
);

// ---------------------------------------------------------------------------
// Level: operator  (routine, low-impact actions; may use a sheet of paper)
// ---------------------------------------------------------------------------
if (allowed("operator")) {
  server.registerTool(
    "printer_identify",
    {
      title: "Blink the printer",
      description: "Flash the printer's lamp so you can find it (IPP Identify-Printer). Harmless.",
      inputSchema: hostArg,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ host }) => json(await identifyPrinter(await resolveHost(host))),
  );

  server.registerTool(
    "printer_cancel_job",
    {
      title: "Cancel current job",
      description: "Cancel the job the printer is currently processing (same as the web UI's cancel).",
      inputSchema: { ...hostArg, ...dryRunArg },
      annotations: { destructiveHint: true },
    },
    async ({ host, dryRun }) => {
      const h = await resolveHost(host);
      if (dryRun) return json({ wouldPost: `http://${h}/rui/job_cancel.cgi` });
      const xml = await ruiPost(h, "job_cancel.cgi", "");
      return json({ printerResult: result(xml) ?? null, raw: xml });
    },
  );

  server.registerTool(
    "printer_nozzle_check",
    {
      title: "Print nozzle check pattern",
      description: "Print Canon's nozzle check pattern. Uses ONE sheet of paper (load plain A4/Letter in the rear tray) and a small amount of ink. Refuses unless the printer is idle with no errors.",
      inputSchema: { ...hostArg, ...dryRunArg },
      annotations: { destructiveHint: false },
    },
    async ({ host, dryRun }) => {
      const h = await resolveHost(host);
      if (dryRun) return json({ wouldCheck: "printer idle", wouldPost: `http://${h}/rui/ut_nozzle_check.cgi` });
      return json(await kickJob(h, "ut_nozzle_check.cgi"));
    },
  );

  // NOTE: quiet mode (rui/ut_silent_mode.cgi, SILENT_MODE=ON|OFF) is rejected (RW_NG) by the
  // PRO-100 fw 2.001 even when re-applying the current value, so it is intentionally not exposed.

  server.registerTool(
    "printer_set_custom_settings",
    {
      title: "Set custom settings",
      description: "Change ink drying time (dryLevel 1-5), paper-gap (abrasion prevention) and paper-width detection. Unspecified values keep their current setting. Reversible.",
      inputSchema: {
        ...hostArg,
        ...dryRunArg,
        dryLevel: z.number().int().min(1).max(5).optional(),
        paperGap: z.boolean().optional().describe("Prevent paper abrasion (wider head gap)"),
        detectPaperWidth: z.boolean().optional(),
      },
      annotations: { idempotentHint: true },
    },
    async ({ host, dryRun, dryLevel, paperGap, detectPaperWidth }) => {
      const h = await resolveHost(host);
      const cur = children(await ruiGet(h, "ut_data.cgi"), "PAGE_UTILITY");
      const pg = paperGap === undefined ? cur.PAPER_GAP : paperGap ? "1" : "0";
      const pw = detectPaperWidth === undefined ? cur.DETECT_PAPER_WIDTH : detectPaperWidth ? "1" : "0";
      const dl = dryLevel === undefined ? cur.DRY_LEVEL : String(dryLevel);
      const body = `SETINFO=0&PAPER_GAP=${pg}&DETECT_PAPER_WIDTH=${pw}&DRY_LEVEL=${dl}`;
      if (dryRun) return json({ current: cur, wouldPost: `http://${h}/rui/ut_data.cgi`, body });
      const xml = await ruiPost(h, "ut_data.cgi", body);
      const after = children(await ruiGet(h, "ut_data.cgi"), "PAGE_UTILITY");
      return json({ printerResult: result(xml), before: cur, after });
    },
  );
}

// ---------------------------------------------------------------------------
// Level: danger  (consumes significant ink, or experimental raw commands)
// ---------------------------------------------------------------------------
if (allowed("danger")) {
  const confirmArg = {
    confirm: z.literal(true).describe("Must be true. Confirms you accept the ink/paper cost and risk."),
  };
  const jobs: Array<[string, string, string, string]> = [
    ["printer_head_cleaning", "Print head cleaning", "ut_normal_cln.cgi",
      "Normal print-head cleaning (all colors). Uses a noticeable amount of ink from every tank. Only do this after a nozzle check shows gaps."],
    ["printer_deep_cleaning", "Deep print head cleaning", "ut_deep_cln.cgi",
      "Deep cleaning. Uses a LOT of ink (and fills the waste-ink absorber). Only after normal cleaning failed twice. Never repeat back-to-back."],
    ["printer_auto_head_alignment", "Automatic head alignment", "ut_auto_regi.cgi",
      "Prints an alignment pattern and scans it to align the head. Uses paper and ink; load plain paper first."],
    ["printer_platen_cleaning", "Bottom plate cleaning", "ut_platen_cln.cgi",
      "Bottom plate (platen) cleaning: feeds a sheet folded per Canon's manual to wipe the inside. Needs paper prepared first."],
  ];
  for (const [name, title, cgi, description] of jobs) {
    server.registerTool(
      name,
      {
        title,
        description: `${description} Refuses unless the printer is idle with no errors.`,
        inputSchema: { ...hostArg, ...dryRunArg, ...confirmArg },
        annotations: { destructiveHint: true, idempotentHint: false },
      },
      async ({ host, dryRun }) => {
        const h = await resolveHost(host);
        if (dryRun) return json({ wouldCheck: "printer idle", wouldPost: `http://${h}/rui/${cgi}` });
        return json(await kickJob(h, cgi));
      },
    );
  }

  server.registerTool(
    "printer_send_raw_bjl",
    {
      title: "EXPERIMENTAL: send raw BJL commands",
      description:
        "Send Canon BJL control lines (e.g. '@TESTPRINT=NOZZLECHECK') wrapped exactly as Canon's Mac utility does, over BJNP. " +
        "Settings-type BJL lines were observed to be ACKed but NOT applied on the PRO-100 over the network. " +
        "Unknown/unsupported lines may be silently ignored; some (e.g. @POWEROFF) cannot be undone remotely.",
      inputSchema: {
        ...hostArg,
        ...dryRunArg,
        ...confirmArg,
        lines: z.array(z.string().regex(/^[@A-Z0-9_=]+$/i, "BJL lines are [A-Za-z0-9_=@] only")).min(1).max(8),
      },
      annotations: { destructiveHint: true },
    },
    async ({ host, dryRun, lines }) => {
      const h = await resolveHost(host);
      const data = Buffer.concat([
        Buffer.from([0x1b, 0x40, 0x1b, 0x5b, 0x4b, 0x02, 0x00, 0x00, 0x1f]),
        Buffer.from("BJLSTART\nCONTROLMODE=COMMON\n" + lines.map((l) => l + "\n").join("") + "BJLEND\n", "ascii"),
      ]);
      if (dryRun) return json({ bytes: data.toString("latin1") });
      await requireIdle(h);
      const acked = await bjnp.sendJobData(h, data, "bjl");
      return json({ bytesSent: data.length, bytesAcknowledged: acked });
    },
  );
}

// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`canon-pixma-mcp running (access level: ${ACCESS}${CONFIGURED_HOST ? `, host: ${CONFIGURED_HOST}` : ", host: auto-discover"})`);
