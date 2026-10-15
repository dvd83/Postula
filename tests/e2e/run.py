"""Tests de bout en bout du site Postula (navigateur Chromium piloté par Playwright).

Le serveur (Supabase, IA, paiement) est simulé : les tests vérifient le site lui-même,
sans compte, sans coût et sans toucher aux vraies données.

Lancer :  python3 tests/e2e/run.py            (tous les tests)
          python3 tests/e2e/run.py lien cv     (seulement les tests dont le nom contient « lien » ou « cv »)
Variables : LIB_DIR=dossier contenant jspdf.umd.min.js et jszip.min.js (sinon chargés depuis le CDN)
            SHOTS=dossier où enregistrer captures et fichiers produits
"""
import asyncio, functools, http.server, io, json, os, re, socketserver, sys, threading, traceback, zipfile
from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "web"))
LIB_DIR = os.environ.get("LIB_DIR")
SHOTS = os.environ.get("SHOTS")

# ---------- données simulées ----------
SUPABASE_STUB = """
window.supabase={createClient:function(){
  const app=location.hash.includes('app');
  const sess=app?{access_token:'test',user:{email:'test@example.ch',user_metadata:{full_name:'Test'}}}:null;
  return {auth:{getSession:async()=>({data:{session:sess}}),onAuthStateChange:()=>{},signInWithOAuth:async()=>({}),signOut:async()=>({})},
    rpc:async()=>({data:{plan:'monthly',active:true,subscription:true,customer:true,period_end:'2026-11-16T15:42:49Z',free_claimed:true,extra_interviews:0,
      quota:{cv:{limit:50,used:3},letter:{limit:50,used:1},interview:{limit:20,used:2},analyze:{limit:100,used:4}}}})};
}};"""
OFFER = {"poste": "Chef de projet digital", "entreprise": "Helvetia Media", "lieu": "Lausanne", "langue": "fr",
         "resume": "Pilotage de projets web.", "missions": ["Piloter des projets web"], "exigences": ["5 ans d'expérience", "Agile"],
         "mots_cles_ats": ["Agile", "Scrum", "SEO", "Jira"], "themes_entretien": ["Gestion de projet"]}
CV = {"nom": "Camille Rochat", "titre": "Chef de projet digital",
      "contact": {"email": "camille.rochat@example.ch", "telephone": "+41 79 123 45 67", "ville": "Lausanne", "linkedin": "linkedin.com/in/camillerochat", "autres": []},
      "profil": "Chef de projet digital avec 7 ans d'expérience dans les médias et le e-commerce. Pilote des refontes de sites à fort trafic, en méthode Agile.",
      "experiences": [
          {"poste": "Chef de projet digital", "entreprise": "Le Temps", "lieu": "Genève", "debut": "mars 2021", "fin": "Aujourd'hui",
           "points": ["Pilotage de la refonte du site (2 M visites/mois), livrée dans les délais", "Animation des rituels Scrum pour 9 personnes",
                      "Suivi SEO : +35 % de trafic organique", "Gestion d'un budget annuel de 480 000 CHF"]},
          {"poste": "Product owner", "entreprise": "Manor", "lieu": "Bâle", "debut": "2018", "fin": "2021",
           "points": ["Priorisation du backlog e-commerce avec Jira", "Lancement du click & collect dans 60 magasins"]},
          {"poste": "Chargé de projet web", "entreprise": "Agence Pixel", "lieu": "Lausanne", "debut": "2016", "fin": "2018",
           "points": ["Gestion de 25 sites clients PME"]}],
      "formation": [{"diplome": "Master en systèmes d'information", "ecole": "HEC Lausanne", "annee": "2016", "details": ""}],
      "competences": [{"categorie": "Gestion de projet", "items": ["Agile", "Scrum", "Jira"]}, {"categorie": "Digital", "items": ["SEO", "Google Analytics"]}],
      "langues": [{"langue": "Français", "niveau": "langue maternelle"}, {"langue": "Anglais", "niveau": "C1"}],
      "certifications": ["PSM I"], "interets": ["Course à pied"],
      "rubriques": {"profil": "Profil", "experiences": "Expériences", "formation": "Formation", "competences": "Compétences",
                    "langues": "Langues", "certifications": "Certifications", "interets": "Centres d'intérêt", "contact": "Contact"}}
FETCHED = {"text": "Poste : Responsable SMI\nEntreprise : OK Job SA\n\n" + "Développer et animer le système de management intégré. " * 8,
           "host": "jobup.ch", "source": "jsonld"}
LETTER = {"text": "Camille Rochat\nLausanne\n\nMadame, Monsieur,\n\n" + "Je vous propose ma candidature. " * 40}


def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    handler = functools.partial(Quiet, directory=ROOT)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}/"


