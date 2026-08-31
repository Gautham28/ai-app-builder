# Bloom — Production Readiness Audit

**Date:** 11 Aug 2026
**Verdict:** **Not ready to host publicly yet.** The short version:

- One bug lets any signed-in user **spend another user's credits and overwrite their saved projects** (P0-01).
- One bug lets **anyone on the internet upload arbitrary files** to your Supabase bucket (P0-09).
- One undeclared dependency will **fail the build on a clean CI install** (P0-02).
- One bug will **silently break every user account** the moment you switch Clerk from dev to production (P0-04).
- Nothing in your pipeline runs database migrations, so a fresh production database yields an app that deploys successfully and then fails on every query (P0-05).

None of them are hard to fix. Realistically this is **2–4 days of focused work** to be safe for real users, and the app is well-structured underneath — the problems are concentrated in the two API routes, the credit logic, and the Clerk/billing lifecycle.

## How to read this

Every issue has a severity, the exact file and line, what actually goes wrong, and how to fix it.

| Severity | Meaning | Count |
| --- | --- | --- |
| **P0** | Do not deploy publicly until fixed. Security, data loss, money, or hard breakage. | 10 |
| **P1** | Fix before or immediately after launch. Real user-visible bugs, cost, or trust problems. | 18 |
| **P2** | Cleanup and polish. Fix as you go. | 18 |

### State of the tooling

These all pass today, so nothing here is blocking; it just means the compiler is not catching the bugs below.

- `npx tsc --noEmit` — clean.
- `npm run build` — succeeds (Next.js 16.2.9, Turbopack, ~10s).
- `npx eslint .` — **2 errors**, 17 warnings.
- No secrets are committed. `.env` has never been in git history, and `.gitignore` correctly covers `.env*`. Good.
- Every route builds as `ƒ (Dynamic)`, including `/` and `/sign-in`. See P1-06.

---

# P0 — Blockers

## P0-01 · Any user can spend another user's credits and overwrite their projects

**File:** `app/api/gen-ai-code/route.ts` lines 104–274

The route authenticates the caller with Clerk, looks up the matching database user, and then **never uses that user record for any write**. Every write uses the `userId` the browser sent in the request body.

```ts
const { userId: clerkId } = await auth();            // trusted, from Clerk
const { workspaceId, userId, ... } = body;            // attacker-controlled

const user = await db.user.findUnique({               // correct user...
  where: { clerkId },
  select: { id: true, credits: true },
});
if (user.credits < CREDIT_COST_PER_GENERATION) { ... } // ...checked against the caller

// ...but every write below uses the body's `userId`, not `user.id`:
db.workspace.update({ where: { id: workspaceId, userId }, ... })
db.workspace.create({ data: { userId, ... } })
db.user.update({ where: { id: userId }, data: { credits: { decrement: 1 } } })
```

The database `userId` is not a secret — it is passed to the browser as a prop in `app/(main)/workspace/page.tsx` (`userId={user.id}`) and is visible in the page payload. So a signed-in attacker who learns any other user's id can:

1. **Drain that user's credits.** The credit *check* runs against the attacker, the credit *decrement* runs against the victim. One attacker credit buys unlimited generations while the victim's balance goes to zero.
2. **Overwrite that user's projects.** `workspace.update({ where: { id: workspaceId, userId } })` matches on the victim's own id, so the ownership scope passes and the victim's `messages` and `fileData` are replaced with the attacker's generated app.
3. **Plant projects in that user's account** via the `create` branch.

**Fix.** Delete `userId` from the request body entirely and use the server-derived id everywhere:

```ts
const { workspaceId, messages, fileData } = body;      // no userId
const user = await db.user.findUnique({ where: { clerkId }, select: { id: true, credits: true } });
// ...then use user.id for all three writes
```

Then remove `userId` from the `fetch` body in `components/WorkspaceClient.tsx` (lines 242–247). Do the same in `app/api/improve/route.ts` — it currently gets this right by accident (`where: { id: userId, clerkId }` validates the pair), but relying on the client to send its own id is the wrong pattern and one refactor away from the same bug.

**Rule to adopt:** a client request may never contain an identity claim. Derive identity from the session, always.

## P0-02 · `zod` is imported but not declared as a dependency; `xod` is an accidental install

**Files:** `package.json` line 37, `app/api/improve/route.ts` line 4

`app/api/improve/route.ts` does `import { z } from "zod"`, but `zod` is **not in `package.json`**. It only resolves today because `@cline/sdk` pulls in `zod@4.4.3` and npm happens to hoist it to the top of `node_modules`:

```
ai-app-builder@0.1.0
`-- @cline/sdk@0.0.51
  `-- @cline/core@0.0.51
    `-- @cline/llms@0.0.51
      `-- @ai-sdk/openai@3.0.73
        `-- zod@4.4.3        <- what your import is actually resolving to
```

This is a phantom dependency. It breaks the moment `@cline/sdk` bumps its zod range, drops it, or you install with pnpm/Yarn PnP (which do not hoist). It will look like a working build that suddenly fails on CI with `Module not found: Can't resolve 'zod'`.

Separately, `package.json` declares **`xod@1.11.3`** — an Arduino visual-programming toolchain, almost certainly a typo for `zod`. It is imported nowhere, and it drags an unnecessary dependency tree into every install.

**Fix:**

```bash
npm uninstall xod
npm install zod@^4.4.3
```

Then commit the updated lockfile and confirm with `npm ls zod` that it shows as a direct dependency.

## P0-03 · Credit deduction is not atomic — balances can go negative

**Files:** `app/api/gen-ai-code/route.ts` lines 150–152 & 270–273, `app/api/improve/route.ts` lines 44–45 & 203–206

Both routes do a read-then-write with a long gap:

```ts
if (user.credits < CREDIT_COST_PER_GENERATION) return 402;   // read
// ...30-120 seconds of Gemini streaming happens here...
db.user.update({ data: { credits: { decrement: 1 } } });     // write
```

