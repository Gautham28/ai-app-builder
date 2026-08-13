# Bloom — Deployment & Environments Guide

This is a first-deployment playbook: how to run **local → staging → production** with three isolated sets of data and keys, how to get Clerk out of development mode without breaking your users, and what to do on an ordinary Tuesday once it is live.

Read `PRODUCTION_READINESS.md` first. Do not point this pipeline at real users until the P0 items there are fixed — in particular P0-01 (credit theft), P0-02 (`zod` not declared), and P0-05 (migrations never run).

---

## 1. The mental model

You asked for test, stage, and prod. In practice you want **four** contexts, because "test" splits into two different things that people often conflate:

| Context | Runs where | Data | Who uses it | Purpose |
| --- | --- | --- | --- | --- |
| **Local** | your laptop, `npm run dev` | throwaway dev DB | you | fast iteration |
| **Test / CI** | GitHub Actions on every PR | ephemeral, none persisted | robots | catch regressions before merge |
| **Staging** | Vercel, `staging` branch | staging DB, fake payments | you + a friend | rehearse production |
| **Production** | Vercel, `main` branch | real DB, real money | customers | the real thing |

The rule that makes this worth the effort: **a change reaches production only after passing CI and being exercised in staging.** Staging is a rehearsal, so it must be configured exactly like production apart from its keys and data — same build command, same migration path, same env var names. If staging differs structurally from production, it stops predicting anything and becomes a second thing to maintain for no benefit.

The other rule: **no environment shares a database, an auth instance, or a storage bucket with another.** The single most common way solo projects cause an incident is a staging deploy pointed at the production database.

## 2. Services and how to split them

Everything here has a free tier that covers a project at your stage.

| Concern | Service | How to split across environments | Cost |
| --- | --- | --- | --- |
| Hosting | **Vercel** | one project, three env scopes (Production / Preview / Development) | free (Hobby) |
| Auth + billing | **Clerk** | two applications: "Bloom" (dev instance for local, production instance for prod) + "Bloom Staging" (dev instance) | free until you need Pro features in prod |
| Database | **Neon** Postgres | one project, three branches: `main`, `staging`, `dev` | free |
| File storage | **Supabase** Storage | two projects: `bloom-prod`, `bloom-nonprod` (shared by local + staging) | free (2-project limit) |
| Security | **Arcjet** | one site per environment → one key each | free tier |
| AI | **Google Gemini** | one API key per environment | pay per token |
| Errors | **Sentry** | one project, `environment` tag per deploy | free |

**Why Neon:** database *branching*. `neon branch create --parent main staging` gives you a copy-on-write clone of production data in seconds, which is exactly what you want for testing a migration against realistic data. If you are already on Supabase Postgres or Railway, that is fine too — just create three separate databases and keep the connection strings straight.

**Why two Clerk applications rather than one:** a Clerk application gives you one development instance and one production instance. If local and staging share the dev instance, your staging test users mix into your local ones and you cannot test billing flows cleanly. A second free application for staging keeps them apart. (Clerk offers a dedicated staging instance type on higher plans; use that instead if you ever upgrade.)

**Why Supabase is only split two ways:** the free tier caps you at two projects. Sharing one non-prod project between local and staging is an acceptable compromise because the blast radius is test images. **Never** let non-prod write to the prod bucket.

## 3. Git branching

Keep it boring:

```
main         ──●────────●────────●──────▶  production (protected)
                ▲        ▲        ▲
staging      ──●─●──●───●──●─────●──────▶  staging
                ▲   ▲      ▲
feature/xyz  ──●───●──────●                PR previews
```

- `main` is production. Protected: no direct pushes, PRs require CI green.
- `staging` is the integration branch. Feature branches merge here first.
- `feature/*` branches get an automatic Vercel preview URL per PR.

Flow for a change: branch from `staging` → open PR → CI runs → merge to `staging` → verify on the staging URL → PR `staging` → `main` → merge → production deploys.

Set up branch protection on `main` in **GitHub → Settings → Branches**: require a PR, require the `ci` status check to pass, and require branches to be up to date. This is what stops you from pushing a hotfix straight to production at 2 a.m. and regretting it.

