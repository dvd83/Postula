// Outils partagés par les fonctions serveur Postula.
import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2.45.4";

const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") ?? "*").split(",").map((s) => s.trim()).filter(Boolean);

export function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allow = ALLOWED.includes("*") ? "*" : ALLOWED.includes(origin) ? origin : ALLOWED[0] ?? "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
  });
}

/** Erreur métier renvoyée au client avec un code stable. */
export class AppError extends Error {
  constructor(public code: string, public status = 400, public extra: Record<string, unknown> = {}) {
    super(code);
  }
}

const STATUS: Record<string, number> = {
  claim_required: 403, blocked: 403, expired: 402, quota_exceeded: 402,
  rate_limited: 429, rate_limited_day: 429, free_budget_exhausted: 503,
  session_over: 409, session_not_found: 404, no_profile: 403, bad_request: 400,
};
export const statusFor = (reason: string) => STATUS[reason] ?? 400;

export function admin(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function requireUser(req: Request, db: SupabaseClient): Promise<User> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new AppError("unauthorized", 401);
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new AppError("unauthorized", 401);
  return data.user;
}

export function clientIp(req: Request): string | null {
  const raw = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ??
    (req.headers.get("x-forwarded-for") ?? "").split(",")[0];
  const ip = (raw ?? "").trim();
  return /^[0-9a-f:.]+$/i.test(ip) && ip.length <= 45 ? ip : null;
}

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- Validation des entrées ---------- */
export function str(v: unknown, max: number, field: string, required = true): string {
  if (v === undefined || v === null || v === "") {
    if (required) throw new AppError("bad_request", 400, { field });
    return "";
  }
  if (typeof v !== "string") throw new AppError("bad_request", 400, { field });
  if (v.length > max) throw new AppError("too_large", 413, { field, max });
  return v;
}
export function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}
export function strList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, maxItems).filter((x) => typeof x === "string").map((x) => (x as string).slice(0, maxLen));
}

/* ---------- Appel IA (Anthropic) ---------- */
export type Tier = "quick" | "default";
const MODEL: Record<Tier, string> = {
  quick: Deno.env.get("MODEL_QUICK") ?? "claude-haiku-5-5",
  default: Deno.env.get("MODEL_DEFAULT") ?? "claude-sonnet-5-5",
};
// Prix en $ par million de jetons (entrée, sortie). Ajustables sans redéployer le code via les secrets.
const PRICE: Record<Tier, [number, number]> = {
  quick: [Number(Deno.env.get("PRICE_QUICK_IN") ?? 1), Number(Deno.env.get("PRICE_QUICK_OUT") ?? 5)],
  default: [Number(Deno.env.get("PRICE_DEFAULT_IN") ?? 3), Number(Deno.env.get("PRICE_DEFAULT_OUT") ?? 15)],
};

export interface LlmResult { text: string; cost: number }

async function callAnthropic(key: string, body: Record<string, unknown>) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let data: Record<string, any> = {};
  try { data = JSON.parse(raw); } catch { /* corps non JSON */ }
  return { ok: res.ok, status: res.status, raw, data };
}

export async function llm(opts: {
  tier: Tier; maxTokens: number; system?: string;
  messages: { role: "user" | "assistant"; content: string | Record<string, unknown>[] }[];
}): Promise<LlmResult> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new AppError("server_not_configured", 500);
  // Les modèles récents réfléchissent d'eux-mêmes (réflexion adaptative) et cette réflexion compte dans max_tokens.
  // On demande un effort faible (réponses directes, plus rapides) et on garde une marge pour la réflexion,
  // sinon la limite peut être atteinte avant le moindre mot de réponse.
  const room = (n: number) => Math.min(32000, n + 4000);
  const base: Record<string, unknown> = {
    model: MODEL[opts.tier], max_tokens: room(opts.maxTokens),
    ...(opts.system ? { system: opts.system } : {}),
    messages: opts.messages,
  };
  let withEffort = true;
  const call = (extra: Record<string, unknown> = {}) =>
    callAnthropic(key, { ...base, ...(withEffort ? { output_config: { effort: "low" } } : {}), ...extra });
  let r = await call();
  if (!r.ok && r.status === 400 && /effort|output_config/i.test(r.raw)) {
    console.error("anthropic_effort_refused", r.raw.slice(0, 300));
    withEffort = false; r = await call();
  }
  if (!r.ok) {
    console.error("anthropic", r.status, r.raw.slice(0, 600));
    throw new AppError(r.status === 429 || r.status === 529 ? "ai_busy" : "ai_error", 502);
  }
  const [pin, pout] = PRICE[opts.tier];
  let cost = 0;
  const read = (d: Record<string, any>) => {
    const u = d.usage ?? {};
    cost += ((u.input_tokens ?? 0) * pin + (u.output_tokens ?? 0) * pout) / 1e6;
    return (d.content ?? []).filter((c: { type: string }) => c.type === "text")
      .map((c: { text: string }) => c.text).join("").trim();
  };
  let text = read(r.data);
  if (!text) {
    // Réponse vide (limite atteinte pendant la réflexion, ou refus) : un nouvel essai avec beaucoup plus de marge
    console.error("anthropic_empty", r.data.stop_reason, JSON.stringify((r.data.content ?? []).map((c: { type: string }) => c.type)), JSON.stringify(r.data.usage ?? {}));
    if (r.data.stop_reason === "refusal") throw new AppError("ai_refused", 422);
    const retry = await call({ max_tokens: Math.min(32000, room(opts.maxTokens) * 2) });
    if (retry.ok) text = read(retry.data);
    else console.error("anthropic_retry", retry.status, retry.raw.slice(0, 300));
    if (!text) throw new AppError("ai_empty", 502);
  }
  return { text, cost };
}

/** Lit une réponse JSON de façon tolérante (bloc ```json, ou du premier { au dernier }). */
export function parseJson<T = unknown>(text: string): T {
  const tryParse = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };
  let v = tryParse(text);
  if (v !== undefined) return v;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { v = tryParse(fence[1]); if (v !== undefined) return v; }
  const a = text.search(/[[{]/), b = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (a >= 0 && b > a) { v = tryParse(text.slice(a, b + 1)); if (v !== undefined) return v; }
  throw new AppError("ai_invalid_json", 502);
}