A user with 1 credit who fires five requests in parallel passes the check five times and ends at **−4 credits**. The `noCredits` UI check (`credits <= 0`) then locks them out, but they already got five free generations. Arcjet's token bucket (5 per 60s per user) caps the blast radius but does not prevent it — the bucket allows exactly 5 concurrent requests.

**Fix.** Reserve the credit atomically *before* calling Gemini, and let the database enforce the invariant:

```ts
const reserved = await db.user.updateMany({
  where: { id: user.id, credits: { gte: CREDIT_COST_PER_GENERATION } },
  data: { credits: { decrement: CREDIT_COST_PER_GENERATION } },
});
if (reserved.count === 0) {
  return Response.json({ message: "Insufficient credits" }, { status: 402 });
}
```

`updateMany` with the `gte` guard in the `where` compiles to a single conditional `UPDATE`, so concurrent requests cannot both win. Then **refund on failure** (invalid JSON, Gemini error, abort) by incrementing back — today a user who hits "AI returned invalid JSON" keeps their credit only because the decrement happens last, but once you reserve up front you must handle the refund path explicitly.

Also add a `credits Int @default(10)` check constraint at the DB level if you want belt-and-braces:

```sql
ALTER TABLE "User" ADD CONSTRAINT "User_credits_non_negative" CHECK ("credits" >= 0);
```

## P0-04 · Every existing user breaks when you switch Clerk to production

**Files:** `lib/checkUser.ts` lines 52–65, `prisma/schema.prisma` line 19

Clerk issues **completely new user IDs in a production instance**, even for an identical email address. Dev-instance user data does not transfer. Your `User` table keys on `clerkId` — but `email` is also `@unique`:

```prisma
clerkId   String   @unique
email     String   @unique
```

So when you go live and an existing user signs in with the same email, `checkUser()` finds no row for the new `clerkId`, falls through to `db.user.create()`, and hits a **unique constraint violation on `email`**. That exception is swallowed:

```ts
} catch (error) {
  console.error("checkUser error:", error);
  return null;                                  // <- user silently has no account
}
```

`checkUser` returns `null`, so `Header` renders no credits, and `getWorkspaceUser()` in `actions/workspace.ts` hits `if (!user) redirect("/")` — the user is bounced from `/workspace` and `/projects` back to the landing page forever, with no error message anywhere. From their side the app is simply broken and there is nothing in the UI to explain it.

This also fires today whenever two Clerk accounts share an email (e.g. someone signs up with Google and then with email/password).

**Fix — three parts:**

1. **Make the write idempotent and race-safe.** Replace find-then-create with an upsert on `clerkId`:

   ```ts
   return await db.user.upsert({
     where: { clerkId: user.id },
     update: {},                       // or refresh name/imageUrl here
     create: { clerkId: user.id, name, email, imageUrl, credits: PLANS.free.credits, plan: "free" },
   });
   ```

   This also fixes a second latent bug: two concurrent first-requests from a brand-new user (very likely, since `Header` runs on every route) both reach `create` and one throws a `clerkId` unique violation today.

2. **Decide what `email` means.** Either drop `@unique` from `email` (recommended — Clerk owns identity, and `clerkId` is the real key), or explicitly re-link: if a create fails on the email constraint, update that row's `clerkId` to the new one. Dropping the constraint needs a migration.

3. **Stop swallowing the error.** Returning `null` from an auth-critical path makes the app appear broken with zero signal. Log it to your error tracker (see P1-11) and surface a real error state.

**Because of this**, plan your dev→prod cutover as a clean start: either accept that existing dev users re-register (they are test accounts), or write a one-off script to map old `clerkId` → new `clerkId` by email before opening the doors. The `DEPLOYMENT_GUIDE.md` covers this.

## P0-05 · Nothing runs database migrations on deploy

**Files:** `package.json` lines 5–10, `prisma/migrations/`

Your scripts are:

```json
"build": "next build",
"postinstall": "prisma generate"
```

`prisma generate` creates the client (good — this is what makes `lib/generated/prisma` exist on Vercel, since it is gitignored). But **nothing ever runs `prisma migrate deploy`**. Point this at a fresh production database and the build succeeds, the app deploys, and every single query fails at runtime with `relation "User" does not exist`.

**Fix.** Add a deploy-time migration step:

```json
"build": "prisma migrate deploy && next build"
```

That is the simplest option and works fine at your scale. Two caveats to know: the build must be able to reach the database (`DIRECT_URL` must be set for the build environment, not just runtime), and migrations then run once per deployment. For a solo project this is the right trade-off. If you later want migrations decoupled from builds, move it to a GitHub Actions release job that runs before the Vercel deploy is promoted.

Also note `prisma/schema.prisma` has no `url` in its `datasource` block — it relies on `prisma.config.ts` reading `DIRECT_URL` for migrations and the `PrismaPg` adapter reading `DATABASE_URL` at runtime. That works with Prisma 7 driver adapters, but it means **both** env vars must be present in every environment, and the failure mode if `DIRECT_URL` is missing is a confusing migrate error. Document both as required.

## P0-06 · Clerk is in development mode — and your plan IDs are dev-only

**Files:** `lib/constants.ts` lines 40 & 55, `.env`

You are running `pk_test_` / `sk_test_` keys. Your screenshots show both symptoms users would see: the **"Development mode"** label under the user menu, and **"Development mode / Pay with test card"** inside the checkout drawer. In a dev instance nobody can actually pay you.

Dev instance limits that matter: **capped at 100 users**, user data cannot be transferred between instances, Clerk uses its own **shared Google OAuth credentials** (so social sign-in silently stops working in production until you supply your own), and there is no custom domain.

The billing side is worse, because it is hardcoded:

```ts
planId: "cplan_3DvxGsOeYA5bpJzGWPi8o7wScRD",   // Starter — dev instance ID
planId: "cplan_3DvxTfywwB0NyQ1iqANclgNqlq8",   // Pro     — dev instance ID
```