## 4. Environment variables

Ten variables today, twelve after you add the fixes. Names must be **identical** across environments — only the values change. That is what lets staging predict production.

| Variable | Local | Staging | Production | Notes |
| --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | `pk_test_` (Bloom dev) | `pk_test_` (Bloom Staging) | **`pk_live_`** | different instance each |
| `CLERK_SECRET_KEY` | `sk_test_` | `sk_test_` | **`sk_live_`** | secret |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | `/sign-in` | `/sign-in` | `/sign-in` | same |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | `/sign-up` | `/sign-up` | `/sign-up` | same |
| `CLERK_WEBHOOK_SIGNING_SECRET` | — | `whsec_` | `whsec_` | **new**, for P1-01 |
| `DATABASE_URL` | Neon `dev` (pooled) | Neon `staging` (pooled) | Neon `main` (pooled) | runtime queries |
| `DIRECT_URL` | Neon `dev` (direct) | Neon `staging` (direct) | Neon `main` (direct) | migrations; **required at build time** |
| `GEMINI_API_KEY` | dev key | staging key | prod key | separate keys = separate quota |
| `ARCJET_KEY` | dev site | staging site | prod site | secret |
| `NEXT_PUBLIC_SUPABASE_URL` | nonprod | nonprod | **prod** | |
| `SUPABASE_SERVICE_ROLE_KEY` | nonprod | nonprod | **prod** | **new**, for P0-09. Never `NEXT_PUBLIC_` |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` | `https://staging.bloom.app` | `https://bloom.app` | **new**, for `metadataBase` |
| `NEXT_PUBLIC_SENTRY_DSN` | — | staging DSN | prod DSN | **new**, for P1-11 |

Notice `NEXT_PUBLIC_SUPABASE_ANON_KEY` is gone from that list. Once you move uploads server-side (P0-09) the browser no longer needs it, and the bucket becomes private.

### Setting them in Vercel

**Project → Settings → Environment Variables.** Each variable is scoped to one or more of Production / Preview / Development.

The trick for staging on the Hobby plan: staging is a **Preview** deployment of the `staging` branch. When you add a Preview variable, Vercel lets you attach it to a **specific git branch**. So:

- Production values → check **Production** only.
- Staging values → check **Preview**, and set the branch filter to `staging`.
- Anything a throwaway PR preview needs → check **Preview** with no branch filter (these get staging-ish values; keep them harmless).

If you are on Vercel Pro, use **Custom Environments** instead — a first-class `staging` environment with its own domain and variables, which is cleaner than branch-filtered previews.

Locally, keep `.env` (already gitignored — verified, and it has never been committed). Add a **`.env.example`** with every key name and empty values, and commit that. It is the only documentation of what the app needs to boot, and right now that documentation does not exist.

## 5. Standing it up, step by step

### Step 0 — before you touch a dashboard

```bash
npm uninstall xod && npm install zod@^4.4.3    # P0-02
npx tsc --noEmit && npx eslint . && npm run build
```

Fix the P0 security items too. Deploying a known credit-theft bug to a public URL and fixing it "next week" is how you end up with a support inbox instead of a project.

Also change your build script now (P0-05):

```json
"build": "prisma migrate deploy && next build"
```

### Step 1 — Database (Neon)

1. Create a Neon project, region closest to your users. The default branch is `main` — this is production.
2. Create two branches from `main`: `staging` and `dev`.
3. For each branch, copy **both** connection strings: the **pooled** one (`-pooler` in the host) for `DATABASE_URL`, and the **direct** one for `DIRECT_URL`. Prisma needs the direct connection for migrations and the pooled one for serverless queries; mixing them up produces connection-exhaustion errors under load that are miserable to debug.
4. Apply the schema to each branch:

```bash
DIRECT_URL="<dev direct url>"     npx prisma migrate deploy
DIRECT_URL="<staging direct url>" npx prisma migrate deploy
DIRECT_URL="<main direct url>"    npx prisma migrate deploy
```

### Step 2 — Storage (Supabase)

