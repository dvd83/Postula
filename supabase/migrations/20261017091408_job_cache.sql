-- Cache des recherches d'offres (API Adzuna limitée en nombre d'appels) : une même recherche n'est refaite qu'après 6 h.
create table public.job_cache (
  key        text primary key,
  data       jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.job_cache enable row level security;  -- aucune policy : réservé aux fonctions serveur
create index job_cache_created_idx on public.job_cache (created_at);
