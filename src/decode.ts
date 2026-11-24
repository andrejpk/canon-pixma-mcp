// Decoding of Canon's BSCCe status string and Remote UI ink data.
import { ERROR_MESSAGES } from "./errors.js";

export type Fields = Record<string, string>;

export function parseFields(status: string): Fields {
  const out: Fields = {};
  for (const part of status.split(";")) {
    const i = part.indexOf(":");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/** "M,SET,/,LC,SET" -> { M: ["SET"], LC: ["SET"] } */
export function perTank(value: string | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!value) return out;
  for (const grp of value.split(",/,")) {
    const [k, ...rest] = grp.split(",");
    if (k) out[k] = rest;
  }
  return out;
}

const BST: Record<string, string> = {
  "00": "idle / ready",
  "01": "busy with another task",
  "02": "operating",
  "03": "error",
  "04": "check printer",
  "05": "cleaning in progress",
  "06": "test print in progress",
  "07": "ink maintenance in progress",
};

const COLOR_NAMES: Record<string, string> = {
  BK: "Black", PBK: "Photo Black", MBK: "Matte Black", C: "Cyan", M: "Magenta", Y: "Yellow",
  LC: "Photo Cyan", PC: "Photo Cyan", LM: "Photo Magenta", PM: "Photo Magenta", GY: "Gray",
  LGY: "Light Gray", R: "Red", CO: "Chroma Optimizer",
};

// MSI (machine setting info) letters, from Canon's cnijfilter util_msi.h
const MSI_KEYS: Record<string, string> = {
  A: "autoPowerOn", B: "autoPowerOffMinutes", C: "autoPowerOffBattery", D: "paperGap", E: "dryLevel",
  F: "pageSizeDetection", H: "plainPaperFeeder", J: "silentMode", K: "silentTime", L: "preventDoubleFeed",
};

export function decodeMsi(v: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of (v ?? "").split(",")) {
    if (!item) continue;
    const key = MSI_KEYS[item[0]] ?? `msi_${item[0]}`;
    out[key] = item.slice(1);
  }
  return out;
}

function explain(prefix: string, code: string | undefined): { code: string; message: string } | null {
  if (!code || code === "NO") return null;
  return { code, message: ERROR_MESSAGES[`${prefix}_${code}`] ?? ERROR_MESSAGES[`${prefix}_ETC`] ?? "Unknown code" };
}

export interface InkTank {
  slot: string;
  color: string;
  percentRemaining: number | null;
  installed: string;
  cartridge?: string;
  tcaFlag?: string;
  low: boolean;
}

export function decodeStatus(raw: string) {
  const f = parseFields(raw);
  const cir: Record<string, string> = {};
  for (const kv of (f.CIR ?? "").split(",")) {
    const [k, v] = kv.split("=");
    if (k && v !== undefined) cir[k] = v;
  }
  const ctk = perTank(f.CTK);
  const tni = perTank(f.TNI);
  const tca = perTank(f.TCA);
  const ink: InkTank[] = Object.keys(cir).map((slot) => {
    const pct = /^\d+$/.test(cir[slot]) ? Number(cir[slot]) : null;
    return {
      slot,
      color: COLOR_NAMES[slot] ?? slot,
      percentRemaining: pct,
      installed: ctk[slot]?.[0] ?? "unknown",
      cartridge: tni[slot]?.[0],
      tcaFlag: tca[slot]?.[0],
      low: pct !== null && pct <= 15,
    };
  });
  const doc = (f.DOC ?? "").split(",");
  const operatorCall = explain("DOC", doc[2]);
  const serviceCall = explain("DSC", f.DSC);
  const warning = explain("DWS", f.DWS);
  return {
    state: BST[f.BST] ?? `unknown (${f.BST})`,
    stateCode: f.BST,
    hasError: !!(operatorCall || serviceCall),
    operatorCall,
    serviceCall,
    warning,
    busy: f.DBS && f.DBS !== "NO" ? f.DBS : null,
    jobStatus: f.DJS && f.DJS !== "NO" ? f.DJS : null,
    ink,
    settings: decodeMsi(f.MSI),
    printHead: f.CHD,
    serialHint: f.MID,
    notes:
      "Ink % is Canon's dot-count estimate in 10% steps; the printer warns at <=15%. " +
      "tcaFlag (AC/DC) is an undocumented per-tank flag.",
  };
}

// Remote UI INKREST triples: [colorIndex, levelStep 0..11 (100%..0%, 11=unknown), warn 0..3]
export const RUI_LEVELS = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0, null];
export const RUI_WARN = ["ok", "low", "out", "unknown"];
