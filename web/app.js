(function(){
"use strict";
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const store={get(k,d){try{const v=localStorage.getItem("postula:"+k);return v?JSON.parse(v):d}catch(e){return d}},set(k,v){try{localStorage.setItem("postula:"+k,JSON.stringify(v))}catch(e){}}};
if(window.pdfjsLib){try{pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"}catch(e){}}

/* ---------- État ---------- */
const S={offer:{url:"",text:"",info:null},cv:null,changes:[],adaptedBlob:null,adaptedText:"",cvData:null,themeId:"moderne",themePdf:null,photo:null,usePhoto:true,letter:"",tone:"formel",len:"standard"};

const EXAMPLE=`Léman Logistique SA – Genève
Cheffe / Chef de projet transformation digitale (80-100 %)

Votre mission
Rattaché·e à la Direction des opérations, vous pilotez des projets de digitalisation de nos entrepôts (WMS, traçabilité, tableaux de bord) de la phase de cadrage jusqu'à la mise en production.

Vos responsabilités
- Cadrer les besoins avec les métiers et rédiger les cahiers des charges
- Piloter les prestataires et le budget des projets (jusqu'à CHF 2 mio)
- Conduire le changement auprès des équipes terrain
- Suivre les indicateurs de performance et faire le reporting à la direction

Votre profil
- Formation supérieure en informatique de gestion, ingénierie ou équivalent
- 5 ans d'expérience minimum en gestion de projets IT
- Maîtrise d'une méthode agile (Scrum, SAFe) et de Hermes, un atout
- Expérience des appels d'offres publics ou marchés publics appréciée
- Français courant, allemand ou anglais professionnel
- Leadership, sens de la négociation, esprit de synthèse

Entrée en fonction : à convenir. Lieu : Genève (télétravail partiel possible).`;

/* ---------- Compte, quotas et appels serveur ---------- */
const CFG=window.POSTULA_CONFIG||{};
const sb=window.supabase.createClient(CFG.SUPABASE_URL,CFG.SUPABASE_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,flowType:"pkce"}});
let session=null, account=null;

async function api(action,payload,opts){
  const {data:{session:s}}=await sb.auth.getSession();
  if(!s) throw {code:"unauthorized"};
  let res;
  try{
    res=await fetch(`${CFG.SUPABASE_URL}/functions/v1/ai`,{method:"POST",signal:opts&&opts.signal,
      headers:{"Content-Type":"application/json","Authorization":`Bearer ${s.access_token}`,"apikey":CFG.SUPABASE_KEY},
      body:JSON.stringify({action,...payload})});
  }catch(e){ throw {code:e&&e.name==="AbortError"?"cancelled":"network"} }
  const body=await res.json().catch(()=>({}));
  refreshAccount();
  if(!res.ok||!body.ok) throw {code:body.error||"server_error",kind:body.kind,limit:body.limit};
  return body.result;
}
const KIND_LABEL={analyze:"analyses d'offres",cv:"adaptations de CV",letter:"lettres",interview:"entretiens"};
function errMsg(e){
  switch(e&&e.code){
    case "cancelled":return "";
    case "unauthorized":return "Ta session a expiré. Reconnecte-toi pour continuer.";
    case "claim_required":openClaim();return "Active d'abord ton offre Découverte (une vérification rapide).";
    case "quota_exceeded":return `Tu as utilisé toutes tes ${KIND_LABEL[e.kind]||"utilisations"} (${e.limit}) pour cette période. <a href="#" data-open-plans>Voir les offres</a>`;
    case "expired":return `Ton abonnement est arrivé à échéance. <a href="#" data-open-plans>Le renouveler</a>`;
    case "rate_limited":return "Beaucoup de demandes en peu de temps : attends quelques minutes avant de relancer.";
    case "rate_limited_day":return "Tu as atteint la limite de 6 entretiens par jour. Reviens demain.";
    case "free_budget_exhausted":return `L'offre Découverte est très demandée aujourd'hui : réessaie demain, ou <a href="#" data-open-plans>passe à une offre payante</a>.`;
    case "blocked":return "Ce compte est suspendu. Écris-nous si tu penses que c'est une erreur.";
    case "session_over":return "Le temps de cet entretien est écoulé.";
    case "scan_unreadable":return "Le texte de ce CV en image n'a pas pu être lu. Utilise si possible un CV Word, ou un PDF exporté depuis Word ou Canva en « PDF standard ».";
    case "too_large":return "Le document est trop long. Utilise un CV de 5 pages maximum et une annonce plus courte.";
    case "offer_too_short":return "Colle le texte complet de l'annonce (au moins quelques lignes).";
    case "not_an_offer":return "Ce texte ne ressemble pas à une offre d'emploi. Colle le texte de l'annonce.";
    case "ai_refused":return "Cette demande n'a pas pu être traitée. Reformule ta réponse et renvoie-la.";
    case "ai_busy":return "Le service est très sollicité. Réessaie dans une minute (rien n'a été décompté).";
    case "ai_invalid_json":case "ai_error":case "ai_empty":return "La génération a échoué. Relance l'opération (rien n'a été décompté).";
    case "fetch_blocked":return "Ce site ne permet pas de lire ses annonces automatiquement. Ouvre l'annonce, copie sa description et colle-la dans le cadre « Texte de l'annonce ».";
    case "fetch_failed":return "Impossible d'ouvrir ce lien (site indisponible ou annonce retirée). Copie la description de l'annonce et colle-la ci-dessous.";
    case "fetch_empty":return "La page ne contient pas le texte de l'annonce (site qui demande une connexion ou une page interactive). Copie la description et colle-la ci-dessous.";
    case "fetch_bad_url":return "Ce lien n'est pas valide. Vérifie qu'il commence par https://";
    case "network":return "Connexion impossible. Vérifie ta connexion internet.";
    default:return "Le service n'a pas répondu. Relance l'opération.";
  }
}
function need(){if(!session){throw {code:"unauthorized"}}}
function show(el,html,kind){const t=typeof el==="string"?$(el):el;t.innerHTML=html?`<div class="msg ${kind||""}">${html}</div>`:""}
function busy(btn,on,label){if(on){btn.dataset.l=btn.innerHTML;btn.innerHTML=`<span class="spinner"></span> ${label||"En cours…"}`;btn.disabled=true}else{if(btn.dataset.l)btn.innerHTML=btn.dataset.l;btn.disabled=false}}
function fail(where,e){ const m=errMsg(e); if(m) show(where,m,"err"); }
document.addEventListener("click",e=>{const a=e.target.closest("[data-open-plans]");if(a){e.preventDefault();openPlans()}});
async function save(filename,data){
  const blob=data instanceof Blob?data:new Blob([data]);
  const url=URL.createObjectURL(blob), a=document.createElement("a");
  a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),10000);
}

/* Connexion */
async function signIn(provider){
  const {error}=await sb.auth.signInWithOAuth({provider,options:{redirectTo:location.origin+location.pathname}});
  if(error) show("#authMsg","La connexion n'a pas pu démarrer. Réessaie.","err");
}
$("#loginGoogle").onclick=()=>signIn("google");
$("#loginApple").onclick=()=>signIn("apple");
$("#logoutBtn").onclick=async()=>{await sb.auth.signOut();location.reload()};
sb.auth.onAuthStateChange((_ev,s)=>{session=s;renderAuth()});
sb.auth.getSession().then(({data})=>{session=data.session;renderAuth()});
function renderAuth(){
  const inApp=!!session;
  $("#authScreen").hidden=inApp; $("#app").hidden=!inApp; $("#account").hidden=!inApp; $("#headerLogin").hidden=inApp;
  if(inApp){
    const email=session.user.email||"", name=(session.user.user_metadata&&session.user.user_metadata.full_name)||email;
    $("#accEmail").textContent=email; $("#accInitial").textContent=(name.trim()[0]||"·").toUpperCase();
    refreshAccount(); restoreCv();
  }
}
async function refreshAccount(){
  if(!session)return;
  const {data,error}=await sb.rpc("my_quota");
  if(error||!data)return;
  account=data;
  const plan=(data.admin?"Admin":({free:"Découverte",monthly:"Mensuel",pass3m:"Pass 3 mois"}[data.plan]||data.plan))+(data.gift&&!data.admin?" offert":"");
  $("#adminLink").hidden=!data.admin;
  $("#accPlan").textContent=plan;
  const q=data.quota||{}, left=k=>Math.max(0,(q[k]?.limit||0)-(q[k]?.used||0));
  $("#accQuota").innerHTML=["cv","letter","interview"].map(k=>{const n=left(k)+(k==="interview"?data.extra_interviews:0);return `<span title="${KIND_LABEL[k]} restants">${n} ${({cv:"CV",letter:n>1?"lettres":"lettre",interview:n>1?"entretiens":"entretien"})[k]}</span>`}).join("<span aria-hidden='true'>·</span>");
  if(data.plan==="free"&&!data.free_claimed) openClaim(); else $("#claimCard").hidden=true;
  $("#manageSub").hidden=!data.customer;
  const until=data.period_end?new Date(data.period_end).toLocaleDateString("fr-CH"):"";
  const extra=data.plan!=="free"&&until?(data.active?(data.subscription?`renouvellement le ${until}`:`jusqu'au ${until}`):"expiré"):"";
  if(data.admin){$("#accPlan").innerHTML=`${esc(plan)}<span class="long"> · illimité</span>`;$("#accPlan").classList.remove("miss");$("#accQuota").innerHTML="<span>Aucune limite</span>";return}
  $("#accPlan").innerHTML=esc(plan)+(extra?(data.active?`<span class="long"> · ${esc(extra)}</span>`:` · ${esc(extra)}`):"");
  $("#accPlan").classList.toggle("miss",data.plan!=="free"&&!data.active);
}

/* Activation de l'offre Découverte : captcha + empreinte d'appareil */
let claimRendered=false;
function openClaim(){
  $("#claimCard").hidden=false;
  if(claimRendered)return;
  if(!window.turnstile){setTimeout(openClaim,400);return}
  claimRendered=true;
  turnstile.render("#turnstileBox",{sitekey:CFG.TURNSTILE_SITE_KEY,language:"fr",callback:token=>claimFree(token)});
}
async function claimFree(token){
  show("#claimMsg",'<span class="spinner"></span> Vérification…',"info");
  try{
    const fp=await (await FingerprintJS.load()).get();
    const {data:{session:s}}=await sb.auth.getSession();
    const res=await fetch(`${CFG.SUPABASE_URL}/functions/v1/claim-free`,{method:"POST",
      headers:{"Content-Type":"application/json","Authorization":`Bearer ${s.access_token}`,"apikey":CFG.SUPABASE_KEY},
      body:JSON.stringify({turnstileToken:token,deviceId:fp.visitorId})});
    const body=await res.json().catch(()=>({}));
    if(!res.ok) throw {code:body.error};
    show("#claimMsg","Offre Découverte activée : 1 CV adapté, 1 lettre et 1 entretien noté.","info");
    setTimeout(()=>{$("#claimCard").hidden=true},1800); refreshAccount();
  }catch(e){
    const m={device_used:"L'offre Découverte a déjà été utilisée sur cet appareil.",ip_limit:"L'offre Découverte a déjà été utilisée plusieurs fois depuis ce réseau ce mois-ci.",provider_not_allowed:"L'offre Découverte nécessite une connexion Google ou Apple.",captcha_failed:"La vérification a échoué. Recharge la page et réessaie."}[e&&e.code];
    show("#claimMsg",(m||"L'activation a échoué. Réessaie dans un instant.")+` <a href="#" data-open-plans>Voir les offres payantes</a>`,"err");
    try{turnstile.reset("#turnstileBox")}catch(_){}
  }
}

/* Offres (le paiement arrive à l'étape suivante) */
function openPlans(){ $("#plansDialog").hidden=false; $("#plansDialog").scrollIntoView({behavior:"smooth",block:"center"}) }
$("#closePlans").onclick=()=>{$("#plansDialog").hidden=true};
async function billing(payload){
  const {data:{session:s}}=await sb.auth.getSession();
  if(!s) throw {code:"unauthorized"};
  const res=await fetch(`${CFG.SUPABASE_URL}/functions/v1/billing`,{method:"POST",
    headers:{"Content-Type":"application/json","Authorization":`Bearer ${s.access_token}`,"apikey":CFG.SUPABASE_KEY},
    body:JSON.stringify(payload)});
  const body=await res.json().catch(()=>({}));
  if(!res.ok||!body.url) throw {code:body.error||"server_error",until:body.until};
  return body.url;
}
const BILLING_ERR={
  topup_requires_plan:"La recharge s'ajoute à un abonnement ou un pass en cours. Choisis d'abord le Mensuel ou le Pass 3 mois.",
  already_subscribed:"Tu as déjà un abonnement mensuel actif. Gère-le avec le bouton « Gérer mon abonnement ».",
  plan_active:"Tu as déjà une offre active. Tu pourras en reprendre une à son échéance, ou ajouter une recharge d'entretiens.",
  payments_not_configured:"Le paiement en ligne n'est pas encore ouvert. Réessaie bientôt.",
  price_not_found:"Le paiement en ligne n'est pas encore ouvert. Réessaie bientôt.",
  no_customer:"Aucun paiement n'est encore associé à ce compte."
};
function billingMsg(e){
  let m=BILLING_ERR[e&&e.code]||"Le paiement n'a pas pu démarrer. Réessaie dans un instant.";
  if(e&&e.code==="plan_active"&&e.until) m=`Ton offre actuelle est valable jusqu'au ${new Date(e.until).toLocaleDateString("fr-CH")}. Tu pourras en reprendre une ensuite, ou ajouter une recharge d'entretiens.`;
  return m;
}
$$("[data-buy]").forEach(b=>b.onclick=async()=>{
  show("#plansMsg",""); busy(b,true,"Redirection…");
  try{ location.href=await billing({action:"checkout",product:b.dataset.buy}); }
  catch(e){ busy(b,false); show("#plansMsg",billingMsg(e),"err"); }
});
$("#manageSub").onclick=async()=>{
  const b=$("#manageSub"); show("#plansMsg",""); busy(b,true,"Ouverture…");
  try{ location.href=await billing({action:"portal"}); }
  catch(e){ busy(b,false); openPlans(); show("#plansMsg",billingMsg(e),"err"); }
};
/* Retour de la page de paiement Stripe */
(function(){
  const p=new URLSearchParams(location.search), st=p.get("paiement");
  if(!st)return;
  history.replaceState(null,"",location.pathname);
  if(st==="annule"){ setTimeout(()=>{openPlans();show("#plansMsg","Paiement annulé : rien n'a été débité.","info")},300); return; }
  const label={monthly:"Ton abonnement Mensuel",pass3m:"Ton Pass Recherche 3 mois",topup:"Ta recharge de 10 entretiens"}[p.get("offre")]||"Ton offre";
  $("#payBanner").hidden=false; $("#payBanner").innerHTML=`<span class="spinner"></span> Paiement reçu. Activation de ton offre…`;
  let tries=0;
  const poll=async()=>{
    tries++; await refreshAccount();
    const done=account&&(p.get("offre")==="topup"?true:account.active);
    if(done&&(p.get("offre")!=="topup"||tries>2)){ $("#payBanner").innerHTML=`<b>${label} est actif.</b> Merci ! Le reçu t'a été envoyé par e-mail.`; setTimeout(()=>{$("#payBanner").hidden=true},8000); return; }
    if(tries<15) setTimeout(poll,2000);
    else $("#payBanner").innerHTML="Le paiement est bien reçu, l'activation prend un peu plus de temps que prévu. Recharge la page dans une minute.";
  };
  setTimeout(poll,1500);
})();

