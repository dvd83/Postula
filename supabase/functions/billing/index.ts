// Paiement : ouvre une page de paiement Stripe (Checkout) ou l'espace client Stripe (factures, résiliation).
// Les prix sont retrouvés par leur « lookup key » Stripe : aucun identifiant de prix dans le code.
import { admin, AppError, cors, json, oneOf, requireUser } from "../_shared/common.ts";
import { stripe } from "../_shared/stripe.ts";

const SITE = (Deno.env.get("SITE_URL") ?? "https://postula.pages.dev").replace(/\/$/, "");
const PRODUCTS = ["monthly", "pass3m", "topup"] as const;
type Product = typeof PRODUCTS[number];
const LOOKUP: Record<Product, string> = { monthly: "postula_monthly", pass3m: "postula_pass3m", topup: "postula_topup" };

const priceCache = new Map<string, string>();
async function priceId(product: Product): Promise<string> {
  const key = LOOKUP[product];
  const hit = priceCache.get(key);
  if (hit) return hit;
  const r = await stripe<{ data: { id: string }[] }>("GET", "/prices", { lookup_keys: [key], active: true, limit: 1 });
  const id = r.data?.[0]?.id;
  if (!id) throw new AppError("price_not_found", 503, { product });
  priceCache.set(key, id);
  return id;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  try {
    const db = admin();
    const user = await requireUser(req, db);
    const body = await req.json().catch(() => ({}));
    const action = oneOf(body.action, ["checkout", "portal"] as const, "checkout");

    const { data: prof } = await db.from("profiles")
      .select("plan, period_end, blocked, stripe_customer_id, stripe_subscription_id").eq("id", user.id).single();
    if (!prof) throw new AppError("no_profile", 403);
    if (prof.blocked) throw new AppError("blocked", 403);
    const active = prof.plan !== "free" && (!prof.period_end || new Date(prof.period_end) > new Date());

    if (action === "portal") {
      if (!prof.stripe_customer_id) throw new AppError("no_customer", 400);
      const s = await stripe<{ url: string }>("POST", "/billing_portal/sessions", {
        customer: prof.stripe_customer_id, return_url: SITE, locale: "fr",
      });
      return json(req, { ok: true, url: s.url });
    }

    const product = oneOf(body.product, PRODUCTS, "monthly");
    // Règles de cohérence entre offres
    if (product === "topup" && !active) throw new AppError("topup_requires_plan", 400);
    if (product !== "topup" && active && prof.stripe_subscription_id) throw new AppError("already_subscribed", 409);
    if (product !== "topup" && active) throw new AppError("plan_active", 409, { until: prof.period_end });

    // Client Stripe (créé une fois, réutilisé ensuite)
    let customer = prof.stripe_customer_id as string | null;
    if (!customer) {
      const c = await stripe<{ id: string }>("POST", "/customers", {
        email: user.email, metadata: { user_id: user.id },
      });
      customer = c.id;
      await db.from("profiles").update({ stripe_customer_id: customer }).eq("id", user.id);
    }

    const meta = { user_id: user.id, product };
    const session = await stripe<{ url: string }>("POST", "/checkout/sessions", {
      mode: product === "monthly" ? "subscription" : "payment",
      customer,
      client_reference_id: user.id,
      line_items: [{ price: await priceId(product), quantity: 1 }],
      metadata: meta,
      ...(product === "monthly"
        ? { subscription_data: { metadata: meta } }
        : { payment_intent_data: { metadata: meta } }),
      allow_promotion_codes: true,
      // Paiement Stripe classique (le texte de renonciation au droit de rétractation est incompatible avec Managed Payments)
      managed_payments: { enabled: false },
      locale: "fr",
      success_url: `${SITE}/?paiement=ok&offre=${product}`,
      cancel_url: `${SITE}/?paiement=annule`,
      custom_text: {
        submit: {
          message: "En payant, tu demandes l'accès immédiat au service. Tu renonces ainsi à ton droit de rétractation de 14 jours dès la première utilisation.",
        },
      },
    });
    return json(req, { ok: true, url: session.url });
  } catch (e) {
    if (e instanceof AppError) return json(req, { error: e.code, ...e.extra }, e.status);
    console.error(e);
    return json(req, { error: "server_error" }, 500);
  }
});
