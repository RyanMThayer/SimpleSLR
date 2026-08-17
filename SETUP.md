# SimpleSLR first time setup

One time setup, about 15 minutes total. Everything is free. Do the steps in order; later steps use values from earlier ones. Menu labels occasionally change in these dashboards, but the flow stays the same.

Sign in is email and password through Supabase. No Google OAuth is needed; adding Google sign in later is described at the bottom as an optional extra.

## 1. Supabase project (~5 minutes)

1. Go to [supabase.com](https://supabase.com) and sign up with your GitHub account.
2. Create a new project. Name: `simpleslr`. Region: **Frankfurt (eu-central-1)**. Set a database password and store it in your password manager (you rarely need it, but losing it is annoying).
3. Wait a minute or two for the project to provision.
4. In the project's settings, find the API section (Project Settings, then "Data API" / "API Keys") and copy two values somewhere handy:
   - **Project URL** (looks like `https://abcdefgh.supabase.co`)
   - **Publishable key** (starts with `sb_publishable_`; the legacy `anon` `public` key also works)

   Both are designed to be public, so it is safe to paste them in chat or commit them to Vercel settings.

## 2. Email sign in settings (~2 minutes)

1. In Supabase, open **Authentication**, then the sign in providers section (labeled "Sign In / Providers" or similar). **Email** is enabled by default; leave it on.
2. In the Email provider's settings, turn **off** "Confirm email", then save.

With confirmation off, creating an account signs you in immediately and Supabase never needs to send an email, which sidesteps the free tier's email rate limits entirely. The tradeoff: anyone who finds the URL can create an account. That is fine for an internal tool, and review data will be invite only per project once projects exist in Phase 1.

## 3. Vercel deployment (~5 minutes)

1. Go to [vercel.com](https://vercel.com) and sign up with your GitHub account (Hobby plan).
2. "Add New..." then "Project", and import the **SimpleSLR** repository.
3. Before clicking Deploy, expand **Environment Variables** and add both values from step 1.4:
   - `NEXT_PUBLIC_SUPABASE_URL` = your Project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = your publishable key
4. Click **Deploy**. After a minute you get your URL, something like `https://simple-slr.vercel.app`. Note it down.

Already deployed before setting the variables? Add them under the project's **Settings, then Environment Variables** (apply to all environments). Variables are baked in at build time, so trigger a new build afterward: either push any commit, or open the **Deployments** tab, click the three dot menu on the latest deployment, and choose **Redeploy**.

## 4. Tell Supabase about your URL (~2 minutes)

In Supabase, open Authentication settings, then **URL Configuration**:

- **Site URL**: your Vercel URL, e.g. `https://simple-slr.vercel.app`
- **Redirect URLs**, add both:
  - `https://simple-slr.vercel.app/auth/callback` (your real URL)
  - `http://localhost:3000/auth/callback` (for local development)

Password sign in does not strictly need these, but future features (password reset emails, OAuth) do, so set them now while you are here.

## 5. Database schema (Phase 1, ~2 minutes)

The review features (projects, import, screening) need tables in your database. In Supabase, open the **SQL Editor** (left sidebar), click **New query**, paste the entire contents of `supabase/migrations/0001_phase1.sql` from this repository, and click **Run**. It should end with "Success. No rows returned". The script is safe to run more than once.

## 6. Test it

Open your Vercel URL. You should see the SimpleSLR landing page with a Sign in button (not the yellow "backend not configured" notice). Click Sign in, choose "No account yet? Create one", and register with your email and a password of at least 6 characters. You should land on the dashboard showing your email address. If anything fails, copy the error shown and the URL you ended up on; that is enough to diagnose it.

## Later, optional

### Custom domain

Buy one at Porkbun or Cloudflare (~$10 to 12 per year), add it in Vercel's domain settings, follow the DNS instructions, then update step 4's URLs to match.

### Google sign in (~15 minutes)

Worth adding if the team prefers one click sign in. The app code needs a small change too (ask Claude to restore the Google button).

1. In Supabase's provider settings, toggle the **Google** provider on but do not save yet. Copy the **Callback URL** it shows (looks like `https://abcdefgh.supabase.co/auth/v1/callback`). Keep this tab open.
2. Go to [console.cloud.google.com](https://console.cloud.google.com), sign in, and create a new project named `SimpleSLR` (no organization).
3. Search for **"OAuth consent screen"**. Configure it: audience **External**, app name `SimpleSLR`, support email and developer contact set to your Gmail address, and add no scopes beyond the defaults (name, email, profile).
4. Publish the app: change status from "Testing" to **"In production"**. Because only basic scopes are used, Google requires no verification review and any Google account can sign in.
5. Search for **"Credentials"**, click "Create credentials", then **"OAuth client ID"**: application type **Web application**, name `SimpleSLR web`, and paste the Supabase Callback URL from step 1 into **Authorized redirect URIs**.
6. Copy the **Client ID** and **Client secret** into the Supabase Google provider settings and save. The secret stays in Supabase; it never goes into the code or into Vercel.

### Teammates

Teammates need no setup at all. They just open the site and create an account.
