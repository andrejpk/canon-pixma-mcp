// Canon BJNP protocol (UDP/TCP port 8611) — status, identity, discovery, raw job data.
// Packet layout per SANE's pixma_bjnp_private.h: "BJNP", devType, cmd, 0, seq, session, payloadLen.
import dgram from "node:dgram";
import net from "node:net";
import os from "node:os";

export const BJNP_PORT = 8611;
const DEV_PRINTER = 0x01;
const CMD_DISCOVER = 0x01;
const CMD_JOB_DETAILS = 0x10;
const CMD_CLOSE = 0x11;
const CMD_GET_STATUS = 0x20; // UDP: status; TCP: read request
const CMD_TCP_SEND = 0x21;
const CMD_GET_ID = 0x30;

let seqCounter = 1;

export function header(cmd: number, payloadLen: number, session = 0): Buffer {
  const b = Buffer.alloc(16);
  b.write("BJNP", 0, "ascii");
  b.writeUInt8(DEV_PRINTER, 4);
  b.writeUInt8(cmd, 5);
  b.writeInt16BE(0, 6);
  b.writeInt16BE(seqCounter++ & 0x7fff, 8);
  b.writeUInt16BE(session, 10);
  b.writeUInt32BE(payloadLen, 12);
  return b;
}

/** Send one UDP packet and wait for a single reply (with retries). */
export async function udpRequest(host: string, packet: Buffer, timeoutMs = 2500, retries = 2): Promise<Buffer> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        const sock = dgram.createSocket("udp4");
        const timer = setTimeout(() => {
          sock.close();
          reject(new Error(`BJNP UDP timeout talking to ${host}:${BJNP_PORT}`));
        }, timeoutMs);
        sock.on("message", (msg) => {
          clearTimeout(timer);
          sock.close();
          resolve(msg);
        });
        sock.on("error", (e) => {
          clearTimeout(timer);
          sock.close();
          reject(e);
        });
        sock.send(packet, BJNP_PORT, host);
      });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** IEEE-1284 device ID string, e.g. "MFG:Canon;CMD:BJL,...;MDL:PRO-100 series;..." */
export async function getDeviceId(host: string): Promise<string> {
  const r = await udpRequest(host, header(CMD_GET_ID, 0));
  return r.subarray(18).toString("utf8").replace(/\0+$/, "");
}

/** Raw "BSCCe" status string from the printer (the same data Canon's drivers read). */
export async function getStatusString(host: string): Promise<string> {
  const r = await udpRequest(host, header(CMD_GET_STATUS, 0));
  const xml = r.subarray(16).toString("utf8");
  const m = xml.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (!m) throw new Error("Printer status reply did not contain a BSCCe status block");
  return m[1];
}

export interface DiscoveredPrinter {
  ip: string;
  mac: string;
  deviceId?: string;
  model?: string;
}

const toInt = (ip: string) => ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
const toIp = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");

/**
 * Targets for discovery: global + per-subnet broadcast, plus every host address on small local
 * subnets (<= /22). Some Canon firmware (e.g. PRO-100) ignores broadcast discovery and only
 * answers unicast, so the sweep is what actually finds them.
 */
function discoveryTargets(): string[] {
  const out = new Set<string>(["255.255.255.255"]);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const ip = toInt(a.address);
      const mask = toInt(a.netmask);
      const net = (ip & mask) >>> 0;
      const bcast = (net | (~mask >>> 0)) >>> 0;
      out.add(toIp(bcast));
      if (bcast - net <= 1024) for (let h = net + 1; h < bcast; h++) if (h !== ip) out.add(toIp(h));
    }
  }
  return [...out];
}

/** Broadcast a BJNP discover on every local IPv4 subnet and collect Canon printers that answer. */
export async function discover(timeoutMs = 2000): Promise<DiscoveredPrinter[]> {
  const found = new Map<string, DiscoveredPrinter>();
  await new Promise<void>((resolve) => {
    const sock = dgram.createSocket("udp4");
    sock.on("message", (msg, rinfo) => {
      if (msg.length < 16 || msg.toString("ascii", 0, 4) !== "BJNP") return;
      const body = msg.subarray(16);
      const mac = body.length >= 12 ? [...body.subarray(6, 12)].map((x) => x.toString(16).padStart(2, "0")).join(":") : "";
      found.set(rinfo.address, { ip: rinfo.address, mac });
    });
    sock.on("error", () => resolve());
    sock.bind(async () => {
      sock.setBroadcast(true);
      const pkt = header(CMD_DISCOVER, 0);
      const targets = discoveryTargets();
      // Two rounds: UDP is lossy and some printers drop the first probe while busy.
      for (let round = 0; round < 2; round++) {
        for (let i = 0; i < targets.length; i++) {
          if (round && found.has(targets[i])) continue;
          sock.send(pkt, BJNP_PORT, targets[i], () => undefined);
          if (i % 64 === 63) await new Promise((r) => setTimeout(r, 5)); // pace the sweep
        }
        await new Promise((r) => setTimeout(r, Math.min(600, timeoutMs / 3)));
      }
    });
    setTimeout(() => {
      sock.close();
      resolve();
    }, timeoutMs);
  });
  const printers = [...found.values()];
  await Promise.all(
    printers.map(async (p) => {
      try {
        p.deviceId = await getDeviceId(p.ip);
        p.model = p.deviceId.match(/MDL:([^;]+)/)?.[1];
      } catch {
        /* ignore */
      }
    }),
  );
  return printers;
}

function utf16be(s: string, bytes: number): Buffer {
  const b = Buffer.alloc(bytes);
  const src = Buffer.from(s, "utf16le").swap16();
  src.copy(b, 0, 0, Math.min(bytes, src.length));
  return b;
}

/**
 * Deliver raw bytes as a BJNP print session: UDP job-details (gets a session id),
 * TCP send, then UDP close. Returns the byte count the printer acknowledged.
 */
export async function sendJobData(host: string, data: Buffer, jobTitle = "canon-pixma-mcp"): Promise<number> {
  const details = Buffer.concat([
    Buffer.alloc(8),
    utf16be("canon-pixma-mcp", 64),
    utf16be("mcp", 64),
    utf16be(jobTitle, 256),
  ]);
  const resp = await udpRequest(host, Buffer.concat([header(CMD_JOB_DETAILS, details.length), details]));
  const session = resp.readUInt16BE(10);
  try {
    return await new Promise<number>((resolve, reject) => {
      const sock = net.createConnection({ host, port: BJNP_PORT, timeout: 8000 });
      let buf = Buffer.alloc(0);
      sock.on("connect", () => sock.write(Buffer.concat([header(CMD_TCP_SEND, data.length, session), data])));
      sock.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length >= 20) {
          sock.end();
          resolve(buf.readUInt32BE(16));
        }
      });
      sock.on("timeout", () => {
        sock.destroy();
        reject(new Error("BJNP TCP timeout"));
      });
      sock.on("error", reject);
    });
  } finally {
    await udpRequest(host, header(CMD_CLOSE, 0, session), 1500, 0).catch(() => undefined);
  }
}