1. Create two projects: `bloom-nonprod` and `bloom-prod`.
2. In each: **Storage → New bucket → `workspace-images`**, and leave it **private**.
3. Set a file size limit (5 MB) and allowed MIME types (`image/png`, `image/jpeg`, `image/webp`) on the bucket.
4. Copy the **service role** key from **Settings → API** for each. This is a full-access admin key — server-only, never in a `NEXT_PUBLIC_` variable, never in the browser bundle.
5. Confirm there is **no** policy allowing anonymous `insert`. If your current setup has one, that is P0-09 and it is live right now.

### Step 3 — Security (Arcjet)

Create three sites (`bloom-local`, `bloom-staging`, `bloom-prod`) and take a key from each. Separate keys mean staging load-testing does not eat your production rate-limit quota, and you can read the dashboards independently.

While you are there, reconsider the rules in `lib/arcjet.ts`: `tokenBucket` at 5 requests per 60 seconds per user is reasonable for generation, but it is also exactly what makes P0-03 (concurrent credit race) possible at 5×. In production, also add `CATEGORY:MONITOR` to the `detectBot` allow list in `proxy.ts` before you set up uptime checks, or your monitor will be blocked and page you (see P2-06).

### Step 4 — AI (Gemini)

Create three API keys in Google AI Studio. Set a **billing budget alert** on the Google Cloud project — this is the one service here that can generate a genuinely alarming bill, because per P1-04 the request size is currently unbounded and attacker-controlled. Do this before you go public, not after.

### Step 5 — Auth for local and staging (Clerk dev instances)

You already have the local one. For staging, create a second Clerk **application** ("Bloom Staging"), enable **Billing** on its development instance, and create plans with slugs **exactly** `starter` and `pro` in the **User Plans** tab. Those slugs are what `lib/checkUser.ts` checks with `has({ plan: "pro" })`; if they differ by even a capital letter, every paid user silently reads as free.

Dev instances can use Clerk's shared development payment gateway, so you can rehearse the whole checkout with test cards — that is the "Development mode / Pay with test card" drawer in your screenshot. Perfect for staging, unacceptable for production.

### Step 6 — First Vercel deploy (staging)

1. **New Project → import the repo.** Framework preset: Next.js. Do not deploy yet.
2. Add every variable from the table in §4 with the right scopes.
3. Confirm the build command is `prisma migrate deploy && next build` and that `postinstall` runs `prisma generate` (it does — this is what generates the gitignored `lib/generated/prisma` on the build machine).
4. Push the `staging` branch. Vercel builds a Preview deployment.
5. Assign a stable domain to it: **Settings → Domains → add `staging.yourdomain.com`**, pointed at the `staging` branch. Without this you get a new random URL per commit, which makes Clerk's allowed-origins config impossible.
6. **Set `robots: { index: false }` for staging** (P1-13). Google will otherwise index your staging site and rank it against production.

Now run the smoke test in §8 against staging. Everything must pass here before you think about production.

### Step 7 — Production Clerk instance

This is the part with the most sharp edges, so it gets its own section (§6).

### Step 8 — Production deploy

1. Add Production-scoped env vars, including the `pk_live_`/`sk_live_` keys.
2. Point your apex domain at the Vercel project.
3. Merge `staging` → `main`. Watch the build log confirm `prisma migrate deploy` applied cleanly.
4. Run the §8 smoke test again against production, with a **real card**, and then refund yourself.

## 6. Getting Clerk out of development mode

Your screenshots show the two things a real user would see today: **"Development mode"** under the user menu, and **"Development mode / Pay with test card"** in the checkout drawer. In a dev instance you cannot take money, you are capped at **100 users**, and Clerk is lending you *its* Google OAuth credentials.

Work through this in order. Steps 1–4 can be done ahead of time without affecting your live dev instance.

### 6.1 Create the production instance

In the Clerk dashboard, top-left environment switcher on the "Bloom" application → **Production**. Clerk creates a fresh instance. Understand what "fresh" means: **no users, no plans, no OAuth config, no settings carry over.** Development-instance data cannot be transferred.

### 6.2 DNS (five records)

