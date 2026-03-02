# Grape Governance Discord Bot

Discord bot that watches the Grape DAO realm (`By2sVGZXwfQq6rAiAM3rNPJ9iQfb5e2QhnF4YjJ4Bip`) via Shyft GraphQL and posts:

- New proposal created
- Proposal moved into voting state

## What It Tracks

- Realm: `By2sVGZXwfQq6rAiAM3rNPJ9iQfb5e2QhnF4YjJ4Bip`
- Program namespace (default): `GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw`
- Polling interval (default): `30s`

The bot stores seen proposal state in `.bot-state/grape-proposal-state.json` so it does not repost the same event.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create env file:

```bash
cp .env.example .env
```

3. Fill required env vars in `.env`:

- `DISCORD_BOT_TOKEN`
- `DISCORD_CHANNEL_ID`

4. Run:

```bash
npm run dev
```

## Discord Bot Permissions

Your Discord bot should at least have:

- View Channel
- Send Messages

Use the bot token from the Discord Developer Portal.

## Behavior Notes

- On first startup, existing proposals are seeded silently by default (`ANNOUNCE_EXISTING_ON_START=false`).
- Set `ANNOUNCE_EXISTING_ON_START=true` if you want immediate announcements for already-indexed proposals.
- If `FETCH_DESCRIPTION_FROM_LINK=true`, the bot fetches proposal description text from `descriptionLink` when possible; otherwise it posts the link.