**Clerk Billing plans do not sync between instances.** You must recreate them by hand in the production instance, which mints new `cplan_*` IDs, making these constants dead values. Also note `active: false` on both paid entries and `planId: null` on free — `PRICING_PLANS` is currently unused dead config (the UI renders Clerk's own `<PricingTable />`), which is exactly why nobody noticed the IDs are stale.

What matters far more than the IDs: `lib/checkUser.ts` gates on **plan slugs**, not IDs —

```ts
if (has({ plan: "pro" })) return "pro";
if (has({ plan: "starter" })) return "starter";
```

If you recreate the production plans with different slugs (or in the "Organization Plans" tab instead of "User Plans"), `has()` returns `false` for everyone, every paying customer silently becomes `free`, and the Pro-only improve endpoint 403s for people who just paid you $29.

**Fix.** Follow the production checklist in `DEPLOYMENT_GUIDE.md`. The must-haves: recreate plans in the **User Plans** tab with the **exact slugs `starter` and `pro`**, connect a real (non-sandbox) Stripe account, add your own Google OAuth credentials, add the five DNS records, swap to `pk_live_`/`sk_live_`, and either delete `PRICING_PLANS` or repopulate it from the production instance.

## P0-07 · Generation and improve errors are silently swallowed — users see nothing

**Files:** `components/WorkspaceClient.tsx` lines 294–299 and 187–192

Both SSE readers throw on an `error` event, and both throws are caught by an empty `catch` in the same loop:

```ts
} else if (event.type === "error"){
    throw new Error(event.message);
}
} catch (error) {                    // <- catches its own throw

}
```

The `catch` is there to skip malformed SSE lines, but it also eats every server-reported error. So when Gemini returns invalid JSON, or the response is missing `files`, or Arcjet blocks mid-stream, or the agent run fails, the outer handler that would `toast.error(...)` and roll back the optimistic user message **never runs**. The user watches the spinner stop and nothing happens — no toast, no message, no explanation. The improve path (line 190) has the identical bug.

**Fix.** Only swallow JSON parse failures, and let real errors out:

```ts
for (const line of lines) {
  if (!line.startsWith("data: ")) continue;

  let event;
  try {
    event = JSON.parse(line.slice(6));
  } catch {
    continue;                                    // malformed line — skip
  }

  if (event.type === "status") pushStep(event.message);
  else if (event.type === "done") { /* ... */ }
  else if (event.type === "error") throw new Error(event.message);
}
```

While you are here: `handleGenerate` never handles `res.status === 403`, so a plan-gate rejection also produces silence.

## P0-08 · The Stop button does nothing during generation

**File:** `components/WorkspaceClient.tsx` lines 231–248

An `AbortController` is created, stored in the ref, and then **immediately shadowed by a second one** inside the `try`:

```ts
const abortController = new AbortController();
generateAbortRef.current = abortController;        // this one is stored

try {
  const conversationHistory = [...currentMessages, userMessage];
  const abortController = new AbortController();   // <- shadows it

  const res = await fetch("/api/gen-ai-code", {
    signal: abortController.signal,                // fetch uses the inner one
```

`handleStop()` aborts the outer controller, which is wired to nothing. The user clicks ■, the button state changes, and the request keeps streaming to completion — and still consumes a credit. The improve path (line 107) does this correctly, which is why only generation is affected.

**Fix.** Delete line 236. One controller, created before the `try`, stored in the ref, passed to `fetch`.

Note that aborting only stops the *client* from listening. The server keeps streaming, still calls Gemini, and still charges the credit. If "stop" should mean "don't charge me", you need `request.signal.addEventListener("abort", ...)` on the server to bail out and refund.

## P0-09 · Image uploads go straight to Supabase from the browser with no limits

**File:** `components/ChatPanel.tsx` lines 30–33 & 117–141

The upload runs entirely client-side using the public anon key, to a bucket whose objects are then served via `getPublicUrl`:

```ts
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);
// ...
const path = `${userId}/${workspaceId ?? "new"}/${Date.now()}.${ext}`;
await supabase.storage.from("workspace-images").upload(path, file, { upsert: true });
```

Problems, in order of severity:

- **The anon key is public by definition** (it ships in the JS bundle). If the `workspace-images` bucket allows anonymous inserts — which it must, for this code to work, since Clerk sessions are invisible to Supabase RLS — then **anyone on the internet can upload arbitrary files to your bucket** and get a public URL. That is an open file host: free malware/phishing/piracy hosting on your domain and your storage bill. This is the single most likely way you get a surprise invoice or a provider abuse complaint.
- **`path` is fully client-controlled.** `userId` and `workspaceId` are just props; nothing server-side validates them. Combined with `upsert: true`, one user can **overwrite another user's uploaded images** by guessing the path prefix.
- **No size limit.** `file.type.startsWith("image/")` is the only check and it is client-side. Someone can upload a 2 GB file, or a `.html` file with an `image/png` MIME type (`getPublicUrl` + a wrong content type is a stored-XSS vector on the Supabase domain).
- **No cleanup.** Images are never deleted, including when the workspace is deleted.

**Fix.** Move the upload behind your own server:

1. Create `POST /api/upload` that calls `auth()`, derives the real user id from the session, validates `Content-Length` (cap it — 5 MB is plenty) and the actual file signature, generates the storage path server-side, and uploads using the **service role key** (server-only, never `NEXT_PUBLIC_`).
2. Set the bucket to **private**, delete any anonymous insert policy, and serve images with short-lived signed URLs instead of `getPublicUrl`.
3. Set a bucket-level file size limit and an allowed-MIME-types list in the Supabase dashboard as a second layer.
4. Add the upload to the Arcjet-protected surface so it is rate limited too.

If you keep public URLs for now (Gemini needs to fetch them), at minimum make the bucket insert-only via a server route and keep reads public.

## P0-10 · `/api/improve` has no rate limiting, and crashes before its own error handler

**File:** `app/api/improve/route.ts` lines 17–45 & 111–153

Two separate problems in the Pro-only endpoint:

**No Arcjet protection at all.** `/api/gen-ai-code` calls `aj.protect(...)` (token bucket, prompt-injection detection, sensitive-info detection). `/api/improve` calls none of it. It is authenticated and Pro-gated, so the exposure is limited to paying users — but it runs an **agent loop with `maxIterations: 8`**, meaning one request can be 8 Gemini calls. A single Pro user can hammer it in parallel and run up your Gemini bill far faster than through the generation endpoint. It is also the only user-input path with no prompt-injection check.

**An unguarded crash path.** These lines sit *outside* the `try` block that starts at line 153:

```ts
const patchedFiles = { ...fileData.files };                 // line 57
const fileContext = Object.entries(fileData.files)          // line 115
```

`fileData` comes straight from the request body with no validation. If it is missing or `files` is undefined, `Object.entries(undefined)` throws inside `ReadableStream.start()` — outside the `try`, so no `error` SSE event is emitted and `controller.close()` never runs. The client gets a broken stream instead of a message. Anyone can trigger it with `{"fileData": {}}`.

**Fix.** Add `aj.protect()` mirroring the generation route (using `userRequest` as the prompt-injection input), and validate the body before touching it. Since you are adding `zod` anyway (P0-02), use it:

```ts
const BodySchema = z.object({
  workspaceId: z.string().min(1),
  userRequest: z.string().min(1).max(2000),
  fileData: z.object({
    files: z.record(z.string(), z.object({ code: z.string() })),
    dependencies: z.record(z.string(), z.string()).default({}),
    title: z.string().optional(),
  }),
});

const parsed = BodySchema.safeParse(await request.json());
if (!parsed.success) return Response.json({ message: "Invalid request" }, { status: 400 });
```

Do the same for `/api/gen-ai-code` (see P1-04).

---

# P1 — Fix before or right after launch

## P1-01 · Users pay monthly but only ever receive credits once

**File:** `lib/checkUser.ts` lines 24–49

Your pricing page sells **"50 generations / month"** and **"150 generations / month"**. The code has no monthly reset anywhere, and no Clerk billing webhooks. Credits are granted exactly once, as a one-time top-up of the *difference* between the old and new plan, and only when `checkUser()` happens to notice the plan changed:

```ts
const creditDelta = newPlanCredits - existingPlanCredits;
credits: creditDelta > 0 ? existing.credits + creditDelta : existing.credits,
```

So a Pro subscriber pays $29 in month one and gets 140 credits. In month two they pay $29 again and get **nothing**. That is a billing dispute, a chargeback, and — because you are advertising a monthly quota you do not deliver — a genuine problem with your payment provider.

The inverse is also exploitable: downgrades deliberately keep credits (fine), but the top-up is not idempotent per billing period, so a **downgrade → re-upgrade cycle grants the delta again**. They do pay each time, so it is not free money, but the accounting is wrong.

**Fix.** Add `creditsResetAt DateTime?` and `planPeriodStart DateTime?` to `User`, then wire **Clerk billing webhooks** (`subscription.created`, `subscription.updated`, `subscriptionItem.*`) to a `POST /api/webhooks/clerk` route that verifies the Svix signature and sets `credits = PLANS[plan].credits` at each period start. Do not rely on `checkUser()` running on a page load to notice billing changes — that is why it is wrong today. Until webhooks exist, change the marketing copy from "per month" to "one-time" so you are not selling something you do not ship.

## P1-02 · The improve feature's UI and server disagree about who can use it

**Files:** `app/api/improve/route.ts` line 41, `components/WorkspaceClient.tsx` lines 123–128, `components/CodePanel.tsx` line 292, `lib/constants.ts` lines 42–47

The server is Pro-only:

```ts
if (user.plan !== "pro") return Response.json({ message: "Upgrade required" }, { status: 403 });
```

The client tells a different story:

```ts
toast.error("Upgrade to Starter or Pro to use Improve with Bloom Agent.");
```

A Starter subscriber who reads that toast, pays $9, and comes back gets the same 403 with the same message telling them to upgrade to Starter. The Starter feature list in `lib/constants.ts` correctly omits the agent, so the toast is simply wrong.

**Fix.** Change the toast to "Upgrade to Pro…". Then decide whether the gate belongs on `plan` at all — Clerk features (`has({ feature: "bloom_agent" })`) are a better fit than hardcoded plan comparisons, because they survive plan renames.

## P1-03 · `PLANS[plan]` crashes the header on any unexpected plan value

**File:** `components/HeaderNav.tsx` line 100

```tsx
{credits} / {PLANS[plan].credits} credits
```

`plan` is a `String` column with no enum constraint, cast with `(user?.plan as Plan)` in `Header.tsx` — TypeScript is being told to trust a value that comes from the database. If it is ever anything other than `free`/`starter`/`pro` (a renamed Clerk plan, a manual DB edit, a future `team` tier, a capitalisation difference), `PLANS[plan]` is `undefined` and `.credits` throws — in the **root layout**, so every single page white-screens.

**Fix.** `PLANS[plan]?.credits ?? "—"`, and make `plan` a real Prisma `enum` so the database enforces the invariant.

## P1-04 · No size or shape validation on AI request bodies

**File:** `app/api/gen-ai-code/route.ts` lines 110–120, 74–102

The only validation is `if (!messages?.length)`. Everything else is cast and trusted:

```ts
const { workspaceId, userId, messages, fileData } = body as { ... };
```

Then the entire `fileData` object is serialised into the prompt:

```ts
text += "\n\nCurrent project files for context:\n" + JSON.stringify(fileData, null, 2);
```

A single request with a few megabytes of `messages` and `fileData` becomes a multi-million-token Gemini call. There is no length cap on prompts anywhere (neither textarea sets `maxLength`), no cap on message count beyond `trimHistory`, and no cap on `fileData` size. Cost per request is effectively unbounded and attacker-controlled, and one credit still only costs the user one credit.

**Fix.** Validate with zod (schema shape as in P0-10) plus hard caps: message content ≤ 4000 chars, ≤ 25 messages, `JSON.stringify(fileData).length` ≤ ~256 KB, and reject anything larger with a 413. Add `maxLength` to both textareas as a UX affordance, not as the enforcement.

## P1-05 · `messages` and `fileData` are written to the database unvalidated

**Files:** `app/api/gen-ai-code/route.ts` lines 253–269, `app/api/improve/route.ts` lines 192–207

Both routes cast to `never` to bypass Prisma's JSON typing and write client-supplied structures straight into Postgres:

```ts
messages: updatedMessages as never,
fileData: newFileData as never,
```

`updatedMessages` is the client's `messages` array plus the assistant reply — so a user can persist arbitrary JSON of arbitrary size into their own rows. It is their own data, so the impact is integrity and storage cost rather than a breach, but it means `parseMessages`/`parseFileData` on the read side are your only defence against a corrupt row breaking the workspace page. Note also that `fileData` in `/api/improve` is **whatever the client sent**, not what the database holds, so a client can overwrite its own saved project with anything.

**Fix.** Validate on write with the same zod schemas. In `/api/improve`, load `fileData` from the database instead of accepting it from the body — the server already knows the workspace id.

## P1-06 · Every page is dynamic because the root layout hits Clerk and the DB

**Files:** `app/layout.tsx` line 48, `components/Header.tsx` lines 7–8

`Header` is an async server component in the **root layout**, and it calls `checkUser()` — which calls `currentUser()`, `auth().has()`, and at least one Prisma query (sometimes a write) — on **every request to every route**. The build output confirms the cost:

```
┌ ƒ /                    <- your marketing page cannot be static
├ ƒ /sign-in/[[...sign-in]]
└ ƒ /workspace
ƒ (Dynamic)  server-rendered on demand
```

Consequences: your landing page has a database round-trip in its critical path, an anonymous visitor triggers Clerk and Prisma work, you cannot use the CDN for the page shell, and a database hiccup takes down the marketing site. It also means the new-user `create` path runs on whichever request lands first, which is the race in P0-04.

**Fix.** Move the authenticated part of the header into a client component that reads credits from a lightweight endpoint or a context, or move `<Header />` from the root layout into `app/(main)/layout.tsx` so only authenticated routes pay for it, and give the landing page its own static header. Then wrap it in `<Suspense>` so it streams instead of blocking. Do not call `checkUser()` (which writes) from a render path at all — trigger user creation from a Clerk `user.created` webhook instead, which pairs naturally with P1-01.

## P1-07 · 7 MB of unoptimised PNGs load as CSS backgrounds

**Files:** `public/*.png`, `app/page.tsx` lines 59 & 347

```
1.9M  public/bloom-bg-purple-dark.png
1.5M  public/bloom-bg-purple-dark2.png
1.7M  public/bloom-bg-purple.png
1.8M  public/bloomAiBG.png     <- not referenced anywhere
```

The two that are used are loaded via inline `style={{ backgroundImage: "url(...)" }}`, which bypasses `next/image` entirely — no WebP/AVIF conversion, no responsive sizes, no lazy loading, no priority hints. Your hero background is a 1.5 MB PNG in the LCP path. On mobile that is several seconds of blank purple.

**Fix.** Convert to AVIF/WebP (expect 100–200 KB each), render the hero background with `<Image fill priority />` instead of a CSS background, and delete `bloomAiBG.png` and `bloom-bg-purple.png` if they are genuinely unused.

## P1-08 · The entire landing page is a client component

**File:** `app/page.tsx` line 1

`"use client"` at the top of the marketing page means all of it — every feature card, every step, the whole pricing section, all the copy — ships as JavaScript and renders on the client. Only the prompt box and the rotating placeholder actually need interactivity.

This hurts the two things that matter most for a public launch: LCP (bundle must download and execute before content paints) and SEO (crawlers see a thinner initial document).

**Fix.** Keep `app/page.tsx` as a server component and extract the interactive prompt box into a small `"use client"` child (`<PromptHero />`). The feature/steps/pricing sections stay server-rendered.

## P1-09 · No error boundaries anywhere

**Files:** none exist

There is no `error.tsx`, `global-error.tsx`, `not-found.tsx`, or `loading.tsx` in the entire `app/` tree. Any thrown error in a server component (a Prisma timeout, the `PLANS[plan]` crash from P1-03) renders Next.js's default error page — in production, a bare "Application error: a server-side exception has occurred" with no branding, no recovery action, and no way for the user to get back.

Related: `getWorkspaceById` and `getWorkspaceUser` use `redirect("/")` for the not-found case. A user who opens a stale or deleted project link is bounced silently to the landing page with no explanation of what happened.

**Fix.** Add `app/error.tsx`, `app/global-error.tsx`, `app/not-found.tsx`, and `app/(main)/workspace/loading.tsx`. Use `notFound()` instead of `redirect("/")` in the actions so the 404 page can say "this project doesn't exist or you don't have access".

## P1-10 · The projects page loads every workspace's full message history

**File:** `actions/projects.ts` lines 23–52

```ts
const workspaces = await db.workspace.findMany({
  where: { userId: user.id },
  select: { id: true, title: true, createdAt: true, updatedAt: true, messages: true },
  orderBy: { updatedAt: "desc" },
});
```

`messages` is a full JSONB chat history per project, pulled over the wire **only** to compute `firstPrompt` (first 120 chars) and `messageCount` (an array length). There is no pagination and no limit. A user with 50 projects and long conversations transfers megabytes of JSON to render a grid of cards, on a page that is server-rendered on every visit.

**Fix.** Denormalise: add `firstPrompt String?` and `messageCount Int @default(0)` columns maintained on write, and drop `messages` from this select. Add `take`/`cursor` pagination. Add an index on `(userId, updatedAt desc)` to match the sort.

## P1-11 · No error tracking, no structured logging

**Files:** `app/api/gen-ai-code/route.ts` line 291, `app/api/improve/route.ts` line 225, `lib/checkUser.ts` line 63

Total observability is three `console.error` calls. Once this is deployed you have no idea when generation fails, how often Gemini returns invalid JSON, how often Arcjet blocks real users, whether credits are being deducted incorrectly, or that P0-04 is silently breaking every account — because that failure returns `null` and looks like a logged-out user.

**Fix.** Add Sentry (`@sentry/nextjs`, free tier is plenty) with `NEXT_PUBLIC_SENTRY_ENVIRONMENT` set per environment so staging noise stays separate from production. Log structured JSON with a request id from the API routes: `{ requestId, clerkId, route, event, durationMs, model, outcome }`. Add explicit counters for the failure modes you already know about: invalid JSON from Gemini, missing `files`, Arcjet denials, insufficient credits, abort.

## P1-12 · No security headers and no CSP

**File:** `next.config.ts`

`next.config.ts` only sets `serverExternalPackages`. There are no security headers at all: no `Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options`/`frame-ancestors`, `Referrer-Policy`, or `X-Content-Type-Options`. This matters more than usual here because the product's whole job is **running untrusted AI-generated code in the browser**, and it renders user-supplied image URLs and Markdown.

**Fix.** Add a `headers()` block in `next.config.ts`. Be aware a CSP needs to allowlist quite a lot for this app: Clerk (`*.clerk.accounts.dev` or your `clerk.yourdomain.com`, plus `script-src` and `worker-src`), Sandpack's bundler (`*.csb.app` in `frame-src`), `cdn.tailwindcss.com`, your Supabase storage domain in `img-src`, and Arcjet. Start with `Content-Security-Policy-Report-Only` so you can see what breaks before enforcing.

## P1-13 · No SEO or social metadata

**File:** `app/layout.tsx` lines 25–31

`metadata` has `title`, `description`, and an icon. Missing: `metadataBase` (so any relative OG URL resolves wrongly), `openGraph`, `twitter`, `robots`, and canonical URLs. There is no `robots.txt` and no `sitemap.ts`. A link to your product shared on X or WhatsApp will render as a bare URL with no title card.

Also: `icons.icon` points at `/logo-short.svg` while `app/favicon.ico` also exists — pick one.

**Fix.** Fill out `metadata` with `metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL!)`, an `openGraph` block with a 1200×630 image, and a `twitter` card. Add `app/robots.ts` and `app/sitemap.ts`. **Important:** set `robots: { index: false }` for your staging environment or Google will index it and compete with production.

## P1-14 · System theme is enabled but the app is hardcoded dark

**Files:** `app/layout.tsx` lines 42–47, `app/globals.css` lines 51–84

```tsx
<ThemeProvider attribute="class" defaultTheme="dark" enableSystem ...>
```

`enableSystem` means a visitor whose OS is set to light mode gets the `:root` (light) CSS variables. But the app's surfaces are hardcoded dark hex values — `bg-[#0a0a0a]`, `bg-[#0d0d0d]`, `text-white/80` — scattered through `page.tsx`, `WorkspaceClient`, `ChatPanel`, `CodePanel`, `ProjectCard`. So a light-mode user gets shadcn primitives (dialogs, dropdowns, toasts) rendering light-on-light against hardcoded dark panels: unreadable text in the pricing modal and toasts. There is no theme toggle in the UI, so they cannot escape it.

**Fix.** Either drop `enableSystem` and add `forcedTheme="dark"` (honest, one-line, matches the design), or do the real work of driving every surface from the CSS variables and add a toggle. Do the former now.

## P1-15 · The ZIP export produces a project that does not run

**File:** `components/CodePanel.tsx` lines 101–199

Four separate defects in one feature:

1. **It exports Sandpack's internal template files.** `filesToZip` is `sandpack.files` whenever it is non-empty — and it always is, because the `react` template seeds `/index.js`, `/package.json`, `/styles.css`, `/public/index.html`. Every one of those gets written under `src/`, so the user's download contains a junk `src/package.json` and `src/public/index.html` alongside their real code.
2. **`browserlist` is a typo** (line 135) for `browserslist`. The field is silently ignored.
3. **`URL.revokeObjectURL(url)` runs immediately after `a.click()`** (lines 192–193) with no `setTimeout` and without appending the anchor to the DOM. In Firefox and Safari this can revoke the blob before the download starts, so the file silently fails to save.
4. **React is pinned to `^18.2.0` but every other dependency is `"latest"`.** `BASE_DEPENDENCIES` sets ~20 packages to `latest`, several of which now require React 19. `npm install` in the exported project resolves peer-dependency conflicts or installs something that will not build.

**Fix.** Filter `filesToZip` to paths present in `fileData.files`; fix the `browserslist` spelling; wrap the revoke in `setTimeout(..., 1000)` and append/remove the anchor; and pin real version ranges in `BASE_DEPENDENCIES` instead of `latest` (which also makes Sandpack previews reproducible). Also swap the Tailwind CDN `<script>` for a real Tailwind setup, since `cdn.tailwindcss.com` prints a "not for production" console warning in every exported app.

## P1-16 · Preview error detection likely produces false positives

**File:** `components/CodePanel.tsx` lines 222–249

The listener treats **any** message of `type === "compile"` as an error:

```ts
if (msg.type === "compile") {
  const errMsg = "message" in msg && typeof msg.message === "string" ? msg.message : "Compile error in preview.";
  setPreviewError(errMsg);
  return;
}
```

In the Sandpack protocol `compile` is the message that carries a *compile request* — it is not inherently an error report (errors arrive as `action: "show-error"`, which the block above already handles correctly). So a normal recompile can raise the red "Preview error / Compile error in preview." banner. That banner's primary button is **"Fix with AI"**, which calls `onFixError` → `handleGenerate` → **spends a credit** on a problem that does not exist.

**Fix.** Drop the `compile` branch and rely on `show-error` plus explicit `msg.type === "action" && msg.action === "show-error"`. Verify against your installed `@codesandbox/sandpack-react` version by logging every message type once. Independently, add a confirmation to "Fix with AI" since it costs a credit, and show the credit cost on the button.

## P1-17 · No tests and no CI

**Files:** none exist

Zero test files, no test runner in `package.json`, no `.github/workflows/`. Nothing prevents a regression on any of the P0s above — in particular, the credit-deduction and ownership logic are exactly the kind of code that needs a test, because the failure mode is silent and financial.

**Fix.** This is the highest-leverage item after the P0s, and you need it before you can safely run three environments. Add Vitest plus a GitHub Actions workflow running `tsc --noEmit`, `eslint`, `npm run build`, and tests on every PR. Cover, at minimum: an unauthenticated request to each API route returns 401; a request with someone else's `userId` cannot touch their workspace or credits (the P0-01 regression test); concurrent generations cannot push credits below zero; a non-Pro user gets 403 from `/api/improve`; `deleteProject` cannot delete another user's workspace. Details in `DEPLOYMENT_GUIDE.md`.

## P1-18 · ESLint reports 2 errors

**Files:** `components/HeaderNav.tsx` line 29, `components/PreviewFullscreen.tsx` line 79

Both are `react-hooks/set-state-in-effect` — calling `setState` synchronously in an effect body, which causes a cascading double render:

- `HeaderNav`: `setPastHero(false)` when not on the landing page. This should be derived during render, not set in an effect (`pastHero` is only meaningful when `isLanding`).
- `PreviewFullscreen`: `setFileData(fromStorage.fileData)` reading `sessionStorage` on mount, which makes the fullscreen preview render once with server data and then immediately re-render with session data — a visible flash and a full Sandpack remount.

`next build` does not run ESLint in Next 16, so these do not block today. They will block the moment you add lint to CI (which you should, per P1-17).

**Fix.** Derive `transparentNav` from `isLanding && !pastHero` without the reset effect. In `PreviewFullscreen`, read `sessionStorage` in a `useState` initialiser (guarded for SSR) or `useSyncExternalStore` instead of an effect.

---

# P2 — Cleanup

## P2-01 · Dead code and unused dependencies

- `components/animate-ui/components/backgrounds/hole.tsx` — **425 lines, imported nowhere.** It is the only consumer of the `motion` package (~100 KB). Delete both.
- `xod@1.11.3` — unused typo dependency (see P0-02).
- `shadcn@^4.11.0` is in `dependencies`, but it is a CLI. It is only referenced by `@import "shadcn/tailwind.css"` in `globals.css`, which is build-time only. Move it to `devDependencies`.
- `onFilePatch` is passed from `WorkspaceClient` to `CodePanel`, destructured as `_onFilePatch`, and **never used**. `handleFilePatch` in `WorkspaceClient` is therefore dead too. Remove both.
- `components/ChatPanel.tsx` lines 63–79: `msgs` and `statuses` are leftover hardcoded mock data. Delete.
- `app/layout.tsx`: `Geist`, `Geist_Mono`, `Inter`, `cn`, `Variable` (from lucide!), and `Toast` (from `@base-ui/react`) are all imported and unused.
- `lib/constants.ts`: `MIN_CREDITS_TO_GENERATE` and `CREDIT_COST_PER_GENERATION` are both `1` and used interchangeably (client uses one, server the other). Collapse to one constant.
- `PRICING_PLANS` is entirely unused — the UI renders Clerk's `<PricingTable />`. Delete it or wire it up; leaving stale plan IDs in the repo is how P0-06 hides.
- `public/bloomAiBG.png` (1.8 MB) and `public/bloom-purple.png` are not referenced.

## P2-02 · Typos and copy bugs

- `components/ChatPanel.tsx` line 357: **`placeholdeer:text-white/20`** — the placeholder styling has never applied.
- `components/ChatPanel.tsx` line 349: `"Upgrading to keep building..."` → should be `"Upgrade to keep building…"`.
- `components/ChatPanel.tsx` line 351: `"CLine is improving your app..."` → `"Cline"`.
- `components/CodePanel.tsx` line 135: `browserlist` → `browserslist` (see P1-15).
- `app/globals.css` line 11: `--font-mono: var(--font-geist-mono)` references a variable that is never defined, because `Geist_Mono` is imported but never instantiated. Any `font-mono` class falls back to the browser default.

## P2-03 · False claims in the marketing copy

`lib/data.ts` promises things the app does not do. These are the ones a user will notice within a minute of signing up:

- `"Edit directly in the built-in editor and watch the preview update in real time"` (line 39) — `SandpackCodeEditor` is `readOnly` (`components/CodePanel.tsx` line 427). The editor cannot be edited.
- `"Open in CodeSandbox, copy the source, and deploy to a live URL"` (line 77) — `showOpenInCodeSandbox={false}` (line 401). There is no deploy flow at all.
- `"10 generations / month"`, `"50 generations / month"`, `"150 generations / month"` in `lib/constants.ts` — no monthly reset exists (P1-01).

Fix the copy or build the features. Do not ship a paid page that overstates what a user gets.

## P2-04 · Deleting a project has no confirmation

**File:** `components/ProjectCard.tsx` lines 26–31 & 57–65

A single click on the trash icon permanently deletes a project. No confirm dialog, no undo, no soft delete — and `deleteProject` does a hard `deleteMany`. The button sits at `absolute right-2 top-2` on a card whose whole body is a link, so a misclick while opening a project destroys work.

**Fix.** Add a confirmation dialog (you already have `components/ui/dialog.tsx`). Consider `deletedAt` soft deletes so accidental deletions are recoverable.

## P2-05 · Regenerating never updates a project's title

**File:** `app/api/gen-ai-code/route.ts` lines 254–261

The `create` branch sets `title`. The `update` branch writes only `messages` and `fileData`. So a project titled "Todo List App" that the user iterates into a full CRM keeps the original title forever on the projects page, even though `fileData.title` (which the workspace header reads) does update. The two disagree.

**Fix.** Add `title: aiTitle ?? undefined` to the update branch.

## P2-06 · Arcjet runs on every request, including static pages

**Files:** `proxy.ts` lines 22–48

The middleware matcher covers essentially every route, and `aj.protect(req)` runs shield + bot detection on all of them — the landing page, sign-in, every navigation. That is an Arcjet request (quota and cost) plus added latency on every page view, mostly to protect static marketing content.

`detectBot` in `LIVE` mode allows only `CATEGORY:SEARCH_ENGINE` and `CATEGORY:PREVIEW`. That will **block uptime monitors, curl-based health checks, and RSS/metadata fetchers** with a 403. Worth knowing before you wire up monitoring and wonder why it reports you as down.

**Fix.** Narrow the matcher so Arcjet only covers `/api/*` and authenticated routes, or call `aj.protect` conditionally inside the middleware. Add `CATEGORY:MONITOR` to the allow list before setting up uptime checks.

## P2-07 · SSE responses lack proxy-buffering protection

**Files:** `app/api/gen-ai-code/route.ts` lines 303–309, `app/api/improve/route.ts` lines 238–244

Both stream responses set `Content-Type: text/event-stream`, `Cache-Control: no-cache`, and `Connection: keep-alive`, but not `X-Accel-Buffering: no`. Some proxies buffer the whole response, which turns your live status updates into a single dump at the end — the user stares at a spinner with no progress for 60 seconds. Vercel handles streaming correctly, so this is insurance for other hosts and any CDN in front.

Also add `Content-Type` charset and consider a periodic heartbeat comment (`: ping\n\n`) to keep intermediaries from timing out an idle stream during long Gemini thinking pauses.

## P2-08 · Conversation history is silently truncated to 9 messages

**File:** `app/api/gen-ai-code/route.ts` lines 44–47

```ts
function trimHistory(messages: Message[]): Message[] {
  if (messages.length <= 10) return messages;
  return [messages[0], ...messages.slice(-8)];
}
```

Past 10 messages the middle of the conversation is dropped with no indication to the user, while the marketing copy says "AI remembers the full conversation" (`lib/data.ts` line 72). On a long iteration session the model forgets constraints the user set earlier and starts undoing them. Token-count-based trimming with a summary of the dropped span would behave much better — and the copy should not promise full recall.

## P2-09 · The prompt is lost if you sign in from the landing page

**File:** `app/page.tsx` lines 34–37 & 109–116

A signed-out visitor types a prompt and clicks Generate, which opens Clerk's modal. After sign-in Clerk navigates, the page remounts, and **the prompt state is gone**. The user has to retype it — at the exact moment you are trying to convert them.

**Fix.** Persist the prompt to `sessionStorage` before opening the modal and rehydrate on mount, or pass it through Clerk's `forceRedirectUrl` as `/workspace?prompt=...`.

## P2-10 · The preview tab is force-switched on every generation

**File:** `components/CodePanel.tsx` lines 264–266

```ts
useEffect(() => { if (fileData) setActiveTab("preview"); }, [fileData]);
```

Any `fileData` change yanks the user back to Preview. A user reading the generated code in the Code tab who sends a follow-up prompt gets thrown out of the file they were reading. Only switch on the *first* successful generation.

## P2-11 · Documentation is stale or boilerplate

- `README.md` is the **untouched `create-next-app` template**. It tells a new contributor (or future you) nothing: no setup steps, no required env vars, no Supabase bucket setup, no migration commands, no deploy process. This is the single cheapest high-value fix in this document.
- `PROJECT_OVERVIEW.md` is genuinely good but has drifted: it does not mention `app/preview/page.tsx`, `components/PreviewFullscreen.tsx`, or `lib/sandpack.ts`; it lists `zod` under "AI And Agent System" as though it were declared (it is not); and it says `xod` "appears in package.json but is not used" without flagging it as the typo it is.

## P2-12 · Minor code-quality items

- `actions/workspace.ts` has **no `"use server"` directive**, unlike `actions/projects.ts`. It works because only server components import it, but the inconsistency invites someone to import it from a client component later and get a confusing failure.
- `db.workspace.findUnique({ where: { id, userId } })` in `actions/workspace.ts` line 24 relies on Prisma allowing non-unique filters inside `findUnique`. It works, but `findFirst` expresses the intent more clearly.
- `prisma/schema.prisma`: `plan` should be an `enum`, not `String` (see P1-03). `Workspace` has no index matching its most common sort (`userId, updatedAt desc`). There is no versioning or snapshot of `fileData`, so a bad generation overwrites the previous good one with no way back — worth a `WorkspaceVersion` table before users have work worth losing.
- `app/api/gen-ai-code/route.ts` lines 276–279 and `improve` 209–212: after the `$transaction`, a **separate** `findUnique` re-reads credits. Use the transaction's return value instead — the extra round-trip can read a value another concurrent request already changed.
- `app/api/gen-ai-code/route.ts` line 128 onward has inconsistent indentation (the Arcjet block is indented as if nested inside something).
- `validateDependencies` (line 26) fires unbounded parallel `fetch` calls to `registry.npmjs.org` with a 1500 ms timeout and **silently drops** any package that times out. On a slow network the user gets an app whose imports were quietly removed, with no explanation. Add a concurrency cap, cache results, and report dropped packages in the assistant message.
- Generated code is sent to **CodeSandbox's hosted bundler** (`*.csb.app`) for every preview. That is a third-party availability and privacy dependency on your critical path that is worth documenting — if `csb.app` is down, your product appears broken, and your users' code transits a service you do not control.
- Neither textarea sets `maxLength` (see P1-04).

---

# Fix order

**Before you deploy anything public** (the P0s, roughly in dependency order):

1. **P0-02** — `npm uninstall xod && npm install zod`. Five minutes, unblocks a clean CI install.
2. **P0-01** — stop trusting `userId` from the body in `/api/gen-ai-code`. This is the security fix.
3. **P0-03** — atomic credit reservation via `updateMany` + `gte` guard.
4. **P0-07** — stop swallowing SSE error events. Without this you are blind to everything else.
5. **P0-08** — delete the shadowed `AbortController`.
6. **P0-10** — zod-validate both route bodies; add Arcjet to `/api/improve`.
7. **P0-09** — move image upload server-side; lock the Supabase bucket down.
8. **P0-04** — `upsert` in `checkUser`, decide the `email` uniqueness question, stop returning `null` on error.
9. **P0-05** — `prisma migrate deploy` in the build.
10. **P0-06** — the Clerk production migration (see `DEPLOYMENT_GUIDE.md`; do this last, after staging works end to end).

**Then, in the first week after launch:** P1-01 (billing webhooks and credit resets — the sooner the better, since every day without it is a day of customers paying for credits they do not receive), P1-11 (Sentry), P1-17 (CI and the ownership/credit regression tests), P1-09 (error boundaries), P1-03, P1-14, P1-02.

**Then:** the performance set (P1-06, P1-07, P1-08, P1-10) and the rest.

For environment setup, the Clerk dev→production migration, and the deploy pipeline, see `DEPLOYMENT_GUIDE.md`.
