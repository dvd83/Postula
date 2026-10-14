// Débloque l'offre Découverte, une seule fois par personne.
// Contrôles : connexion Google/Apple, captcha Turnstile, une découverte par appareil, plafond par IP.
import { admin, AppError, clientIp, cors, json, requireUser, sha256, str } from "../_shared/common.ts";

const FREE_PROVIDERS = (Deno.env.get("FREE_PROVIDERS") ?? "google,apple").split(",");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  try {
    const db = admin();
    const user = await requireUser(req, db);
    const body = await req.json().catch(() => ({}));
    const turnstileToken = str(body.turnstileToken, 4096, "turnstileToken");
    const deviceId = str(body.deviceId, 200, "deviceId");
    const ip = clientIp(req);

    // 1. Connexion Google ou Apple obligatoire pour le gratuit
    const providers: string[] = [
      user.app_metadata?.provider,
      ...((user.app_metadata?.providers as string[] | undefined) ?? []),
    ].filter(Boolean);
    if (!providers.some((p) => FREE_PROVIDERS.includes(p))) throw new AppError("provider_not_allowed", 403);

    // 2. Déjà débloqué ?
    const { data: prof } = await db.from("profiles").select("free_claimed_at, blocked").eq("id", user.id).single();
    if (!prof) throw new AppError("no_profile", 403);
    if (prof.blocked) throw new AppError("blocked", 403);
    if (prof.free_claimed_at) return json(req, { ok: true, already: true });

    // 3. Captcha
    const secret = Deno.env.get("TURNSTILE_SECRET");
    if (!secret) throw new AppError("server_not_configured", 500);
    const form = new FormData();
    form.append("secret", secret);
    form.append("response", turnstileToken);
    if (ip) form.append("remoteip", ip);
    const ts = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form })
      .then((r) => r.json()).catch(() => ({ success: false }));
    if (!ts.success) throw new AppError("captcha_failed", 403);

    // 4. Plafond par adresse IP (sans bannir : colocations, écoles)
    if (ip) {
      const { data: s } = await db.from("app_settings").select("value").eq("key", "max_claims_per_ip_30d").single();
      const max = Number(s?.value ?? 2);
      const since = new Date(Date.now() - 30 * 86400_000).toISOString();
      const { count } = await db.from("free_claims").select("id", { count: "exact", head: true })
        .eq("ip", ip).gte("created_at", since);
      if ((count ?? 0) >= max) throw new AppError("ip_limit", 429);
    }

    // 5. Une découverte par appareil (empreinte salée, jamais stockée en clair)
    const deviceHash = await sha256(`${Deno.env.get("DEVICE_SALT") ?? "postula"}:${deviceId}`);
    const { error: insErr } = await db.from("free_claims").insert({ user_id: user.id, device_hash: deviceHash, ip });
    if (insErr) {
      if (insErr.code === "23505") throw new AppError("device_used", 409);
      throw insErr;
    }
    await db.from("profiles").update({ free_claimed_at: new Date().toISOString() }).eq("id", user.id);
    return json(req, { ok: true });
  } catch (e) {
    if (e instanceof AppError) return json(req, { error: e.code, ...e.extra }, e.status);
    console.error(e);
    return json(req, { error: "server_error" }, 500);
  }
});