Clerk gives you CNAME records to add at your registrar / DNS provider:

| Purpose | Typical host |
| --- | --- |
| Frontend API | `clerk.yourdomain.com` |
| Account portal | `accounts.yourdomain.com` |
| Email | `clkmail.yourdomain.com` |
| DKIM 1 | `clk._domainkey.yourdomain.com` |
| DKIM 2 | `clk2._domainkey.yourdomain.com` |

Add all five, then hit **Verify** in Clerk. If your DNS is behind Cloudflare, set these records to **DNS only** (grey cloud) — proxying them breaks verification. Propagation is usually minutes but can take hours; do this a day early.

### 6.3 Your own OAuth credentials

If you offer Google sign-in, production requires **your** credentials. In Google Cloud Console: create an OAuth 2.0 Client ID (Web application), set the authorised redirect URI to the value Clerk shows you, then paste the Client ID and Secret into Clerk. Repeat for GitHub or any other provider.

Skip this and social sign-in fails in production while working perfectly in dev — a confusing failure, because nothing in your code changed.

### 6.4 Billing (the part that will bite)

1. **Billing → Settings → enable Billing** on the production instance.
2. **Connect a real Stripe account.** The sandbox account behind your dev instance cannot be used for production; you need a separate, activated Stripe account with your business details.
3. **Recreate both plans by hand** in the **User Plans** tab, with slugs **exactly `starter` and `pro`**, prices $9 and $29. Clerk Billing plans do not sync between instances, and slugs are not movable between the User and Organization tabs after creation.
4. This mints **new `cplan_*` IDs**, so the hardcoded ones in `lib/constants.ts` (lines 40 and 55) are now dead. Since `PRICING_PLANS` is unused dead config anyway (P0-06), delete it rather than updating it.
5. Verify `has({ plan: "pro" })` returns `true` for a real subscriber. If Billing is not enabled, or the gateway is not connected, or a slug differs, `has()` returns `false` for everyone and every paying customer is silently downgraded to free.

### 6.5 The database problem

**Clerk production issues brand-new user IDs, even for the same email address.** Your `User.clerkId` values are all dev-instance IDs, and `User.email` is `@unique` — so an existing user signing in to production creates a `clerkId` miss, falls through to `create`, and hits the email unique constraint. `checkUser()` swallows the error and returns `null`, and the user is redirected to `/` forever with no message. That is P0-04, and it is the single most likely way your launch day goes wrong.

Two options:

- **Clean start (recommended).** Your dev users are test accounts. Start production with an empty `User` table and let people sign up fresh. Fix `checkUser()` to `upsert` (P0-04) so the general case — one email, multiple Clerk accounts — stops failing too.
- **Migrate.** Export dev users, match on email, and write a script that updates each row's `clerkId` to the new production ID. Only worth it if you have real users you cannot ask to re-register.

Either way, **fix `checkUser()` before the cutover**, and add the `user.created` webhook so account creation stops depending on a page render (P1-06).

### 6.6 Swap the keys

Set `pk_live_` / `sk_live_` in the **Production** scope only, redeploy, and confirm the "Development mode" badge is gone from both the user menu and the checkout drawer.

### 6.7 Update your CSP

When you add security headers (P1-12), the allowlist must include your new Clerk domain (`clerk.yourdomain.com`) in `script-src`, `connect-src`, and `worker-src`. A CSP tuned against `*.clerk.accounts.dev` will silently block production Clerk.

### Clerk cutover checklist

- [ ] Production instance created
- [ ] All five DNS records added and verified
- [ ] Own Google/GitHub OAuth credentials configured
- [ ] Billing enabled; real (non-sandbox) Stripe account connected
- [ ] `starter` and `pro` plans recreated in the **User Plans** tab with exact slugs
- [ ] `has({ plan: "pro" })` verified against a real subscription
- [ ] `checkUser()` fixed to `upsert`; email uniqueness decision made
- [ ] `pk_live_` / `sk_live_` set in Production scope only
- [ ] `PRICING_PLANS` deleted or repopulated with production IDs
- [ ] CSP allowlists the production Clerk domain
- [ ] "Development mode" gone from the user menu **and** the checkout drawer
- [ ] Test purchase with a real card, then refunded

