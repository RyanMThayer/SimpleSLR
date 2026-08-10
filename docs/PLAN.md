# Build Plan: Collaborative SLR Platform

A free, team based web app for running systematic literature reviews in your e-government coursework. It covers a light PRISMA process plus Webster and Watson (concept matrix and snowballing), replacing the shared spreadsheet with a tool that has real ownership, a screening interface built for speed, and automatic PRISMA counts.

Decisions already made: multi project platform (reusable across classes, teammates can create their own reviews), Google sign in, free subdomain first with a custom domain possible later, and no AI assisted screening at any point. All screening decisions are made by humans and attributed to them.

## 1. Why this beats the spreadsheet

The three problems you named map directly to features:

**Little ownership.** Every record gets assigned to a named reviewer. Every decision is stamped with who made it and when. A project dashboard shows per person progress bars, so "who has not done their screening" is visible at a glance instead of being buried in a column of initials.

**Hard to view hundreds of records.** Screening happens one record per screen: large title, full abstract, keyboard shortcuts to decide and advance. No horizontal scrolling, no squinting at truncated cells. A filterable table view still exists for overview and auditing, but it is the secondary view, not the working surface.

**Title and abstract screening wastes the most time.** This stage gets the most design attention: single keystroke decisions, keyword highlighting in the abstract, an undo key, and a queue that only shows you your own unfinished records. Screening a record should take seconds, and the tool should never make you hunt for the next one.

## 2. The workflow the app supports

The app models the review as a pipeline. Records move through stages, and the PRISMA numbers fall out of the data automatically.

1. **Project setup.** Research question, inclusion and exclusion criteria, the list of databases and search strings used, and the project's exclusion reason list (e.g. "not e-government", "not peer reviewed", "wrong language").
2. **Import.** Upload exports from Scopus, Web of Science, and IEEE Xplore as RIS, BibTeX, or CSV. The parser extracts title, authors, year, venue, abstract, DOI, and URL, and tags each record with its source database and search run. Raw counts per source are recorded for the PRISMA diagram.
3. **Deduplication.** Automatic matching on DOI (exact) and normalized title plus year (fuzzy). Confident matches merge automatically; uncertain pairs go to a short review queue where a human confirms or rejects the merge. This is the union find approach you already used manually, built in.
4. **Title and abstract screening.** The centerpiece. Records are split among reviewers, each person works through their queue, and every decision (include, exclude with reason, maybe) is logged. Optional dual screening mode: two reviewers screen the same records blind, disagreements surface in a conflicts view for discussion.
5. **Full text screening.** Same interface, now with a link or uploaded PDF per record. Exclusions at this stage require a reason, because PRISMA 2020 wants full text exclusion reasons reported with counts.
6. **Snowballing (Webster and Watson).** For each included paper, backward snowballing (its references) and forward snowballing (papers citing it). The app can pull both lists automatically from the free OpenAlex API by DOI, so you check candidates off a list instead of copying references by hand. Selected candidates enter the same dedup and screening pipeline, tracked as a separate identification source so the PRISMA diagram reports them in the "identification via other methods" column.
7. **Concept matrix (Webster and Watson).** Define your concepts as columns; included papers are the rows. Cells are toggles with an optional note. Sortable, filterable, and exportable to Excel for the paper.
8. **Outputs.** PRISMA 2020 flow diagram with live counts, exportable as SVG and PNG. Included set as RIS, BibTeX, or CSV (Zotero ready). Concept matrix as XLSX. A full screening log (every decision, reviewer, reason, timestamp) as CSV for the appendix. A one click export of the entire project as JSON, which doubles as your backup.

## 3. The screens

- **Home.** Your projects, invitations, and a button to create a new review.
- **Project dashboard.** Pipeline status, per reviewer progress, PRISMA counts so far, recent activity.
- **Import.** Drag and drop files, per file parse report (records found, fields missing), source tagging.
- **Dedup review.** Side by side pairs, merge or keep both, one keystroke each.
- **Screening room.** The one record per screen interface used for both screening stages. Keyboard: I include, E exclude (then pick a reason), M maybe, U undo, arrow keys navigate. Include and exclude keywords defined in project settings are highlighted in the title and abstract in green and red.
- **Conflicts.** Only in dual screening mode: records where reviewers disagreed, with both decisions shown, resolved by discussion and a final call.
- **Snowball.** Per included paper: fetched reference and citation lists with checkboxes, plus manual entry for anything OpenAlex misses.
- **Concept matrix.** The Webster and Watson grid.
- **PRISMA and exports.** The diagram plus all download buttons.
- **Project settings.** Criteria, exclusion reasons, keywords, members and roles (owner, reviewer), screening mode (single or dual).

## 4. Architecture and stack

- **Frontend and hosting:** Next.js (TypeScript, Tailwind) deployed on Vercel's free Hobby plan. The Hobby plan is for non commercial use, which a class tool is, and its limits (100 GB bandwidth per month) are far beyond what a handful of student teams will use.
- **Database, auth, and realtime: Supabase** free tier. Postgres with row level security so each project's data is only visible to its members, built in Google sign in, and realtime subscriptions so progress bars and conflict lists update live while teammates work.
- **Snowballing data: OpenAlex API.** Free, no API key required, 100,000 credits per day, covers references and citing works by DOI.
- **Reference parsing:** RIS and BibTeX parsed in the app (RIS is a simple line based format; existing JS libraries cover BibTeX). CSV import with a column mapping step for database specific quirks.

