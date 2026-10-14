// Lecture d'une annonce publique à partir de son lien.
// Règles : uniquement des pages publiques (pas de compte), respect du robots.txt du site,
// une seule page lue par demande, identifiée honnêtement (PostulaBot), taille et durée limitées.
import { AppError } from "./common.ts";

const UA = "Mozilla/5.0 (compatible; PostulaBot/1.0; +https://postula.pages.dev)";
const BOT = "postulabot";
const MAX_BYTES = 3_000_000;

function safeUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new AppError("fetch_bad_url", 400); }
  if (!["http:", "https:"].includes(u.protocol)) throw new AppError("fetch_bad_url", 400);
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || /^[\d.]+$/.test(h) || h.includes(":") || h.endsWith(".local") || h.endsWith(".internal") || h === "localhost") {
    throw new AppError("fetch_bad_url", 400);
  }
  if (u.port && !["80", "443"].includes(u.port)) throw new AppError("fetch_bad_url", 400);
  u.hash = "";
  return u;
}

async function get(url: string, ms: number, accept: string): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { "User-Agent": UA, "Accept": accept, "Accept-Language": "fr-CH,fr;q=0.9,de;q=0.7,en;q=0.6" } });
  } finally { clearTimeout(t); }
}

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = []; let n = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length; chunks.push(value);
    if (n > max) { await reader.cancel(); break; }
  }
  const all = new Uint8Array(n); let o = 0;
  for (const c of chunks) { all.set(c.subarray(0, Math.min(c.length, n - o)), o); o += c.length; if (o >= n) break; }
  return new TextDecoder("utf-8").decode(all);
}

/* ---------- robots.txt (RFC 9309, version simple) ---------- */
function ruleMatch(pattern: string, path: string): boolean {
  const end = pattern.endsWith("$");
  const p = (end ? pattern.slice(0, -1) : pattern).replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + p + (end ? "$" : "")).test(path);
}
async function robotsAllowed(u: URL): Promise<boolean> {
  let res: Response;
  try { res = await get(`${u.origin}/robots.txt`, 5000, "text/plain"); } catch { return true; }
  if (res.status >= 500) return false;          // serveur en erreur : on s'abstient
  if (!res.ok) return true;                     // pas de robots.txt : tout est permis
  const txt = (await readCapped(res, 500_000)).replace(/\r/g, "");
  type G = { agents: string[]; rules: { allow: boolean; path: string }[] };
  const groups: G[] = []; let cur: G | null = null; let lastWasAgent = false;
  for (const line0 of txt.split("\n")) {
    const line = line0.replace(/#.*/, "").trim(); if (!line) continue;
    const i = line.indexOf(":"); if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    if (k === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase()); lastWasAgent = true;
    } else if ((k === "allow" || k === "disallow") && cur) {
      lastWasAgent = false;
      if (v) cur.rules.push({ allow: k === "allow", path: v });
    } else lastWasAgent = false;
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && BOT.includes(a.split("/")[0])));
  const use = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  const path = u.pathname + u.search;
  let best: { allow: boolean; len: number } | null = null;
  for (const r of use.flatMap((g) => g.rules)) {
    if (!ruleMatch(r.path, path)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
  }
  return best ? best.allow : true;
}

