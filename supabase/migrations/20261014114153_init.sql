-- Postula : comptes, offres, quotas et anti-abus.
-- Toute consommation passe par public.reserve_usage(), appelée uniquement par les fonctions serveur (service_role).

create type public.plan_t as enum ('free', 'monthly', 'pass3m');
create type public.usage_kind as enum ('analyze', 'cv', 'letter', 'interview', 'turn', 'eval');

-- Profil (1 par compte) ---------------------------------------------------------
create table public.profiles (
  id               uuid primary key references auth.users (id) on delete cascade,
  plan             public.plan_t not null default 'free',
  period_start     timestamptz   not null default now(),  -- début de l'abonnement / du pass
  period_end       timestamptz,                            -- fin du pass ou de la période payée ; null = gratuit
  extra_interviews integer       not null default 0 check (extra_interviews >= 0), -- recharges achetées
  free_claimed_at  timestamptz,                            -- découverte débloquée (après contrôles anti-abus)
  blocked          boolean       not null default false,
  created_at       timestamptz   not null default now()
);

-- Une découverte par appareil (empreinte), traçabilité IP -----------------------
create table public.free_claims (
  id          bigint generated always as identity primary key,
  user_id     uuid not null unique references auth.users (id) on delete cascade,
  device_hash text not null unique,
  ip          inet,
  created_at  timestamptz not null default now()
);
create index free_claims_ip_idx on public.free_claims (ip, created_at);

-- Journal de consommation (sert aux quotas, limites de débit, coûts) ------------
create table public.usage_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       public.usage_kind not null,
  plan       public.plan_t not null,
  cost_usd   numeric(10, 5) not null default 0,
  session_id uuid,
  ip         inet,
  created_at timestamptz not null default now()
);
create index usage_events_user_idx on public.usage_events (user_id, kind, created_at);
create index usage_events_plan_idx on public.usage_events (plan, created_at);

-- Sessions d'entretien : durée et nombre d'échanges bornés côté serveur ---------
create table public.interview_sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  lang       text not null default 'fr',
  context    text not null,              -- consignes du recruteur, construites côté serveur
  started_at timestamptz not null default now(),
  turns      integer not null default 0,
  evaluated  boolean not null default false
);
create index interview_sessions_user_idx on public.interview_sessions (user_id, started_at);

-- Réglages (coupe-circuit, seuils) ----------------------------------------------
create table public.app_settings (
  key   text primary key,
  value jsonb not null
);
insert into public.app_settings (key, value) values
  ('free_daily_budget_usd', '30'),       -- dépense max / jour sur les comptes gratuits
  ('user_monthly_alert_usd', '8'),       -- alerte coût par utilisateur
  ('max_claims_per_ip_30d', '2'),
  ('interview_max_seconds', '330'),      -- porté à 420 par la migration suivante
  ('interview_max_turns', '16'),
  ('rate_generations_per_hour', '15'),
  ('rate_interviews_per_day', '6'),
  ('rate_turns_per_hour', '120');

-- RLS : lecture de ses propres données uniquement, aucune écriture côté client ---
alter table public.profiles           enable row level security;
alter table public.free_claims        enable row level security;
alter table public.usage_events       enable row level security;
alter table public.interview_sessions enable row level security;
alter table public.app_settings       enable row level security;

create policy "profil: lecture de soi" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy "usage: lecture de soi" on public.usage_events
  for select to authenticated using ((select auth.uid()) = user_id);
-- free_claims, interview_sessions (contiennent les consignes) et app_settings : aucune policy => invisibles aux clients.

-- Création automatique du profil -------------------------------------------------
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Limites par offre --------------------------------------------------------------
create function public.plan_limits(p public.plan_t) returns jsonb
language sql immutable set search_path = '' as $$
  select case p
    when 'free'    then '{"analyze": 3,   "cv": 2,   "letter": 1,   "interview": 1}'::jsonb
    when 'monthly' then '{"analyze": 100, "cv": 50,  "letter": 50,  "interview": 20}'::jsonb
    when 'pass3m'  then '{"analyze": 300, "cv": 150, "letter": 150, "interview": 60}'::jsonb
  end
$$;

