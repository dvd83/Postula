// Tests de la lecture d'annonces depuis un lien (aucun accès réseau : fetch est simulé).
// Petites assertions maison : aucune dépendance à télécharger.
function assert(c: unknown, msg = "assertion"): asserts c { if (!c) throw new Error(msg); }
function assertEquals(a: unknown, b: unknown) { if (a !== b) throw new Error(`attendu ${JSON.stringify(b)}, obtenu ${JSON.stringify(a)}`); }
function assertStringIncludes(s: string, part: string) { if (!s.includes(part)) throw new Error(`« ${part} » absent de :\n${s}`); }
async function assertRejects(fn: () => Promise<unknown>, _t: unknown, code: string) {
  try { await fn(); } catch (e) { if ((e as { code?: string }).code === code) return; throw new Error(`code attendu ${code}, obtenu ${(e as { code?: string }).code ?? e}`); }
  throw new Error(`aurait dû échouer avec ${code}`);
}
import { fetchOffer } from "../_shared/fetch_offer.ts";

const ROBOTS = `User-agent: *
Disallow: /fr/login/
Disallow: /*?*feat=
Disallow: /api/

User-agent: SemrushBot
Disallow: /
`;
const JOB_HTML = `<html><head><title>Responsable SMI | jobup.ch</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting",
"title":"Responsable Syst&egrave;me de Management Int&eacute;gr&eacute;",
"hiringOrganization":{"@type":"Organization","name":"OK Job SA"},
"jobLocation":{"@type":"Place","address":{"addressLocality":"Delémont"}},
"employmentType":"FULL_TIME","datePosted":"2026-10-14T08:00:00",
"description":"&lt;p&gt;Pour notre client, nous recherchons un &lt;strong&gt;Responsable SMI&lt;/strong&gt;.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Développer et animer le système de management intégré&lt;/li&gt;&lt;li&gt;Réaliser les audits internes ISO 9001 et ISO 45001&lt;/li&gt;&lt;li&gt;Suivre les KPI et piloter les actions correctives et préventives&lt;/li&gt;&lt;/ul&gt;"}
</script></head><body><nav>menu</nav><main><h1>Titre</h1></main></body></html>`;
const PLAIN_HTML = `<html><head><title>Ingénieur réseau – Acme</title></head><body>
<header>Logo Acme</header><nav>Accueil Carrières</nav>
<main><h1>Ingénieur réseau (H/F)</h1><p>Vous administrez le réseau LAN/WAN de nos 12 sites et le pare-feu Fortinet.</p>
<ul><li>Exploitation et supervision du réseau</li><li>Projets de migration SD-WAN</li><li>Piquet niveau 2 une semaine sur cinq</li></ul>
<p>Profil : CFC d'informaticien ou ingénieur HES, 3 ans d'expérience, CCNP apprécié, français courant, allemand un atout.</p></main>
<footer>© Acme</footer></body></html>`;

type Page = { status?: number; body: string; type?: string };
let calls: string[] = [];
function mock(pages: Record<string, Page>) {
  calls = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const p = pages[url] ?? { status: 404, body: "not found" };
    return Promise.resolve(new Response(p.body, { status: p.status ?? 200, headers: { "content-type": p.type ?? "text/html; charset=utf-8" } }));
  }) as typeof fetch;
}

Deno.test("jobup : lit l'annonce structurée (JSON-LD)", async () => {
  const url = "https://www.jobup.ch/fr/emplois/detail/1d629c2b-38ee-4b80-928a-781ef71ac1c8/";
  mock({ "https://www.jobup.ch/robots.txt": { body: ROBOTS, type: "text/plain" }, [url]: { body: JOB_HTML } });
  const r = await fetchOffer(url);
  assertEquals(r.host, "jobup.ch");
  assertEquals(r.source, "jsonld");
  assertStringIncludes(r.text, "Poste : Responsable Système de Management Intégré");
  assertStringIncludes(r.text, "Entreprise : OK Job SA");
  assertStringIncludes(r.text, "Lieu : Delémont");
  assertStringIncludes(r.text, "- Réaliser les audits internes ISO 9001 et ISO 45001");
});

Deno.test("site carrière sans données structurées : lit le contenu principal sans menu ni pied de page", async () => {
  const url = "https://careers.acme.ch/jobs/42";
  mock({ "https://careers.acme.ch/robots.txt": { status: 404, body: "" }, [url]: { body: PLAIN_HTML } });
  const r = await fetchOffer(url);
  assertEquals(r.source, "page");
  assertStringIncludes(r.text, "Projets de migration SD-WAN");
  assert(!r.text.includes("Accueil Carrières"), "le menu ne doit pas être repris");
  assert(!r.text.includes("© Acme"), "le pied de page ne doit pas être repris");
});

Deno.test("robots.txt : une page interdite n'est jamais lue", async () => {
  mock({ "https://www.jobup.ch/robots.txt": { body: ROBOTS, type: "text/plain" } });
  await assertRejects(() => fetchOffer("https://www.jobup.ch/fr/login/x"), Error, "fetch_blocked");
  await assertRejects(() => fetchOffer("https://www.jobup.ch/fr/emplois/?feat=1"), Error, "fetch_blocked");
  assertEquals(calls.filter((c) => !c.endsWith("/robots.txt")).length, 0);
});

Deno.test("LinkedIn est exclu sans même être contacté", async () => {
  mock({});
  await assertRejects(() => fetchOffer("https://www.linkedin.com/jobs/view/123"), Error, "fetch_blocked");
  assertEquals(calls.length, 0);
});

Deno.test("adresses refusées : IP, localhost, autres protocoles, ports exotiques", async () => {
  mock({});
  for (const u of ["http://127.0.0.1/x", "http://localhost/x", "file:///etc/passwd", "https://exemple.ch:8443/x", "pas un lien"]) {
    await assertRejects(() => fetchOffer(u), Error, "fetch_bad_url");
  }
  assertEquals(calls.length, 0);
});

Deno.test("page vide ou réservée aux membres : message clair", async () => {
  const url = "https://jobs.exemple.ch/offre/1";
  mock({ "https://jobs.exemple.ch/robots.txt": { status: 404, body: "" }, [url]: { body: "<html><body><div id=app></div></body></html>" } });
  await assertRejects(() => fetchOffer(url), Error, "fetch_empty");
  const url2 = "https://jobs.exemple.ch/offre/2";
  mock({ "https://jobs.exemple.ch/robots.txt": { status: 404, body: "" }, [url2]: { status: 403, body: "Forbidden" } });
  await assertRejects(() => fetchOffer(url2), Error, "fetch_blocked");
});

import { voiceFor } from "../_shared/tts.ts";
Deno.test("voix naturelle : voix stable, féminine ou masculine selon le recruteur", () => {
  const a = voiceFor("Claire Morel", "fr"), b = voiceFor("Claire Morel", "fr"), m = voiceFor("Marc Rochat", "fr");
  assertEquals(a.name, b.name);
  assert(/^fr-FR-Chirp3-HD-(Aoede|Kore|Leda)$/.test(a.name), a.name);
  assert(/^fr-FR-Chirp3-HD-(Charon|Orus|Fenrir)$/.test(m.name), m.name);
  assertEquals(voiceFor("Anna Keller", "de").languageCode, "de-DE");
});
