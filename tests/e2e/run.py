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
if SHOTS:
    os.makedirs(SHOTS, exist_ok=True)

# ---------- données simulées ----------
SUPABASE_STUB = """
window.supabase={createClient:function(){
  const app=location.hash.includes('app');
  const sess=app?{access_token:'test',user:{email:'test@example.ch',user_metadata:{full_name:'Test'}}}:null;
  return {auth:{getSession:async()=>({data:{session:sess}}),onAuthStateChange:()=>{},signInWithOAuth:async()=>({}),signOut:async()=>({})},
    from:(table)=>{
      const db=(window.__db=window.__db||{applications:[]}); const rows=db[table]=db[table]||[];
      let op='select',patch=null,filt=[],single=false,lim=null;
      const run=()=>{
        let r=rows.filter(x=>filt.every(([k,v])=>x[k]===v));
        if(op==='insert'){const row=Object.assign({id:crypto.randomUUID(),status:'todo',scores:[],notes:'',created_at:new Date().toISOString(),updated_at:new Date().toISOString()},patch);rows.unshift(row);r=[row]}
        if(op==='update'){r.forEach(x=>Object.assign(x,patch,{updated_at:new Date().toISOString()}))}
        if(op==='delete'){r.forEach(x=>rows.splice(rows.indexOf(x),1))}
        if(lim)r=r.slice(0,lim);
        return {data:single?(r[0]||null):r,error:null};
      };
      const q={select(){return q},insert(p){op='insert';patch=p;return q},update(p){op='update';patch=p;return q},delete(){op='delete';return q},
        eq(k,v){filt.push([k,v]);return q},order(){return q},limit(n){lim=n;return q},single(){single=true;return q},maybeSingle(){single=true;return q},
        then(res,rej){return Promise.resolve(run()).then(res,rej)}};
      return q;
    },
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
    def __init__(self, browser, base, width=1280, height=900, ai=None, patch=None, init=None, ua=None):
        self.browser, self.base, self.size, self.ai, self.patch, self.init, self.ua = browser, base, (width, height), ai or {}, patch, init, ua
        self.bodies = []
        self.calls, self.errors = [], []

    async def __aenter__(self):
        opts = {"user_agent": self.ua} if self.ua else {}
        self.ctx = await self.browser.new_context(viewport={"width": self.size[0], "height": self.size[1]}, accept_downloads=True, **opts)
        self.page = await self.ctx.new_page()
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        if self.init:
            await self.page.add_init_script(self.init)
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
        if LIB_DIR and "pdf.worker" in u:
            return await r.fulfill(path=os.path.join(LIB_DIR, "pdfjs", "build", "pdf.worker.js"), content_type="application/javascript")
        if LIB_DIR and "pdf.js/" in u and "pdf.min.js" in u:
            return await r.fulfill(path=os.path.join(LIB_DIR, "pdfjs", "build", "pdf.js"), content_type="application/javascript")
        if "/functions/v1/admin" in u:
            body = json.loads(r.request.post_data or "{}")
            self.calls.append("admin:" + body.get("action", "")); self.bodies.append(body)
            res = self.ai.get("admin:" + body.get("action", ""), {"ok": True})
            if callable(res):
                res = res(body)
            if isinstance(res, dict) and "error" in res:
                return await r.fulfill(status=403, content_type="application/json", body=json.dumps(res))
            return await r.fulfill(content_type="application/json", body=json.dumps({"ok": True, "result": res}))
        if "/functions/v1/ai" in u:
            body = json.loads(r.request.post_data or "{}")
            act = body.get("action")
            self.calls.append(act)
            self.bodies.append(body)
            res = self.ai.get(act, {"analyze_offer": OFFER, "structure_cv": CV, "fetch_offer": FETCHED, "letter": LETTER}.get(act))
            if callable(res):
                res = res(body)
            if isinstance(res, dict) and "error" in res:
                return await r.fulfill(status=422, content_type="application/json", body=json.dumps(res))
            return await r.fulfill(content_type="application/json", body=json.dumps({"ok": True, "result": res}))
        if self.patch and u.startswith(self.base) and u.split("?")[0].endswith("/app.js"):
            js = open(os.path.join(ROOT, "app.js"), encoding="utf-8").read()
            for old, new in self.patch:
                check(old in js, f"correctif de test introuvable dans app.js : {old}")
                js = js.replace(old, new)
            return await r.fulfill(content_type="application/javascript", body=js)
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
        errs = [e for e in self.errors if "docx" not in e.lower()] if LIB_DIR else self.errors
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


LONG_CV = json.loads(json.dumps(CV))
LONG_CV["rubriques"].update({"experiences": "Expériences professionnelles", "competences": "Compétences techniques et outils",
                             "interets": "Centres d'intérêt et engagements associatifs"})
LONG_CV["experiences"] = LONG_CV["experiences"] * 2  # CV de deux pages


async def t_cv_depuis_linkedin_pdf_et_word(b, base):
    await cv_exports(b, base, CV, "cv", max_pages=1)


async def t_cv_rubriques_longues_deux_pages(b, base):
    await cv_exports(b, base, LONG_CV, "cvlong", max_pages=2)


async def cv_exports(b, base, cv, tag, max_pages):
    async with Ctx(b, base, ai={"structure_cv": cv}) as c:
        await c.open("#app")
        await c.page.fill("#offerText", "Chef de projet digital chez Helvetia Media à Lausanne. " * 4)
        await c.page.click("#analyzeBtn")
        await c.page.wait_for_selector("#offerOut:not([hidden])")
        await c.step(2)
        await c.page.click("#liAlt summary")
        await c.page.fill("#profileText", "Camille Rochat\nChef de projet digital\nExpérience\nLe Temps\n" * 6)
        await c.page.click("#useProfile")
        await c.page.wait_for_timeout(300)
        check("LinkedIn" in await c.page.inner_text("#dropTitle"), "le profil LinkedIn collé n'a pas été accepté")
        # l'offre étant analysée, la mise en forme démarre toute seule ; sinon on la lance
        try:
            await c.page.wait_for_selector("#dlThemeDocx:not([hidden])", timeout=4000)
        except Exception:
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
            check(1 <= pages <= max_pages, f"{name} : le CV fait {pages} pages (maximum attendu : {max_pages})")
            check(b"FontFile2" in pdf, f"{name} : polices non intégrées au PDF")
            async with c.page.expect_download() as d:
                await c.page.click("#dlThemeDocx")
            raw = open(await (await d.value).path(), "rb").read()
            z = zipfile.ZipFile(io.BytesIO(raw))
            doc = z.read("word/document.xml").decode("utf-8")
            check("Camille Rochat" in doc and "Le Temps" in doc, f"{name} : contenu absent du Word")
            check("[Content_Types].xml" in z.namelist() and "word/styles.xml" in z.namelist(), f"{name} : Word incomplet")
            if SHOTS:
                open(os.path.join(SHOTS, f"{tag}_{name}.pdf"), "wb").write(pdf)
                open(os.path.join(SHOTS, f"{tag}_{name}.docx"), "wb").write(raw)
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


FIX = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "fixtures"))


async def photo_from(b, base, fname, patch=None):
    async with Ctx(b, base, patch=patch) as c:
        await c.open("#app")
        await c.step(2)
        await c.page.set_input_files("#cvFile", os.path.join(FIX, fname))
        await c.page.wait_for_selector("#photoRow:not([hidden])", timeout=15000)
        await c.page.wait_for_timeout(300)
        hint = await c.page.inner_text("#photoHint")
        await c.shot("photo_" + fname.replace(".", "_"))
        check("Récupérée" in hint, f"{fname} : photo non récupérée (« {hint} »)")
        # la vignette doit être le portrait (fond bleu), pas le petit logo rouge
        rgb = await c.page.evaluate("""async()=>{const i=document.querySelector('#photoThumb img');await i.decode();
          const c=document.createElement('canvas');c.width=c.height=60;const g=c.getContext('2d');g.drawImage(i,0,0,60,60);
          const d=g.getImageData(30,8,1,1).data;return [d[0],d[1],d[2]]}""")
        check(rgb[2] > rgb[0] + 40, f"{fname} : la photo retenue n'est pas le portrait (couleur {rgb})")
        c.no_js_errors()


async def t_photo_word(b, base):
    await photo_from(b, base, "cv_photo.docx")


async def t_photo_pdf_exporte_de_word(b, base):
    await photo_from(b, base, "cv_photo_word.pdf")


async def t_photo_pdf_decoupee_en_rond(b, base):
    await photo_from(b, base, "cv_photo_rond.pdf")


async def t_photo_pdf_avec_grands_aplats_de_couleur(b, base):
    # les blocs décoratifs (images unies plus grandes que la photo) ne doivent pas être pris pour la photo
    await photo_from(b, base, "cv_photo_aplats.pdf")


async def t_photo_aplats_par_rendu_de_la_page(b, base):
    await photo_from(b, base, "cv_photo_aplats.pdf", patch=[("try{ r=await pdfPhotoObjects(page,ops,pdfImagePlacements(page,ops)) }catch(e){}", "")])


async def t_photo_pdf_par_rendu_de_la_page(b, base):
    # méthode de secours : extraction directe désactivée, la photo est découpée dans le rendu de la page
    await photo_from(b, base, "cv_photo_rond.pdf", patch=[("try{ r=await pdfPhotoObjects(page,ops,pdfImagePlacements(page,ops)) }catch(e){}", "")])


async def t_photo_ajout_possible_sans_cv_fichier(b, base):
    async with Ctx(b, base) as c:
        await c.open("#app")
        await c.step(2)
        await c.page.click("#liAlt summary")
        await c.page.fill("#profileText", "Camille Rochat\nChef de projet digital\nExpérience\nLe Temps\n" * 6)
        await c.page.click("#useProfile")
        await c.page.wait_for_timeout(300)
        check(await c.page.is_visible("#photoRow"), "avec un profil collé, il faut pouvoir ajouter sa photo")
        await c.page.set_input_files("#photoFile", os.path.join(FIX, "portrait.jpg"))
        await c.page.wait_for_selector("#photoThumb img", timeout=5000)


# ---------- CV entièrement en image (scan) ----------
SCAN_TEXT = "Camille Rochat\nChef de projet digital\ncamille.rochat@example.ch\nEXPÉRIENCE\nChef de projet digital – Le Temps, Genève (2021 – aujourd'hui)\nPilotage de la refonte du site, animation Scrum, suivi SEO.\nFORMATION\nMaster en systèmes d'information – HEC Lausanne (2016)"


async def scan_case(b, base, photo):
    def read(body):
        imgs = body.get("images") or []
        check(len(imgs) == 1 and len(imgs[0]) > 20000, "la page du CV en image doit être envoyée à l'IA")
        return {"text": SCAN_TEXT, "photo": photo}
    async with Ctx(b, base, ai={"read_cv_image": read}) as c:
        await c.open("#app")
        await c.step(2)
        await c.page.set_input_files("#cvFile", os.path.join(FIX, "cv_scan.pdf"))
        await c.page.wait_for_selector("#photoRow:not([hidden])", timeout=15000)
        await c.page.wait_for_timeout(300)
        check("read_cv_image" in c.calls, "le CV en image n'a pas été lu")
        check("image" in (await c.page.inner_text("#cvMsg")).lower(), "il faut prévenir que le CV était une image")
        check(not await c.page.is_disabled("#adaptBtn"), "le CV en image doit pouvoir être adapté")
        c.no_js_errors()
        return c, await c.page.inner_text("#photoHint"), await c.page.evaluate("""async()=>{const i=document.querySelector('#photoThumb img');if(!i)return null;await i.decode();
          const c=document.createElement('canvas');c.width=c.height=60;const g=c.getContext('2d');g.drawImage(i,0,0,60,60);
          const d=g.getImageData(30,8,1,1).data;return [d[0],d[1],d[2]]}""")


async def t_cv_scanne_lu_et_photo_reprise(b, base):
    _, hint, rgb = await scan_case(b, base, {"x0": 0.714, "y0": 0.034, "x1": 0.905, "y1": 0.168})
    # le portrait (visage clair sur fond bleu) et non un morceau blanc ou le bandeau marine
    check("Récupérée" in hint and rgb and not all(v > 235 for v in rgb) and not (rgb[0] < 60 and rgb[1] < 60), f"photo du CV en image non reprise ({hint}, {rgb})")


async def t_cv_scanne_page_entiere_pas_prise_pour_photo(b, base):
    _, hint, rgb = await scan_case(b, base, None)
    check("Récupérée" not in hint, "la page entière ne doit pas être prise pour la photo")


# ---------- adaptation d'un CV Word produit par Postula ----------
async def make_theme_docx(b, base):
    async with Ctx(b, base) as c:
        await c.open("#app")
        await c.page.fill("#offerText", "Chef de projet digital chez Helvetia Media à Lausanne. " * 4)
        await c.page.click("#analyzeBtn"); await c.page.wait_for_selector("#offerOut:not([hidden])")
        await c.step(2)
        await c.page.click("#liAlt summary")
        await c.page.fill("#profileText", "Camille Rochat\nChef de projet digital\nExpérience\nLe Temps\n" * 6)
        await c.page.click("#useProfile")
        await c.page.wait_for_selector("#dlThemeDocx:not([hidden])", timeout=10000)
        async with c.page.expect_download() as d:
            await c.page.click("#dlThemeDocx")
        return open(await (await d.value).path(), "rb").read()


async def t_cv_word_postula_readapte(b, base):
    raw = await make_theme_docx(b, base)
    tmp = os.path.join(SHOTS or "/tmp", "cv_postula.docx"); open(tmp, "wb").write(raw)

    def adapt(body):
        paras = body["paras"]
        for p in paras:
            check(not any(re.fullmatch(r"[\s•·\-–—*]*", x) for x in p["s"]), f"puce ou séparateur envoyé à l'IA : {p['s']}")
        i = next(k for k, p in enumerate(paras) if any("Pilotage" in x for x in p["s"]))
        j = next(k for k, p in enumerate(paras) if any("Scrum" in x for x in p["s"]) and k != i)
        return {"resume": "Accent sur la gestion de projet Agile.", "modifs": [
            {"i": i, "s": ["Pilotage Agile de la refonte du site (2 M visites/mois), livrée dans les délais"], "raison": "vocabulaire de l'offre"},
            {"i": j, "s": ["Animation", "des rituels Scrum et Kanban pour 9 personnes"], "raison": "segments recollés"}]}
    async with Ctx(b, base, ai={"adapt_cv": adapt}) as c:
        await c.open("#app")
        await c.page.fill("#offerText", "Chef de projet digital chez Helvetia Media à Lausanne. " * 4)
        await c.page.click("#analyzeBtn"); await c.page.wait_for_selector("#offerOut:not([hidden])")
        await c.step(2)
        await c.page.set_input_files("#cvFile", tmp)
        await c.page.wait_for_function("!document.querySelector('#adaptBtn').disabled")
        await c.page.click("#adaptBtn")
        await c.page.wait_for_selector("#changesCard:not([hidden])", timeout=8000)
        n = await c.page.locator("#changes .chg").count()
        check(n == 2, f"{n} modification(s) affichée(s) au lieu de 2")
        check(await c.page.is_visible("#dlDocx"), "le CV adapté n'est pas téléchargeable")
        async with c.page.expect_download() as d:
            await c.page.click("#dlDocx")
        doc = zipfile.ZipFile(io.BytesIO(open(await (await d.value).path(), "rb").read())).read("word/document.xml").decode("utf-8")
        check("Pilotage Agile de la refonte" in doc, "la modification n'a pas été appliquée au Word")
        check("Scrum et Kanban" in doc, "la modification recollée n'a pas été appliquée")
        c.no_js_errors()


# ---------- entretien oral : on voit si le micro capte ----------
FAKE_VOICE = """
(() => {
  const mode = window.__voice || 'talk';
  window.speechSynthesis = {speaking:false,pending:false,cancel(){},getVoices(){return []},onvoiceschanged:null,
    speak(u){setTimeout(()=>u.onend&&u.onend(),30)}};
  window.SpeechSynthesisUtterance = function(t){this.text=t};
  class FakeRec {
    start(){ const m = localStorage.getItem('fakeVoice') || 'talk'; this.on = true;
      if (m === 'denied') { setTimeout(()=>{this.onerror&&this.onerror({error:'not-allowed'}); this.onend&&this.onend()},20); return; }
      setTimeout(()=>this.onaudiostart&&this.onaudiostart(), 30);
      if (m === 'talk') {
        setTimeout(()=>{this.onspeechstart&&this.onspeechstart()}, 300);
        setTimeout(()=>this.onresult&&this.onresult({resultIndex:0,results:[Object.assign([{transcript:'Je pilote des projets'}],{isFinal:false})]}), 500);
        setTimeout(()=>this.onresult&&this.onresult({resultIndex:0,results:[Object.assign([{transcript:'Je pilote des projets web depuis sept ans'}],{isFinal:true})]}), 900);
      }
    }
    stop(){ this.on = false; setTimeout(()=>this.onend&&this.onend(), 10); }
    abort(){ this.stop(); }
  }
  window.SpeechRecognition = FakeRec; window.webkitSpeechRecognition = FakeRec;
})();"""
IV_AI = {"interview_start": {"sessionId": "s1", "persona": {"name": "Claire Morel", "role": "Responsable RH"},
                             "text": "Bonjour, je suis Claire. Parlez-moi de votre parcours."},
         "interview_turn": {"text": "Merci. Donnez-moi un exemple concret."}}


async def start_interview(c, voice):
    await c.open("#app")
    await c.page.evaluate(f"localStorage.setItem('fakeVoice','{voice}')")
    await c.page.fill("#offerText", "Chef de projet digital chez Helvetia Media à Lausanne. " * 4)
    await c.page.click("#analyzeBtn"); await c.page.wait_for_selector("#offerOut:not([hidden])")
    await c.step(4)
    await c.page.click("#ivStart")
    await c.page.wait_for_selector("#voicePanel:not([hidden])", timeout=5000)


async def t_entretien_micro_montre_ce_qu_il_capte(b, base):
    async with Ctx(b, base, 390, 844, ai=IV_AI, init=FAKE_VOICE) as c:
        await start_interview(c, "talk")
        await c.page.wait_for_selector('#voicePanel[data-mode="hearing"]', timeout=5000)
        await c.page.wait_for_function("document.querySelector('#liveText').textContent.includes('sept ans')", timeout=5000)
        check("J'ai fini" in await c.page.inner_text("#sendBtn"), "le bouton doit indiquer « J'ai fini de répondre » pendant la dictée")
        check("sept ans" in await c.page.input_value("#answerBox"), "la réponse dictée doit aussi être dans le cadre de texte")
        await c.shot("entretien_micro_capte")
        await c.page.click("#sendBtn")
        await c.page.wait_for_function("document.querySelectorAll('#transcript .bub.c').length===1", timeout=5000)
        turn = [x for x in c.bodies if x.get("action") == "interview_turn"]
        check(turn and "sept ans" in json.dumps(turn[-1], ensure_ascii=False), "la réponse dictée n'a pas été envoyée au recruteur")
        c.no_js_errors()


async def t_entretien_micro_silence_signale(b, base):
    async with Ctx(b, base, ai=IV_AI, init=FAKE_VOICE) as c:
        await start_interview(c, "silent")
        await c.page.wait_for_selector('#voicePanel[data-mode="listening"]', timeout=5000)
        await c.page.wait_for_selector('#voicePanel[data-mode="silent"]', timeout=9000)
        check("rien" in (await c.page.inner_text("#micState")).lower(), "il faut dire clairement que rien n'est entendu")


async def t_entretien_micro_refuse_explique(b, base):
    async with Ctx(b, base, ai=IV_AI, init=FAKE_VOICE) as c:
        await start_interview(c, "denied")
        await c.page.wait_for_timeout(400)
        await c.page.click("#micBtn")
        await c.page.wait_for_selector('#voicePanel[data-mode="error"]', timeout=5000)
        check("autorise" in (await c.page.inner_text("#micHint")).lower(), "il faut expliquer comment autoriser le micro")
        check(not await c.page.is_disabled("#answerBox"), "on doit pouvoir répondre par écrit")


# ---------- administration ----------
ADM_STATS = {"users": 5, "new_7d": 5, "free_claimed": 5, "active_monthly": 1, "active_pass3m": 0, "active_gift": 0, "blocked": 1,
             "uses_30d": {"cv": 13, "letter": 7, "interview": 5, "analyze": 18}, "cost_30d": 1.1, "cost_today": 0.49,
             "cost_free_today": 0.06, "free_daily_budget": 30, "log": []}
ADM_USERS = {"total": 2, "users": [
    {"id": "11111111-1111-1111-1111-111111111111", "email": "ami@example.ch", "name": "Ami Testeur", "created_at": "2026-10-14T10:00:00Z",
     "plan": "free", "period_end": None, "extra_interviews": 0, "free_claimed_at": None, "blocked": False, "is_admin": False, "gift": False,
     "note": None, "stripe_sub": False, "uses_30d": 3, "cost_30d": 0.05, "last_use": None, "last_sign_in_at": None},
    {"id": "22222222-2222-2222-2222-222222222222", "email": "admin@example.ch", "name": "Admin", "created_at": "2026-10-13T10:00:00Z",
     "plan": "monthly", "period_end": "2026-11-16T00:00:00Z", "extra_interviews": 0, "free_claimed_at": "2026-10-13T10:00:00Z", "blocked": False,
     "is_admin": True, "gift": False, "note": None, "stripe_sub": True, "uses_30d": 40, "cost_30d": 0.9, "last_use": None, "last_sign_in_at": None}]}


async def t_admin_offrir_un_abonnement(b, base):
    async with Ctx(b, base, ai={"admin:stats": ADM_STATS, "admin:users": ADM_USERS, "admin:grant": {"userId": "x"}}) as c:
        await c.open("admin.html#app")
        await c.page.wait_for_selector("#panel:not([hidden])", timeout=5000)
        check("5" in await c.page.inner_text("#stats"), "les statistiques ne s'affichent pas")
        check("ami@example.ch" in await c.page.inner_text("#users"), "la liste des comptes ne s'affiche pas")
        await c.page.click('[data-open="0"]')
        await c.page.wait_for_selector("#dlg[open]")
        await c.page.select_option("#gDays", "90")
        await c.page.click('[data-act="grant"]')
        await c.page.wait_for_timeout(500)
        g = [x for x in c.bodies if x.get("action") == "grant"]
        check(g and g[0]["days"] == 90 and g[0]["plan"] == "monthly" and g[0]["userId"].startswith("1111"), f"offre mal envoyée : {g}")
        await c.shot("admin")
        c.no_js_errors()


async def t_admin_refuse_aux_autres(b, base):
    async with Ctx(b, base, ai={"admin:stats": {"error": "forbidden"}, "admin:users": {"error": "forbidden"}}) as c:
        await c.open("admin.html#app")
        await c.page.wait_for_timeout(800)
        check("réservé" in await c.page.inner_text("#gate"), "un non-admin doit voir « Accès réservé »")
        check(await c.page.is_hidden("#panel"), "le panneau admin ne doit pas s'afficher")


IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1"


async def t_entretien_voix_naturelle_puis_secours(b, base):
    # audio du serveur illisible ici : la question doit quand même passer (voix du navigateur en secours) et le micro s'ouvrir
    ai = dict(IV_AI); ai["interview_start"] = dict(IV_AI["interview_start"], audio="SUQzBAAAAAAA")
    async with Ctx(b, base, ai=ai, init=FAKE_VOICE) as c:
        await start_interview(c, "talk")
        await c.page.wait_for_selector('#voicePanel[data-mode="hearing"]', timeout=12000)
        c.no_js_errors()


async def t_entretien_iphone_micro_par_appui(b, base):
    async with Ctx(b, base, 390, 844, ai=IV_AI, init=FAKE_VOICE, ua=IPHONE_UA) as c:
        await start_interview(c, "talk")
        await c.page.wait_for_timeout(900)
        check(await c.page.get_attribute("#voicePanel", "data-mode") == "off", "sur iPhone le micro ne doit pas s'allumer tout seul")
        check("appuie" in (await c.page.inner_text("#micState")).lower(), "sur iPhone il faut inviter à appuyer sur le micro")
        await c.page.click("#micBtn")
        await c.page.wait_for_selector('#voicePanel[data-mode="hearing"]', timeout=5000)
        c.no_js_errors()


async def t_entretien_appui_relance_si_rien_entendu(b, base):
    async with Ctx(b, base, ai=IV_AI, init=FAKE_VOICE) as c:
        await start_interview(c, "silent")
        await c.page.wait_for_selector('#voicePanel[data-mode="silent"]', timeout=9000)
        await c.page.evaluate("localStorage.setItem('fakeVoice','talk')")
        await c.page.click("#micBtn")
        await c.page.wait_for_selector('#voicePanel[data-mode="hearing"]', timeout=5000)
        await c.page.wait_for_function("document.querySelector('#answerBox').value.includes('sept ans')", timeout=5000)
        c.no_js_errors()


# ---------- suivi des candidatures, offres, ATS, traduction ----------
OFFER_TXT = "Chef de projet digital chez Helvetia Media à Lausanne. Pilotage de projets web, méthodes agiles, SEO. " * 3


async def t_candidature_creee_suivie_et_rouverte(b, base):
    async with Ctx(b, base) as c:
        await c.open("#app")
        await c.page.click('.apptabs [data-view="dossier"]')
        await c.page.fill("#offerText", OFFER_TXT)
        await c.page.click("#analyzeBtn"); await c.page.wait_for_selector("#offerOut:not([hidden])")
        await c.page.wait_for_selector("#dossierBar:not([hidden])", timeout=5000)
        check("Chef de projet digital" in await c.page.inner_text("#dosTitle"), "le dossier n'a pas été créé à l'analyse de l'offre")
        await c.step(3)
        await c.page.fill("#letterNotes", "7 ans de gestion de projets web au journal Le Temps, refonte du site, équipe Scrum de 9 personnes.")
        await c.page.click("#letterBtn"); await c.page.wait_for_timeout(1000)
        apps = await c.page.evaluate("window.__db.applications")
        check(len(apps) == 1 and apps[0]["letter"].startswith("Camille"), f"la lettre n'est pas enregistrée dans le dossier : {apps}")
        await c.page.click('.apptabs [data-view="dash"]')
        await c.page.wait_for_selector(".app-card", timeout=5000)
        await c.page.select_option(".app-card [data-status]", "applied"); await c.page.wait_for_timeout(400)
        apps = await c.page.evaluate("window.__db.applications")
        check(apps[0]["status"] == "applied", "le statut n'a pas été enregistré")
        await c.shot("candidatures")
        # nouvelle candidature puis réouverture de l'ancienne
        await c.page.click("#newApp")
        check(await c.page.input_value("#offerText") == "", "« Nouvelle candidature » doit repartir d'une offre vide")
        await c.page.click('.apptabs [data-view="dash"]'); await c.page.wait_for_selector(".app-card")
        await c.page.click('.app-card [data-dash="open"]'); await c.page.wait_for_timeout(500)
        check("Helvetia" in await c.page.input_value("#offerText"), "l'offre du dossier n'est pas restaurée")
        check((await c.page.input_value("#letterText")).startswith("Camille"), "la lettre du dossier n'est pas restaurée")
        c.no_js_errors()


JOBS = {"count": 2, "jobs": [
    {"id": "1", "title": "Chef de projet digital", "company": "Helvetia Media", "location": "Lausanne, Vaud", "description": "Pilotage de projets web et SEO pour nos marques.", "url": "https://www.adzuna.ch/land/ad/1", "created": "2026-10-15T08:00:00Z", "salary": "", "contract": "CDI"},
    {"id": "2", "title": "Product owner", "company": "Manor", "location": "Bâle", "description": "Backlog e-commerce.", "url": "https://www.adzuna.ch/land/ad/2", "created": None, "salary": "90 000–110 000 CHF", "contract": ""}]}


async def t_offres_emploi_recherche_et_dossier(b, base):
    async with Ctx(b, base, ai={"search_jobs": JOBS, "fetch_offer": {"error": "fetch_blocked"}}) as c:
        await c.open("#app")
        await c.page.click('.apptabs [data-view="jobs"]')
        await c.page.fill("#jobWhat", "chef de projet"); await c.page.fill("#jobWhere", "Lausanne")
        await c.page.click("#jobsBtn"); await c.page.wait_for_selector(".job-card", timeout=5000)
        q = [x for x in c.bodies if x.get("action") == "search_jobs"][0]
        check(q["country"] == "ch" and q["what"] == "chef de projet", f"recherche mal envoyée : {q}")
        check(await c.page.locator(".job-card").count() == 2, "les offres ne s'affichent pas")
        check(await c.page.is_visible("#jobsCredit"), "la mention Adzuna doit être affichée")
        await c.shot("offres")
        await c.page.click('[data-job="0"]')
        await c.page.wait_for_selector("#dossierBar:not([hidden])", timeout=8000)
        apps = await c.page.evaluate("window.__db.applications")
        check(apps and apps[0]["source"] == "adzuna" and apps[0]["url"].endswith("/1"), f"dossier mal créé depuis l'offre : {apps}")
        check("analyze_offer" in c.calls, "l'offre doit être analysée (avec le résumé si la page complète est refusée)")
        c.no_js_errors()


async def t_offres_emploi_non_configurees(b, base):
    async with Ctx(b, base, ai={"search_jobs": {"error": "jobs_not_configured"}}) as c:
        await c.open("#app")
        await c.page.click('.apptabs [data-view="jobs"]')
        await c.page.fill("#jobWhat", "comptable"); await c.page.click("#jobsBtn"); await c.page.wait_for_timeout(500)
        check("pas encore activée" in await c.page.inner_text("#jobsMsg"), "message attendu quand la clé Adzuna manque")


ATS = {"score": 64, "verdict": "Bonne base, il manque des mots-clés clés.", "criteres": [
    {"nom": "Mots-clés de l'offre", "note": 55, "commentaire": ""}, {"nom": "Expérience pertinente", "note": 75, "commentaire": ""},
    {"nom": "Compétences et qualifications", "note": 60, "commentaire": ""}, {"nom": "Lisibilité pour un ATS", "note": 80, "commentaire": ""}],
    "mots_cles_presents": ["Scrum"], "mots_cles_manquants": ["SEO technique", "Google Tag Manager"], "problemes": [{"titre": "Dates", "conseil": "Uniformise le format des dates."}]}


async def t_score_ats(b, base):
    async with Ctx(b, base, ai={"ats_score": ATS}) as c:
        await c.open("#app")
        await c.page.click('.apptabs [data-view="dossier"]')
        await c.page.fill("#offerText", OFFER_TXT)
        await c.page.click("#analyzeBtn"); await c.page.wait_for_selector("#offerOut:not([hidden])")
        await c.step(2)
        await c.page.click("#liAlt summary")
        await c.page.fill("#profileText", "Camille Rochat\nChef de projet digital\nExpérience\nLe Temps\n" * 6)
        await c.page.click("#useProfile"); await c.page.wait_for_timeout(1500)
        await c.page.click("#atsBtn"); await c.page.wait_for_selector(".ats-gauge", timeout=5000)
        txt = await c.page.inner_text("#atsOut")
        check("64" in txt and "Google Tag Manager" in txt and "Uniformise" in txt, "le score ATS ne s'affiche pas correctement")
        await c.page.wait_for_timeout(400)
        apps = await c.page.evaluate("window.__db.applications")
        check(apps and apps[0].get("ats_score") == 64, "le score ATS n'est pas enregistré dans le dossier")
        await c.shot("ats")
        c.no_js_errors()


def tr_paras(body):
    return {"paras": [[x.upper() for x in p["s"]] for p in body["paras"]]}


async def t_traduction_cv_word_et_lettre(b, base):
    async with Ctx(b, base, ai={"translate": lambda body: tr_paras(body) if body.get("what") == "cv_paras" else {"text": "Dear Sir or Madam, I am applying."}}) as c:
        await c.open("#app")
        await c.page.click('.apptabs [data-view="dossier"]')
        await c.step(2)
        await c.page.set_input_files("#cvFile", os.path.join(FIX, "cv_photo.docx"))
        await c.page.wait_for_function("!document.querySelector('#trCvBtn').disabled", timeout=8000)
        await c.page.select_option("#trLang", "en")
        await c.page.click("#trCvBtn"); await c.page.wait_for_selector("#dlTrDocx:not([hidden])", timeout=8000)
        sent = [x for x in c.bodies if x.get("action") == "translate"][0]
        check(sent["lang"] == "en" and not any(re.fullmatch(r"[\s•·\-–—*]*", t) for p in sent["paras"] for t in p["s"]), "traduction mal envoyée")
        async with c.page.expect_download() as d:
            await c.page.click("#dlTrDocx")
        doc = zipfile.ZipFile(io.BytesIO(open(await (await d.value).path(), "rb").read())).read("word/document.xml").decode("utf-8")
        check("CAMILLE ROCHAT" in doc and "HEC LAUSANNE" in doc, "le Word traduit ne contient pas la traduction")
        # lettre
        await c.step(3)
        await c.page.fill("#letterText", "Madame, Monsieur, je postule.")
        await c.page.dispatch_event("#letterText", "input")
        await c.page.click("#trLetterBtn"); await c.page.wait_for_timeout(500)
        check(await c.page.input_value("#letterText") == "Dear Sir or Madam, I am applying.", "la lettre n'a pas été traduite")
        await c.page.click("#trLetterUndo")
        check(await c.page.input_value("#letterText") == "Madame, Monsieur, je postule.", "retour à l'original impossible")
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