Honest caveats with this stack, so nothing surprises you later:

1. **Supabase free projects pause after one week of inactivity.** During the semester this never triggers; between semesters it will, and restoring is one click in the Supabase dashboard (takes about a minute). The free tier also allows only two active projects per account, which is why the app is multi project inside one Supabase project rather than one per review.
2. **The free tier has no automatic backups.** Mitigation is built in: the export everything button produces a complete JSON snapshot, and we make exporting after each screening session a habit. Your thesis data should never live in only one place anyway.
3. **OpenAlex coverage is very good but not identical to Scopus or Web of Science.** Snowballing assist is a convenience layer; for methods rigor you can still note that candidate lists were verified against the databases.
4. **Vercel Hobby is single seat.** Only you deploy, which is fine since teammates use the site, not the Vercel account.

### Data model (summary)

profiles, projects, project_members (role), search_sources (database, query, date, raw count), records (metadata plus origin), dedup_decisions, screening_decisions (record, stage, reviewer, decision, reason, timestamp), assignments, exclusion_reasons, snowball_edges (from paper, to paper, backward or forward), concepts, concept_cells, activity_log. PRISMA counts are computed from these tables, never entered by hand.

## 5. Build phases

**Phase 0: Foundation.** Accounts (your part, see section 6), project scaffold, Google sign in working, deployed skeleton on the vercel.app subdomain. Deploying first means every later phase ships continuously.

**Phase 1: Screening MVP.** Create project, invite members, import RIS/BibTeX/CSV, dedup, title and abstract screening with assignments and progress dashboard. At the end of this phase the tool already replaces the spreadsheet for its most painful job, and your team can start using it.

**Phase 2: Complete PRISMA.** Full text stage with exclusion reasons, live PRISMA 2020 diagram, all exports (RIS, BibTeX, CSV, screening log, full JSON backup).

**Phase 3: Webster and Watson.** Snowballing with OpenAlex lookup and manual entry, concept matrix with XLSX export.

**Phase 4: Polish.** Dual screening with conflict resolution, inter rater agreement (Cohen's kappa, a nice number to report in a methods section), activity log, realtime presence, keyboard shortcut help overlay.

Since I write the code, each phase is roughly one to two working sessions. Realistically you can have the Phase 1 MVP in your team's hands within days of starting, with the rest following over the next week or two as we test it on real records.

## 6. What I need from you

Everything below is free. Total setup time is about 30 to 45 minutes, and only the Google OAuth step has any fiddliness. I will give you exact click by click steps when we do each one; this is the overview so you know what accounts you are creating and why.

1. **GitHub account** (if you do not have one). Holds the code repository. Vercel and Supabase both sign in with it, so it is the root account. Create a repository (e.g. `slr-platform`).
2. **Vercel account.** Sign up with GitHub, import the repository. Every push then deploys automatically to your free `something.vercel.app` URL. Nothing else to configure at signup.
3. **Supabase account.** Sign up with GitHub, create one project (choose the Frankfurt region, closest to you). You will paste two values into Vercel's environment variables: the project URL and the anon key. Both are designed to be public, so sharing them with me in chat is safe.
4. **Google OAuth credentials** (about 15 minutes, the one fiddly step). In Google Cloud Console: create a project, configure the OAuth consent screen as External with only the basic scopes (name, email, profile), create a web OAuth client, paste in the callback URL that Supabase gives you, and publish the app to production. Because only basic scopes are used, Google requires no verification review, there is no 100 test user cap, and any Google account can sign in immediately. The client ID and secret go into the Supabase dashboard, not into the code, so you keep the secret and I never need it.
5. **Domain: nothing now.** The vercel.app subdomain is the launch address. If you later want a custom domain, it is roughly $10 to 12 per year at a registrar like Porkbun or Cloudflare, plus about 10 minutes of DNS setup, with no changes to the app.

### How we work together

I build and test everything in my cloud workspace, then commit the code into your connected SLR Website folder. From there, two options:

- **Simple:** you push to GitHub from that folder with a couple of terminal commands whenever I hand you a batch, and Vercel deploys it. You stay in full control of what ships.
- **Faster:** you create a fine grained GitHub access token scoped to just this one repository and share it with me, and I push directly, so deploys happen without you in the loop. The token can be revoked anytime.

Either works; we can start simple and switch if the handoffs get tedious.

## 7. Costs

| Item | Cost |
|---|---|
| Vercel Hobby hosting | $0 |
| Supabase free tier | $0 |
| OpenAlex API | $0 |
| Google OAuth | $0 |
| GitHub | $0 |
| Custom domain (optional, later) | ~$10 to 12 per year |

The only scenario that would ever cost money is the tool growing far beyond a few class teams, and the free tier ceilings (500 MB database, 50,000 monthly active users on auth, 100 GB bandwidth) are so far above coursework scale that this is not a planning concern.

## 8. Open questions for when we build

None of these block starting; defaults are noted.

- **Screening mode default:** single reviewer per record (fast, common for course level reviews) or dual screening from the start? Default: single, with dual available per project in settings.
- **Maybe pile handling:** do "maybe" records go to a second pass by the same reviewer or get decided in a team session? Default: they stay in the queue and the dashboard nags about them.
- **PDF storage for full text screening:** links only, or upload PDFs into Supabase storage (1 GB free)? Default: links first, uploads in Phase 2 if wanted.
- **A name.** The repository needs one and the login page will show it. Working title is "slr-platform" until you pick something better.
