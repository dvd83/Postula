# Mise en route

Ce qui est déjà fait : projet Supabase `postula` (Zurich), base de données et quotas, fonctions serveur `ai` et `claim-free` déployées, front prêt dans `web/`, CI/CD GitHub Actions.

Ce qu'il reste à faire de ton côté (environ 30 minutes).

## 1. Clé d'API Anthropic (obligatoire)

1. Crée une clé sur https://console.anthropic.com → **API Keys**.
2. Fixe une limite de dépense mensuelle dans **Limits** : c'est ton dernier filet de sécurité.
3. Dans Supabase → projet `postula` → **Edge Functions → Secrets**, ajoute `ANTHROPIC_API_KEY`.

## 2. Connexion Google

1. https://console.cloud.google.com → nouveau projet `Postula` → **APIs & Services → OAuth consent screen** : type « Externe », nom « Postula », ton e-mail.
2. **Credentials → Create credentials → OAuth client ID** → « Web application ».
   - Authorized redirect URI : `https://gnnslezorkjlpprmroiv.supabase.co/auth/v1/callback`
3. Copie le Client ID et le Client secret dans Supabase → **Authentication → Sign In / Providers → Google**, puis active-le.

## 3. Connexion Apple (facultatif au lancement)

Nécessite un compte Apple Developer (99 $/an). Suis https://supabase.com/docs/guides/auth/social-login/auth-apple, avec le même callback. Sans Apple, le bouton « Continuer avec Apple » échouera : retire-le de `web/index.html` si tu lances sans.

## 4. Désactiver l'inscription par e-mail et mot de passe

Supabase → **Authentication → Sign In / Providers → Email** : désactive-le. Le gratuit n'est de toute façon accessible qu'avec Google/Apple.

## 5. Cloudflare (captcha + hébergement du site)

1. Crée un compte sur https://dash.cloudflare.com.
2. **Turnstile → Add widget** : nom `Postula`, domaine de ton site (et `postula.pages.dev`), mode « Managed ».
   - Mets la **Site key** dans `web/config.js` (`TURNSTILE_SITE_KEY`).
   - Mets la **Secret key** dans Supabase → Edge Functions → Secrets → `TURNSTILE_SECRET`.
3. **Workers & Pages → Create → Pages → Direct Upload** : nom du projet `postula` (la CI s'occupe ensuite des déploiements).
4. **My Profile → API Tokens → Create Token** → modèle « Edit Cloudflare Workers » (inclut Pages). Note aussi ton **Account ID** (colonne de droite du tableau de bord).

## 6. Secrets GitHub pour la CI/CD

GitHub → dépôt `postula` → **Settings → Secrets and variables → Actions → New repository secret** :

| Secret | Où le trouver |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | https://supabase.com/dashboard/account/tokens |
| `SUPABASE_DB_PASSWORD` | Supabase → Project Settings → Database (réinitialise-le si tu ne l'as pas noté) |
| `CLOUDFLARE_API_TOKEN` | étape 5.4 |
| `CLOUDFLARE_ACCOUNT_ID` | étape 5.4 |

Tant qu'un secret manque, la CI fait les vérifications et saute le déploiement correspondant (avec un avertissement), sans échouer.

## 7. Secrets Supabase complémentaires

Supabase → Edge Functions → Secrets :

| Secret | Valeur |
|---|---|
| `DEVICE_SALT` | une longue chaîne aléatoire (sert à hacher les empreintes d'appareil) |
| `ALLOWED_ORIGINS` | l'adresse de ton site, ex. `https://postula.pages.dev,https://postula.ch` |

## 8. Adresse du site dans Supabase

Supabase → **Authentication → URL Configuration** :
- Site URL : `https://postula.pages.dev` (ou ton domaine)
- Redirect URLs : ajoute la même adresse.

## Vérifier

Ouvre le site, connecte-toi avec Google, valide le captcha : le compteur « 2 CV · 1 lettres · 1 entretiens » apparaît en haut à droite.
