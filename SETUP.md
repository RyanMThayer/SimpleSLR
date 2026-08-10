# SimpleSLR first time setup

One time setup, about 30 to 45 minutes total. Everything is free. Do the steps in order; later steps use values from earlier ones. Menu labels occasionally change in these dashboards, but the flow stays the same.

## 1. Supabase project (~5 minutes)

1. Go to [supabase.com](https://supabase.com) and sign up with your GitHub account.
2. Create a new project. Name: `simpleslr`. Region: **Frankfurt (eu-central-1)**. Set a database password and store it in your password manager (you rarely need it, but losing it is annoying).
3. Wait a minute or two for the project to provision.
4. In the project's settings, find the API section (Project Settings, then "Data API" / "API Keys") and copy two values somewhere handy:
   - **Project URL** (looks like `https://abcdefgh.supabase.co`)
   - **Anon / publishable key** (a long string; may be labeled `anon` `public` or start with `sb_publishable_`)

   Both are designed to be public, so it is safe to paste them in chat or commit them to Vercel settings.

## 2. Google OAuth credentials (~15 minutes, the fiddly one)

1. In Supabase, open Authentication settings and find the **Google** provider (under "Sign In / Providers"). Toggle it on but do not save yet. Copy the **Callback URL** it shows (looks like `https://abcdefgh.supabase.co/auth/v1/callback`). Keep this tab open.
2. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in with your Google account. Accept the terms if this is your first visit.
3. Create a new project (top bar, project picker, "New project"). Name: `SimpleSLR`. No organization.
4. With the project selected, search for **"OAuth consent screen"** (also called "Google Auth Platform" branding). Configure it:
   - Audience / user type: **External**
   - App name: `SimpleSLR`
   - Support email: your Gmail address
   - Developer contact: your Gmail address
   - Scopes: add nothing. The defaults (name, email, profile) are all the app uses.
5. Publish the app: on the consent screen page, change status from "Testing" to **"In production"** (sometimes labeled "Publish app"). Because only basic scopes are used, Google requires no verification review and any Google account can sign in.
6. Search for **"Credentials"** (under APIs & Services). Click "Create credentials", then **"OAuth client ID"**:
   - Application type: **Web application**
   - Name: `SimpleSLR web`
   - Authorized redirect URIs: paste the Supabase **Callback URL** from step 2.1
7. Copy the **Client ID** and **Client secret** it shows you.
8. Back in the Supabase tab: paste the Client ID and Client secret into the Google provider settings and save. The secret stays in Supabase; it never goes into the code or into Vercel.

## 3. Vercel deployment (~5 minutes)

1. Go to [vercel.com](https://vercel.com) and sign up with your GitHub account (Hobby plan).
2. "Add New..." then "Project", and import the **SimpleSLR** repository.
3. Before clicking Deploy, expand **Environment Variables** and add both values from step 1.4:
   - `NEXT_PUBLIC_SUPABASE_URL` = your Project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = your anon / publishable key
4. Click **Deploy**. After a minute you get your URL, something like `https://simpleslr.vercel.app`. Note it down.

## 4. Tell Supabase about your URL (~2 minutes)

In Supabase, open Authentication settings, then **URL Configuration**:

- **Site URL**: your Vercel URL, e.g. `https://simpleslr.vercel.app`
- **Redirect URLs**, add both:
  - `https://simpleslr.vercel.app/auth/callback` (your real URL)
  - `http://localhost:3000/auth/callback` (for local development)

## 5. Test it

Open your Vercel URL. You should see the SimpleSLR landing page with a Sign in button (not the yellow "backend not configured" notice). Click Sign in, continue with Google, and you should land on the dashboard showing your email address. If anything fails, copy the error shown and the URL you ended up on; that is enough to diagnose it.

## Later, optional

- **Custom domain**: buy one at Porkbun or Cloudflare (~$10 to 12 per year), add it in Vercel's domain settings, follow the DNS instructions, then update step 4's URLs to match.
- **Teammates need no setup at all.** They just open the site and sign in with Google.