/* ---------- HTML → texte ---------- */
const ENT: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", eacute: "é", egrave: "è", ecirc: "ê", euml: "ë",
  agrave: "à", acirc: "â", auml: "ä", ccedil: "ç", icirc: "î", iuml: "ï", ocirc: "ô", ouml: "ö", ugrave: "ù",
  ucirc: "û", uuml: "ü", Eacute: "É", Egrave: "È", Agrave: "À", Ccedil: "Ç", Ouml: "Ö", Uuml: "Ü", Auml: "Ä",
  szlig: "ß", laquo: "«", raquo: "»", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—",
  hellip: "…", euro: "€", bull: "•", middot: "·", oelig: "œ", deg: "°",
};
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return ""; } }
    return ENT[e] ?? m;
  });
}
function htmlToText(html: string): string {
  let s = html
    .replace(/<(script|style|noscript|svg|template|iframe|form|button|select)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|section|article|tr|table|dd|dt)>/gi, "\n")
    .replace(/<h[1-6]\b[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");
  s = decode(s).replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n")
    .replace(/\n+- /g, "\n- ").replace(/ +([.,])/g, "$1");
  return s.trim();
}

function findJobPosting(v: unknown): Record<string, any> | null {
  if (!v || typeof v !== "object") return null;
  if (Array.isArray(v)) { for (const x of v) { const f = findJobPosting(x); if (f) return f; } return null; }
  const o = v as Record<string, any>;
  const t = o["@type"]; if (t === "JobPosting" || (Array.isArray(t) && t.includes("JobPosting"))) return o;
  if (o["@graph"]) return findJobPosting(o["@graph"]);
  return null;
}
function fromJsonLd(html: string): string | null {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let data: unknown; try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const j = findJobPosting(data); if (!j) continue;
    const org = typeof j.hiringOrganization === "object" ? j.hiringOrganization?.name : j.hiringOrganization;
    const locs = (Array.isArray(j.jobLocation) ? j.jobLocation : [j.jobLocation]).filter(Boolean)
      .map((l: any) => [l?.address?.addressLocality, l?.address?.addressRegion].filter(Boolean).join(", ")).filter(Boolean);
    const emp = Array.isArray(j.employmentType) ? j.employmentType.join(", ") : j.employmentType;
    const desc = htmlToText(decode(String(j.description ?? "")));
    const head = [
      j.title && `Poste : ${decode(String(j.title))}`, org && `Entreprise : ${decode(String(org))}`,
      locs.length && `Lieu : ${locs.join(" ; ")}`, emp && `Type de contrat : ${emp}`,
      j.datePosted && `Publiée le : ${String(j.datePosted).slice(0, 10)}`,
    ].filter(Boolean).join("\n");
    if (desc.length > 150) return `${head}\n\n${desc}`;
  }
  return null;
}
function fromPage(html: string): string {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim());
  let body = html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? html.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ?? html.match(/<body\b[\s\S]*<\/body>/i)?.[0] ?? html;
  body = body.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");
  const text = htmlToText(body);
  return (title ? title + "\n\n" : "") + text;
}

export async function fetchOffer(raw: string): Promise<{ text: string; host: string; source: string }> {
  const u = safeUrl(raw);
  const host = u.hostname.replace(/^www\./, "");
  if (/(^|\.)linkedin\.com$/.test(host)) throw new AppError("fetch_blocked", 422, { host });
  if (!(await robotsAllowed(u))) throw new AppError("fetch_blocked", 422, { host });
  let res: Response;
  try { res = await get(u.toString(), 9000, "text/html,application/xhtml+xml"); }
  catch { throw new AppError("fetch_failed", 422, { host }); }
  if (!res.ok) { console.error("fetch_offer", host, res.status); throw new AppError(res.status === 401 || res.status === 403 ? "fetch_blocked" : "fetch_failed", 422, { host }); }
  const finalHost = (() => { try { return new URL(res.url).hostname; } catch { return host; } })();
  if (/(^|\.)linkedin\.com$/.test(finalHost)) throw new AppError("fetch_blocked", 422, { host });
  const ct = res.headers.get("content-type") ?? "";
  if (ct && !/html|xml/i.test(ct)) throw new AppError("fetch_failed", 422, { host });
  const html = await readCapped(res, MAX_BYTES);
  const ld = fromJsonLd(html);
  const text = (ld ?? fromPage(html)).slice(0, 15000);
  if (text.replace(/\s+/g, " ").length < 200) throw new AppError("fetch_empty", 422, { host });
  return { text, host, source: ld ? "jsonld" : "page" };
}
