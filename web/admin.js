// Espace administrateur Postula. Les droits sont vérifiés côté serveur (fonction « admin ») à chaque appel.
(()=>{
const CFG=window.POSTULA_CONFIG||window.CONFIG||{};
const $=s=>document.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const sb=window.supabase.createClient(CFG.SUPABASE_URL,CFG.SUPABASE_KEY);
let toastT=null; const toast=t=>{const e=$("#toast");e.textContent=t;e.classList.add("show");clearTimeout(toastT);toastT=setTimeout(()=>e.classList.remove("show"),2600)};
const ERR={forbidden:"Accès réservé aux administrateurs.",unauthorized:"Ta session a expiré : reconnecte-toi sur Postula.",stripe_managed:"Cet abonnement est payé via Stripe : résilie-le depuis le tableau de bord Stripe.",not_on_self:"Action impossible sur ton propre compte.",user_not_found:"Compte introuvable.",bad_request:"Demande invalide."};

async function call(action,payload={}){
  const {data:{session:s}}=await sb.auth.getSession();
  if(!s) throw {code:"unauthorized"};
  const r=await fetch(`${CFG.SUPABASE_URL}/functions/v1/admin`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${s.access_token}`,apikey:CFG.SUPABASE_KEY},body:JSON.stringify({action,...payload})});
  const b=await r.json().catch(()=>({}));
  if(!r.ok||!b.ok) throw {code:b.error||"server_error"};
  return b.result;
}
const fmtDate=d=>d?new Date(d).toLocaleDateString("fr-CH",{day:"numeric",month:"short",year:"numeric"}):"—";
const ago=d=>{if(!d)return"jamais";const m=(Date.now()-new Date(d))/60000;if(m<60)return`il y a ${Math.max(1,Math.round(m))} min`;const h=m/60;if(h<24)return`il y a ${Math.round(h)} h`;return`il y a ${Math.round(h/24)} j`};
const usd=n=>`$${Number(n||0).toFixed(2)}`;
const PLAN={free:"Découverte",monthly:"Mensuel",pass3m:"Pass 3 mois"};

function badges(u){
  const active=u.plan!=="free"&&(!u.period_end||new Date(u.period_end)>new Date());
  const b=[];
  if(u.is_admin) b.push('<span class="pill ok">Admin</span>');
  b.push(`<span class="pill${u.plan!=="free"&&!active?" miss":""}">${esc(PLAN[u.plan]||u.plan)}${u.plan!=="free"?(active?` · jusqu'au ${fmtDate(u.period_end)}`:" · expiré"):""}</span>`);
  if(u.gift) b.push('<span class="pill mark">Offert</span>');
  if(u.stripe_sub) b.push('<span class="pill">Stripe</span>');
  if(u.extra_interviews) b.push(`<span class="pill">+${u.extra_interviews} entretiens</span>`);
  if(u.plan==="free"&&!u.free_claimed_at) b.push('<span class="pill">Découverte non activée</span>');
  if(u.blocked) b.push('<span class="pill bad">Bloqué</span>');
  return b.join(" ");
}

async function loadStats(){
  const s=await call("stats"), u=s.uses_30d||{};
  const tile=(label,val,sub)=>`<div class="card adm-tile"><span>${esc(label)}</span><b>${esc(val)}</b>${sub?`<small>${esc(sub)}</small>`:""}</div>`;
  $("#stats").innerHTML=[
    tile("Comptes",s.users,`+${s.new_7d} sur 7 jours`),
    tile("Abonnés payants",(s.active_monthly||0)+(s.active_pass3m||0),`${s.active_monthly} mensuel · ${s.active_pass3m} pass`),
    tile("Abonnements offerts",s.active_gift||0,`${s.blocked} compte(s) bloqué(s)`),
    tile("Coût IA 30 jours",usd(s.cost_30d),`aujourd'hui ${usd(s.cost_today)}`),
    tile("Budget gratuit du jour",`${usd(s.cost_free_today)} / ${usd(s.free_daily_budget)}`,"coupe-circuit des comptes Découverte"),
    tile("Utilisation 30 jours",`${u.cv||0} CV`,`${u.letter||0} lettres · ${u.interview||0} entretiens · ${u.analyze||0} analyses`)
  ].join("");
  const L={grant:"Offre",revoke:"Retrait d'offre",extra_interviews:"Entretiens",grant_free:"Découverte débloquée",block:"Blocage",unblock:"Déblocage",make_admin:"Nouvel admin",remove_admin:"Admin retiré",note:"Note"};
  $("#log").innerHTML=(s.log||[]).length?(s.log||[]).map(l=>{
    const d=l.details||{}; const det=l.action==="grant"?`${PLAN[d.plan]||d.plan}, ${d.days} j`:l.action==="extra_interviews"?`${d.n>0?"+":""}${d.n}`:"";
    return `<div><span class="hint" style="margin:0">${esc(fmtDate(l.created_at))}</span> <b>${esc(L[l.action]||l.action)}</b>${det?` (${esc(det)})`:""} · ${esc(l.target||"—")}</div>`}).join(""):'<p class="lede" style="margin:0">Aucune action pour l\'instant.</p>';
}

let page=0, users=[], qTimer=null;
async function loadUsers(reset){
  if(reset){page=0;users=[]}
  const r=await call("users",{q:$("#q").value.trim(),page});
  users=users.concat(r.users||[]);
  $("#total").textContent=`${r.total} compte${r.total>1?"s":""}`;
  $("#more").hidden=users.length>=r.total;
  $("#users").innerHTML=users.length?users.map((u,i)=>`
    <div class="adm-user">
      <div class="who"><b>${esc(u.name||u.email)}</b><small>${esc(u.email)} · inscrit le ${fmtDate(u.created_at)}</small><div class="badges">${badges(u)}</div>${u.note?`<small class="note">📝 ${esc(u.note)}</small>`:""}</div>
      <div class="use"><span>${u.uses_30d} utilisations / 30 j</span><small>${usd(u.cost_30d)} · ${esc(ago(u.last_use))}</small></div>
      <button class="btn sm" type="button" data-open="${i}">Gérer</button>
    </div>`).join(""):'<p class="lede">Aucun compte trouvé.</p>';
}

let cur=null;
function openUser(u){
  cur=u;
  $("#dlgTitle").textContent=u.name||u.email;
  $("#dlgInfo").innerHTML=`<div>${esc(u.email)}</div><div class="badges">${badges(u)}</div><div class="hint" style="margin:0">Dernière connexion ${esc(ago(u.last_sign_in_at))} · ${u.uses_30d} utilisations sur 30 jours (${usd(u.cost_30d)})</div>`;
  $("#bFree").hidden=!!u.free_claimed_at||u.plan!=="free";
  $("#bRevoke").hidden=!(u.plan!=="free"&&(u.gift||!u.stripe_sub));
  $("#bBlock").textContent=u.blocked?"Débloquer":"Bloquer";
  $("#bAdmin").textContent=u.is_admin?"Retirer les droits admin":"Rendre admin";
  $("#note").value=u.note||""; $("#dlgMsg").innerHTML="";
  $("#dlg").showModal();
}
document.addEventListener("click",e=>{const o=e.target.closest("[data-open]");if(o)openUser(users[+o.dataset.open])});
$("#dlg").addEventListener("click",async e=>{
  const b=e.target.closest("[data-act]"); if(!b||!cur)return;
  const act=b.dataset.act, id=cur.id; let payload={userId:id}, done="";
  if(act==="grant"){payload.plan=$("#gPlan").value;payload.days=+$("#gDays").value;done=`${PLAN[payload.plan]} offert pour ${$("#gDays").selectedOptions[0].textContent}`}
  else if(act==="extra"){payload.n=+b.dataset.n;done=`Entretiens ${payload.n>0?"+":""}${payload.n}`}
  else if(act==="revoke"){if(!confirm(`Retirer l'offre de ${cur.email} ? Il repasse en Découverte.`))return;done="Offre retirée"}
  else if(act==="free"){done="Découverte débloquée"}
  else if(act==="block"){payload.blocked=!cur.blocked;if(payload.blocked&&!confirm(`Bloquer ${cur.email} ? Il ne pourra plus rien générer.`))return;done=payload.blocked?"Compte bloqué":"Compte débloqué"}
  else if(act==="admin"){payload.on=!cur.is_admin;if(!confirm(payload.on?`Donner les droits admin à ${cur.email} ? Il pourra gérer tous les comptes.`:`Retirer les droits admin de ${cur.email} ?`))return;done=payload.on?"Droits admin donnés":"Droits admin retirés"}
  else if(act==="note"){payload.note=$("#note").value.trim();done="Note enregistrée"}
  b.disabled=true;
  try{
    await call(act,payload); toast(done);
    await loadUsers(true); await loadStats();
    const fresh=users.find(x=>x.id===id); if(fresh) openUser(fresh); else $("#dlg").close();
  }catch(err){$("#dlgMsg").innerHTML=`<div class="msg err">${esc(ERR[err.code]||"L'action a échoué ("+err.code+").")}</div>`}
  finally{b.disabled=false}
});
$("#q").addEventListener("input",()=>{clearTimeout(qTimer);qTimer=setTimeout(()=>loadUsers(true).catch(fail),300)});
$("#more").onclick=()=>{page++;loadUsers(false).catch(fail)};
$("#reload").onclick=()=>Promise.all([loadStats(),loadUsers(true)]).then(()=>toast("À jour")).catch(fail);
function fail(e){$("#gate").hidden=false;$("#panel").hidden=true;$("#gate").innerHTML=`<p class="lede">${esc(ERR[e&&e.code]||"Impossible de charger l'administration.")}</p><div class="row"><a class="btn primary" href="./#app">Aller sur Postula</a></div>`}

(async()=>{
  const {data:{session:s}}=await sb.auth.getSession();
  if(!s) return fail({code:"unauthorized"});
  try{ await Promise.all([loadStats(),loadUsers(true)]); $("#gate").hidden=true; $("#panel").hidden=false; }
  catch(e){ fail(e) }
})();
})();
