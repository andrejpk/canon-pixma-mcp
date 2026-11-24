// Minimal IPP client for the one operation we need that has no Canon-specific equivalent:
// Identify-Printer (RFC 8011 / PWG 5100.13) — makes the printer flash its lamp.
import http from "node:http";

function attr(tagByte: number, name: string, value: string): Buffer {
  const n = Buffer.from(name, "utf8");
  const v = Buffer.from(value, "utf8");
  const b = Buffer.alloc(1 + 2 + n.length + 2 + v.length);
  let o = b.writeUInt8(tagByte, 0);
  o = b.writeUInt16BE(n.length, o);
  o += n.copy(b, o);
  o = b.writeUInt16BE(v.length, o);
  v.copy(b, o);
  return b;
}

export async function identifyPrinter(host: string): Promise<{ statusCode: number; ok: boolean }> {
  const uri = `ipp://${host}/ipp/print`;
  const body = Buffer.concat([
    Buffer.from([0x02, 0x00, 0x00, 0x3c, 0x00, 0x00, 0x00, 0x01]), // IPP 2.0, Identify-Printer, request-id 1
    Buffer.from([0x01]), // operation-attributes-tag
    attr(0x47, "attributes-charset", "utf-8"),
    attr(0x48, "attributes-natural-language", "en"),
    attr(0x45, "printer-uri", uri),
    attr(0x44, "identify-actions", "flash"),
    Buffer.from([0x03]), // end-of-attributes
  ]);
  // node:http rather than fetch: the printer sends an unsolicited "100 Continue" that undici rejects.
  const buf = await new Promise<Buffer>((resolve, reject) => {
    const req = http.request(
      { host, port: 631, path: "/ipp/print", method: "POST", timeout: 10000,
        headers: { "Content-Type": "application/ipp", "Content-Length": body.length } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      },
    );
    req.on("timeout", () => req.destroy(new Error("IPP timeout")));
    req.on("error", reject);
    req.end(body);
  });
  const statusCode = buf.length >= 4 ? buf.readUInt16BE(2) : -1;
  return { statusCode, ok: statusCode >= 0 && statusCode < 0x100 };
}
