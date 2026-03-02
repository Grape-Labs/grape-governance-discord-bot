import path from "node:path";

const DEFAULT_REALM = "By2sVGZXwfQq6rAiAM3rNPJ9iQfb5e2QhnF4YjJ4Bip";
const DEFAULT_PROGRAM_NAMESPACE = "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw";
const DEFAULT_SHYFT_URL = "https://grape.shyft.to/v1/graphql/";
const DEFAULT_LABEL = "Grape DAO";

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function envInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export type AppConfig = {
  discordToken: string;
  discordChannelId: string;
  daoTargets: DaoTarget[];
  shyftGraphqlUrl: string;
  stateStore: "redis" | "file";
  stateKey: string;
  stateFilePath: string;
  announceExistingOnStart: boolean;
  fetchDescriptionFromLink: boolean;
  proposalScanLimit: number;
  cronSecret: string | null;
};

export type DaoTarget = {
  label: string;
  realmPubkey: string;
  programNamespace: string;
};

function parseDaoTargets(raw: string | undefined): DaoTarget[] {
  if (!raw?.trim()) {
    return [
      {
        label: DEFAULT_LABEL,
        realmPubkey: process.env.REALM_PUBKEY?.trim() || DEFAULT_REALM,
        programNamespace: process.env.GOV_PROGRAM_NAMESPACE?.trim() || DEFAULT_PROGRAM_NAMESPACE
      }
    ];
  }

  const parsed: DaoTarget[] = [];
  const entries = raw
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const [index, entry] of entries.entries()) {
    const [realmPubkey, programNamespace, label] = entry.split("@").map((x) => x.trim());
    if (!realmPubkey || !programNamespace) {
      throw new Error(
        `Invalid DAO_TARGETS entry "${entry}". Expected "REALM@PROGRAM_NAMESPACE@OPTIONAL_LABEL".`
      );
    }

    parsed.push({
      label: label || `DAO ${index + 1}`,
      realmPubkey,
      programNamespace
    });
  }

  if (!parsed.length) {
    throw new Error("DAO_TARGETS was provided but no valid entries were parsed.");
  }

  return parsed;
}

function getDefaultStateStore(): "redis" | "file" {
  if (
    (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) ||
    (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
  ) {
    return "redis";
  }
  return "file";
}

export function getConfig(): AppConfig {
  const discordToken = process.env.DISCORD_BOT_TOKEN?.trim();
  const discordChannelId = process.env.DISCORD_CHANNEL_ID?.trim();

  if (!discordToken) {
    throw new Error("Missing DISCORD_BOT_TOKEN.");
  }
  if (!discordChannelId) {
    throw new Error("Missing DISCORD_CHANNEL_ID.");
  }

  return {
    discordToken,
    discordChannelId,
    daoTargets: parseDaoTargets(process.env.DAO_TARGETS),
    shyftGraphqlUrl: process.env.SHYFT_GRAPHQL_URL?.trim() || DEFAULT_SHYFT_URL,
    stateStore: (
      process.env.STATE_STORE?.trim().toLowerCase() === "file"
        ? "file"
        : process.env.STATE_STORE?.trim().toLowerCase() === "redis"
        ? "redis"
        : getDefaultStateStore()
    ),
    stateKey: process.env.STATE_KEY?.trim() || "grape-governance-discord-bot:state",
    stateFilePath: path.resolve(process.cwd(), process.env.STATE_FILE?.trim() || ".bot-state/grape-proposal-state.json"),
    announceExistingOnStart: envBool(process.env.ANNOUNCE_EXISTING_ON_START, false),
    fetchDescriptionFromLink: envBool(process.env.FETCH_DESCRIPTION_FROM_LINK, true),
    proposalScanLimit: envInt(process.env.PROPOSAL_SCAN_LIMIT, 1200),
    cronSecret: process.env.CRON_SECRET?.trim() || null
  };
}