/* ---------- Navigation ---------- */
function go(n,scroll){
  $$("section[data-step]").forEach(s=>{const on=s.dataset.step===String(n);if(on&&s.hidden){s.classList.remove("enter");void s.offsetWidth;s.classList.add("enter")}s.hidden=!on});
  const ol=$("nav.steps ol"); if(ol) ol.style.setProperty("--p",(n-1)/3);
  if(scroll){const top=$("#app").getBoundingClientRect().top+scrollY-70; if(scrollY>top) scrollTo({top,behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"})}
  $$("nav.steps button").forEach(b=>{if(b.dataset.go===String(n))b.setAttribute("aria-current","step");else b.removeAttribute("aria-current")});
  if(n===4) refreshHistory(); else if("speechSynthesis" in window&&IV&&IV.state==="speaking"){try{speechSynthesis.cancel()}catch(e){}}
  store.set("step",n);
}
$$("nav.steps button").forEach(b=>b.onclick=()=>go(+b.dataset.go,true));

/* Petits plus d'interface : en-tête au défilement, toast, menu compte, boutons « Commencer » */
const header=$("#top");
const setHdr=()=>document.documentElement.style.setProperty("--hdr",header.offsetHeight+"px");
setHdr(); try{new ResizeObserver(setHdr).observe(header)}catch(e){addEventListener("resize",setHdr)}
addEventListener("scroll",()=>header.classList.toggle("scrolled",scrollY>4),{passive:true});
let toastTimer=null;
function toast(text,ms){const t=$("#toast");t.textContent=text;t.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove("show"),ms||2600)}
document.addEventListener("click",e=>{
  const m=$("#accMenu"); if(m&&m.open&&(!m.contains(e.target)||e.target.closest(".acc-pop .btn"))) m.open=false;
  const c=e.target.closest("[data-login]"); if(c){e.preventDefault();$("#connexion").scrollIntoView({behavior:"smooth",block:"start"});setTimeout(()=>$("#loginGoogle").focus({preventScroll:true}),450)}
});
document.addEventListener("keydown",e=>{if(e.key==="Escape"){const m=$("#accMenu");if(m)m.open=false}});
if(!CFG.APPLE_ENABLED) $("#loginApple").hidden=true;
function markDone(n){$(`nav.steps button[data-go="${n}"]`).classList.add("done")}

/* ---------- Étape 1 : offre ---------- */
const offerText=$("#offerText"), offerUrl=$("#offerUrl");
offerText.value=store.get("offerText",EXAMPLE); offerUrl.value=store.get("offerUrl","");
function syncExample(){$("#exBadge").hidden=offerText.value.trim()!==EXAMPLE.trim()}
syncExample();
offerText.addEventListener("input",()=>{store.set("offerText",offerText.value);syncExample()});
offerUrl.addEventListener("input",e=>{store.set("offerUrl",offerUrl.value);
  // Nouveau lien : l'exemple prérempli ou l'annonce précédente ne doivent pas être analysés à sa place
  if(offerUrl.value.trim()){
    if(offerText.value.trim()===EXAMPLE.trim()){offerText.value="";store.set("offerText","");syncExample()}
    else if(offerText.value.trim()&&S.offer.info&&S.offer.info._src===offerText.value.trim().slice(0,400)){offerText.value="";store.set("offerText","");syncExample()}
  }
  urlHint();
  clearTimeout(linkTimer);
  if(e.inputType==="insertFromPaste"||e.inputType==="insertReplacementText"||e.inputType==="insertFromDrop") linkTimer=setTimeout(()=>readLink(),300);
});
offerUrl.addEventListener("change",()=>{clearTimeout(linkTimer);readLink()});
offerUrl.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();clearTimeout(linkTimer);readLink()}});
let linkTimer=null, linkCtl=null, lastLink=store.get("lastLink","");
const isLink=u=>/^https?:\/\/[^\s/]+\.[^\s]{2,}/i.test(u);
/* Lit l'annonce directement depuis son lien (pages publiques ; LinkedIn exclu), puis lance l'analyse */
async function readLink(force){
  const u=offerUrl.value.trim();
  if(!isLink(u)||(!force&&u===lastLink))return false;
  if(/linkedin\./i.test(u)){show("#offerMsg","LinkedIn ne laisse pas lire ses annonces automatiquement : ouvre l'annonce, copie sa description et colle-la ci-dessous.","info");return false}
  if(!session)return false;
  if(linkCtl)linkCtl.abort(); linkCtl=new AbortController();
  const btn=$("#analyzeBtn"); let r=null;
  show("#offerMsg",""); busy(btn,true,"Lecture de l'annonce…");
  try{ r=await api("fetch_offer",{url:u},{signal:linkCtl.signal}); }
  catch(e){ if(e&&e.code!=="cancelled"){fail("#offerMsg",e);offerText.focus()} }
  finally{ busy(btn,false); }
  if(!r||offerUrl.value.trim()!==u)return false;
  lastLink=u; store.set("lastLink",u);
  offerText.value=r.text; store.set("offerText",r.text); syncExample();
  toast("Annonce récupérée sur "+r.host);
  await $("#analyzeBtn").onclick();
  return true;
}
const TOUCH=matchMedia("(pointer: coarse)").matches;
function urlHint(){
  const li=/linkedin\./i.test(offerUrl.value);
  const how=TOUCH
    ?"Ouvre l'annonce, appuie sur « Afficher plus », puis garde le doigt appuyé sur la description pour la sélectionner et la copier."
    :"Ouvre l'annonce, sélectionne la description (Ctrl/Cmd + A sélectionne toute la page) et copie-la.";
  $("#urlHint").textContent=li?"LinkedIn ne laisse pas lire ses annonces automatiquement : colle aussi le texte ci-dessous. "+how:"On lit l'annonce automatiquement sur la plupart des sites (jobup.ch, jobs.ch, sites carrière…). Pour LinkedIn, ou si ça ne marche pas, colle le texte ci-dessous.";
}
urlHint();
$("#clearOffer").onclick=()=>{offerText.value="";offerUrl.value="";store.set("offerText","");store.set("offerUrl","");syncExample();offerText.focus()};

/* Coller l'annonce en un geste (lit le presse-papiers, puis lance l'analyse) */
const pasteBtn=$("#pasteBtn");
if(!(navigator.clipboard&&navigator.clipboard.readText)) pasteBtn.hidden=true;
pasteBtn.onclick=async()=>{
  show("#offerMsg","");
  let t="";
  try{ t=(await navigator.clipboard.readText()||"").trim(); }
  catch(e){ offerText.focus(); show("#offerMsg",TOUCH?"Ton navigateur n'a pas autorisé la lecture du presse-papiers. Appuie longuement dans le cadre ci-dessous, puis sur « Coller ».":"Ton navigateur n'a pas autorisé la lecture du presse-papiers. Clique dans le cadre ci-dessous, puis Ctrl/Cmd + V.","info"); return; }
  if(!t){ show("#offerMsg","Le presse-papiers est vide. Copie d'abord la description de l'annonce.","info"); return; }
  if(/^https?:\/\/\S+$/.test(t)){
    offerUrl.value=t; offerUrl.dispatchEvent(new Event("input")); clearTimeout(linkTimer);
    if(/linkedin\./i.test(t)){show("#offerMsg","Lien ajouté. LinkedIn ne laisse pas lire ses annonces : copie maintenant la description, puis appuie à nouveau sur « Coller l'annonce ».","info");return}
    await readLink(true); return;
  }
  offerText.value=t.slice(0,15000); store.set("offerText",offerText.value); syncExample();
  if(t.length>=80) $("#analyzeBtn").onclick();
  else show("#offerMsg","Le texte copié est très court. Copie toute la description du poste.","info");
};

const savedInfo=store.get("offerInfo",null);
if(savedInfo&&savedInfo._src===offerText.value.trim().slice(0,400)){S.offer.info=savedInfo;renderOffer()}

$("#analyzeBtn").onclick=async()=>{
  const btn=$("#analyzeBtn"); show("#offerMsg","");
  const text=offerText.value.trim();
  if(text.length<80&&isLink(offerUrl.value.trim())&&!/linkedin\./i.test(offerUrl.value)){await readLink(true);return}
  if(text.length<80){
    show("#offerMsg",offerUrl.value.trim()&&!text
      ?"Le lien seul ne suffit pas : colle aussi le texte de l'annonce dans le cadre « Texte de l'annonce »."
      :"Colle le texte complet de l'annonce (au moins quelques lignes) pour que l'analyse soit utile.","err");
    offerText.focus();return}
  if(text.length>15000){show("#offerMsg","L'annonce est trop longue (15 000 caractères maximum). Retire les parties sans rapport avec le poste.","err");return}
  analyzing=(async()=>{try{need();busy(btn,true,"Analyse…");
    const info=await api("analyze_offer",{offerText:text,offerUrl:offerUrl.value.slice(0,500)});
    info._src=text.slice(0,400); S.offer.info=info; store.set("offerInfo",info); renderOffer(); markDone(1); toast("Offre analysée");
    if(info.langue&&["fr","en","de","it"].includes(info.langue)) $("#ivLang").value=info.langue;
    updateKw();
  }catch(e){fail("#offerMsg",e)}finally{busy(btn,false)}})();
  await analyzing;
};
let analyzing=null;
function renderOffer(){
  const i=S.offer.info; if(!i)return;
  $("#offerEmpty").hidden=true; const o=$("#offerOut"); o.hidden=false;
  const li=a=>(a||[]).filter(Boolean).map(x=>`<li>${esc(x)}</li>`).join("");
  o.innerHTML=`<div class="stack">
    <dl class="kv"><dt>Poste</dt><dd>${esc(i.poste||"—")}</dd><dt>Entreprise</dt><dd>${esc(i.entreprise||"—")}</dd><dt>Lieu</dt><dd>${esc(i.lieu||"—")}${i.taux?" · "+esc(i.taux):""}</dd></dl>
    <p style="margin:0">${esc(i.resume||"")}</p>
    <div><label>Exigences</label><ul class="clean">${li(i.exigences)}</ul></div>
    <div><label>Mots-clés ATS</label><div class="chips">${(i.mots_cles_ats||[]).map(k=>`<span class="pill">${esc(k)}</span>`).join("")}</div></div>
    <div><label>Ce que l'entretien va creuser</label><ul class="clean">${li(i.themes_entretien)}</ul></div>
    <div class="row"><button class="btn primary" id="toCv">${S.cv?"Adapter mon CV à cette offre":"Passer au CV"}</button>${S.cv?`<span class="hint" style="margin:0">${esc(S.cv.name)}</span>`:""}</div></div>`;
  $("#toCv").onclick=()=>{go(2,true); if(S.cv) $("#adaptBtn").click();};
}
async function ensureOffer(where){
  if(S.offer.info)return true;
  if(offerText.value.trim().length<80){show(where,"Renseigne d'abord l'offre à l'étape 1.","err");return false}
  await $("#analyzeBtn").onclick(); // lance l'analyse et attend son résultat
  if(!S.offer.info) show(where,"L'analyse de l'offre a échoué : relance-la à l'étape 1.","err");
  return !!S.offer.info;
}

/* ---------- Étape 2 : CV ---------- */
const W="http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MC="http://schemas.openxmlformats.org/markup-compatibility/2006";
const drop=$("#drop"), fileIn=$("#cvFile");
["dragenter","dragover"].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add("over")}));
["dragleave","drop"].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove("over")}));
drop.addEventListener("drop",e=>{const f=e.dataTransfer.files[0];if(f)loadCv(f)});
fileIn.addEventListener("change",()=>{const f=fileIn.files[0];if(f)loadCv(f)});

let views={}; // nom -> fonction de rendu
function setViews(v,active){
  views=v; const t=$("#vtabs"); t.innerHTML=""; if(!active) return;
  Object.keys(v).forEach(k=>{const b=document.createElement("button");b.className="btn"+(k===active?" primary":"");b.textContent=k;b.onclick=()=>setViews(views,k);t.appendChild(b)});
  const el=$("#viewer"); el.innerHTML='<div class="empty"><span class="spinner"></span></div>';
  Promise.resolve(v[active](el)).catch(()=>{el.innerHTML='<div class="empty">Aperçu indisponible pour ce fichier. Le téléchargement fonctionne quand même.</div>'});
}
async function renderDocxInto(el,blob){
  el.innerHTML="";
  if(!window.docx||!docx.renderAsync){el.innerHTML='<div class="empty">Aperçu Word indisponible ici. Le fichier reste téléchargeable.</div>';return}
  const box=document.createElement("div"); el.appendChild(box);
  await docx.renderAsync(blob,box,null,{inWrapper:true,breakPages:true,ignoreLastRenderedPageBreak:true,experimental:true});
  const page=box.querySelector("section.docx"); if(page){const z=Math.min(1,(el.clientWidth-32)/page.offsetWidth); box.style.zoom=z}
}
async function renderPdfInto(el,buf){
  el.innerHTML="";
  if(!window.pdfjsLib){el.innerHTML='<div class="empty">Aperçu PDF indisponible ici.</div>';return}
  const pdf=await pdfjsLib.getDocument({data:new Uint8Array(buf.slice(0)),isEvalSupported:false,useSystemFonts:true}).promise;
  for(let p=1;p<=Math.min(pdf.numPages,4);p++){
    const page=await pdf.getPage(p); const vp=page.getViewport({scale:2});
    const c=document.createElement("canvas"); c.width=vp.width;c.height=vp.height; el.appendChild(c);
    await page.render({canvasContext:c.getContext("2d"),viewport:vp}).promise;
  }
}

/* DOCX : lecture des paragraphes en segments (texte de même mise en forme, séparés par tabulations/sauts) */
function nearestP(n){let x=n.parentNode;while(x&&x.nodeType===1){if(x.namespaceURI===W&&x.localName==="p")return x;x=x.parentNode}return null}
function hasAnc(n,ns,name){let x=n.parentNode;while(x&&x.nodeType===1){if(x.namespaceURI===ns&&x.localName===name)return true;x=x.parentNode}return false}
function rKey(r){const pr=[...r.childNodes].find(c=>c.nodeType===1&&c.localName==="rPr");return pr?new XMLSerializer().serializeToString(pr):""}
function paraSegments(p){
  const segs=[]; let cur=null;
  const walk=node=>{
    for(const c of node.childNodes){
      if(c.nodeType!==1)continue;
      if(c.namespaceURI===W&&c.localName==="p")continue; // paragraphe imbriqué (zone de texte)
      if(c.namespaceURI===W&&(c.localName==="del"||c.localName==="instrText"))continue;
      if(c.namespaceURI===MC&&c.localName==="Fallback")continue;
      if(c.namespaceURI===W&&c.localName==="r"){
        const key=rKey(c);
        for(const k of c.childNodes){
          if(k.nodeType!==1)continue;
          if(k.localName==="t"){ if(!cur||cur.key!==key){cur={key,ts:[]};segs.push(cur)} cur.ts.push(k) }
          else if(["tab","br","cr","ptab"].includes(k.localName)){cur=null}
          else if(k.localName==="drawing"||k.localName==="pict"||k.localName==="AlternateContent"){cur=null}
        }
        continue;
      }
      walk(c);
    }
  };
  walk(p);
  segs.forEach(s=>s.text=s.ts.map(t=>t.textContent).join(""));
  return segs;
}
async function parseDocx(buf){
  const zip=await JSZip.loadAsync(buf.slice(0));
  const f=zip.file("word/document.xml"); if(!f)throw new Error("docx invalide");
  const xml=await f.async("string");
  const dom=new DOMParser().parseFromString(xml,"application/xml");
  if(dom.getElementsByTagName("parsererror").length)throw new Error("xml");
  const all=[...dom.getElementsByTagNameNS(W,"p")];
  const paras=[], fallbacks=[];
  all.forEach(p=>{
    const segs=paraSegments(p);
    if(!segs.some(s=>s.text.trim()))return;
    if(hasAnc(p,MC,"Fallback")){fallbacks.push({p,segs});return}
    paras.push({p,segs});
  });
  return {zip,dom,paras,fallbacks};
}
function docxPlain(paras){return paras.map(x=>x.segs.map(s=>s.text).join("")).join("\n")}

