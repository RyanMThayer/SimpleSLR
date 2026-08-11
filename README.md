# SimpleSLR

A free, collaborative web app for systematic literature reviews in coursework and research. It supports a light PRISMA process plus Webster and Watson: title and abstract screening built for speed, deduplication, snowballing, a concept matrix, and an automatically computed PRISMA 2020 flow diagram.

Full product and build plan: [docs/PLAN.md](docs/PLAN.md). First time setup (Supabase, Google sign in, Vercel): [SETUP.md](SETUP.md).

## Stack

- Next.js (App Router, TypeScript, Tailwind) on Vercel
- Supabase: Postgres, auth (email and password; Google sign in optional later), row level security, realtime
- OpenAlex API for snowballing lookups (free, no key)

## Local development

```bash
npm install
cp .env.example .env.local   # fill in the two Supabase values
npm run dev
```

The app runs without the environment variables set, but shows a "backend not configured" notice instead of the sign in button.

## Status

Phase 0: deployed skeleton with email and password sign in. See docs/PLAN.md for the phase roadmap.