## 7. CI: the "test" environment

This is your safety net, and it does not exist yet (P1-17). Create `.github/workflows/ci.yml`:

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [staging, main]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx prisma generate
      - run: npx tsc --noEmit
      - run: npx eslint .
      - run: npm test
      - run: npm run build
        env:
          # build-time placeholders; never real secrets
          NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: pk_test_placeholder
          CLERK_SECRET_KEY: sk_test_placeholder
          DATABASE_URL: postgresql://user:pass@localhost:5432/db
          DIRECT_URL: postgresql://user:pass@localhost:5432/db
```

Two notes. `npm ci` installs strictly from the lockfile with no hoisting luck — which is exactly why P0-02 (`zod` undeclared) must be fixed first, or this job fails on day one. And `npm run build` here should be plain `next build`, not the migrate-and-build variant, since CI has no database; keep `prisma migrate deploy` in Vercel's build command rather than the npm script if you want them cleanly separated.

### What to test

You do not need broad coverage. You need tests on the code where a silent bug costs money or leaks data. Install Vitest and write these seven:

1. Unauthenticated `POST /api/gen-ai-code` → 401.
2. Unauthenticated `POST /api/improve` → 401.
3. **A request carrying another user's `userId` cannot touch their workspace or credits.** This is the P0-01 regression test and the most important test in the suite.
4. **Concurrent generations cannot drive credits below zero.** The P0-03 regression test.
5. A non-Pro user gets 403 from `/api/improve`.
6. `deleteProject` cannot delete a workspace owned by someone else.
7. `checkUser` is idempotent: called twice concurrently for a new user, it creates exactly one row and does not throw.

Add `"test": "vitest run"` to `package.json`. Seven tests that cover your money and your ownership boundaries are worth more than 200 component snapshots.

## 8. Smoke test

Run this against staging before every production release, and against production right after. Ten minutes, and it exercises every integration.

**Anonymous**
- [ ] Landing page loads; hero image renders; no console errors
- [ ] Pricing table renders with both plans at the right prices
- [ ] Visiting `/workspace` directly redirects to sign-in
- [ ] Visiting `/projects` directly redirects to sign-in

**Sign-up**
- [ ] Sign up with email; land back on the app signed in
- [ ] Google sign-in works (**production only** — this is what breaks if §6.3 was skipped)
- [ ] Header shows `10 / 10 credits`
- [ ] A `User` row exists with the right `clerkId`, `email`, `plan=free`, `credits=10`

**Generation**
- [ ] Enter a prompt from the landing page → redirected to `/workspace?prompt=...` and generation auto-starts
- [ ] Status messages stream in (not one dump at the end — that is P2-07)
- [ ] Preview renders the app; Code tab shows the files
- [ ] Credits drop to 9 in the header
- [ ] A follow-up prompt modifies the app and drops credits to 8
- [ ] **Stop actually stops** (P0-08)
- [ ] Attach an image; it uploads and influences the result
- [ ] Download ZIP; unzip, `npm install`, `npm start`, and confirm it **runs** (P1-15)

**Failure paths** — the ones nobody tests until a user finds them
- [ ] Set credits to 0 in the DB → UI shows the no-credits state and blocks input
- [ ] Send 6 generations quickly → Arcjet returns 429 and a toast appears
- [ ] Force an error server-side → **a toast appears** (this is P0-07; today you get silence)
- [ ] Open a workspace id belonging to another user → denied, with a sensible message

**Billing**
- [ ] Subscribe to Pro (test card on staging, real card on production)
- [ ] Header reflects `pro`; credits topped up to 150
- [ ] "Improve with Agent" is enabled and completes a run
- [ ] `has({ plan: "pro" })` resolves true server-side
- [ ] Cancel; confirm the app degrades sensibly

**Production only**
- [ ] No "Development mode" anywhere, including the checkout drawer
- [ ] HTTPS with a valid certificate; `http://` redirects
- [ ] Sentry receives a deliberately triggered test error
- [ ] `robots.txt` allows production (and **blocks** staging)
- [ ] Sharing the URL renders a proper OG preview card

