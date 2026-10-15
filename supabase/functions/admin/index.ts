// Espace administrateur : réservé aux comptes marqués is_admin dans la base (vérifié à chaque appel, côté serveur).
import { admin, AppError, cors, json, requireUser, str } from "../_shared/common.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

const PLANS = ["monthly", "pass3m"] as const;
const isUuid = (v: unknown) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

async function log(db: SupabaseClient, adminId: string, target: string | null, action: string, details: Record<string, unknown> = {}) {
  await db.from("admin_log").insert({ admin_id: adminId, target_id: target, action, details });
}
async function target(db: SupabaseClient, b: Record<string, unknown>) {
  if (!isUuid(b.userId)) throw new AppError("bad_request", 400, { field: "userId" });
  const { data, error } = await db.from("profiles").select("*").eq("id", b.userId as string).maybeSingle();
  if (error) { console.error(error); throw new AppError("server_error", 500); }
  if (!data) throw new AppError("user_not_found", 404);
  return data as Record<string, any>;
}
async function update(db: SupabaseClient, id: string, patch: Record<string, unknown>) {
  const { error } = await db.from("profiles").update(patch).eq("id", id);
  if (error) { console.error(error); throw new AppError("server_error", 500); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  try {
    const db = admin();
    const user = await requireUser(req, db);
    const { data: me } = await db.from("profiles").select("is_admin").eq("id", user.id).maybeSingle();
    if (!me?.is_admin) throw new AppError("forbidden", 403);
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(b.action ?? "");

    if (action === "stats") {
      const { data, error } = await db.rpc("admin_stats");
      if (error) { console.error(error); throw new AppError("server_error", 500); }
      return json(req, { ok: true, result: data });
    }
    if (action === "users") {
      const q = str(b.q, 200, "q", false).trim();
      const page = Math.max(0, Math.min(1000, Number(b.page) || 0));
      const { data, error } = await db.rpc("admin_users", { p_q: q || null, p_limit: 50, p_offset: page * 50 });
      if (error) { console.error(error); throw new AppError("server_error", 500); }
      return json(req, { ok: true, result: data });
    }

    const t = await target(db, b);
    const self = t.id === user.id;

    if (action === "grant") {
      // Offre un abonnement (sans paiement) pour un nombre de jours donné
      const plan = PLANS.includes(b.plan as typeof PLANS[number]) ? b.plan as string : "monthly";
      const days = Math.round(Number(b.days));
      if (!(days >= 1 && days <= 3650)) throw new AppError("bad_request", 400, { field: "days" });
      const now = new Date(), end = new Date(now.getTime() + days * 86400_000);
      await update(db, t.id, { plan, period_start: now.toISOString(), period_end: end.toISOString(), gift: true, blocked: false });
      await log(db, user.id, t.id, "grant", { plan, days, until: end.toISOString() });
    } else if (action === "revoke") {
      // Retire une offre attribuée à la main ; les abonnements payés se gèrent dans Stripe
      if (t.stripe_subscription_id && !t.gift) throw new AppError("stripe_managed", 409);
      await update(db, t.id, { plan: "free", period_end: null, gift: false });
      await log(db, user.id, t.id, "revoke", { previous: t.plan });
    } else if (action === "extra") {
      const n = Math.round(Number(b.n));
      if (!(n >= -100 && n <= 100) || n === 0) throw new AppError("bad_request", 400, { field: "n" });
      await update(db, t.id, { extra_interviews: Math.max(0, (t.extra_interviews ?? 0) + n) });
      await log(db, user.id, t.id, "extra_interviews", { n });
    } else if (action === "free") {
      // Débloque l'offre Découverte sans la vérification d'appareil
      await update(db, t.id, { free_claimed_at: new Date().toISOString() });
      await log(db, user.id, t.id, "grant_free");
    } else if (action === "block") {
      if (self) throw new AppError("not_on_self", 400);
      const blocked = b.blocked === true;
      await update(db, t.id, { blocked });
      await log(db, user.id, t.id, blocked ? "block" : "unblock");
    } else if (action === "admin") {
      if (self) throw new AppError("not_on_self", 400);
      const on = b.on === true;
      await update(db, t.id, { is_admin: on });
      await log(db, user.id, t.id, on ? "make_admin" : "remove_admin");
    } else if (action === "note") {
      const note = str(b.note, 1000, "note", false);
      await update(db, t.id, { note: note || null });
      await log(db, user.id, t.id, "note");
    } else {
      throw new AppError("unknown_action", 400);
    }
    return json(req, { ok: true, result: { userId: t.id } });
  } catch (e) {
    if (e instanceof AppError) return json(req, { error: e.code, ...e.extra }, e.status);
    console.error(e);
    return json(req, { error: "server_error" }, 500);
  }
});
