// Reçoit les notifications de Stripe et met à jour l'offre du compte. Seul Stripe peut l'appeler :
// chaque requête est authentifiée par sa signature (STRIPE_WEBHOOK_SECRET), et chaque événement n'est appliqué qu'une fois.
import { admin } from "../_shared/common.ts";
import { stripe, verifyStripeSignature } from "../_shared/stripe.ts";

type Obj = Record<string, any>; // charge utile Stripe (formats variables selon la version d'API)

const ok = (body: unknown = { received: true }, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Fin de période d'un abonnement, quel que soit le format de l'API (avant / après 2025). */
async function subscriptionPeriodEnd(subId: string): Promise<string | null> {
  try {
    const s = await stripe<Obj>("GET", `/subscriptions/${subId}`);
    const end = s.current_period_end ?? s.items?.data?.[0]?.current_period_end;
    return end ? new Date(end * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return ok({ error: "method_not_allowed" }, 405);
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) return ok({ error: "not_configured" }, 500);

  const payload = await req.text();
  if (!(await verifyStripeSignature(payload, req.headers.get("stripe-signature"), secret))) {
    return ok({ error: "bad_signature" }, 400);
  }
  const event = JSON.parse(payload) as Obj;
  const o = event.data?.object as Obj;
  const db = admin();

  const apply = async (action: string, args: { user?: string; customer?: string; subscription?: string; periodEnd?: string | null }) => {
    const { data, error } = await db.rpc("apply_purchase", {
      p_event_id: event.id, p_event_type: event.type, p_action: action,
      p_user: args.user ?? null, p_customer: args.customer ?? null,
      p_subscription: args.subscription ?? null, p_period_end: args.periodEnd ?? null,
    });
    if (error) throw error;
    if (!data?.ok) console.error("apply_purchase", event.id, JSON.stringify(data));
    return data;
  };

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        if (o.payment_status !== "paid" && o.payment_status !== "no_payment_required") break; // paiement différé : on attend
        const product = o.metadata?.product;
        if (!["monthly", "pass3m", "topup"].includes(product)) break;
        const sub = typeof o.subscription === "string" ? o.subscription : o.subscription?.id;
        await apply(product, {
          user: o.metadata?.user_id ?? o.client_reference_id,
          customer: typeof o.customer === "string" ? o.customer : o.customer?.id,
          subscription: sub,
          periodEnd: sub ? await subscriptionPeriodEnd(sub) : null,
        });
        break;
      }
      case "invoice.paid": {
        if (o.billing_reason !== "subscription_cycle") break; // le 1er paiement est traité par checkout.session.completed
        const sub = o.subscription ?? o.parent?.subscription_details?.subscription;
        if (!sub) break;
        const end = o.lines?.data?.[0]?.period?.end;
        await apply("renewal", {
          subscription: typeof sub === "string" ? sub : sub.id,
          customer: typeof o.customer === "string" ? o.customer : o.customer?.id,
          periodEnd: end ? new Date(end * 1000).toISOString() : null,
        });
        break;
      }
      case "customer.subscription.deleted": {
        await apply("cancel", { subscription: o.id, customer: typeof o.customer === "string" ? o.customer : o.customer?.id });
        break;
      }
      default:
        break; // autres événements ignorés
    }
    return ok();
  } catch (e) {
    console.error("webhook", event.type, event.id, e);
    return ok({ error: "processing_failed" }, 500); // Stripe réessaiera automatiquement
  }
});
