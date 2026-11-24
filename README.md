# canon-pixma-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant inspect and maintain a
**Canon PIXMA** inkjet printer over your LAN: ink levels, error codes (with Canon's own
explanations), page counters, settings, nozzle checks and cleaning.

No Canon driver needed. It talks to the printer directly using the same channels Canon's
software uses. Built on the official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk),
pure Node.js (no native modules), so it runs on Windows, macOS and Linux.

Developed and live-tested against a **Canon PIXMA PRO-100** (firmware 2.001). Other PIXMA models that
speak BJNP and have the "Remote UI" web page will likely work for the read-only tools.

## Access levels

The server starts in **read-only** mode. Higher levels must be chosen explicitly, and the tools
of a higher level are not even *registered* at a lower level, so the model can't see or call them.

| Level | Flag | What it can do |
|---|---|---|
| 🟢 **read-only** (default) | `--access read-only` | Inspect only: discover, status, errors, ink, counters, settings, raw status. Never changes the printer. |
| 🟡 **operator** | `--access operator` | Routine, low-impact actions: blink the printer, cancel a job, print a nozzle check (1 sheet), change dry level / paper gap / paper-width detection. |
| 🔴 **danger** | `--access danger` | Ink-hungry and experimental: head cleaning, **deep cleaning**, auto head alignment, platen cleaning, raw BJL commands. Each call also requires `confirm: true`. |

Every action tool supports `dryRun: true` to show what it would send without doing anything.
Job-starting tools refuse to run unless the printer reports idle with no errors.

## Tools

**read-only**
- `printer_discover`: find Canon printers on all local subnets (BJNP).
- `printer_status`: state, operator-call / service-call errors with Canon's text, per-tank ink.
- `printer_ink_levels`: % remaining, cartridge part numbers, the printer's low/out flags.
- `printer_counters`: lifetime page counts.
- `printer_info`: model, firmware, network, settings.
- `printer_raw_status`: undecoded Canon status fields.
- `printer_explain_error`: look up a code such as `1688`, `1700` or `5B00` (offline).

**operator**: `printer_identify`, `printer_cancel_job`, `printer_nozzle_check`, `printer_set_custom_settings`

**danger**: `printer_head_cleaning`, `printer_deep_cleaning`, `printer_auto_head_alignment`,
`printer_platen_cleaning`, `printer_send_raw_bjl`

## Install & configure

Requires Node.js 20+.

```bash
git clone https://github.com/andrejpk/canon-pixma-mcp.git
cd canon-pixma-mcp
npm install        # also builds dist/
```

Configuration (flags or environment variables):

| Flag | Env | Default |
|---|---|---|
| `--host <ip>` | `PIXMA_HOST` | auto-discover the first Canon printer |
| `--access <level>` | `PIXMA_ACCESS` | `read-only` |

### Claude Code

```bash
claude mcp add pixma -- node /path/to/canon-pixma-mcp/dist/index.js --host 192.168.1.50
# or, with routine actions enabled:
claude mcp add pixma -- node /path/to/canon-pixma-mcp/dist/index.js --host 192.168.1.50 --access operator
```

### Claude Desktop / other MCP clients

```json
{
  "mcpServers": {
    "pixma": {
      "command": "node",
      "args": ["C:\\path\\to\\canon-pixma-mcp\\dist\\index.js", "--host", "192.168.1.50"],
      "env": { "PIXMA_ACCESS": "read-only" }
    }
  }
}
```

Tip: run a separate `danger` instance only when you actually need cleaning, rather than leaving it configured.

## How it works

| Channel | Port | Used for |
|---|---|---|
| Canon **BJNP** | UDP/TCP 8611 | Status (Canon's internal `BSCCe` string: state, error codes, ink %, tank IDs), device ID, discovery, raw job data |
| Canon **Remote UI** backend | HTTP 80, `/rui/*.cgi` | Ink warnings, counters, settings, maintenance jobs (the same calls as the printer's web page buttons) |
| **IPP** | 631 | Identify-Printer (blink) |

The protocol details were worked out from the printer's own web UI JavaScript, Canon's GPL Linux
driver sources (cnijfilter), Canon's macOS IJ Printer Utility command tables, and SANE's BJNP code.

## What it can't do (on the PRO-100)

- **Override "ink out" / unknown-cartridge errors remotely.** Canon's override is physical: hold
  the Resume/Cancel button for ~5 seconds, which disables level detection for that tank. Canon's own utility
  doesn't offer an ink-detection toggle for this model, and there's no network command for it.
- **Reset the waste-ink absorber counter** (errors 1700 / 5B00 / 5B01). That needs the printer's
  service mode and a service tool, and isn't possible over the network.
- **Change settings via BJL.** The printer acknowledges BJL settings commands sent over the network
  but doesn't apply them. Settings changes go through the Remote UI instead.
- **Quiet mode.** The Remote UI rejects the quiet-mode call on this firmware, so it isn't exposed.

## Testing

```bash
npm test                               # offline: decoder + per-level tool exposure
node scripts/smoke.mjs <printer-ip>    # live, SAFE: read-only calls, blink, dry runs, no-op writes
```

The live smoke test never starts a cleaning or prints anything.

## Security note

The printer's web interface and BJNP have **no authentication**. Anyone on your LAN can already do
everything this server can. Consider setting an admin password in the printer's web UI.

## Disclaimer

Not affiliated with Canon. Cleaning cycles use real ink and fill the printer's waste-ink absorber;
use the danger level deliberately. MIT licensed.