## 9. Migrations without downtime

The riskiest routine operation you will perform. Prisma's flow:

```bash
# local: author the migration
npx prisma migrate dev --name add_credits_reset

# staging: apply automatically on deploy (via the build command)
git push origin staging

# production: applies on merge to main
```

Rules that will save you:

1. **Never edit an applied migration.** Write a new one.
2. **Additive first.** Adding a nullable column or a new table is safe. Dropping or renaming a column breaks the currently-running old code during the deploy window. For a rename: add the new column → deploy code writing both → backfill → deploy code reading the new one → drop the old one in a later release.
3. **Test against realistic data.** This is where Neon branching earns its keep: `neon branch create --parent main migration-test`, apply the migration there, confirm it completes in reasonable time, then delete the branch.
4. **Take a backup before anything destructive.** Neon has point-in-time restore; know your retention window before you need it.
5. **Watch the build log.** `prisma migrate deploy` failing means the deploy fails, which is correct behaviour — but you need to notice, because Vercel keeps serving the previous deployment and everything looks fine.

Your first migration after launch will almost certainly be the P1-01 credits work (`creditsResetAt`, `planPeriodStart`) plus the P1-03 `plan` enum and the P1-10 denormalised columns. All additive. Good first exercise.

## 10. Day-2 operations

**Monitoring.** Sentry for errors (with `environment` set per deploy so staging noise stays out of your production inbox). Vercel Analytics for traffic and Web Vitals. An uptime check on `/` every 5 minutes — and remember to allow `CATEGORY:MONITOR` in Arcjet first (P2-06) or the monitor gets a 403 and pages you at 3 a.m. about an app that is fine.

**Budget alerts.** Set these before launch, not after: a Google Cloud budget alert on the Gemini project (unbounded request size, per P1-04), Neon and Supabase usage alerts, and Vercel's spend limit.

**Rollback.** Vercel keeps every deployment. **Deployments → the last good one → Promote to Production** is your fastest fix, and it is instant. The exception is a bad migration: code rolls back, schema does not. That asymmetry is exactly why rule 2 in §9 matters.

**A weekly ten minutes.** Skim Sentry for new error types. Check credits granted versus generations served (this is how you would have caught P0-01 or P0-03 in the wild). Check the Gemini bill against signups. Review Arcjet denials for false positives — blocked legitimate users do not file bug reports, they leave.

## 11. Rough monthly cost

| Service | Free tier covers | When you start paying |
| --- | --- | --- |
| Vercel Hobby | personal, non-commercial | **once you charge money, Vercel requires Pro — $20/mo** |
| Clerk | 10k monthly active users | Pro needed for paid features in production |
| Neon | ~0.5 GB, 10 branches | small paid tier when `fileData` JSON grows |
| Supabase | 1 GB storage, 2 projects | third project or more storage |
| Arcjet | generous free tier | high volume |
| Gemini | pay per token | **from request one — your main variable cost** |
| Sentry | 5k errors/mo | rarely, at this scale |

Realistic starting point: **$20–40/month** (Vercel Pro plus modest Gemini usage). The one that can surprise you is Gemini, because `fileData` is serialised into every prompt with no size cap (P1-04) — a handful of users with large generated apps can cost more than everything else combined. Fix that cap before you advertise.

## 12. The order I would actually do this in

**Week 1 — make it safe.** Fix all ten P0s. Add CI with the seven tests from §7. Write a real `README.md` and `.env.example`.

**Week 2 — build the pipeline.** Neon branches, Supabase projects, Arcjet sites, Gemini keys. Deploy staging. Run the §8 smoke test until it passes end to end. Add Sentry.

**Week 3 — go live.** Clerk production migration (§6). Domain and DNS. Security headers and CSP in report-only mode. Deploy production. Smoke test with a real card. Tell exactly five people.

**Week 4 — make it sustainable.** Billing webhooks and monthly credit resets (P1-01) — the sooner this lands, the fewer customers pay for credits they never receive. Error boundaries. Then the performance work.

Then stop reading checklists and go get users.
