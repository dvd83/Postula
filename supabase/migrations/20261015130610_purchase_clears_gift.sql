-- Un achat Stripe remplace une offre attribuée à la main (gift).
create or replace function public.apply_purchase(
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
      plan = 'monthly', period_start = now(), gift = false,
      period_end = coalesce(p_period_end, now() + interval '31 days') + interval '2 days',
      stripe_customer_id = coalesce(p_customer, stripe_customer_id),
      stripe_subscription_id = coalesce(p_subscription, stripe_subscription_id)
    where id = target;

  elsif p_action = 'pass3m' then
    update public.profiles set
      plan = 'pass3m', period_start = now(), period_end = now() + interval '90 days', gift = false,
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
      plan = 'monthly', period_start = now(), gift = false,
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

