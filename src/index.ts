import "dotenv/config";
import { Client, GatewayIntentBits, type SendableChannels } from "discord.js";
import { getConfig } from "./config.js";
import { fetchRealmProposals } from "./shyft.js";
import { StateStore } from "./state-store.js";
import type { ProposalRecord } from "./types.js";

function toNum(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : Number(value);
  return Number.isFinite(parsed) ? parsed : -1;
}

function isVotingState(state: unknown): boolean {
  const normalized = String(state ?? "").trim().toUpperCase();
  if (normalized === "VOTING") return true;
  return toNum(state) === 2;
}

function ellipsize(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen - 3)}...`;
}

async function fetchDescriptionText(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        accept: "application/json,text/plain,text/markdown,*/*"
      }
    });
    clearTimeout(timer);

    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const json = (await res.json()) as Record<string, unknown>;
      const description =
        (typeof json.description === "string" && json.description) ||
        (typeof json.body === "string" && json.body) ||
        (typeof json.content === "string" && json.content) ||
        null;
      return description ? description.replace(/\s+/g, " ").trim() : null;
    }

    const text = await res.text();
    const compact = text.replace(/\s+/g, " ").trim();
    return compact || null;
  } catch {
    return null;
  }
}

async function getDescription(proposal: ProposalRecord, shouldFetch: boolean): Promise<string> {
  const link = proposal.descriptionLink;
  if (!link) return "No description provided.";

  if (!shouldFetch) return link;

  const description = await fetchDescriptionText(link);
  if (!description) return link;
  return description;
}

function proposalUrl(realmPubkey: string, proposalPubkey: string): string {
  return `https://app.realms.today/dao/${encodeURIComponent(realmPubkey)}/proposal/${encodeURIComponent(proposalPubkey)}?cluster=mainnet`;
}

async function buildCreatedMessage(params: {
  proposal: ProposalRecord;
  realmPubkey: string;
  fetchDescriptionFromLink: boolean;
}): Promise<string> {
  const description = await getDescription(params.proposal, params.fetchDescriptionFromLink);
  const lines = [
    "New Proposal Created",
    `Title: ${params.proposal.name}`,
    `Description: ${ellipsize(description, 1200)}`,
    `Proposal: ${proposalUrl(params.realmPubkey, params.proposal.pubkey)}`
  ];

  return ellipsize(lines.join("\n"), 1900);
}

async function buildVotingMessage(params: {
  proposal: ProposalRecord;
  realmPubkey: string;
  fetchDescriptionFromLink: boolean;
}): Promise<string> {
  const description = await getDescription(params.proposal, params.fetchDescriptionFromLink);
  const lines = [
    "Proposal Moved To Voting",
    `Title: ${params.proposal.name}`,
    `Description: ${ellipsize(description, 1200)}`,
    `Proposal: ${proposalUrl(params.realmPubkey, params.proposal.pubkey)}`
  ];

  return ellipsize(lines.join("\n"), 1900);
}

function assertSendableChannel(channel: unknown): asserts channel is SendableChannels {
  if (
    !channel ||
    typeof channel !== "object" ||
    !("isSendable" in channel) ||
    typeof (channel as { isSendable?: unknown }).isSendable !== "function" ||
    !(channel as { isSendable: () => boolean }).isSendable()
  ) {
    throw new Error("Configured DISCORD_CHANNEL_ID is not a text-based channel.");
  }
}

async function main(): Promise<void> {
  const config = getConfig();
  const stateStore = new StateStore(config.stateFilePath);

  const client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });

  let pollInFlight = false;

  const runPoll = async (): Promise<void> => {
    if (pollInFlight) return;
    pollInFlight = true;

    try {
      const proposals = await fetchRealmProposals({
        shyftUrl: config.shyftGraphqlUrl,
        programNamespace: config.programNamespace,
        realmPubkey: config.realmPubkey,
        limit: config.proposalScanLimit
      });

      const state = await stateStore.load();
      const channelRef = await client.channels.fetch(config.discordChannelId);
      assertSendableChannel(channelRef);
      const channel = channelRef;

      for (const proposal of proposals) {
        const known = state.proposals[proposal.pubkey];
        const nowVoting = isVotingState(proposal.state);

        if (!known) {
          const shouldAnnounceCreate = state.initialized || config.announceExistingOnStart;
          if (shouldAnnounceCreate) {
            const message = await buildCreatedMessage({
              proposal,
              realmPubkey: config.realmPubkey,
              fetchDescriptionFromLink: config.fetchDescriptionFromLink
            });
            await channel.send({ content: message });
          }

          state.proposals[proposal.pubkey] = {
            lastState: proposal.state,
            announcedCreated: true,
            announcedVoting: nowVoting
          };
          continue;
        }

        const wasVoting = isVotingState(known.lastState);
        if (!wasVoting && nowVoting && !known.announcedVoting) {
          const message = await buildVotingMessage({
            proposal,
            realmPubkey: config.realmPubkey,
            fetchDescriptionFromLink: config.fetchDescriptionFromLink
          });
          await channel.send({ content: message });
          known.announcedVoting = true;
        }

        known.lastState = proposal.state;
      }

      if (!state.initialized) {
        state.initialized = true;
      }

      await stateStore.save(state);
      console.log(`[poll] proposals=${proposals.length} tracked=${Object.keys(state.proposals).length}`);
    } catch (error) {
      console.error("[poll] failed:", error);
    } finally {
      pollInFlight = false;
    }
  };

  client.once("ready", async () => {
    console.log(`Discord bot logged in as ${client.user?.tag || "unknown-user"}`);
    await runPoll();
    setInterval(() => {
      void runPoll();
    }, config.pollIntervalMs);
  });

  process.on("SIGINT", () => {
    console.log("Received SIGINT. Closing bot.");
    void client.destroy();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("Received SIGTERM. Closing bot.");
    void client.destroy();
    process.exit(0);
  });

  await client.login(config.discordToken);
}

void main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
