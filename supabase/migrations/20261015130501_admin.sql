-- Espace administrateur : comptes admin (sans limites), abonnements offerts, journal des actions admin.

alter table public.profiles
  add column is_admin boolean not null default false,
  add column gift     boolean not null default false,   -- offre attribuée à la main (pas de paiement Stripe)
  add column note     text;                              -- note interne de l'admin

create table public.admin_log (
  id         bigint generated always as identity primary key,
  admin_id   uuid references auth.users (id) on delete set null,
  target_id  uuid references auth.users (id) on delete set null,
  action     text not null,
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.admin_log enable row level security;  -- aucune policy : invisible aux clients

-- Compte administrateur du propriétaire
update public.profiles p set is_admin = true
  from auth.users u where u.id = p.id and lower(u.email) = 'davide.pagliuca@gmail.com';

-- Réservation : un compte admin n'a ni quotas, ni limites de débit, ni expiration
create or replace function public.reserve_usage(
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
  select * into pr from public.profiles where id = p_user for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_profile'); end if;
  if pr.blocked then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;

  if not pr.is_admin then
    if pr.plan <> 'free' and pr.period_end is not null and pr.period_end < now() then
      return jsonb_build_object('ok', false, 'reason', 'expired');
    end if;
    if pr.plan = 'free' and pr.free_claimed_at is null then
      return jsonb_build_object('ok', false, 'reason', 'claim_required');
    end if;
    if pr.plan = 'free' and (
         select coalesce(sum(cost_usd), 0) from public.usage_events
         where plan = 'free' and created_at >= date_trunc('day', now())
       ) >= public.setting_num('free_daily_budget_usd') then
      return jsonb_build_object('ok', false, 'reason', 'free_budget_exhausted');
    end if;
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
  end if;

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

-- Compteur de l'app : indique aussi les comptes admin et les offres offertes
create or replace function public.my_quota() returns jsonb
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
    'active', pr.is_admin or (pr.plan <> 'free' and (pr.period_end is null or pr.period_end > now())),
    'renews_at', case when pr.plan = 'monthly' and not pr.gift then win + interval '30 days' end,
    'free_claimed', pr.free_claimed_at is not null or pr.is_admin,
    'extra_interviews', pr.extra_interviews,
    'subscription', pr.stripe_subscription_id is not null,
    'customer', pr.stripe_customer_id is not null,
    'blocked', pr.blocked,
    'admin', pr.is_admin,
    'gift', pr.gift,
    'quota', res);
end $$;
revoke all on function public.my_quota() from public, anon;
grant execute on function public.my_quota() to authenticated;

-- Liste des comptes pour l'espace admin (appelée uniquement par la fonction serveur « admin »)
create function public.admin_users(p_q text default null, p_limit int default 50, p_offset int default 0)
returns jsonb language sql stable security definer set search_path = '' as $$
  with base as (
    select u.id, u.email, u.created_at, u.last_sign_in_at,
           coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name') as name,
           p.plan, p.period_start, p.period_end, p.extra_interviews, p.free_claimed_at, p.blocked,
           p.is_admin, p.gift, p.note, p.stripe_subscription_id is not null as stripe_sub,
           (select count(*) from public.usage_events e where e.user_id = u.id and e.created_at > now() - interval '30 days' and e.kind in ('analyze','cv','letter','interview')) as uses_30d,
           (select coalesce(sum(cost_usd),0) from public.usage_events e where e.user_id = u.id and e.created_at > now() - interval '30 days') as cost_30d,
           (select max(created_at) from public.usage_events e where e.user_id = u.id) as last_use
    from auth.users u join public.profiles p on p.id = u.id
    where p_q is null or p_q = '' or u.email ilike '%' || p_q || '%'
       or coalesce(u.raw_user_meta_data ->> 'full_name', '') ilike '%' || p_q || '%'
  )
  select jsonb_build_object(
    'total', (select count(*) from base),
    'users', coalesce((select jsonb_agg(to_jsonb(b) order by b.created_at desc)
                       from (select * from base order by created_at desc limit least(greatest(p_limit,1),200) offset greatest(p_offset,0)) b), '[]'::jsonb))
$$;

create function public.admin_stats() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'users', (select count(*) from public.profiles),
    'new_7d', (select count(*) from public.profiles where created_at > now() - interval '7 days'),
    'free_claimed', (select count(*) from public.profiles where free_claimed_at is not null),
    'active_monthly', (select count(*) from public.profiles where plan = 'monthly' and not gift and (period_end is null or period_end > now())),
    'active_pass3m', (select count(*) from public.profiles where plan = 'pass3m' and not gift and (period_end is null or period_end > now())),
    'active_gift', (select count(*) from public.profiles where gift and plan <> 'free' and (period_end is null or period_end > now())),
    'blocked', (select count(*) from public.profiles where blocked),
    'uses_30d', (select jsonb_object_agg(kind, n) from (select kind, count(*) n from public.usage_events where created_at > now() - interval '30 days' group by kind) x),
    'cost_30d', (select coalesce(sum(cost_usd),0) from public.usage_events where created_at > now() - interval '30 days'),
    'cost_today', (select coalesce(sum(cost_usd),0) from public.usage_events where created_at >= date_trunc('day', now())),
    'cost_free_today', (select coalesce(sum(cost_usd),0) from public.usage_events where plan = 'free' and created_at >= date_trunc('day', now())),
    'free_daily_budget', public.setting_num('free_daily_budget_usd'),
    'log', coalesce((select jsonb_agg(to_jsonb(l) order by l.created_at desc) from (
        select a.created_at, a.action, a.details, ut.email as target from public.admin_log a
        left join auth.users ut on ut.id = a.target_id order by a.created_at desc limit 20) l), '[]'::jsonb)
  )
$$;

revoke all on function public.admin_users(text, int, int) from public, anon, authenticated;
revoke all on function public.admin_stats() from public, anon, authenticated;
grant execute on function public.admin_users(text, int, int) to service_role;
grant execute on function public.admin_stats() to service_role;
