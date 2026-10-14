# Postula

Adapte ton CV et ta lettre de motivation à chaque offre d'emploi, puis entraîne-toi avec un entretien vocal de 5 minutes, noté sur 10 avec un retour précis.

## Architecture

| Partie | Où | Rôle |
|---|---|---|
| `web/` | Cloudflare Pages (statique, sans build) | Interface, lecture des CV (Word/PDF) dans le navigateur, thèmes PDF, voix (synthèse et dictée du navigateur) |
| `supabase/migrations/` | Supabase (Zurich, `eu-central-2`) | Comptes, offres, quotas, journal de consommation, anti-abus |
| `supabase/functions/ai` | Supabase Edge Functions | Toutes les générations IA. Les consignes sont construites côté serveur ; chaque action est décomptée **avant** l'appel et remboursée si l'IA échoue |
| `supabase/functions/claim-free` | Supabase Edge Functions | Activation de l'offre Découverte (Google/Apple, captcha, appareil, IP) |
| `.github/workflows/ci-cd.yml` | GitHub Actions | Vérifications à chaque PR ; déploiement base + fonctions + site à chaque push sur `main` |

Les CV ne sont jamais stockés : ils restent dans le navigateur et ne transitent par le serveur que le temps d'une génération.

## Offres et quotas

Définis dans `public.plan_limits()` (base de données).

| Offre | Prix | Analyses | CV | Lettres | Entretiens |
|---|---|---|---|---|---|
| Découverte | gratuit, une fois | 3 | 2 (adaptation + thème) | 1 | 1 |
| Mensuel | 14.90 CHF / mois | 100 | 50 | 50 | 20 / 30 jours |
| Pass 3 mois | 34.90 CHF | 300 | 150 | 150 | 60 |
| Recharge | 5.90 CHF | | | | +10 |

## Anti-abus

- **Découverte** : connexion Google ou Apple obligatoire, captcha Cloudflare Turnstile, une seule fois par appareil (empreinte salée et hachée), 2 activations maximum par adresse IP sur 30 jours.
- **Coupe-circuit** : au-delà de `free_daily_budget_usd` (30 $ par défaut) dépensés dans la journée sur les comptes gratuits, le gratuit est mis en pause jusqu'au lendemain.
- **Limites de débit** : 15 générations / heure, 6 entretiens / jour, 120 échanges d'entretien / heure.
- **Entretien verrouillé** : session créée côté serveur, 7 min réelles maximum (le chrono affiché de 5 min se met en pause pendant que le recruteur prépare sa question), 16 échanges maximum, une seule évaluation. Le recruteur refuse de sortir de son rôle.
- **Tailles bornées** : annonce 15 000 caractères, CV 40 000 caractères, requête 400 Ko.
- **Suivi des coûts** : coût réel de chaque appel dans `usage_events.cost_usd`, vue `user_cost_30d` pour repérer les abus.

Tous les seuils sont dans la table `app_settings` et se changent sans redéployer :

```sql
update public.app_settings set value = '50' where key = 'free_daily_budget_usd';
```

## Gérer un compte (en attendant le paiement en ligne)

```sql
-- Passer un compte en Pass 3 mois
update public.profiles p set plan = 'pass3m', period_start = now(), period_end = now() + interval '90 days'
from auth.users u where u.id = p.id and u.email = 'client@exemple.ch';

-- Ajouter une recharge de 10 entretiens
update public.profiles p set extra_interviews = extra_interviews + 10
from auth.users u where u.id = p.id and u.email = 'client@exemple.ch';

-- Suspendre un compte
update public.profiles p set blocked = true from auth.users u where u.id = p.id and u.email = 'abus@exemple.ch';

-- Les plus gros consommateurs sur 30 jours
select u.email, c.cost_usd, c.events from public.user_cost_30d c join auth.users u on u.id = c.user_id order by c.cost_usd desc limit 20;
```

## Mise en route

Voir [docs/SETUP.md](docs/SETUP.md).
