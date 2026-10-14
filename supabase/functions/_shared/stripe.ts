// Appels à l'API Stripe sans SDK (fetch + formulaire encodé) et vérification de signature des webhooks.
import { AppError } from "./common.ts";

const API = "https://api.stripe.com/v1";
const VERSION = "2024-06-20"; // version figée : formats de réponse stables pour nos appels

type Params = Record<string, unknown>;

function encode(params: Params, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === "object") encode(item as Params, `${key}[${i}]`, out);
        else out.append(`${key}[]`, String(item));
      });
    } else if (typeof v === "object") encode(v as Params, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripe<T = Record<string, unknown>>(
  method: "GET" | "POST", path: string, params: Params = {},
): Promise<T> {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new AppError("payments_not_configured", 503);
  const body = encode(params);
  const url = method === "GET" && [...body.keys()].length ? `${API}${path}?${body}` : `${API}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Stripe-Version": VERSION,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: method === "POST" ? body : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("stripe", method, path, res.status, JSON.stringify(data?.error ?? data));
    throw new AppError("payment_error", 502);
  }
  return data as T;
}

/** Vérifie l'en-tête Stripe-Signature (HMAC SHA-256, tolérance 5 min). */
export async function verifyStripeSignature(payload: string, header: string | null, secret: string): Promise<boolean> {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.split("=") as [string, string]);
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => timingSafeEqual(s, expected));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