class Ctx:
    """Un onglet isolé avec serveur simulé ; garde la trace des appels et des erreurs JavaScript."""
    def __init__(self, browser, base, width=1280, height=900, ai=None):
        self.browser, self.base, self.size, self.ai = browser, base, (width, height), ai or {}
        self.calls, self.errors = [], []

    async def __aenter__(self):
        self.ctx = await self.browser.new_context(viewport={"width": self.size[0], "height": self.size[1]}, accept_downloads=True)
        self.page = await self.ctx.new_page()
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        await self.page.route("**/*", self.route)
        return self

    async def __aexit__(self, *a):
        await self.ctx.close()

    async def route(self, r):
        u = r.request.url
        if "supabase-js" in u:
            return await r.fulfill(content_type="application/javascript", body=SUPABASE_STUB)
        if LIB_DIR and "jspdf" in u:
            return await r.fulfill(path=os.path.join(LIB_DIR, "jspdf.umd.min.js"), content_type="application/javascript")
        if LIB_DIR and "jszip" in u:
            return await r.fulfill(path=os.path.join(LIB_DIR, "jszip.min.js"), content_type="application/javascript")
        if "/functions/v1/ai" in u:
            body = json.loads(r.request.post_data or "{}")
            act = body.get("action")
            self.calls.append(act)
            res = self.ai.get(act, {"analyze_offer": OFFER, "structure_cv": CV, "fetch_offer": FETCHED, "letter": LETTER}.get(act))
            if isinstance(res, dict) and "error" in res:
                return await r.fulfill(status=422, content_type="application/json", body=json.dumps(res))
            return await r.fulfill(content_type="application/json", body=json.dumps({"ok": True, "result": res}))
        if u.startswith(self.base):
            return await r.continue_()
        if any(h in u for h in ("cdn.jsdelivr.net", "cdnjs.cloudflare.com")) and not LIB_DIR:
            return await r.continue_()
        return await r.abort()

    async def open(self, path=""):
        await self.page.goto(self.base + path)
        await self.page.wait_for_function("document.readyState==='complete'")
        await self.page.wait_for_timeout(600)

    async def step(self, n):
        await self.page.click(f'nav.steps button[data-go="{n}"]')
        await self.page.wait_for_timeout(300)

    async def shot(self, name):
        if SHOTS:
            os.makedirs(SHOTS, exist_ok=True)
            await self.page.screenshot(path=os.path.join(SHOTS, name + ".png"))

    def no_js_errors(self):
        errs = [e for e in self.errors if "pdfjsLib" not in e and "docx" not in e.lower()] if LIB_DIR else self.errors
        assert not errs, "Erreurs JavaScript : " + " | ".join(errs[:3])


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


# ---------- tests ----------
async def t_accueil_et_pages_legales(b, base):
    async with Ctx(b, base) as c:
        for p in ["", "conditions.html", "confidentialite.html", "mentions-legales.html"]:
            await c.open(p)
            check("Postula" in await c.page.title(), f"titre manquant sur /{p}")
        c.no_js_errors()
        await c.open("")
        check(await c.page.locator('link[rel="manifest"]').count() == 1, "manifeste (app installable) absent")
        man = json.load(open(os.path.join(ROOT, "manifest.webmanifest"), encoding="utf-8"))
        for ic in man["icons"]:
            check(os.path.exists(os.path.join(ROOT, ic["src"].lstrip("/"))), f"icône manquante : {ic['src']}")


async def t_mobile_sans_debordement(b, base):
    for path in ["", "#app"]:
        async with Ctx(b, base, 375, 812) as c:
            await c.open(path)
            for n in ([1, 2, 3, 4] if path else [None]):
                if n:
                    await c.step(n)
                w = await c.page.evaluate("document.documentElement.scrollWidth")
                check(w <= 376, f"la page déborde horizontalement sur mobile ({w}px) — {path or 'accueil'} étape {n}")
            await c.shot("mobile" + (path.replace('#', '_') or "_accueil"))
            c.no_js_errors()


async def t_lien_jobup_lu_puis_analyse(b, base):
    async with Ctx(b, base) as c:
        await c.open("#app")
        await c.page.fill("#offerText", "")
        await c.page.fill("#offerUrl", "https://www.jobup.ch/fr/emplois/detail/1d629c2b-38ee-4b80-928a-781ef71ac1c8/")
        await c.page.press("#offerUrl", "Enter")
        await c.page.wait_for_selector("#offerOut:not([hidden])", timeout=5000)
        check(c.calls[:2] == ["fetch_offer", "analyze_offer"], f"enchaînement inattendu : {c.calls}")
        check("Responsable SMI" in await c.page.input_value("#offerText"), "le texte lu n'a pas été placé dans le cadre")
        check("Chef de projet digital" in await c.page.inner_text("#offerOut"), "le résultat de l'analyse n'est pas affiché")
        c.no_js_errors()


async def t_lien_linkedin_pas_lu(b, base):
    async with Ctx(b, base) as c:
        await c.open("#app")
        await c.page.fill("#offerUrl", "https://www.linkedin.com/jobs/view/4012345678/")
        await c.page.press("#offerUrl", "Enter")
        await c.page.wait_for_timeout(400)
        check("fetch_offer" not in c.calls, "LinkedIn ne doit jamais être lu automatiquement")
        check("LinkedIn" in await c.page.inner_text("#offerMsg"), "pas d'explication pour LinkedIn")


