-- Suivi des candidatures : un dossier par offre (texte de l'annonce, lettre, notes, statut, scores d'entretien).
-- Les fichiers CV restent sur l'appareil ; seul le nom du CV utilisé est gardé ici.
create table public.applications (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title         text not null default '' check (char_length(title) <= 300),
  company       text not null default '' check (char_length(company) <= 300),
  location      text not null default '' check (char_length(location) <= 300),
  url           text not null default '' check (char_length(url) <= 1000),
  source        text not null default '' check (char_length(source) <= 60),
  status        text not null default 'todo' check (status in ('todo','applied','interview','offer','rejected','archived')),
  offer_text    text not null default '' check (char_length(offer_text) <= 15000),
  offer_info    jsonb,
  letter        text not null default '' check (char_length(letter) <= 20000),
  cv_name       text not null default '' check (char_length(cv_name) <= 300),
  ats_score     smallint check (ats_score between 0 and 100),
  scores        jsonb not null default '[]'::jsonb,   -- notes des entretiens d'entraînement [{at, note}]
  notes         text not null default '' check (char_length(notes) <= 5000),
  applied_at    timestamptz,
  follow_up_at  date,                                 -- date de relance prévue
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index applications_user_idx on public.applications (user_id, updated_at desc);
alter table public.applications enable row level security;

create policy "candidatures: lecture de soi" on public.applications for select to authenticated using ((select auth.uid()) = user_id);
create policy "candidatures: création pour soi" on public.applications for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "candidatures: modification de soi" on public.applications for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "candidatures: suppression de soi" on public.applications for delete to authenticated using ((select auth.uid()) = user_id);

-- Date de mise à jour, date d'envoi automatique, et plafond de 500 dossiers par compte (anti-abus)
create function public.applications_touch() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  if new.status = 'applied' and new.applied_at is null then new.applied_at := now(); end if;
  if tg_op = 'INSERT' and (select count(*) from public.applications where user_id = new.user_id) >= 500 then
    raise exception 'applications_limit' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger applications_touch before insert or update on public.applications
  for each row execute function public.applications_touch();
revoke all on function public.applications_touch() from public, anon, authenticated;

grant select, insert, update, delete on public.applications to authenticated;