/* PDF : texte reconstruit ligne par ligne */
async function pdfText(buf){
  const pdf=await pdfjsLib.getDocument({data:new Uint8Array(buf.slice(0)),isEvalSupported:false,useSystemFonts:true}).promise;
  const out=[];
  for(let p=1;p<=pdf.numPages;p++){
    const tc=await (await pdf.getPage(p)).getTextContent();
    const items=tc.items.filter(i=>i.str&&i.str.trim()).map(i=>({s:i.str,x:i.transform[4],y:i.transform[5],w:i.width}));
    items.sort((a,b)=>b.y-a.y||a.x-b.x);
    let line=[],ly=null; const lines=[];
    for(const it of items){ if(ly===null||Math.abs(it.y-ly)<3){line.push(it);ly=ly===null?it.y:ly} else {lines.push(line);line=[it];ly=it.y} }
    if(line.length)lines.push(line);
    lines.forEach(l=>{l.sort((a,b)=>a.x-b.x);let s="",px=null;l.forEach(it=>{if(px!==null&&it.x-px>4)s+=it.x-px>40?"   ":" ";s+=it.s;px=it.x+it.w});out.push(s)});
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g,"\n\n");
}

const cvStore={
  db(){return new Promise((res,rej)=>{const r=indexedDB.open("postula",1);r.onupgradeneeded=()=>r.result.createObjectStore("files");r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})},
  async op(mode,fn){const db=await this.db();return new Promise((res,rej)=>{const tx=db.transaction("files",mode);const q=fn(tx.objectStore("files"));tx.oncomplete=()=>res(q&&q.result);tx.onerror=()=>rej(tx.error)})},
  save(v){return this.op("readwrite",s=>s.put(v,"cv")).catch(()=>{})},
  get(){return this.op("readonly",s=>s.get("cv")).catch(()=>null)},
  clear(){return this.op("readwrite",s=>s.delete("cv")).catch(()=>{})}
};
$("#forgetCv").onclick=async()=>{
  await cvStore.clear(); $("#cvSaved").hidden=true; S.cv=null;
  $("#dropTitle").textContent="Dépose ton CV ici"; $("#dropSub").textContent="ou clique pour choisir un fichier .docx ou .pdf";
  $("#adaptBtn").disabled=true; $("#themeBtn").disabled=true; $("#photoRow").hidden=true; $("#dlThemeDocx").hidden=true; $("#dlThemePdf").hidden=true;
  setViews({},null); $("#viewer").innerHTML='<div class="empty"><span class="sheet-ghost" aria-hidden="true"></span>L\'aperçu de ton CV s\'affichera ici.</div>';
  if(S.offer.info) renderOffer(); toast("CV oublié sur cet appareil");
};
function useProfileText(text,restored){
  show("#cvMsg",""); S.changes=[];S.adaptedBlob=null;S.adaptedText="";S.cvData=null;S.themePdf=null;S.photo=null;$("#photoRow").hidden=true;
  $("#changesCard").hidden=true;$("#dlDocx").hidden=true;$("#dlThemePdf").hidden=true;$("#dlThemeDocx").hidden=true;$("#kwBox").hidden=true;
  S.cv={kind:"text",name:"Profil LinkedIn",text:text.slice(0,40000)};
  $("#dropTitle").textContent="Profil LinkedIn"; $("#dropSub").textContent="Texte collé · mis en forme avec le thème choisi ci-dessous";
  $("#adaptBtn").disabled=false; $("#themeBtn").disabled=false; $("#cvSaved").hidden=false; $("#liAlt").open=false;
  renderPhotoRow("none");
  setViews({},null); $("#viewer").innerHTML='<div class="empty"><span class="sheet-ghost" aria-hidden="true"></span>Ton CV apparaîtra ici une fois mis en forme.</div>';
  if(!restored) cvStore.save({name:"Profil LinkedIn",kind:"text",text:S.cv.text,savedAt:Date.now()});
  updateKw(); if(S.offer.info) renderOffer();
}
$("#useProfile").onclick=()=>{
  const t=$("#profileText").value.trim();
  if(t.length<200){show("#profileMsg","Colle un peu plus de ton profil : au minimum ton parcours (expériences) et ta formation.","err");return}
  show("#profileMsg",""); useProfileText(t);
  if(S.offer.info) $("#adaptBtn").click(); else show("#cvMsg","Profil enregistré. Analyse l'offre à l'étape 1, puis reviens ici pour créer ton CV.","info");
};
async function restoreCv(){
  const v=await cvStore.get(); if(!v||S.cv) return;
  if(v.kind==="text"&&v.text){ useProfileText(v.text,true); return; }
  if(!v.buf) return;
  await loadCv(new File([v.buf],v.name,{type:v.type||""}),{ocr:v.ocr||null});
  if(S.offer.info) renderOffer();
}
async function loadCv(f,restored){
  show("#cvMsg",""); S.changes=[];S.adaptedBlob=null;S.adaptedText="";S.cvData=null;S.themePdf=null;S.photo=null;$("#photoRow").hidden=true;
  $("#changesCard").hidden=true;$("#dlDocx").hidden=true;$("#dlThemePdf").hidden=true;$("#kwBox").hidden=true;
  const name=f.name, ext=name.split(".").pop().toLowerCase();
  if(!["docx","pdf"].includes(ext)){show("#cvMsg","Format non pris en charge. Utilise un fichier .docx (Word) ou .pdf.","err");return}
  if(f.size>15*1024*1024){show("#cvMsg","Fichier trop lourd (15 Mo maximum).","err");return}
  $("#dropTitle").textContent=name; $("#dropSub").textContent="Lecture…";
  try{
    const buf=await f.arrayBuffer();
    if(ext==="docx"){
      if(!window.JSZip)throw new Error("lib");
      const d=await parseDocx(buf);
      S.cv={kind:"docx",name,buf,text:docxPlain(d.paras),nParas:d.paras.length};
      $("#dropSub").textContent=`Word · ${d.paras.length} paragraphes · mise en page conservée à l'adaptation`;
      setViews({"Original":el=>renderDocxInto(el,new Blob([buf]))},"Original");
    }else{
      if(!window.pdfjsLib)throw new Error("lib");
      let text=await pdfText(buf), scanned=null;
      if(text.trim().length<60){
        // CV en image (scan, export Canva « image »…) : l'IA lit la page
        scanned=restored&&restored.ocr?restored.ocr:await readScannedPdf(buf);
        text=scanned.text;
      }
      S.cv={kind:"pdf",name,buf,text,scanned};
      $("#dropSub").textContent="PDF · contenu adapté puis remis en forme avec le thème choisi";
      setViews({"Original":el=>renderPdfInto(el,buf)},"Original");
      if(scanned) show("#cvMsg","Ce CV est une image : son texte a été lu automatiquement. Il sera adapté puis remis en forme avec le thème choisi ci-dessous (vérifie le résultat).","info");
      else if(/linkedin\.com\/in\//i.test(text)) show("#cvMsg","Profil LinkedIn reconnu : il sera transformé en CV avec le thème choisi ci-dessous.","info");
      else show("#cvMsg","Un PDF ne se modifie pas proprement sur place. Le contenu sera adapté puis mis en forme avec le thème choisi ci-dessous. Pour garder ta mise en page exacte, charge plutôt ton CV en .docx.","info");
    }
    $("#adaptBtn").disabled=false; $("#themeBtn").disabled=false; updateKw();
    findPhoto(ext,buf,S.cv.scanned&&S.cv.scanned.photo);
    // garde aussi le texte lu d'un CV en image, pour ne pas le relire (et le décompter) à chaque visite
    if(!restored||(S.cv.scanned&&!restored.ocr)) cvStore.save({name,type:f.type,buf:buf.slice(0),ocr:S.cv.scanned||null,savedAt:Date.now()});
    $("#cvSaved").hidden=false;
    if(S.offer.info) renderOffer();
  }catch(e){
    $("#dropSub").textContent="ou clique pour choisir un fichier .docx ou .pdf";
    if(e&&e.code){ $("#dropTitle").textContent="Dépose ton CV ici"; $("#dropSub").textContent="ou clique pour choisir un fichier .docx ou .pdf"; fail("#cvMsg",e); return }
    show("#cvMsg",e&&e.message==="lib"?"Les outils de lecture de fichiers n'ont pas pu se charger. Recharge la page.":"Impossible de lire ce fichier. Vérifie qu'il s'ouvre bien dans Word ou un lecteur PDF.","err");
  }
}

/* CV en image : on envoie les pages (3 max) en JPEG à l'IA, qui transcrit le texte et repère la photo */
async function renderPdfPage(pdf,n,maxW){
  const page=await pdf.getPage(n), vp1=page.getViewport({scale:1}), sc=Math.min(3,maxW/vp1.width), vp=page.getViewport({scale:sc});
  const c=document.createElement("canvas"); c.width=Math.round(vp.width); c.height=Math.round(vp.height);
  const g=c.getContext("2d"); g.fillStyle="#fff"; g.fillRect(0,0,c.width,c.height);
  await page.render({canvasContext:g,viewport:vp}).promise; return c;
}
async function readScannedPdf(buf){
  $("#dropSub").textContent="CV en image : lecture du texte en cours…";
  const pdf=await pdfjsLib.getDocument({data:new Uint8Array(buf.slice(0)),isEvalSupported:false}).promise;
  const images=[];
  for(let n=1;n<=Math.min(3,pdf.numPages);n++){const c=await renderPdfPage(pdf,n,1400);images.push(c.toDataURL("image/jpeg",0.82).split(",")[1])}
  const r=await api("read_cv_image",{images});
  if(!r||!r.text||r.text.trim().length<60) throw {code:"scan_unreadable"};
  return {text:r.text,photo:r.photo||null};
}
async function photoFromBox(buf,box){
  const pdf=await pdfjsLib.getDocument({data:new Uint8Array(buf.slice(0)),isEvalSupported:false}).promise;
  const c=await renderPdfPage(pdf,1,1800);
  const x=box.x0*c.width,y=box.y0*c.height,w=(box.x1-box.x0)*c.width,h=(box.y1-box.y0)*c.height;
  if(w<40||h<40)return null;
  const out=document.createElement("canvas"); out.width=Math.round(w); out.height=Math.round(h);
  out.getContext("2d").drawImage(c,x,y,w,h,0,0,out.width,out.height);
  return makePhoto(out,out.width,out.height,null);
}

/* ---------- Photo du CV ---------- */
const NS_A="http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R="http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_V="urn:schemas-microsoft-com:vml";
async function blobImg(blob){
  const url=URL.createObjectURL(blob);
  try{const img=new Image();img.src=url;await img.decode();return img}
  finally{setTimeout(()=>URL.revokeObjectURL(url),5000)}
}
/* Recadrage carré centré (visage en haut pour les portraits) + version ronde */
function makePhoto(src,sw,sh,crop){
  crop=crop||{l:0,t:0,r:0,b:0};
  const x=sw*crop.l,y=sh*crop.t,w=sw*(1-crop.l-crop.r),h=sh*(1-crop.t-crop.b);
  const side=Math.min(w,h), cx=x+(w-side)/2, cy=y+(h>w?(h-side)*0.12:(h-side)/2);
  const N=600, sq=document.createElement("canvas"); sq.width=sq.height=N;
  const g=sq.getContext("2d"); g.fillStyle="#ffffff"; g.fillRect(0,0,N,N); g.drawImage(src,cx,cy,side,side,0,0,N,N);
  const ci=document.createElement("canvas"); ci.width=ci.height=N;
  const h2=ci.getContext("2d"); h2.beginPath(); h2.arc(N/2,N/2,N/2,0,Math.PI*2); h2.closePath(); h2.clip(); h2.drawImage(sq,0,0);
  return {square:sq.toDataURL("image/jpeg",0.9),circle:ci.toDataURL("image/png")};
}
/* Niveau de détail d'une image (écart-type de la luminosité sur une vignette 40×40).
   Une vraie photo varie beaucoup ; un aplat ou un dégradé décoratif (fréquent dans les CV Word) presque pas. */
function imgDetail(src,sx,sy,sw,sh){
  const c=document.createElement("canvas"); c.width=c.height=40; const g=c.getContext("2d",{willReadFrequently:true});
  g.fillStyle="#fff"; g.fillRect(0,0,40,40);
  try{ if(sw) g.drawImage(src,sx,sy,sw,sh,0,0,40,40); else g.drawImage(src,0,0,40,40) }catch(e){ return 0 }
  const d=g.getImageData(0,0,40,40).data; let n=0,sum=0,sq=0,edges=0,prev=null;
  for(let i=0;i<d.length;i+=4){const l=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];sum+=l;sq+=l*l;n++;if(prev!==null&&Math.abs(l-prev)>18)edges++;prev=l}
  const m=sum/n, sd=Math.sqrt(Math.max(0,sq/n-m*m));
  return sd*(0.5+Math.min(1,edges/120));
}
const detailFactor=dt=>dt<10?0:Math.min(1.6,dt/30);
function photoScore(w,h,order){
  if(w<90||h<90)return -1;               // icônes
  const ar=w/h; if(ar<0.55||ar>1.6)return -1; // logos, bandeaux
  return w*h*(order===0?1.3:1)*(ar<=1.05?1.2:1);
}
async function docxPhoto(buf){
  const zip=await JSZip.loadAsync(buf.slice(0));
  const parts=Object.keys(zip.files).filter(n=>/^word\/(document|header\d*|footer\d*)\.xml$/.test(n)).sort((a,b)=>(a==="word/document.xml"?-1:0)-(b==="word/document.xml"?-1:0));
  const cands=[], seen=new Set();
  for(const part of parts){
    const base=part.split("/").pop(), relF=zip.file(`word/_rels/${base}.rels`); if(!relF)continue;
    const rels=new DOMParser().parseFromString(await relF.async("string"),"application/xml");
    const map={}; [...rels.getElementsByTagName("Relationship")].forEach(r=>map[r.getAttribute("Id")]=r.getAttribute("Target"));
    const dom=new DOMParser().parseFromString(await zip.file(part).async("string"),"application/xml");
    const refs=[];
    [...dom.getElementsByTagNameNS(NS_A,"blip")].forEach(b=>{
      const id=b.getAttributeNS(NS_R,"embed"); if(!id)return;
      const sr=[...(b.parentNode?b.parentNode.childNodes:[])].find(c=>c.nodeType===1&&c.localName==="srcRect");
      const f=a=>sr&&sr.getAttribute(a)?Math.max(0,Math.min(0.9,parseInt(sr.getAttribute(a),10)/100000)):0;
      refs.push({id,crop:{l:f("l"),t:f("t"),r:f("r"),b:f("b")}});
    });
    // anciennes images Word (VML) : image simple ou forme remplie par une photo (souvent ronde)
    [...dom.getElementsByTagNameNS(NS_V,"imagedata"),...dom.getElementsByTagNameNS(NS_V,"fill")].forEach(v=>{const id=v.getAttributeNS(NS_R,"id");if(id)refs.push({id,crop:null})});
    refs.forEach(r=>{
      const t=map[r.id]; if(!t||/^https?:/i.test(t))return;
      const path=("word/"+t).replace(/word\/\.\.\//,"").replace(/^\/+/,"");
      const key=path+JSON.stringify(r.crop); if(seen.has(key))return; seen.add(key);
      cands.push({path,crop:r.crop,order:cands.length});
    });
  }
  // en plus, toutes les images du fichier (photo insérée d'une façon non prévue) : moins prioritaires
  Object.keys(zip.files).filter(n=>/^word\/media\//.test(n)&&!cands.some(c=>c.path===n)).forEach(p=>cands.push({path:p,crop:null,order:cands.length+1}));
  let best=null;
  for(const c of cands){
    if(!/\.(jpe?g|png|gif|bmp|webp)$/i.test(c.path))continue;
    const f=zip.file(c.path); if(!f)continue;
    try{
      const img=await blobImg(await f.async("blob"));
      const cr=c.crop||{l:0,t:0,r:0,b:0}, w=img.naturalWidth*(1-cr.l-cr.r), h=img.naturalHeight*(1-cr.t-cr.b);
      let s=photoScore(w,h,c.order); if(s<=0)continue;
      s*=detailFactor(imgDetail(img,img.naturalWidth*cr.l,img.naturalHeight*cr.t,w,h));
      if(s>0&&(!best||s>best.s))best={s,img,crop:cr};
    }catch(e){}
  }
  return best?makePhoto(best.img,best.img.naturalWidth,best.img.naturalHeight,best.crop):null;
}
async function pdfPhoto(buf){
  const pdf=await pdfjsLib.getDocument({data:new Uint8Array(buf.slice(0)),isEvalSupported:false,useSystemFonts:true}).promise;
  const page=await pdf.getPage(1), ops=await page.getOperatorList();
  let r=null;
  try{ r=await pdfPhotoObjects(page,ops,pdfImagePlacements(page,ops)) }catch(e){}
  if(!r){ try{ r=await pdfPhotoRendered(page,ops) }catch(e){} }
  return r;
}
/* Repère où chaque image est posée sur la page, puis découpe ce rectangle dans le rendu de la page.
   Marche aussi pour les photos masquées, détourées ou intégrées d'une façon que l'extraction directe ne lit pas. */
/* Où chaque image est posée sur la page (rectangle en points), d'après les opérations de dessin */
function pdfImagePlacements(page,ops){
  const O=pdfjsLib.OPS, mul=(m,n)=>[m[0]*n[0]+m[2]*n[1],m[1]*n[0]+m[3]*n[1],m[0]*n[2]+m[2]*n[3],m[1]*n[2]+m[3]*n[3],m[0]*n[4]+m[2]*n[5]+m[4],m[1]*n[4]+m[3]*n[5]+m[5]];
  const vp=page.getViewport({scale:1}); let ctm=[1,0,0,1,0,0]; const stack=[]; const out=[];
  const IMG=new Set([O.paintImageXObject,O.paintInlineImageXObject,O.paintJpegXObject].filter(x=>x!==undefined));
  ops.fnArray.forEach((fn,i)=>{const a=ops.argsArray[i];
    if(fn===O.save)stack.push(ctm); else if(fn===O.restore)ctm=stack.pop()||[1,0,0,1,0,0];
    else if(fn===O.transform)ctm=mul(ctm,a);
    else if(fn===O.paintFormXObjectBegin){stack.push(ctm);if(a&&Array.isArray(a[0])&&a[0].length===6)ctm=mul(ctm,a[0])}
    else if(fn===O.paintFormXObjectEnd)ctm=stack.pop()||[1,0,0,1,0,0];
    else if(IMG.has(fn)){
      const pts=[[0,0],[1,0],[0,1],[1,1]].map(([x,y])=>[ctm[0]*x+ctm[2]*y+ctm[4],ctm[1]*x+ctm[3]*y+ctm[5]]);
      const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);
      const [x1,y1,x2,y2]=vp.convertToViewportRectangle([Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)]);
      out.push({name:typeof (a&&a[0])==="string"?a[0]:null,x:Math.min(x1,x2),y:Math.min(y1,y2),w:Math.abs(x2-x1),h:Math.abs(y2-y1),pageArea:vp.width*vp.height});
    }});
  return out;
}
async function pdfPhotoRendered(page,ops){
  const O=pdfjsLib.OPS, mul=(m,n)=>[m[0]*n[0]+m[2]*n[1],m[1]*n[0]+m[3]*n[1],m[0]*n[2]+m[2]*n[3],m[1]*n[2]+m[3]*n[3],m[0]*n[4]+m[2]*n[5]+m[4],m[1]*n[4]+m[3]*n[5]+m[5]];
  const vp=page.getViewport({scale:1}); let ctm=[1,0,0,1,0,0]; const stack=[]; const rects=[];
  const IMG=new Set([O.paintImageXObject,O.paintInlineImageXObject,O.paintJpegXObject].filter(x=>x!==undefined));
  ops.fnArray.forEach((fn,i)=>{const a=ops.argsArray[i];
    if(fn===O.save)stack.push(ctm); else if(fn===O.restore)ctm=stack.pop()||[1,0,0,1,0,0];
    else if(fn===O.transform)ctm=mul(ctm,a);
    else if(fn===O.paintFormXObjectBegin){stack.push(ctm);if(a&&Array.isArray(a[0])&&a[0].length===6)ctm=mul(ctm,a[0])}
    else if(fn===O.paintFormXObjectEnd)ctm=stack.pop()||[1,0,0,1,0,0];
    else if(IMG.has(fn)){
      const pts=[[0,0],[1,0],[0,1],[1,1]].map(([x,y])=>[ctm[0]*x+ctm[2]*y+ctm[4],ctm[1]*x+ctm[3]*y+ctm[5]]);
      const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);
      const [x1,y1,x2,y2]=vp.convertToViewportRectangle([Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)]);
      rects.push({x:Math.min(x1,x2),y:Math.min(y1,y2),w:Math.abs(x2-x1),h:Math.abs(y2-y1),k:rects.length});
    }});
  const cand=[];
  for(const r of rects){
    const x=Math.max(0,r.x),y=Math.max(0,r.y),w=Math.min(vp.width,r.x+r.w)-x,h=Math.min(vp.height,r.y+r.h)-y;
    if(w<34||h<34)continue;                                  // moins d'environ 12 mm : icône
    const ar=w/h; if(ar<0.55||ar>1.6)continue;
    if(w*h>vp.width*vp.height*0.25)continue;                 // fond de page
    cand.push({s:w*h*(y<vp.height*0.4?1.5:1)*(ar<=1.05?1.2:1),x,y,w,h});
  }
  if(!cand.length)return null;
  const SC=3, cv=document.createElement("canvas"); cv.width=Math.ceil(vp.width*SC); cv.height=Math.ceil(vp.height*SC);
  const g=cv.getContext("2d"); g.fillStyle="#fff"; g.fillRect(0,0,cv.width,cv.height);
  await page.render({canvasContext:g,viewport:page.getViewport({scale:SC})}).promise;
  let best=null;
  for(const c of cand){ const s=c.s*detailFactor(imgDetail(cv,c.x*SC,c.y*SC,c.w*SC,c.h*SC)); if(s>0&&(!best||s>best.s))best={...c,s} }
  if(!best)return null;
  const out=document.createElement("canvas"); out.width=Math.round(best.w*SC); out.height=Math.round(best.h*SC);
  out.getContext("2d").drawImage(cv,best.x*SC,best.y*SC,best.w*SC,best.h*SC,0,0,out.width,out.height);
  return makePhoto(out,out.width,out.height,null);
}
async function pdfPhotoObjects(page,ops,places){
  const O=pdfjsLib.OPS;
  const names=[];
  ops.fnArray.forEach((fn,i)=>{if(fn===O.paintImageXObject||fn===O.paintJpegXObject||fn===O.paintImageXObjectRepeat){const n=ops.argsArray[i][0];if(typeof n==="string"&&!names.includes(n))names.push(n)}});
  let best=null;
  for(let k=0;k<names.length;k++){
    const name=names[k];
    // une image qui recouvre une grande partie de la page est un fond (ou un CV entièrement en image), pas une photo
    const pl=(places||[]).find(p=>p.name===name); if(pl&&pl.w*pl.h>pl.pageArea*0.25)continue;
    const obj=await new Promise(res=>{
      const st=name.startsWith("g_")?page.commonObjs:page.objs; let done=false; const fin=v=>{if(!done){done=true;res(v)}};
      try{ if(st.has&&st.has(name)) fin(st.get(name)); else st.get(name,fin) }catch(e){fin(null)}
      setTimeout(()=>fin(null),4000);
    });
    if(!obj)continue;
    const w=obj.width||(obj.bitmap&&obj.bitmap.width), h=obj.height||(obj.bitmap&&obj.bitmap.height);
    let s=photoScore(w,h,k); if(s<=0)continue;
    const c=document.createElement("canvas"); c.width=w;c.height=h; const g=c.getContext("2d");
    if(obj.bitmap){g.drawImage(obj.bitmap,0,0)}
    else if(obj.data&&(obj.kind===2||obj.kind===3)){
      const id=g.createImageData(w,h), d=obj.data, out=id.data;
      if(obj.kind===3) out.set(d.subarray(0,out.length));
      else for(let i=0,j=0;j<out.length;i+=3,j+=4){out[j]=d[i];out[j+1]=d[i+1];out[j+2]=d[i+2];out[j+3]=255}
      g.putImageData(id,0,0);
    }else continue;
    s*=detailFactor(imgDetail(c)); if(s<=0||(best&&s<=best.s))continue;
    best={s,c,w,h};
  }
  return best?makePhoto(best.c,best.w,best.h,null):null;
}
function renderPhotoRow(found){
  const row=$("#photoRow"), th=$("#photoThumb"); row.hidden=false;
  if(S.photo){th.innerHTML=`<img alt="Photo du CV" src="${S.photo.circle}">`;$("#usePhoto").disabled=false;$("#photoBtnLabel").textContent="Changer la photo"}
  else{th.textContent="Photo";$("#usePhoto").disabled=true;$("#photoBtnLabel").textContent="Ajouter une photo"}
  const li=S.cv&&(S.cv.kind==="text"||/linkedin\.com\/in\//i.test(S.cv.text||""));
  $("#photoHint").textContent=S.photo?(found==="upload"?"Photo ajoutée":"Récupérée depuis ton CV · recadrée automatiquement")
    :li?"LinkedIn ne fournit pas ta photo : ajoute-la ici si tu veux qu'elle figure sur ton CV.":"Aucune photo trouvée dans ton CV : tu peux l'ajouter ici.";
}
async function findPhoto(kind,buf,box){
  try{ S.photo=kind==="docx"?await docxPhoto(buf):(box?await photoFromBox(buf,box):await pdfPhoto(buf)) }catch(e){ S.photo=null }
  renderPhotoRow("cv");
  if(S.cvData) await buildThemePdf();
}
$("#usePhoto").addEventListener("change",async e=>{S.usePhoto=e.target.checked;if(S.cvData)await buildThemePdf()});
$("#photoFile").addEventListener("change",async()=>{
  const f=$("#photoFile").files[0]; if(!f)return;
  try{const img=await blobImg(f);S.photo=makePhoto(img,img.naturalWidth,img.naturalHeight,null);S.usePhoto=true;$("#usePhoto").checked=true;renderPhotoRow("upload");if(S.cvData)await buildThemePdf()}
  catch(e){show("#themeMsg","Cette image n'a pas pu être lue. Utilise un JPEG ou un PNG.","err")}
  $("#photoFile").value="";
});

/* Couverture des mots-clés */
function kwCover(text){const kws=(S.offer.info&&S.offer.info.mots_cles_ats)||[];const t=(text||"").toLowerCase();return kws.map(k=>({k,ok:t.includes(String(k).toLowerCase())}))}
function updateKw(){
  if(!S.cv||!S.offer.info)return;
  const before=kwCover(S.cv.text), after=kwCover(S.adaptedText||S.cv.text);
  if(!before.length)return;
  $("#kwBox").hidden=false;
  $("#kwBefore").textContent=`Avant : ${before.filter(x=>x.ok).length}/${before.length}`;
  $("#kwAfter").textContent=`Après : ${after.filter(x=>x.ok).length}/${after.length}`;
  $("#kwAfter").hidden=!S.adaptedText;
  $("#kwChips").innerHTML=after.map(x=>`<span class="pill ${x.ok?"ok":"miss"}">${x.ok?"✓":"·"} ${esc(x.k)}</span>`).join("");
}

$("#adaptBtn").onclick=async()=>{
  const btn=$("#adaptBtn"); show("#cvMsg","");
  if(!S.cv)return;
  if(!(await ensureOffer("#cvMsg")))return;
  if(S.cv.kind!=="docx"){ $("#themeBtn").click(); return; }
  try{need();busy(btn,true,"Adaptation…");
    const d=await parseDocx(S.cv.buf);
    // On n'envoie que les morceaux de texte réels : puces, tirets, séparateurs restent tels quels.
    // Sinon l'IA les fusionne ou les oublie, et la modification ne peut plus être replacée (CV « non modifié »).
    const FIXED=/^[\s•·\-–—*▪●◦○■□►▸✓✔|:;,.()\[\]\/]*$/;
    const sent=d.paras.map((x,i)=>{const idx=x.segs.map((g,k)=>FIXED.test(g.text)?-1:k).filter(k=>k>=0);return {i,idx,s:idx.map(k=>x.segs[k].text)}}).filter(x=>x.s.length);
    const payload=sent.map(x=>({s:x.s}));
    const o=S.offer.info;
    if(JSON.stringify(payload).length>60000) throw {code:"too_large"};
    const res=await api("adapt_cv",{offer:o,paras:payload});
    const mods=[];
    (res&&Array.isArray(res.modifs)?res.modifs:[]).forEach(m=>{
      const x=sent[m.i]; if(!x||!Array.isArray(m.s))return;
      let ns=m.s.map(v=>String(v??""));
      // tolérance : un seul morceau modifiable mais réponse découpée autrement → on recolle
      if(ns.length!==x.s.length){ if(x.s.length===1) ns=[ns.join(" ").replace(/\s+/g," ").trim()]; else return; }
      const p=d.paras[x.i], before=p.segs.map(g=>g.text), after=before.slice();
      x.idx.forEach((k,j)=>{after[k]=ns[j]});
      if(after.join("")===before.join(""))return;
      mods.push({i:x.i,s:after,before,why:m.raison||"",on:true});
    });
    S.changes=mods;
    $("#chgSummary").textContent=res&&res.resume||"";
    renderChanges(); await applyChanges(); markDone(2);
    if(!mods.length) show("#cvMsg","Aucune modification utile trouvée : ton CV couvre déjà bien l'offre.","info");
  }catch(e){fail("#cvMsg",e)}finally{busy(btn,false)}
};
function wordDiff(a,b){
  const A=a.split(/(\s+)/),B=b.split(/(\s+)/),set=new Set(A.map(w=>w.toLowerCase()));
  return B.map(w=>/\S/.test(w)&&!set.has(w.toLowerCase())?`<mark>${esc(w)}</mark>`:esc(w)).join("");
}
function renderChanges(){
  const box=$("#changes"); box.innerHTML="";
  $("#changesCard").hidden=!S.changes.length;
  $("#chgCount").textContent=`${S.changes.filter(c=>c.on).length}/${S.changes.length} retenues`;
  S.changes.forEach((c,k)=>{
    const before=c.before.join(""), after=c.s.join("");
    const el=document.createElement("label"); el.className="chg";
    el.innerHTML=`<input type="checkbox" id="chg${k}" ${c.on?"checked":""}><div class="before">${esc(before)}</div><span></span><div class="after">${wordDiff(before,after)}</div><span></span><div class="why">${esc(c.why)}</div>`;
    el.querySelector("input").onchange=async e=>{c.on=e.target.checked;$("#chgCount").textContent=`${S.changes.filter(c=>c.on).length}/${S.changes.length} retenues`;await applyChanges()};
    box.appendChild(el);
  });
}
const XMLNS="http://www.w3.org/XML/1998/namespace";
function setSegs(segs,arr){
  segs.forEach((seg,j)=>{seg.ts.forEach((t,n)=>{t.textContent=n===0?arr[j]:"";if(n===0)t.setAttributeNS(XMLNS,"xml:space","preserve")})});
}
async function applyChanges(){
  if(!S.cv||S.cv.kind!=="docx")return;
  const d=await parseDocx(S.cv.buf);
  const map=new Map();
  S.changes.filter(c=>c.on).forEach(c=>{const p=d.paras[c.i];if(!p)return;map.set(p.segs.map(s=>s.text).join("\u0001"),c.s);setSegs(p.segs,c.s)});
  d.fallbacks.forEach(f=>{const k=f.segs.map(s=>s.text).join("\u0001");const v=map.get(k);if(v&&v.length===f.segs.length)setSegs(f.segs,v)});
  let xml=new XMLSerializer().serializeToString(d.dom);
  if(!xml.startsWith("<?xml"))xml='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'+xml;
  d.zip.file("word/document.xml",xml);
  S.adaptedBlob=await d.zip.generateAsync({type:"blob",mimeType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",compression:"DEFLATE"});
  S.adaptedText=docxPlain(d.paras);
  $("#dlDocx").hidden=false; updateKw();
  const v={"CV adapté":el=>renderDocxInto(el,S.adaptedBlob),"Original":el=>renderDocxInto(el,new Blob([S.cv.buf]))};
  if(S.themePdf) v["Version thème"]=el=>renderPdfInto(el,S.themePdf);
  setViews(v,"CV adapté");
}
$("#dlDocx").onclick=async()=>{if(!S.adaptedBlob)return;const base=S.cv.name.replace(/\.docx$/i,"");await save(`${base} - ${slug(S.offer.info&&S.offer.info.entreprise)||"adapté"}.docx`,S.adaptedBlob,"#cvMsg")};
function slug(s){return String(s||"").replace(/[\\/:*?"<>|]/g,"").trim().slice(0,40)}

/* ---------- Thèmes PDF ---------- */
const THEMES=[
  {id:"moderne",name:"Moderne",font:"Carlito",word:"Calibri",layout:"sidebar",accent:"#0E7A68",ink:"#1B2421"},
  {id:"classique",name:"Classique",font:"Caladea",word:"Cambria",layout:"single",accent:"#1F3A5F",ink:"#1A1D24"},
  {id:"executif",name:"Exécutif",font:"Carlito",word:"Calibri",layout:"band",accent:"#9A7424",ink:"#22262E"},
  {id:"epure",name:"Épuré",font:"Poppins",word:"Calibri Light",layout:"gutter",accent:"#8A3B5C",ink:"#1E1E22"}
];
function themeThumb(t){
  const a=t.accent,i=t.ink;
  if(t.layout==="sidebar")return `<svg viewBox="0 0 84 60"><rect width="26" height="60" fill="${a}" opacity=".14"/><rect x="31" y="6" width="34" height="5" fill="${i}"/><rect x="31" y="13" width="22" height="3" fill="${a}"/><rect x="31" y="22" width="46" height="2" fill="#ccc"/><rect x="31" y="27" width="40" height="2" fill="#ccc"/><rect x="31" y="34" width="46" height="2" fill="#ccc"/><rect x="5" y="8" width="16" height="2" fill="${a}"/><rect x="5" y="13" width="14" height="2" fill="#bbb"/><rect x="5" y="17" width="12" height="2" fill="#bbb"/></svg>`;
  if(t.layout==="band")return `<svg viewBox="0 0 84 60"><rect width="84" height="17" fill="${i}"/><rect x="8" y="5" width="34" height="4" fill="#fff"/><rect x="8" y="11" width="20" height="2" fill="${a}"/><rect x="8" y="23" width="18" height="2" fill="${a}"/><rect x="8" y="28" width="68" height="2" fill="#ccc"/><rect x="8" y="33" width="60" height="2" fill="#ccc"/><rect x="8" y="41" width="18" height="2" fill="${a}"/><rect x="8" y="46" width="68" height="2" fill="#ccc"/></svg>`;
  if(t.layout==="gutter")return `<svg viewBox="0 0 84 60"><rect x="8" y="6" width="40" height="5" fill="${i}"/><rect x="8" y="13" width="22" height="2" fill="${a}"/><rect x="8" y="24" width="14" height="2" fill="${a}"/><rect x="28" y="24" width="48" height="2" fill="#ccc"/><rect x="28" y="29" width="44" height="2" fill="#ccc"/><rect x="8" y="38" width="14" height="2" fill="${a}"/><rect x="28" y="38" width="48" height="2" fill="#ccc"/><rect x="28" y="43" width="40" height="2" fill="#ccc"/></svg>`;
  return `<svg viewBox="0 0 84 60"><rect x="22" y="6" width="40" height="5" fill="${i}"/><rect x="30" y="13" width="24" height="2" fill="${a}"/><rect x="8" y="20" width="68" height=".8" fill="${a}"/><rect x="8" y="25" width="20" height="2" fill="${a}"/><rect x="8" y="30" width="68" height="2" fill="#ccc"/><rect x="8" y="35" width="62" height="2" fill="#ccc"/><rect x="8" y="43" width="20" height="2" fill="${a}"/><rect x="8" y="48" width="68" height="2" fill="#ccc"/></svg>`;
}
(function(){const box=$("#themes");THEMES.forEach(t=>{const b=document.createElement("button");b.className="theme";b.setAttribute("aria-pressed",String(t.id===S.themeId));b.innerHTML=themeThumb(t)+`<span>${t.name}</span>`;b.onclick=async()=>{S.themeId=t.id;$$(".theme").forEach(x=>x.setAttribute("aria-pressed","false"));b.setAttribute("aria-pressed","true");if(S.cvData)await buildThemePdf()};box.appendChild(b)})})();

$("#themeBtn").onclick=async()=>{
  const btn=$("#themeBtn"); show("#themeMsg","");
  if(!S.cv)return;
  if(!(await ensureOffer("#themeMsg")))return;
  try{need();busy(btn,true,"Mise en forme…");
    const o=S.offer.info, src=S.adaptedText||S.cv.text, adapt=!S.adaptedText;
    const data=await api("structure_cv",{offer:o,cvText:src.slice(0,40000),adapt});
    S.cvData=data; await buildThemePdf(); markDone(2);
    if(S.cv.kind!=="docx"){S.adaptedText=cvDataText(data);updateKw()}
    $("#themes").scrollIntoView({behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth",block:"center"});
  }catch(e){fail("#themeMsg",e)}finally{busy(btn,false)}
};
function cvDataText(d){return [d.nom,d.titre,d.profil,...(d.experiences||[]).flatMap(e=>[e.poste,e.entreprise,...(e.points||[])]),...(d.formation||[]).map(f=>f.diplome+" "+f.ecole),...(d.competences||[]).flatMap(c=>[c.categorie,...(c.items||[])]),...(d.certifications||[])].join("\n")}
async function buildThemePdf(){
  try{
    await ensureFonts();
    const t=THEMES.find(x=>x.id===S.themeId);
    const doc=renderCVFit(S.cvData,t,S.usePhoto?S.photo:null);
    S.themePdf=doc.output("arraybuffer");
    $("#dlThemePdf").hidden=false; $("#dlThemeDocx").hidden=false;
    const v={"Version thème":el=>renderPdfInto(el,S.themePdf)};
    if(S.adaptedBlob) v["CV adapté"]=el=>renderDocxInto(el,S.adaptedBlob);
    if(S.cv.kind==="docx") v["Original"]=el=>renderDocxInto(el,new Blob([S.cv.buf])); else if(S.cv.kind==="pdf") v["Original"]=el=>renderPdfInto(el,S.cv.buf);
    setViews(v,"Version thème");
  }catch(e){show("#themeMsg","La mise en forme a échoué. Essaie un autre thème.","err")}
}
$("#dlThemeDocx").onclick=async()=>{
  if(!S.cvData)return;
  try{const t=THEMES.find(x=>x.id===S.themeId);const blob=await cvDocx(S.cvData,t,S.usePhoto?S.photo:null);
    const n=S.cvData.nom?slug(S.cvData.nom):"CV"; await save(`${n} - CV ${t.name}.docx`,blob); toast("Version Word téléchargée")}
  catch(e){show("#themeMsg","La version Word n'a pas pu être créée.","err")}
};
$("#dlThemePdf").onclick=async()=>{if(!S.themePdf)return;const n=S.cvData&&S.cvData.nom?slug(S.cvData.nom):"CV";await save(`${n} - CV ${THEMES.find(x=>x.id===S.themeId).name}.pdf`,new Blob([S.themePdf]),"#themeMsg")};

/* Version Word du CV thème : une colonne, police et couleurs du thème, entièrement modifiable */
function cvDocx(d,th,photo){
  const X=v=>String(v??"").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
  const T=v=>clean(v);
  const ACC=th.accent.replace("#",""), INK=th.ink.replace("#",""), GREY="5E6574", W=9638;
  const run=(t,o={})=>t?`<w:r><w:rPr>${o.b?"<w:b/>":""}${o.i?"<w:i/>":""}${o.caps?"<w:caps/>":""}<w:color w:val="${o.c||INK}"/>${o.sz?`<w:sz w:val="${Math.round(o.sz*2)}"/><w:szCs w:val="${Math.round(o.sz*2)}"/>`:""}${o.sp?`<w:spacing w:val="${o.sp}"/>`:""}</w:rPr><w:t xml:space="preserve">${X(t)}</w:t></w:r>`:"";
  const tab='<w:r><w:tab/></w:r>';
  const para=(runs,o={})=>`<w:p><w:pPr>${o.keep?"<w:keepNext/>":""}${o.border?`<w:pBdr><w:bottom w:val="single" w:sz="8" w:space="3" w:color="${ACC}"/></w:pBdr>`:""}${o.tab?`<w:tabs><w:tab w:val="right" w:pos="${W}"/></w:tabs>`:""}<w:spacing w:before="${o.before||0}" w:after="${o.after??0}" w:line="${o.line||250}" w:lineRule="auto"/>${o.ind?`<w:ind w:left="${o.ind}" w:hanging="${o.hang||0}"/>`:""}</w:pPr>${runs}</w:p>`;
  const R=Object.assign({profil:"Profil",experiences:"Expérience professionnelle",formation:"Formation",competences:"Compétences",langues:"Langues",certifications:"Certifications",interets:"Centres d'intérêt"},d.rubriques||{});
  const head=k=>para(run(T(R[k]),{b:true,caps:true,sz:11,c:ACC,sp:10}),{border:true,before:220,after:100,keep:true});
  const bullet=t=>para(run("•",{c:ACC,sz:10.5})+tab+run(T(t),{sz:10.5}),{ind:300,hang:300,after:40});
  const contact=[d.contact&&d.contact.email,d.contact&&d.contact.telephone,d.contact&&d.contact.ville,d.contact&&d.contact.linkedin,...((d.contact&&d.contact.autres)||[])].map(T).filter(Boolean).join("  |  ");
  const top=para(run(T(d.nom),{b:true,sz:24}),{after:40})+para(run(T(d.titre),{sz:13,c:ACC}),{after:60})+para(run(contact,{sz:9.5,c:GREY}),{after:0});
  const EMU=1008000;
  const pic=`<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${EMU}" cy="${EMU}"/><wp:docPr id="1" name="Photo"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="photo.jpg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdPhoto"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${EMU}" cy="${EMU}"/></a:xfrm><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  const nob='<w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders>';
  let body=photo?`<w:tbl><w:tblPr><w:tblW w:w="${W}" w:type="dxa"/>${nob}<w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="${W-1900}"/><w:gridCol w:w="1900"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="${W-1900}" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>${top}</w:tc><w:tc><w:tcPr><w:tcW w:w="1900" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:jc w:val="right"/></w:pPr>${pic}</w:p></w:tc></w:tr></w:tbl>`:top;
  if(T(d.profil)) body+=head("profil")+para(run(T(d.profil),{sz:10.5}),{after:40});
  if((d.experiences||[]).length){body+=head("experiences");d.experiences.forEach(e=>{
    const dates=T([e.debut,e.fin].filter(Boolean).join(" – "));
    body+=para(run(T(e.poste),{b:true,sz:11.5})+(dates?tab+run(dates,{sz:9.5,c:GREY}):""),{tab:true,keep:true,before:100});
    const sub=T([e.entreprise,e.lieu].filter(Boolean).join(" · "));
    if(sub) body+=para(run(sub,{i:true,sz:10.5,c:ACC}),{after:60,keep:true});
    (e.points||[]).filter(p=>T(p)).forEach(p=>body+=bullet(p));
  })}
  if((d.formation||[]).length){body+=head("formation");d.formation.forEach(f=>{
    body+=para(run(T(f.diplome),{b:true,sz:11})+(T(f.annee)?tab+run(T(f.annee),{sz:9.5,c:GREY}):""),{tab:true,keep:true,before:80});
    const sub=T([f.ecole,f.details].filter(Boolean).join(" · ")); if(sub) body+=para(run(sub,{sz:10,c:GREY}),{after:40});
  })}
  if((d.competences||[]).length){body+=head("competences");d.competences.forEach(c=>{
    const items=T((c.items||[]).join(", ")); if(!items&&!T(c.categorie))return;
    body+=para((T(c.categorie)?run(T(c.categorie)+" : ",{b:true,sz:10.5}):"")+run(items,{sz:10.5}),{after:60});
  })}
  if((d.langues||[]).length) body+=head("langues")+para(run(d.langues.map(l=>T([l.langue,l.niveau].filter(Boolean).join(" – "))).filter(Boolean).join("   ·   "),{sz:10.5}),{after:40});
  const certs=(d.certifications||[]).filter(c=>T(c)); if(certs.length){body+=head("certifications");certs.forEach(c=>body+=bullet(c))}
  const ints=(d.interets||[]).filter(c=>T(c)); if(ints.length) body+=head("interets")+para(run(ints.map(T).join(", "),{sz:10.5}),{after:40});
  const zip=new JSZip();
  zip.file("[Content_Types].xml",`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
  zip.file("_rels/.rels",`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels",`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${photo?'<Relationship Id="rIdPhoto" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/photo.jpeg"/>':""}</Relationships>`);
  zip.file("word/styles.xml",`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${th.word}" w:hAnsi="${th.word}" w:cs="${th.word}" w:eastAsia="${th.word}"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="fr-CH"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`);
  if(photo) zip.file("word/media/photo.jpeg",photo.square.split(",")[1],{base64:true});
  zip.file("word/document.xml",`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="850" w:right="1134" w:bottom="850" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({type:"blob",mimeType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",compression:"DEFLATE"});
}

/* Moteur de rendu jsPDF : vraies polices embarquées (Carlito, Caladea, Poppins), texte sélectionnable */
const FONT_FILES={Carlito:{normal:"Carlito-Regular.ttf",bold:"Carlito-Bold.ttf",italic:"Carlito-Italic.ttf"},
  Caladea:{normal:"Caladea-Regular.ttf",bold:"Caladea-Bold.ttf",italic:"Caladea-Italic.ttf"},
  Poppins:{normal:"Poppins-Regular.ttf",bold:"Poppins-Bold.ttf",italic:"Poppins-Italic.ttf"}};
const FONT_FALLBACK={Carlito:"helvetica",Caladea:"times",Poppins:"helvetica"};
let fontData=null, fontsReady=null;
function ensureFonts(){
  if(!fontsReady) fontsReady=(async()=>{
    const out={};
    await Promise.all(Object.values(FONT_FILES).flatMap(f=>Object.values(f)).map(async file=>{
      const r=await fetch("fonts/"+file); if(!r.ok) throw new Error("font");
      const b=new Uint8Array(await r.arrayBuffer()); let bin=""; for(let i=0;i<b.length;i+=0x8000) bin+=String.fromCharCode.apply(null,b.subarray(i,i+0x8000));
      out[file]=btoa(bin);
    }));
    fontData=out; return true;
  })().catch(()=>{fontData=null;return false});
  return fontsReady;
}
function newDoc(){
  const {jsPDF}=window.jspdf; const doc=new jsPDF({unit:"mm",format:"a4",compress:true});
  if(fontData) for(const [fam,styles] of Object.entries(FONT_FILES)) for(const [st,file] of Object.entries(styles)){doc.addFileToVFS(file,fontData[file]);doc.addFont(file,fam,st)}
  return doc;
}
const famOf=f=>fontData?f:(FONT_FALLBACK[f]||f);
const WIN=new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ".split(""));
const OK_RANGES=[[32,126],[160,383],[536,539],[8208,8231],[8240,8240],[8249,8250],[8364,8364],[8482,8482],[8592,8595],[8722,8722]];
function clean(s){
  s=String(s??"").replace(/[‐‑‒]/g,"-").replace(/[  ]/g," ").replace(/^[•●▪‣\-*]\s+/gm,"");
  return s.split("").filter(c=>{const k=c.charCodeAt(0);if(c==="\n")return true;return fontData?OK_RANGES.some(([a,b])=>k>=a&&k<=b):((k>=32&&k<=126)||(k>=160&&k<=255)||WIN.has(c))}).join("").replace(/[ \t]{2,}/g," ").trim();
}
function hex(h){h=h.replace("#","");return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]}
function mix(h,w,t){const a=hex(h),b=hex(w);return a.map((v,i)=>Math.round(v*(1-t)+b[i]*t))}
/* Si la dernière page ne contient presque rien, on resserre légèrement le texte pour gagner une page */
function renderCVFit(d,th,photo){
  const doc=renderCV(d,th,photo,1), n=doc.getNumberOfPages();
  if(n>1&&doc._lastFill<0.4) for(const k of [0.96,0.92,0.88,0.85]){const d2=renderCV(d,th,photo,k);if(d2.getNumberOfPages()<n)return d2}
  return doc;
}
function renderCV(d,th,photo,K){
  K=K||1;
  const doc=newDoc(); const setFS=doc.setFontSize.bind(doc); doc.setFontSize=sz=>setFS(sz*K);
  const PW=210,PH=297,F=famOf(th.font), ACC=hex(th.accent), INK=hex(th.ink), MUTE=[96,104,116];
  const fit=(text,maxW,start,min,style)=>{let sz=start;doc.setFont(F,style||"bold");for(;sz>min;sz-=0.5){doc.setFontSize(sz);if(doc.getTextWidth(text)<=maxW)break}doc.setFontSize(sz);return sz};
  const measure=(text,size,style,w)=>{text=clean(text);if(!text)return 0;doc.setFont(F,style||"normal");doc.setFontSize(size);return doc.splitTextToSize(text,w).length*lh(size)};
  const R=Object.assign({profil:"Profil",experiences:"Expérience professionnelle",formation:"Formation",competences:"Compétences",langues:"Langues",certifications:"Certifications",interets:"Centres d'intérêt",contact:"Contact"},d.rubriques||{});
  const lh=sz=>sz*K*0.3528*1.38;
  const sideW=th.layout==="sidebar"?66:0;
  const decor=()=>{ if(th.layout==="sidebar"){doc.setFillColor(...mix(th.accent,"#ffffff",0.88));doc.rect(0,0,sideW,PH,"F")} };
  decor();
  function Col(x,w,top,bottom){this.x=x;this.w=w;this.y=top;this.top2=16;this.bottom=bottom;this.page=1}
  Col.prototype.ensure=function(h){
    if(this.y+h>this.bottom){this.page++;while(doc.getNumberOfPages()<this.page){doc.addPage();decor()}this.y=this.top2}
    doc.setPage(this.page);
  };
  function txt(col,s,o){
    o=o||{}; s=clean(s); if(!s)return;
    const sz=o.size||9.5; doc.setFont(F,o.style||"normal"); doc.setFontSize(sz); doc.setTextColor(...(o.color||INK));
    const ind=o.indent||0, w=col.w-ind-(o.right||0);
    const lines=doc.splitTextToSize(s,w);
    lines.forEach((ln,k)=>{col.ensure(lh(sz));
      if(o.bullet&&k===0){doc.setFillColor(...(o.bcolor||ACC));doc.circle(col.x+ind-2.6,col.y-sz*0.3528*0.32,0.55,"F")}
      doc.text(ln,col.x+ind,col.y,o.cs?{charSpace:o.cs}:undefined);col.y+=lh(sz)});
    col.y+=(o.after||0)*K*K;
  }
  // Titre de rubrique en capitales espacées, renvoyé à la ligne dans une largeur fixe (réduit si un mot est trop long)
  function capsLines(label,w,size,cs){
    const up=clean(label).toUpperCase(), words=up.split(/\s+/).filter(Boolean);
    const width=(t,sz)=>{doc.setFontSize(sz);return doc.getTextWidth(t)+cs*Math.max(0,t.length-1)};
    doc.setFont(F,"bold");
    let sz=size; while(sz>6.4&&words.some(x=>width(x,sz)>w)) sz-=0.2;
    const lines=[]; let cur="";
    words.forEach(x=>{const t=cur?cur+" "+x:x; if(!cur||width(t,sz)<=w)cur=t; else {lines.push(cur);cur=x}}); if(cur)lines.push(cur);
    doc.setFontSize(sz); return {lines,size:sz,step:sz*K*0.3528*1.3};
  }
  function heading(col,label,o){
    o=o||{}; label=clean(label); if(!label)return;
    if(th.layout==="gutter"){
      // la rubrique précédente peut occuper plusieurs lignes dans la marge : ne jamais la chevaucher
      if(col.labelEnd&&col.labelPage===col.page) col.y=Math.max(col.y,col.labelEnd+3);
      const L=capsLines(label,col.x-18-5,8.2,.3);
      col.ensure(Math.max(16,L.lines.length*L.step+10,o.need||0)); col.y+=(o.before??4)*K*K; doc.setTextColor(...ACC);
      L.lines.forEach((ln,k)=>doc.text(ln,18,col.y+k*L.step,{charSpace:.3}));
      col.labelEnd=col.y+(L.lines.length-1)*L.step; col.labelPage=col.page; return}
    col.ensure(Math.max(18*K,(o.need||0)+10*K)); col.y+=(o.before??4)*K*K;
    const L=capsLines(label,col.w,o.size||9.6,.45); doc.setTextColor(...(o.color||ACC));
    L.lines.forEach((ln,k)=>{if(k){col.y+=L.step}doc.text(ln,col.x,col.y,{charSpace:.45})});
    if(th.layout!=="sidebar"||o.rule){doc.setDrawColor(...(o.color||ACC));doc.setLineWidth(th.layout==="single"?0.35:0.25);doc.line(col.x,col.y+1.6,col.x+col.w,col.y+1.6)}
    col.y+=(o.gap??6)*K;
  }
  // Hauteur à réserver pour garder un poste et ses puces ensemble (ou au moins son en-tête si le poste est très long)
  function expNeed(col,e){
    const pts=(e.points||[]).filter(p=>clean(p));
    const need=measure(e.poste,10.4,"bold",col.w-28)+measure([e.entreprise,e.lieu].filter(Boolean).join(" · "),9.2,"normal",col.w)+pts.reduce((a,p)=>a+measure(p,9.3,"normal",col.w-4)+0.6,0)+5;
    return need<(col.bottom-col.top2)*0.6?need:lh(10.4)+lh(9)+4;
  }
  function exp(col,e){
    const dates=clean([e.debut,e.fin].filter(Boolean).join(" – "));
    // Garde un poste et ses puces sur la même page quand c'est possible
    const pts=(e.points||[]).filter(p=>clean(p));
    col.ensure(expNeed(col,e));
    doc.setFont(F,"bold");doc.setFontSize(10.4);doc.setTextColor(...INK);
    const dw=dates?(doc.setFont(F,"normal"),doc.setFontSize(8.8),doc.getTextWidth(dates)+4):0;
    if(dates){doc.setTextColor(...MUTE);doc.text(dates,col.x+col.w,col.y,{align:"right"})}
    txt(col,e.poste,{size:10.4,style:"bold",right:dw});
    const sub=[e.entreprise,e.lieu].filter(Boolean).join(" · ");
    txt(col,sub,{size:9.2,style:F==="times"?"italic":"normal",color:th.layout==="single"?MUTE:ACC,after:1});
    pts.forEach(p=>txt(col,p,{size:9.3,indent:4,bullet:true,after:0.6}));
    col.y+=3.2*K*K;
  }
  const C=v=>clean(v);
  const contact=[d.contact&&d.contact.email,d.contact&&d.contact.telephone,d.contact&&d.contact.ville,d.contact&&d.contact.linkedin,...((d.contact&&d.contact.autres)||[])].map(C).filter(Boolean);
  let main;
  if(th.layout==="band"){
    doc.setFillColor(...INK);doc.rect(0,0,PW,40,"F");
    const tw=PW-36-(photo?38:0);
    if(photo){doc.addImage(photo.circle,"PNG",PW-18-30,5,30,30);doc.setDrawColor(...ACC);doc.setLineWidth(.7);doc.circle(PW-18-15,20,15,"S")}
    fit(C(d.nom),tw,23,15);doc.setTextColor(255,255,255);doc.text(C(d.nom),18,17);
    doc.setFont(F,"normal");doc.setFontSize(11);doc.setTextColor(...ACC);doc.text(doc.splitTextToSize(C(d.titre),tw)[0]||"",18,24.5);
    doc.setFontSize(8.6);doc.setTextColor(225,228,234);doc.text(doc.splitTextToSize(contact.join("   |   "),tw).slice(0,2),18,32);
    main=new Col(18,PW-36,52,PH-16);
  }else if(th.layout==="single"&&photo){
    const ps=30,px=PW-20-ps,py=12,tw=PW-40-ps-8;
    doc.addImage(photo.square,"JPEG",px,py,ps,ps);doc.setDrawColor(...ACC);doc.setLineWidth(.4);doc.rect(px,py,ps,ps,"S");
    doc.setFont(F,"bold");doc.setFontSize(24);doc.setTextColor(...INK);const nl=doc.splitTextToSize(C(d.nom),tw);doc.text(nl,20,22);
    let y=22+(nl.length-1)*9+7.5;
    doc.setFont(F,"italic");doc.setFontSize(12);doc.setTextColor(...ACC);doc.text(doc.splitTextToSize(C(d.titre),tw)[0]||"",20,y);y+=6.5;
    doc.setFont(F,"normal");doc.setFontSize(9);doc.setTextColor(...MUTE);const cl=doc.splitTextToSize(contact.join("  ·  "),tw);doc.text(cl,20,y);y+=cl.length*4;
    const top=Math.max(y,py+ps)+3;doc.setDrawColor(...ACC);doc.setLineWidth(.35);doc.line(20,top,PW-20,top);
    main=new Col(20,PW-40,top+6,PH-16);
  }else if(th.layout==="single"){
    fit(C(d.nom),PW-40,24,15);doc.setTextColor(...INK);doc.text(C(d.nom),PW/2,22,{align:"center"});
    doc.setFont(F,"italic");doc.setFontSize(12);doc.setTextColor(...ACC);doc.text(doc.splitTextToSize(C(d.titre),PW-40)[0]||"",PW/2,29.5,{align:"center"});
    doc.setFont(F,"normal");doc.setFontSize(9);doc.setTextColor(...MUTE);
    const cl=doc.splitTextToSize(contact.join("  ·  "),PW-40);doc.text(cl,PW/2,36,{align:"center"});
    main=new Col(20,PW-40,40+cl.length*4,PH-16);
  }else if(th.layout==="gutter"){
    const tw=PW-36-(photo?38:0);
    if(photo){doc.addImage(photo.circle,"PNG",PW-18-30,10,30,30)}
    fit(C(d.nom),tw,27,16,"normal");doc.setTextColor(...INK);doc.text(C(d.nom),18,24);
    doc.setFont(F,"bold");doc.setFontSize(10.5);doc.setTextColor(...ACC);doc.text(doc.splitTextToSize(C(d.titre).toUpperCase(),tw-8)[0]||"",18,31.5,{charSpace:.4});
    doc.setFont(F,"normal");doc.setFontSize(8.8);doc.setTextColor(...MUTE);
    const cl=doc.splitTextToSize(contact.join("   "),tw);doc.text(cl,18,38);
    const ry=Math.max(42+cl.length*3.6,photo?45:0);
    doc.setDrawColor(...mix(th.accent,"#ffffff",.6));doc.setLineWidth(.3);doc.line(18,ry,PW-18,ry);
    main=new Col(58,PW-58-18,ry+8,PH-16);
  }else{ // sidebar
    main=new Col(sideW+12,PW-sideW-12-16,22,PH-16);
    doc.setFont(F,"bold");doc.setFontSize(23);doc.setTextColor(...INK);
    const nl=doc.splitTextToSize(C(d.nom),main.w);doc.text(nl,main.x,main.y);main.y+=nl.length*9;
    doc.setFont(F,"normal");doc.setFontSize(12);doc.setTextColor(...ACC);doc.text(doc.splitTextToSize(C(d.titre),main.w),main.x,main.y);main.y+=10;
    let sideTop=24;
    if(photo){const ps=40,px=(sideW-ps)/2,py=14;doc.addImage(photo.circle,"PNG",px,py,ps,ps);doc.setDrawColor(255,255,255);doc.setLineWidth(1.4);doc.circle(px+ps/2,py+ps/2,ps/2,"S");sideTop=py+ps+10}
    const side=new Col(12,sideW-22,sideTop,PH-16); side.top2=18;
    const sh=l=>{side.y+=2;side.ensure(10);const L=capsLines(l,side.w,8.6,.4);doc.setTextColor(...ACC);L.lines.forEach(ln=>{doc.text(ln,side.x,side.y,{charSpace:.4});side.y+=L.step});side.y+=2.2};
    sh(R.contact); contact.forEach(c=>txt(side,c,{size:8.6,after:1.2}));
    if((d.competences||[]).length){side.y+=3;sh(R.competences);d.competences.forEach(c=>{txt(side,c.categorie,{size:8.8,style:"bold",after:.4});txt(side,(c.items||[]).join(", "),{size:8.5,color:[70,78,88],after:2.2})})}
    if((d.langues||[]).length){side.y+=1;sh(R.langues);d.langues.forEach(l=>txt(side,[l.langue,l.niveau].filter(Boolean).join(" – "),{size:8.6,after:1}))}
    if((d.certifications||[]).filter(Boolean).length){side.y+=3;sh(R.certifications);d.certifications.filter(Boolean).forEach(c=>txt(side,c,{size:8.5,after:1}))}
    if((d.interets||[]).filter(Boolean).length){side.y+=3;sh(R.interets);txt(side,d.interets.filter(Boolean).join(", "),{size:8.5})}
    doc.setPage(1);
  }
  const sec=(key,fn,need)=>{heading(main,R[key],{need});fn()};
  if(d.profil){sec("profil",()=>txt(main,d.profil,{size:9.6,after:1.5}))}
  if((d.experiences||[]).length){sec("experiences",()=>d.experiences.forEach(e=>exp(main,e)),expNeed(main,d.experiences[0]))}
  if((d.formation||[]).length){sec("formation",()=>d.formation.forEach(f=>{
    const yr=C(f.annee); main.ensure(lh(10)+lh(9));
    if(yr){doc.setFont(F,"normal");doc.setFontSize(8.8);doc.setTextColor(...MUTE);doc.text(yr,main.x+main.w,main.y,{align:"right"})}
    txt(main,f.diplome,{size:10,style:"bold",right:yr?22:0});txt(main,[f.ecole,f.details].filter(Boolean).join(" · "),{size:9,color:MUTE,after:2.5})}))}
  if(th.layout!=="sidebar"){
    if((d.competences||[]).length){sec("competences",()=>d.competences.forEach(c=>{
      const cat=C(c.categorie), items=C((c.items||[]).join(", "));
      if(cat){txt(main,cat+" : "+items,{size:9.3,after:1.2})} else txt(main,items,{size:9.3,after:1.2});
    }))}
    if((d.langues||[]).length){sec("langues",()=>txt(main,d.langues.map(l=>[l.langue,l.niveau].filter(Boolean).join(" (")+(l.niveau?")":"")).join("   ·   "),{size:9.3,after:1}))}
    if((d.certifications||[]).filter(Boolean).length){sec("certifications",()=>d.certifications.filter(Boolean).forEach(c=>txt(main,c,{size:9.3,indent:4,bullet:true,after:.6})))}
    if((d.interets||[]).filter(Boolean).length){sec("interets",()=>txt(main,d.interets.filter(Boolean).join(", "),{size:9.3}))}
  }
  const n=doc.getNumberOfPages();
  doc._lastFill=main.page<n?1:(main.y-main.top2)/(main.bottom-main.top2);
  if(n>1) for(let p=1;p<=n;p++){doc.setPage(p);doc.setFont(F,"normal");doc.setFontSize(8);doc.setTextColor(...MUTE);doc.text(`${C(d.nom)}  ${p}/${n}`,PW-14,PH-8,{align:"right"})}
  return doc;
}

/* ---------- Étape 3 : lettre ---------- */
function segInit(id,key){$$(`#${id} button`).forEach(b=>b.onclick=()=>{$$(`#${id} button`).forEach(x=>x.setAttribute("aria-pressed","false"));b.setAttribute("aria-pressed","true");S[key]=b.dataset.v})}
segInit("toneSeg","tone"); segInit("lenSeg","len");
const letterText=$("#letterText");
letterText.value=store.get("letter","");
function letterReady(){const ok=!!letterText.value.trim();["#dlLetterDocx","#dlLetterPdf","#copyLetter"].forEach(s=>$(s).disabled=!ok)}
letterReady();
letterText.addEventListener("input",()=>{store.set("letter",letterText.value);letterReady()});
let letterCtl=null;
$("#letterStop").onclick=()=>letterCtl&&letterCtl.abort();
$("#letterBtn").onclick=async()=>{
  const btn=$("#letterBtn"); show("#letterMsg","");
  if(!(await ensureOffer("#letterMsg")))return;
  const cvText=S.adaptedText||(S.cv&&S.cv.text)||"";
  if(!cvText&&$("#letterNotes").value.trim().length<40){
    show("#letterMsg","Pour écrire une vraie lettre, Postula a besoin de ton parcours : ajoute ton CV ou ton profil LinkedIn à l'étape 2, ou décris en quelques phrases ton expérience dans « À mettre en avant ».","err");
    $("#letterNotes").focus(); return;
  }
  const o=S.offer.info;
  letterCtl=new AbortController(); $("#letterStop").hidden=false;
  try{need();busy(btn,true,"Rédaction…"); letterText.value="";letterText.placeholder="Rédaction de ta lettre en cours (20 à 40 secondes)…";
    const r=await api("letter",{offer:o,offerText:offerText.value.slice(0,15000),cvText:cvText.slice(0,40000),notes:$("#letterNotes").value.slice(0,2000),tone:S.tone,len:S.len,lang:o.langue||"fr"},{signal:letterCtl.signal});
    letterText.value=r.text;
    store.set("letter",letterText.value); markDone(3);
  }catch(e){ if(e&&e.text)letterText.value=e.text; fail("#letterMsg",e) }
  finally{busy(btn,false);$("#letterStop").hidden=true;letterText.placeholder="La lettre apparaîtra ici pendant sa rédaction.";letterReady()}
};
$("#copyLetter").onclick=async()=>{try{await navigator.clipboard.writeText(letterText.value);toast("Lettre copiée")}catch(e){letterText.select();show("#letterMsg","Texte sélectionné : copie-le avec Ctrl/Cmd + C.","info")}};
const xmlEsc=s=>String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
$("#dlLetterDocx").onclick=async()=>{
  try{
    const zip=new JSZip(); let styles=null;
    if(S.cv&&S.cv.kind==="docx"){try{const z=await JSZip.loadAsync(S.cv.buf.slice(0));const f=z.file("word/styles.xml");if(f)styles=await f.async("string")}catch(e){}}
    const paras=letterText.value.replace(/\r/g,"").split("\n").map(l=>l.trim()?`<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:t xml:space="preserve">${xmlEsc(l)}</w:t></w:r></w:p>`:`<w:p/>`).join("");
    zip.file("[Content_Types].xml",`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${styles?'<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>':""}</Types>`);
    zip.file("_rels/.rels",`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
    if(styles){zip.file("word/styles.xml",styles);zip.file("word/_rels/document.xml.rels",`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`)}
    zip.file("word/document.xml",`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${paras}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`);
    const blob=await zip.generateAsync({type:"blob",compression:"DEFLATE"});
    await save(`Lettre de motivation - ${slug(S.offer.info&&S.offer.info.entreprise)||"candidature"}.docx`,blob,"#letterMsg");
  }catch(e){show("#letterMsg","Le fichier Word n'a pas pu être créé.","err")}
};
$("#dlLetterPdf").onclick=async()=>{
  try{
    await ensureFonts();
    const t=THEMES.find(x=>x.id===S.themeId), doc=newDoc();
    doc.setFillColor(...hex(t.accent));doc.rect(25,14,18,1.2,"F");
    doc.setFont(famOf(t.font),"normal");doc.setFontSize(10.8);doc.setTextColor(...hex(t.ink));
    let y=26; const lhh=10.8*0.3528*1.45;
    clean(letterText.value).split("\n").forEach(par=>{
      const lines=par.trim()?doc.splitTextToSize(par,160):[""];
      lines.forEach(l=>{if(y>280){doc.addPage();y=22}doc.text(l,25,y);y+=lhh});
    });
    await save(`Lettre de motivation - ${slug(S.offer.info&&S.offer.info.entreprise)||"candidature"}.pdf`,new Blob([doc.output("arraybuffer")]),"#letterMsg");
  }catch(e){show("#letterMsg","Le PDF n'a pas pu être créé.","err")}
};

/* ---------- Étape 4 : entretien ---------- */
const DURATION=300;
const IV={turns:[],asked:[],remaining:DURATION,state:"idle",last:0,timer:null,persona:null,session:null,lang:"fr",muted:false,lastSpoken:"",ctl:null,ended:false};

/* Voix */
let voices=[];
function loadVoices(){
  if(!("speechSynthesis" in window)){$("#voiceHint").textContent="La synthèse vocale n'est pas disponible dans ce navigateur : les questions s'afficheront en texte.";return}
  voices=speechSynthesis.getVoices(); fillVoices();
}
function fillVoices(){
  const l=$("#ivLang").value, sel=$("#ivVoice"); sel.innerHTML="";
  const list=voices.filter(v=>v.lang&&v.lang.toLowerCase().startsWith(l));
  const score=v=>(/natural|premium|enhanced|neural|google/i.test(v.name)?2:0)+(/CH/i.test(v.lang)?1:0);
  list.sort((a,b)=>score(b)-score(a));
  list.forEach((v,i)=>{const o=document.createElement("option");o.value=v.name;o.textContent=`${v.name} (${v.lang})`;sel.appendChild(o)});
  if(!list.length){const o=document.createElement("option");o.value="";o.textContent="Voix par défaut du navigateur";sel.appendChild(o)}
  $("#voiceHint").textContent=list.length?"":"Aucune voix dédiée à cette langue sur cet appareil : la voix par défaut sera utilisée.";
}
if("speechSynthesis" in window){loadVoices();speechSynthesis.onvoiceschanged=loadVoices}else loadVoices();
$("#ivLang").addEventListener("change",fillVoices);

function speak(text){
  return new Promise(res=>{
    IV.lastSpoken=text;
    if(IV.muted||!("speechSynthesis" in window)){setTimeout(res,Math.min(6000,600+text.length*25));return}
    try{
      if(speechSynthesis.speaking||speechSynthesis.pending) speechSynthesis.cancel();
      const u=new SpeechSynthesisUtterance(text);
      const v=voices.find(x=>x.name===$("#ivVoice").value); if(v)u.voice=v;
      u.lang=v?v.lang:({fr:"fr-CH",en:"en-GB",de:"de-CH",it:"it-CH"}[IV.lang]); u.rate=1.03;
      let done=false; const fin=()=>{if(!done){done=true;res()}};
      u.onend=fin;u.onerror=fin; setTimeout(fin,6000+text.length*85);
      speechSynthesis.speak(u);
    }catch(e){res()}
  });
}

/* Micro (reconnaissance vocale du navigateur)
   Le panneau montre en permanence ce qui se passe : micro coupé, à l'écoute, voix captée (avec le texte en direct),
   rien entendu depuis quelques secondes, ou problème d'accès au micro. */
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
let rec=null, recOn=false, recBase="", heard=false, silentTimer=null, recAuto=false, micDenied=false;
let wantMic=store.get("ivMic",true);
function voiceUI(mode,state,hint){
  const v=$("#voicePanel"); v.dataset.mode=mode;
  $("#micState").innerHTML=`<span class="dot"></span>${esc(state)}`; $("#micHint").textContent=hint||"";
  $("#micBtn").setAttribute("aria-pressed",String(recOn)); $("#micBtn").setAttribute("aria-label",recOn?"Couper le micro":"Activer le micro");
  $("#sendBtn").textContent=recOn?"J'ai fini de répondre":"Envoyer";
}
function micIdle(){
  if(!SR){voiceUI("error","Dictée vocale indisponible","Ce navigateur ne sait pas transcrire la voix (essaie Chrome, Edge ou Safari) : écris ta réponse ci-dessous.");$("#micBtn").disabled=true;return}
  if(micDenied){voiceUI("error","Micro bloqué","Autorise le micro pour ce site (icône à gauche de l'adresse), puis appuie sur le bouton micro. Tu peux aussi écrire ta réponse.");return}
  if(IV.state==="answering") voiceUI("off",IS_IOS?"Appuie sur le micro pour répondre":"Micro coupé","Appuie sur le micro pour répondre à voix haute, ou écris ta réponse.");
  else voiceUI("off","En attente",wantMic?"Le micro s'allumera tout seul quand ce sera à toi de répondre.":"Le micro est désactivé : tu répondras par écrit.");
}
function showLive(tmp){
  const fin=recBase.trim(); $("#liveText").innerHTML=esc(fin)+(tmp?` <span class="tmp">${esc(tmp)}</span>`:"");
  const el=$("#liveText"); el.scrollTop=el.scrollHeight;
}
function armSilence(){
  clearTimeout(silentTimer);
  silentTimer=setTimeout(()=>{ if(!recOn)return;
    if(heard) voiceUI("silent","Je n'entends plus rien","Continue ta réponse, ou appuie sur « J'ai fini de répondre ».");
    else voiceUI("silent","Je n'entends rien pour l'instant","Touche le micro pour relancer l'écoute, puis parle normalement. Sinon, vérifie que ce site a le droit d'utiliser le micro.");
  },heard?4000:6000);
}
function hearing(){ if(!recOn)return; heard=true; voiceUI("hearing","Je t'entends","Ce que tu dis s'affiche en direct ; corrige-le dans le cadre si besoin, puis « J'ai fini de répondre »."); armSilence(); }
function startRec(auto){
  if(!SR||recOn)return;
  recAuto=!!auto;
  try{
    const r=new SR(); rec=r; rec.lang=({fr:"fr-CH",en:"en-GB",de:"de-CH",it:"it-CH"})[IV.lang]; rec.continuous=true; rec.interimResults=true;
    recBase=$("#answerBox").value?$("#answerBox").value.trim()+" ":""; heard=!!recBase.trim();
    rec.onaudiostart=()=>{ if(rec!==r)return; if(recOn&&!heard) voiceUI("listening","Je t'écoute… parle quand tu veux","Ta réponse s'affichera ici au fur et à mesure."); armSilence(); };
    rec.onspeechstart=()=>{ if(rec===r) hearing() };
    rec.onresult=e=>{if(rec!==r)return;let fin="",tmp="";for(let i=e.resultIndex;i<e.results.length;i++){const t=e.results[i][0].transcript;if(e.results[i].isFinal)fin+=t;else tmp+=t}
      if(fin)recBase+=fin.trim()+" "; $("#answerBox").value=(recBase+tmp).trimStart(); showLive(tmp); if((fin+tmp).trim())hearing()};
    rec.onerror=e=>{
      if(rec!==r)return;   // ancienne écoute relancée entre-temps
      const er=e&&e.error;
      if(er==="no-speech"||er==="aborted")return;           // silence : la reconnaissance redémarre toute seule
      recOn=false; clearTimeout(silentTimer);
      if(er==="not-allowed"||er==="service-not-allowed"){
        if(recAuto){voiceUI("off","Appuie sur le micro pour parler","Ton navigateur demande un geste de ta part pour allumer le micro.");return}
        micDenied=true; return micIdle();
      }
      if(er==="audio-capture") return voiceUI("error","Aucun micro détecté","Branche ou active un micro, puis appuie sur le bouton. Tu peux aussi écrire ta réponse.");
      if(er==="network") return voiceUI("error","Dictée interrompue","La transcription de la voix a besoin d'une connexion internet stable. Réessaie ou écris ta réponse.");
      voiceUI("error","Le micro s'est arrêté","Appuie à nouveau sur le micro pour reprendre, ou écris ta réponse.");
    };
    rec.onend=()=>{if(rec!==r||!recOn)return;try{r.start()}catch(e){recOn=false;micIdle()}};
    rec.start(); recOn=true; micDenied=false;
    voiceUI("listening","Je t'écoute… parle quand tu veux","Ta réponse s'affichera ici au fur et à mesure."); showLive(""); armSilence();
  }catch(e){recOn=false;voiceUI("off","Appuie sur le micro pour parler","")}
}
function stopRec(){recOn=false;clearTimeout(silentTimer);try{rec&&rec.stop()}catch(e){} micIdle()}
$("#micBtn").onclick=()=>{
  unlockSpeech();
  // micro allumé mais rien de capté : un appui relance l'écoute (au lieu de couper)
  if(recOn&&!heard){recOn=false;clearTimeout(silentTimer);try{rec&&rec.abort()}catch(e){} setTimeout(()=>startRec(false),180);return}
  if(recOn){stopRec();return}
  wantMic=true;store.set("ivMic",true);micDenied=false;
  if(IV.state==="answering")startRec(false); else micIdle();
};
// Taper au clavier pendant la dictée : on coupe le micro pour ne pas écraser ce que tu écris
$("#answerBox").addEventListener("keydown",e=>{if(recOn&&e.key!=="Enter"&&!e.metaKey&&!e.ctrlKey&&e.key.length===1)stopRec()});

/* Chrono : tourne seulement quand le recruteur parle ou que le candidat répond */
function tick(){
  const now=performance.now(), dt=(now-IV.last)/1000; IV.last=now;
  const visible=!$('section[data-step="4"]').hidden&&!document.hidden;
  if(visible&&(IV.state==="speaking"||IV.state==="answering")) IV.remaining=Math.max(0,IV.remaining-dt);
  const r=Math.ceil(IV.remaining), m=Math.floor(r/60), s=String(r%60).padStart(2,"0");
  $("#clock").textContent=`${m}:${s}`; $("#clock").classList.toggle("low",r<=30);
  $("#clockBar").style.width=(IV.remaining/DURATION*100)+"%";
  if(IV.remaining<=0&&IV.state==="answering"&&!IV.timeUp){IV.timeUp=true;setState("answering","Temps écoulé : termine ta phrase puis envoie.")}
}
function setState(st,label){
  IV.state=st; $("#avatar").classList.toggle("speaking",st==="speaking");
  const map={thinking:'<span class="spinner"></span> Le recruteur prépare sa question… (chrono en pause)',speaking:"Le recruteur parle",answering:"À toi de répondre",evaluating:'<span class="spinner"></span> Analyse de ton entretien…'};
  $("#ivState").innerHTML=label?esc(label):(map[st]||"");
  const canAnswer=st==="answering"; $("#sendBtn").disabled=!canAnswer; $("#answerBox").disabled=!canAnswer;
  if(!$("#voicePanel").hidden){
    // iPhone/iPad : le micro n'écoute réellement que s'il est allumé par un appui, et pas juste après la voix du recruteur.
    // On attend donc l'appui ; ailleurs on l'allume tout seul, après une courte pause pour libérer l'audio.
    if(canAnswer&&SR&&wantMic&&!micDenied&&!IV.ended){
      if(IS_IOS) voiceUI("off","Appuie sur le micro pour répondre","Un appui à chaque réponse : c'est ce que demande l'iPhone pour écouter.");
      else setTimeout(()=>{if(IV.state==="answering"&&!IV.ended&&!recOn)startRec(true)},400);
    }
    // sur téléphone, ramène le micro et la réponse à l'écran quand c'est à toi
    if(canAnswer&&matchMedia("(max-width: 920px)").matches) $("#voicePanel").scrollIntoView({behavior:"smooth",block:"center"});
    else if(!canAnswer&&recOn) stopRec();
    else if(!recOn) micIdle();
  }
  if(canAnswer&&!recOn&&!TOUCH)$("#answerBox").focus();
}
function bubble(role,text){
  const t=$("#transcript"), d=document.createElement("div"); d.className="bub "+(role==="r"?"r":"c");
  d.innerHTML=`<span class="who">${esc(role==="r"?IV.persona[0]:"Toi")}</span>${esc(text)}`; t.appendChild(d); t.scrollTop=t.scrollHeight;
}
function offerKey(){const s=(S.offer.info&&(S.offer.info.poste+"|"+S.offer.info.entreprise))||offerText.value.slice(0,200);let h=0;for(const c of s)h=(h*31+c.charCodeAt(0))|0;return "iv:"+h}
async function interviewerTurn(){
  if(IV.ended)return;
  if(IV.remaining<=0){return endInterview()}
  setState("thinking");
  IV.ctl=new AbortController();
  try{
    const {text}=await api("interview_turn",{sessionId:IV.session,history:IV.turns},{signal:IV.ctl.signal});
    if(IV.ended)return;
    await askQuestion(text); if(IV.ended)return;
    if(IV.remaining<=0)return endInterview();
    setState("answering");
  }catch(e){
    if(IV.ended||(e&&e.code==="cancelled"))return;
    if(e&&e.code==="session_over")return endInterview();
    setState("answering",errMsg(e).replace(/<[^>]+>/g,"")+" Envoie ta réponse pour réessayer.");
    IV.retry=true;
  }
}
async function sendAnswer(){
  if(IV.state!=="answering")return;
  stopRec();
  const a=$("#answerBox").value.trim()||"(silence, pas de réponse)";
  if(!IV.retry){ bubble("c",a); IV.turns.push({role:"user",content:`Réponse du candidat : ${a}\n[Temps restant : ${Math.ceil(IV.remaining)} s]`}); }
  IV.retry=false; $("#answerBox").value=""; $("#liveText").textContent=""; heard=false;
  if(IV.remaining<=0||IV.timeUp) return endInterview();
  await interviewerTurn();
}
$("#sendBtn").onclick=sendAnswer;
$("#answerBox").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendAnswer()}});
$("#muteBtn").onclick=()=>{IV.muted=!IV.muted;$("#muteBtn").textContent=IV.muted?"Activer le son":"Couper le son";if(IV.muted&&"speechSynthesis" in window)speechSynthesis.cancel()};
$("#replayBtn").onclick=()=>{unlockSpeech();if(IV.lastSpoken&&!IV.muted&&IV.state==="answering"){try{speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(IV.lastSpoken);const v=voices.find(x=>x.name===$("#ivVoice").value);if(v)u.voice=v;speechSynthesis.speak(u)}catch(e){}}};
$("#ivEnd").onclick=()=>endInterview(true);

async function askQuestion(text){
  const q=text.trim(); IV.turns.push({role:"assistant",content:q}); IV.asked.push(q.slice(0,180));
  bubble("r",q); setState("speaking"); await speak(q);
}
const IS_IOS=/iP(hone|ad|od)/.test(navigator.userAgent)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1);
function unlockSpeech(){
  // Safari (iPhone, iPad) n'autorise la voix que si la première phrase est lancée pendant un toucher
  if(!("speechSynthesis" in window)||IV.unlocked)return;
  try{const u=new SpeechSynthesisUtterance(" ");u.volume=0;u.rate=2;speechSynthesis.speak(u);IV.unlocked=true}catch(e){}
}
$("#ivStart").onclick=async()=>{
  unlockSpeech();
  const btn=$("#ivStart"); show("#ivMsg","");
  busy(btn,true,"Préparation…");
  try{
    need();
    if(!(await ensureOffer("#ivMsg")))return;
    IV.lang=$("#ivLang").value;
    const avoid=store.get(offerKey(),{asked:[]}).asked.slice(-30);
    const r=await api("interview_start",{offer:S.offer.info,cvText:(S.adaptedText||(S.cv&&S.cv.text)||"").slice(0,40000),lang:IV.lang,style:$("#ivStyle").value,avoid});
    Object.assign(IV,{turns:[],asked:[],remaining:DURATION,ended:false,timeUp:false,retry:false,last:performance.now(),session:r.sessionId,persona:[r.persona.name,r.persona.role]});
    $("#rName").textContent=IV.persona[0]; $("#rRole").textContent=IV.persona[1]+(S.offer.info.entreprise?" · "+S.offer.info.entreprise:"");
    $("#avatar").textContent=IV.persona[0].split(" ").map(w=>w[0]).join("");
    $("#transcript").innerHTML=""; $("#ivSetup").hidden=true; $("#ivResult").hidden=true; $("#ivRoom").hidden=false;
    $("#voicePanel").hidden=false; $("#liveText").textContent=""; micIdle();
    if(IS_IOS) toast("Tu n'entends rien ? Désactive le mode silencieux de ton iPhone et monte le volume.");
    clearInterval(IV.timer); IV.timer=setInterval(tick,250); tick();
    await askQuestion(r.text); if(IV.ended)return;
    setState("answering");
  }catch(e){fail("#ivMsg",e)}finally{busy(btn,false)}
};

async function endInterview(early){
  if(IV.ended)return; IV.ended=true; stopRec();
  try{IV.ctl&&IV.ctl.abort()}catch(e){}
  clearInterval(IV.timer);
  const closing={fr:"Merci, c'est terminé pour moi. Je vous fais un retour dans un instant.",en:"Thank you, that's all from me. I'll give you feedback in a moment.",de:"Vielen Dank, das war's von meiner Seite. Gleich bekommen Sie ein Feedback.",it:"Grazie, per me è tutto. Tra un attimo le do un riscontro."}[IV.lang];
  bubble("r",closing); setState("evaluating"); speak(closing);
  const answered=IV.turns.filter(t=>t.role==="user").length;
  const used=Math.round(DURATION-IV.remaining);
  // mémorise les questions posées pour ne pas les reposer
  const key=offerKey(), mem=store.get(key,{asked:[],attempts:[]}); mem.asked=[...mem.asked,...IV.asked].slice(-60); store.set(key,mem);
  if(answered<1){
    $("#ivRoom").hidden=true;$("#ivSetup").hidden=false;
    show("#ivMsg","Entretien arrêté avant ta première réponse : pas de note cette fois. Relance quand tu veux, les questions seront différentes.","info");return;
  }
  const transcript=IV.turns.map(t=>t.role==="assistant"?`RECRUTEUR : ${t.content}`:`CANDIDAT : ${t.content.replace(/^Réponse du candidat : /,"").replace(/\n\[Temps restant.*\]$/,"")}`).join("\n");
  try{
    const o=S.offer.info;
    const ev=await api("interview_eval",{sessionId:IV.session,offer:o,transcript:transcript.slice(0,25000),cvText:(S.adaptedText||(S.cv&&S.cv.text)||"").slice(0,40000),usedSeconds:used,early:!!early});
    const att={date:Date.now(),note:Math.max(0,Math.min(10,Number(ev.note)||0)),ev,persona:IV.persona[0]};
    mem.attempts=[...(mem.attempts||[]),{date:att.date,note:att.note}].slice(-12); mem.last=att; store.set(key,mem);
    markDone(4); showResult(att,mem.attempts);
  }catch(e){
    $("#ivRoom").hidden=true;$("#ivSetup").hidden=false; fail("#ivMsg",e);
  }
}
function histBars(el,attempts,curIdx){
  el.innerHTML=attempts.map((a,i)=>`<div class="${i===curIdx?"cur":""}" title="${new Date(a.date).toLocaleString("fr-CH")}"><span>${a.note.toFixed(1)}</span><i style="height:${Math.max(3,a.note*6)}px"></i><span>#${i+1}</span></div>`).join("");
}
function evalHtml(att){
  const ev=att.ev||{}, n=att.note;
  const tone=n>=7.5?"var(--good)":n>=5.5?"var(--warn)":"var(--danger)";
  return `<div class="stack">
    <div class="score"><div class="big" style="color:${tone}">${n.toFixed(1)}<small>/10</small></div><p style="margin:0;max-width:52ch;font-size:16px">${esc(ev.verdict||"")}</p></div>
    <div class="crit">${(ev.criteres||[]).map(c=>{const v=Math.max(0,Math.min(10,Number(c.note)||0));return `<span>${esc(c.nom)}</span><span class="m"><i style="width:${v*10}%"></i></span><span class="v">${v}</span><span class="c">${esc(c.commentaire||"")}</span>`}).join("")}</div>
  </div>`;
}
function showResult(att,attempts){
  $("#ivRoom").hidden=true; const r=$("#ivResult"); r.hidden=false;
  const ev=att.ev||{};
  r.innerHTML=`<div class="grid">
    <div class="card stack">
      <div class="row" style="justify-content:space-between"><h2>Ton résultat</h2><span class="pill">Tentative #${attempts.length}</span></div>
      ${evalHtml(att)}
      <div><label>Progression sur cette offre</label><div class="hist" id="resHist"></div></div>
      <div class="row"><button class="btn primary" id="retry">Repasser l'entretien (nouvelles questions)</button><button class="btn ghost" id="backSetup">Réglages</button></div>
    </div>
    <div class="card stack">
      <div><h3>Ce qui a marché</h3><ul class="clean">${(ev.points_forts||[]).map(p=>`<li>${esc(p)}</li>`).join("")}</ul></div>
      <div class="stack"><h3>À travailler</h3>${(ev.axes||[]).map(a=>`<div class="ax"><b>${esc(a.titre)}</b><p>${esc(a.conseil)}</p>${a.exemple?`<q>${esc(a.exemple)}</q>`:""}</div>`).join("")}</div>
      ${ev.meilleure_reponse&&ev.meilleure_reponse.question?`<div class="stack"><h3>Réponse à retravailler</h3><p style="margin:0;font-weight:600">${esc(ev.meilleure_reponse.question)}</p><p style="margin:0" class="msg">${esc(ev.meilleure_reponse.reformulation)}</p></div>`:""}
      ${ev.prochaine_fois?`<div class="msg info"><b>Prochaine tentative :</b> ${esc(ev.prochaine_fois)}</div>`:""}
    </div></div>`;
  histBars($("#resHist"),attempts,attempts.length-1);
  $("#retry").onclick=()=>{r.hidden=true;$("#ivStart").click()};
  $("#backSetup").onclick=()=>{r.hidden=true;$("#ivSetup").hidden=false;refreshHistory()};
}
function refreshHistory(){
  const mem=store.get(offerKey(),{asked:[],attempts:[]}), a=mem.attempts||[];
  $("#histEmpty").hidden=!!a.length; $("#histBars").hidden=!a.length; $("#lastEval").hidden=!mem.last;
  if(a.length)histBars($("#histBars"),a,a.length-1);
  if(mem.last){$("#lastEval").innerHTML=`<label>Dernier retour</label>`+evalHtml(mem.last)}
}

go(store.get("step",1));

/* ---------- App installable (PWA) ---------- */
if("serviceWorker" in navigator&&location.protocol==="https:"){
  addEventListener("load",()=>navigator.serviceWorker.register("/sw.js").catch(()=>{}));
}
const STANDALONE=matchMedia("(display-mode: standalone)").matches||matchMedia("(display-mode: minimal-ui)").matches||navigator.standalone;
let installEvt=null;
const showInstall=on=>document.querySelectorAll("[data-install]").forEach(b=>b.hidden=!on);
addEventListener("beforeinstallprompt",e=>{e.preventDefault();installEvt=e;showInstall(true)});
addEventListener("appinstalled",()=>{installEvt=null;showInstall(false);toast("Postula est installée. Retrouve-la sur ton écran d'accueil.")});
if(IS_IOS&&!STANDALONE)showInstall(true);
document.querySelectorAll("[data-install]").forEach(b=>b.onclick=async()=>{
  if(installEvt){installEvt.prompt();const r=await installEvt.userChoice.catch(()=>null);if(r&&r.outcome==="accepted")showInstall(false);installEvt=null;return}
  if(IS_IOS)toast("Sur iPhone : touche le bouton Partager de Safari, puis « Sur l'écran d'accueil ».",7000);
  else toast("Dans le menu du navigateur, choisis « Installer l'application » ou « Ajouter à l'écran d'accueil ».",7000);
});
})();
