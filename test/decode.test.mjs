// Offline unit tests (no printer needed): node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeStatus } from "../dist/decode.js";

// Captured from a real PRO-100 (fw 2.001)
const SAMPLE =
  "BST:00;PID:00,00,00;CHD:LS;LVR:GAL,AT;MID:000000;CTK:M,SET,/,LC,SET,/,Y,SET,/,PBK,SET,/,GY,SET,/,LM,SET,/,LGY,SET,/,C,SET;" +
  "CIR:M=080,LC=100,Y=100,PBK=100,GY=020,LM=080,LGY=020,C=020;DJS:NO;DBS:NO;DWS:NO;DOC:4,00,NO;DSC:NO;" +
  "MSI:AOFF,B240,DAT,E3,FOFF,HASF,JOFF,K21000700;TCA:M,AC,/,LC,DC,/,Y,AC,/,PBK,AC,/,GY,AC,/,LM,DC,/,LGY,AC,/,C,DC;" +
  "TNI:M,CLI-42M,/,LC,CLI-42PC,/,Y,CLI-42Y,/,PBK,CLI-42BK,/,GY,CLI-42GY,/,LM,CLI-42PM,/,LGY,CLI-42LGY,/,C,CLI-42C;";

test("decodes idle PRO-100 status", () => {
  const s = decodeStatus(SAMPLE);
  assert.equal(s.state, "idle / ready");
  assert.equal(s.hasError, false);
  assert.equal(s.ink.length, 8);
  const cyan = s.ink.find((t) => t.slot === "C");
  assert.deepEqual([cyan.percentRemaining, cyan.cartridge, cyan.installed], [20, "CLI-42C", "SET"]);
  assert.equal(s.settings.dryLevel, "3");
  assert.equal(s.settings.autoPowerOffMinutes, "240");
});

test("explains operator and service calls", () => {
  const s = decodeStatus(SAMPLE.replace("DOC:4,00,NO", "DOC:4,00,1688").replace("DSC:NO", "DSC:5B01"));
  assert.equal(s.hasError, true);
  assert.equal(s.operatorCall.code, "1688");
  assert.match(s.operatorCall.message, /ink has run out/i);
  assert.match(s.serviceCall.message, /absorber/i);
});