-- Début de la fenêtre de quota : à vie (gratuit), cycle de 30 jours (mensuel), toute la durée (pass)
create function public.quota_window_start(pr public.profiles) returns timestamptz
language sql stable set search_path = '' as $$
  select case pr.plan
    when 'free'    then '-infinity'::timestamptz
    when 'pass3m'  then pr.period_start
    when 'monthly' then pr.period_start
                        + floor(extract(epoch from now() - pr.period_start) / (30 * 86400)) * interval '30 days'
  end
$$;

create function public.setting_num(k text) returns numeric
language sql stable security definer set search_path = '' as $$
  select (value #>> '{}')::numeric from public.app_settings where key = k
$$;

-- Réserve une consommation (ou refuse avec une raison). Appelée AVANT l'appel IA.
-- Retour : {"ok":true,"event_id":…, "session_id":…} ou {"ok":false,"reason":"…"}
create function public.reserve_usage(
  p_user uuid, p_kind public.usage_kind, p_ip inet default null,
  p_session uuid default null, p_context text default null, p_lang text default 'fr'
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  pr public.profiles;
  lim jsonb;
  win timestamptz;
  used int;
  base_limit int;
  sess public.interview_sessions;
  new_session uuid;
  ev bigint;
begin
  select * into pr from public.profiles where id = p_user for update;  -- sérialise les demandes d'un même compte
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_profile'); end if;
  if pr.blocked then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;
  if pr.plan <> 'free' and pr.period_end is not null and pr.period_end < now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if pr.plan = 'free' and pr.free_claimed_at is null then
    return jsonb_build_object('ok', false, 'reason', 'claim_required');
  end if;

  -- Coupe-circuit : budget quotidien des comptes gratuits
  if pr.plan = 'free' and (
       select coalesce(sum(cost_usd), 0) from public.usage_events
       where plan = 'free' and created_at >= date_trunc('day', now())
     ) >= public.setting_num('free_daily_budget_usd') then
    return jsonb_build_object('ok', false, 'reason', 'free_budget_exhausted');
  end if;

  -- Limites de débit (anti-script)
  if p_kind in ('analyze', 'cv', 'letter', 'interview', 'eval') and (
       select count(*) from public.usage_events
       where user_id = p_user and kind in ('analyze', 'cv', 'letter', 'interview', 'eval')
         and created_at > now() - interval '1 hour'
     ) >= public.setting_num('rate_generations_per_hour') then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;
  if p_kind = 'interview' and (
       select count(*) from public.usage_events
       where user_id = p_user and kind = 'interview' and created_at > now() - interval '1 day'
     ) >= public.setting_num('rate_interviews_per_day') then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited_day');
  end if;
  if p_kind = 'turn' and (
       select count(*) from public.usage_events
       where user_id = p_user and kind = 'turn' and created_at > now() - interval '1 hour'
     ) >= public.setting_num('rate_turns_per_hour') then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;

  -- Quotas de l'offre
  if p_kind in ('analyze', 'cv', 'letter', 'interview') then
    lim := public.plan_limits(pr.plan);
    win := public.quota_window_start(pr);
    base_limit := (lim ->> p_kind::text)::int;
    select count(*) into used from public.usage_events
      where user_id = p_user and kind = p_kind and created_at >= win;
    if used >= base_limit then
      if p_kind = 'interview' and pr.plan <> 'free' and pr.extra_interviews > 0 then
        update public.profiles set extra_interviews = extra_interviews - 1 where id = p_user;
      else
        return jsonb_build_object('ok', false, 'reason', 'quota_exceeded', 'kind', p_kind, 'limit', base_limit);
      end if;
    end if;
  end if;

  -- Entretien : création de session, ou contrôle de la session existante
  if p_kind = 'interview' then
    if p_context is null then return jsonb_build_object('ok', false, 'reason', 'bad_request'); end if;
    insert into public.interview_sessions (user_id, context, lang)
      values (p_user, p_context, coalesce(p_lang, 'fr')) returning id into new_session;
  elsif p_kind in ('turn', 'eval') then
    select * into sess from public.interview_sessions where id = p_session and user_id = p_user for update;
    if not found then return jsonb_build_object('ok', false, 'reason', 'session_not_found'); end if;
    if p_kind = 'turn' then
      if now() - sess.started_at > make_interval(secs => public.setting_num('interview_max_seconds')::int)
         or sess.turns >= public.setting_num('interview_max_turns') then
        return jsonb_build_object('ok', false, 'reason', 'session_over');
      end if;
      update public.interview_sessions set turns = turns + 1 where id = sess.id;
    else
      if sess.evaluated or now() - sess.started_at > interval '30 minutes' then
        return jsonb_build_object('ok', false, 'reason', 'session_over');
      end if;
      update public.interview_sessions set evaluated = true where id = sess.id;
    end if;
    new_session := sess.id;
  end if;

  insert into public.usage_events (user_id, kind, plan, session_id, ip)
    values (p_user, p_kind, pr.plan, new_session, p_ip) returning id into ev;

  return jsonb_build_object('ok', true, 'event_id', ev, 'session_id', new_session,
                            'context', case when p_kind = 'turn' then sess.context end,
                            'lang', case when p_kind in ('turn', 'eval') then sess.lang end);
end $$;

-- Coût réel après l'appel IA
create function public.record_cost(p_event bigint, p_cost numeric) returns void
language sql security definer set search_path = '' as $$
  update public.usage_events set cost_usd = p_cost where id = p_event
$$;

-- Annule une réservation si l'appel IA a échoué (l'utilisateur n'est pas débité)
create function public.release_usage(p_event bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.usage_events;
begin
  delete from public.usage_events where id = p_event returning * into e;
  if e.kind = 'interview' and e.session_id is not null then
    delete from public.interview_sessions where id = e.session_id;
  elsif e.kind = 'turn' and e.session_id is not null then
    update public.interview_sessions set turns = greatest(turns - 1, 0) where id = e.session_id;
  elsif e.kind = 'eval' and e.session_id is not null then
    update public.interview_sessions set evaluated = false where id = e.session_id;
  end if;
end $$;

-- Quotas restants, pour le compteur affiché dans l'app (lecture seule, soi-même)
create function public.my_quota() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare pr public.profiles; win timestamptz; lim jsonb; res jsonb := '{}'::jsonb; k text;
begin
  select * into pr from public.profiles where id = (select auth.uid());
  if not found then return null; end if;
  lim := public.plan_limits(pr.plan);
  win := public.quota_window_start(pr);
  foreach k in array array['analyze', 'cv', 'letter', 'interview'] loop
    res := res || jsonb_build_object(k, jsonb_build_object(
      'limit', (lim ->> k)::int,
      'used', (select count(*) from public.usage_events
               where user_id = pr.id and kind = k::public.usage_kind and created_at >= win)));
  end loop;
  return jsonb_build_object(
    'plan', pr.plan, 'period_end', pr.period_end,
    'renews_at', case when pr.plan = 'monthly' then win + interval '30 days' end,
    'free_claimed', pr.free_claimed_at is not null,
    'extra_interviews', pr.extra_interviews,
    'blocked', pr.blocked,
    'quota', res);
end $$;

-- Coût par utilisateur sur 30 jours (pour l'alerte d'abus, lecture admin)
create view public.user_cost_30d with (security_invoker = true) as
  select user_id, sum(cost_usd) as cost_usd, count(*) as events
  from public.usage_events
  where created_at > now() - interval '30 days'
  group by user_id;

-- Droits : seules les fonctions serveur peuvent réserver/consommer
revoke all on function public.reserve_usage(uuid, public.usage_kind, inet, uuid, text, text) from public, anon, authenticated;
revoke all on function public.record_cost(bigint, numeric) from public, anon, authenticated;
revoke all on function public.release_usage(bigint) from public, anon, authenticated;
revoke all on function public.setting_num(text) from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.reserve_usage(uuid, public.usage_kind, inet, uuid, text, text) to service_role;
grant execute on function public.record_cost(bigint, numeric) to service_role;
grant execute on function public.release_usage(bigint) to service_role;
grant execute on function public.setting_num(text) to service_role;
revoke all on function public.my_quota() from public, anon;
grant execute on function public.my_quota() to authenticated;
revoke all on public.user_cost_30d from anon, authenticated;
