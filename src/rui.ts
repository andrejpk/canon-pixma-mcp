// Canon "Remote UI" backend: POST http://<printer>/rui/<name>.cgi with form data, XML reply.
// Endpoints and payloads were taken from the printer's own web UI JavaScript (fw 2.001).

export async function ruiPost(host: string, cgi: string, body: string, tries = 3): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(`http://${host}/rui/${cgi}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const text = await res.text();
      // The embedded web server sometimes returns an empty body; retry.
      if (text.trim()) return text;
      lastErr = new Error(`Empty reply from ${cgi}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Read endpoint (GETINFO=0). */
export const ruiGet = (host: string, cgi: string) => ruiPost(host, cgi, "GETINFO=0");

/** Flat-XML helpers: the RUI responses are shallow and never contain attributes we need. */
export function tag(xml: string, name: string): string | undefined {
  return xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];
}

export function children(xml: string, parent: string): Record<string, string> {
  const inner = tag(xml, parent);
  const out: Record<string, string> = {};
  if (!inner) return out;
  for (const m of inner.matchAll(/<([A-Z0-9_]+)>([^<]*)<\/\1>/g)) out[m[1]] = m[2];
  return out;
}

export function result(xml: string): string | undefined {
  return tag(xml, "RESULT");
}