async def t_lien_refuse_message_clair(b, base):
    async with Ctx(b, base, ai={"fetch_offer": {"error": "fetch_blocked"}}) as c:
        await c.open("#app")
        await c.page.fill("#offerUrl", "https://www.exemple-emplois.ch/offre/1")
        await c.page.press("#offerUrl", "Enter")
        await c.page.wait_for_timeout(600)
        msg = await c.page.inner_text("#offerMsg")
        check("colle" in msg.lower(), f"le message d'échec doit proposer de coller le texte : « {msg} »")
        check("analyze_offer" not in c.calls, "aucune analyse ne doit partir sans texte")


async def t_cv_depuis_linkedin_pdf_et_word(b, base):
    async with Ctx(b, base) as c:
        await c.open("#app")
        await c.page.fill("#offerText", "Chef de projet digital chez Helvetia Media à Lausanne. " * 4)
        await c.page.click("#analyzeBtn")
        await c.page.wait_for_selector("#offerOut:not([hidden])")
        await c.step(2)
        await c.page.click("#liAlt summary")
        await c.page.fill("#profileText", "Camille Rochat\nChef de projet digital\nExpérience\nLe Temps\n" * 6)
        await c.page.click("#useProfile")
        await c.page.wait_for_timeout(300)
        check(not await c.page.is_disabled("#themeBtn"), "le profil LinkedIn collé n'a pas été accepté")
        await c.page.click("#themeBtn")
        await c.page.wait_for_selector("#dlThemeDocx:not([hidden])", timeout=8000)
        names = await c.page.eval_on_selector_all(".theme span", "els=>els.map(e=>e.textContent)")
        check(len(names) >= 4, "thèmes manquants")
        for name in names:
            await c.page.click(f'.theme:has-text("{name}")')
            await c.page.wait_for_timeout(700)
            async with c.page.expect_download() as d:
                await c.page.click("#dlThemePdf")
            pdf = open(await (await d.value).path(), "rb").read()
            pages = len(re.findall(rb"/Type\s*/Page(?!s)", pdf))
            check(pdf.startswith(b"%PDF"), f"{name} : PDF invalide")
            check(pages == 1, f"{name} : le CV tient sur {pages} pages au lieu d'une")
            check(b"FontFile2" in pdf, f"{name} : polices non intégrées au PDF")
            async with c.page.expect_download() as d:
                await c.page.click("#dlThemeDocx")
            raw = open(await (await d.value).path(), "rb").read()
            z = zipfile.ZipFile(io.BytesIO(raw))
            doc = z.read("word/document.xml").decode("utf-8")
            check("Camille Rochat" in doc and "Le Temps" in doc, f"{name} : contenu absent du Word")
            check("[Content_Types].xml" in z.namelist() and "word/styles.xml" in z.namelist(), f"{name} : Word incomplet")
            if SHOTS:
                open(os.path.join(SHOTS, f"cv_{name}.pdf"), "wb").write(pdf)
                open(os.path.join(SHOTS, f"cv_{name}.docx"), "wb").write(raw)
        c.no_js_errors()


async def t_lettre_demande_un_parcours(b, base):
    async with Ctx(b, base) as c:
        await c.open("#app")
        await c.page.fill("#offerText", "Chef de projet digital chez Helvetia Media à Lausanne. " * 4)
        await c.page.click("#analyzeBtn")
        await c.page.wait_for_selector("#offerOut:not([hidden])")
        await c.step(3)
        await c.page.click("#letterBtn")
        await c.page.wait_for_timeout(300)
        check("letter" not in c.calls, "une lettre sans CV ni notes ne doit pas être générée (elle serait vide)")
        check("parcours" in await c.page.inner_text("#letterMsg"), "pas d'explication quand le CV manque")
        await c.page.fill("#letterNotes", "7 ans de gestion de projets web au journal Le Temps, refonte du site, équipe Scrum de 9 personnes.")
        await c.page.click("#letterBtn")
        await c.page.wait_for_timeout(800)
        check("letter" in c.calls, "avec des notes suffisantes, la lettre doit être demandée")
        c.no_js_errors()


TESTS = [v for k, v in list(globals().items()) if k.startswith("t_")]


async def main(filters):
    httpd, base = serve()
    failed = 0
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for t in TESTS:
            name = t.__name__[2:].replace("_", " ")
            if filters and not any(f in t.__name__ for f in filters):
                continue
            try:
                await t(b, base)
                print(f"  ok      {name}")
            except Exception as e:
                failed += 1
                print(f"  ÉCHEC   {name}\n          {e}")
                if not isinstance(e, AssertionError):
                    traceback.print_exc()
        await b.close()
    httpd.shutdown()
    print(f"\n{'Tout est bon' if not failed else str(failed) + ' test(s) en échec'}.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
