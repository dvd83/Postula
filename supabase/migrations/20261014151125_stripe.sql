-- Paiement Stripe : identifiants client/abonnement, journal des événements (idempotence),
-- et application atomique d'un achat sur le profil.

alter table public.profiles
  add column stripe_customer_id     text unique,
  add column stripe_subscription_id text unique;

create table public.stripe_events (
  id          text primary key,          -- identifiant d'événement Stripe (evt_…)
  type        text not null,
  user_id     uuid references auth.users (id) on delete set null,
  product     text,
  received_at timestamptz not null default now()
);
alter table public.stripe_events enable row level security;  -- aucune policy : invisible aux clients

-- p_action : 'monthly' | 'pass3m' | 'topup' | 'renewal' | 'cancel'
create function public.apply_purchase(
  p_event_id text, p_event_type text, p_action text,
  p_user uuid default null, p_customer text default null,
  p_subscription text default null, p_period_end timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  target uuid := p_user;
  n int;
begin
  -- Un événement Stripe n'est appliqué qu'une seule fois, même si Stripe le renvoie
  insert into public.stripe_events (id, type, user_id, product)
    values (p_event_id, p_event_type, p_user, p_action)
    on conflict (id) do nothing;
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('ok', true, 'duplicate', true); end if;

  if target is null and p_subscription is not null then
    select id into target from public.profiles where stripe_subscription_id = p_subscription;
  end if;
  if target is null and p_customer is not null then
    select id into target from public.profiles where stripe_customer_id = p_customer;
  end if;
  if target is null then return jsonb_build_object('ok', false, 'reason', 'user_not_found'); end if;
  update public.stripe_events set user_id = target where id = p_event_id;

  if p_action = 'monthly' then
    update public.profiles set
      plan = 'monthly', period_start = now(),
      period_end = coalesce(p_period_end, now() + interval '31 days') + interval '2 days',
      stripe_customer_id = coalesce(p_customer, stripe_customer_id),
      stripe_subscription_id = coalesce(p_subscription, stripe_subscription_id)
    where id = target;

  elsif p_action = 'pass3m' then
    update public.profiles set
      plan = 'pass3m', period_start = now(), period_end = now() + interval '90 days',
      stripe_customer_id = coalesce(p_customer, stripe_customer_id)
    where id = target;

  elsif p_action = 'topup' then
    update public.profiles set
      extra_interviews = extra_interviews + 10,
      stripe_customer_id = coalesce(p_customer, stripe_customer_id)
    where id = target;

  elsif p_action = 'renewal' then
    -- Renouvellement mensuel payé : nouveau cycle de quotas
    update public.profiles set
      plan = 'monthly', period_start = now(),
      period_end = coalesce(p_period_end, now() + interval '31 days') + interval '2 days'
    where id = target;

  elsif p_action = 'cancel' then
    -- Abonnement terminé (fin de période après résiliation, ou impayé définitif)
    update public.profiles set
      period_end = least(coalesce(period_end, now()), now()),
      stripe_subscription_id = null
    where id = target and plan = 'monthly';

  else
    return jsonb_build_object('ok', false, 'reason', 'unknown_action');
  end if;

  return jsonb_build_object('ok', true, 'user_id', target);
end $$;

revoke all on function public.apply_purchase(text, text, text, uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.apply_purchase(text, text, text, uuid, text, text, timestamptz) to service_role;

-- Le compteur de l'app indique aussi si un abonnement est géré par Stripe
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
    'active', pr.plan <> 'free' and (pr.period_end is null or pr.period_end > now()),
    'renews_at', case when pr.plan = 'monthly' then win + interval '30 days' end,
    'free_claimed', pr.free_claimed_at is not null,
    'extra_interviews', pr.extra_interviews,
    'subscription', pr.stripe_subscription_id is not null,
    'customer', pr.stripe_customer_id is not null,
    'blocked', pr.blocked,
    'quota', res);
end $$;
revoke all on function public.my_quota() from public, anon;
grant execute on function public.my_quota() to authenticated;
