-- Durées de conservation (voir web/confidentialite.html), appliquées chaque nuit à 3h15 :
-- - extraits de CV et d'offre utilisés par le recruteur virtuel : effacés 24 h après l'entretien ;
-- - adresses IP (journal de consommation, activations Découverte) : effacées après 90 jours.
-- Le reste (compte, journal de consommation sans IP) est supprimé avec le compte.
create extension if not exists pg_cron;

create or replace function public.purge_old_data() returns void
language sql security definer set search_path = '' as $$
  update public.interview_sessions set context = '' where context <> '' and started_at < now() - interval '24 hours';
  update public.usage_events set ip = null where ip is not null and created_at < now() - interval '90 days';
  update public.free_claims set ip = null where ip is not null and created_at < now() - interval '90 days';
$$;
revoke all on function public.purge_old_data() from public, anon, authenticated;

select cron.schedule('postula-purge-old-data', '15 3 * * *', 'select public.purge_old_data()');
