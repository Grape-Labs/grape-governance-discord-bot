# Grape Governance Notifier (Vercel Cron)

Serverless Discord notifier for SPL Governance proposals using Shyft GraphQL.

It posts to a Discord channel when:
- A new proposal is created
- A proposal moves into voting state

Supports one or many DAO realms in the same channel.

## Architecture

- `api/cron.ts`: Vercel cron HTTP function
- `src/runner.ts`: proposal fetch + state transition logic
- State persistence:
  - `redis` (recommended on Vercel, persistent)
  - `file` (local-only fallback)

## Required Environment Variables

- `DISCORD_BOT_TOKEN`
- `DISCORD_CHANNEL_ID`
- `CRON_SECRET`

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

## Vercel Deploy

1. Push repo to GitHub/GitLab/Bitbucket.
2. Import into Vercel.
3. Add env vars from `.env.example` in Vercel Project Settings.
4. Create and attach an Upstash Redis integration in Vercel (recommended), then set:
   - `STATE_STORE=redis`
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
5. Deploy.

Cron schedule is in [vercel.json](/Users/kirk/Development/grape-governance-discord-bot/vercel.json) and is set to once per day (Hobby-compatible):

```json
{
  "crons": [{ "path": "/api/cron", "schedule": "0 0 * * *" }]
}
```

## Troubleshooting

- If `STATE_STORE=redis`, you must set Redis credentials or the cron function will fail fast.
- `STATE_STORE=file` is local-only. On Vercel it is ephemeral and not reliable for proposal change detection.
- Check Vercel function logs for the `stats` payload (`proposalsFetched`, `createdPosted`, `votingPosted`) after each cron run.

## Security

- `api/cron` checks `Authorization: Bearer <CRON_SECRET>`.
- Vercel cron uses this automatically when `CRON_SECRET` is configured.

## Discord Credentials Note

For this architecture, you only need:
- `DISCORD_BOT_TOKEN`
- `DISCORD_CHANNEL_ID`

`DISCORD_APP_ID` and `DISCORD_PUBLIC_KEY` are not required unless you add slash commands/interactions.
