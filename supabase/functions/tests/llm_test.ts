// Tests de l'appel IA (fetch simulé) : marge pour la réflexion, effort faible, nouvel essai si réponse vide.
import { llm } from "../_shared/common.ts";

function assert(c: unknown, msg: string): asserts c { if (!c) throw new Error(msg); }
Deno.env.set("ANTHROPIC_API_KEY", "test");
type Reply = { status?: number; body: Record<string, unknown> };
let sent: Record<string, any>[] = [];
function mock(replies: Reply[]) {
  sent = [];
  globalThis.fetch = ((_u: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    const r = replies.shift() ?? { status: 500, body: {} };
    return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status ?? 200 }));
  }) as typeof fetch;
}
const ok = (text: string) => ({ body: { content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 10 }, stop_reason: "end_turn" } });
const onlyThinking = { body: { content: [{ type: "thinking", thinking: "…" }], usage: { input_tokens: 10, output_tokens: 2500 }, stop_reason: "max_tokens" } };
const msgs = [{ role: "user" as const, content: "Bonjour" }];

Deno.test("effort faible et marge pour la réflexion", async () => {
  mock([ok("Salut")]);
  const r = await llm({ tier: "default", maxTokens: 2500, messages: msgs });
  assert(r.text === "Salut", "texte attendu");
  assert(sent[0].output_config?.effort === "low", "effort faible attendu");
  assert(sent[0].max_tokens >= 6000, "marge pour la réflexion attendue");
  assert(!("thinking" in sent[0]), "pas de paramètre thinking refusé par l'API");
});

Deno.test("réflexion qui épuise la limite : nouvel essai avec plus de marge, puis succès", async () => {
  mock([onlyThinking, ok("Lettre complète")]);
  const r = await llm({ tier: "default", maxTokens: 2500, messages: msgs });
  assert(r.text === "Lettre complète", "le second essai doit être utilisé");
  assert(sent.length === 2 && sent[1].max_tokens > sent[0].max_tokens, "le second essai doit avoir plus de marge");
});

Deno.test("si l'API refuse l'effort, on réessaie sans", async () => {
  mock([{ status: 400, body: { error: { message: "output_config.effort: unsupported for this model" } } }, ok("OK")]);
  const r = await llm({ tier: "quick", maxTokens: 600, messages: msgs });
  assert(r.text === "OK" && !("output_config" in sent[1]), "doit réessayer sans effort");
});
