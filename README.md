# Grape Governance Notifier (GitHub Actions Cron)

Serverless Discord notifier for SPL Governance proposals using Shyft GraphQL.

It posts to a Discord channel when:
- A new proposal is created
- A proposal moves into voting state

Supports one or many DAO realms in the same channel.

## Architecture

- `api/cron.ts`: Vercel cron HTTP function
- `.github/workflows/cron.yml`: GitHub Actions scheduled runner
- `src/runner.ts`: proposal fetch + state transition logic
- State persistence:
  - `redis` (recommended on Vercel, persistent)
  - `file` (local-only fallback)

## Required Environment Variables

- `DISCORD_BOT_TOKEN`
- `DISCORD_CHANNEL_ID`

For persistent state via Upstash Redis:
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

## DAO Target Configuration

Use `DAO_TARGETS` (semicolon-separated):

```env
DAO_TARGETS=By2sVGZXwfQq6rAiAM3rNPJ9iQfb5e2QhnF4YjJ4Bip@GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw@Grape DAO;66Du7mXgS2KMQBUk6m9h3TszMjqZqdWhsG3Duuf69VNW@J9uWvULFL47gtCPvgR3oN7W357iehn5WF2Vn9MJvcSxz@Orca
```

Format per target:
- `REALM_PUBKEY@PROGRAM_NAMESPACE@OPTIONAL_LABEL`

If `DAO_TARGETS` is empty, it falls back to:
- `REALM_PUBKEY`
- `GOV_PROGRAM_NAMESPACE`

## Local Run

```bash
npm install
cp .env.example .env
npm run dev
```

`npm run dev` runs one cron cycle locally (no Discord gateway process).

## GitHub Actions Cron (Recommended)

1. Push this repo to GitHub.
2. In GitHub, open `Settings -> Secrets and variables -> Actions`.
3. Add secrets (same names as `.env.example`), at minimum:
   - `DISCORD_BOT_TOKEN`
   - `DISCORD_CHANNEL_ID`
   - `DAO_TARGETS` (or `REALM_PUBKEY` + `GOV_PROGRAM_NAMESPACE`)
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
4. Workflow is at [.github/workflows/cron.yml](/Users/kirk/Development/grape-governance-discord-bot/.github/workflows/cron.yml):
   - Scheduled hourly: `0 * * * *`
   - Manual run: `workflow_dispatch`

## Optional Vercel Deploy

Vercel cron is disabled in [vercel.json](/Users/kirk/Development/grape-governance-discord-bot/vercel.json) to avoid duplicate notifications when GitHub Actions is enabled.
You can still deploy `api/cron` as a manual/protected HTTP endpoint (requires `CRON_SECRET`).

## Troubleshooting

- If `STATE_STORE=redis`, you must set Redis credentials or the cron function will fail fast.
- `STATE_STORE=file` is local-only. On Vercel it is ephemeral and not reliable for proposal change detection.
- Check Vercel function logs for the `stats` payload (`proposalsFetched`, `createdPosted`, `votingPosted`) after each cron run.
- If `stateInitializedBeforeRun=false` and `seededWithoutAlert>0`, that run only seeded state (expected when `ANNOUNCE_EXISTING_ON_START=false`), so no Discord create messages are sent on that first run.
- When you add a new entry to `DAO_TARGETS`, existing proposals in that newly added DAO are seeded silently once (`newTargetsSeeded>0`) to avoid backfilling/spamming old proposals.
- For smoke tests: set `TEST_POST_LATEST_PROPOSAL_ONCE=true`.
- Add `TEST_POST_LATEST_PROPOSAL_EACH_DAO=true` to post the latest proposal for each DAO target.
- Set `TEST_POST_LATEST_VOTING_PROPOSAL_ONCE=true` to post the latest proposal currently in Voting state.
- If a second test run is skipped, set `TEST_POST_LATEST_PROPOSAL_RESET=true` for one run (then turn it back off) and check `testPostLatestResetApplied=1`.
- If `sendErrors>0`, Discord rejected one or more messages (e.g., wrong channel ID, missing bot permissions, or invalid token). Check adjacent error lines in Function Logs.

## Security

- `api/cron` checks `Authorization: Bearer <CRON_SECRET>`.
- Vercel cron uses this automatically when `CRON_SECRET` is configured.
- In GitHub Actions, secrets are step-scoped (not job-wide) in [.github/workflows/cron.yml](/Users/kirk/Development/grape-governance-discord-bot/.github/workflows/cron.yml).
- Protect `main` with required reviews and restrict who can push.
- Prefer GitHub Environments with required reviewers for production secrets.

## Discord Credentials Note

For this architecture, you only need:
- `DISCORD_BOT_TOKEN`
- `DISCORD_CHANNEL_ID`

`DISCORD_APP_ID` and `DISCORD_PUBLIC_KEY` are not required unless you add slash commands/interactions.
