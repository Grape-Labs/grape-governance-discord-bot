import { getConfig, type AppConfig, type DaoTarget } from "./config.js";
import { fetchRealmProposals } from "./shyft.js";
import { FileStateStore, RedisStateStore, type StateStore } from "./state-store.js";
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

function proposalStateKey(target: DaoTarget, proposal: ProposalRecord): string {
  return `${target.realmPubkey}:${proposal.pubkey}`;
}

function targetStateKey(target: DaoTarget): string {
  return `${target.realmPubkey}:${target.programNamespace}`;
}

function proposalUrl(realmPubkey: string, proposalPubkey: string): string {
  return `https://governance.so/proposal/${encodeURIComponent(realmPubkey)}/${encodeURIComponent(proposalPubkey)}`;
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

async function buildCreatedMessage(params: {
  daoLabel: string;
  proposal: ProposalRecord;
  realmPubkey: string;
  fetchDescriptionFromLink: boolean;
}): Promise<string> {
  const description = await getDescription(params.proposal, params.fetchDescriptionFromLink);
  const lines = [
    "New Proposal Created",
    `DAO: ${params.daoLabel}`,
    `Title: ${params.proposal.name}`,
    `Description: ${ellipsize(description, 1200)}`,
    `Proposal: ${proposalUrl(params.realmPubkey, params.proposal.pubkey)}`
  ];
  return ellipsize(lines.join("\n"), 1900);
}

async function buildVotingMessage(params: {
  daoLabel: string;
  proposal: ProposalRecord;
  realmPubkey: string;
  fetchDescriptionFromLink: boolean;
}): Promise<string> {
  const description = await getDescription(params.proposal, params.fetchDescriptionFromLink);
  const lines = [
    "Proposal Moved To Voting",
    `DAO: ${params.daoLabel}`,
    `Title: ${params.proposal.name}`,
    `Description: ${ellipsize(description, 1200)}`,
    `Proposal: ${proposalUrl(params.realmPubkey, params.proposal.pubkey)}`
  ];
  return ellipsize(lines.join("\n"), 1900);
}

async function buildLatestProposalTestMessage(params: {
  daoLabel: string;
  proposal: ProposalRecord;
  realmPubkey: string;
  fetchDescriptionFromLink: boolean;
}): Promise<string> {
  const description = await getDescription(params.proposal, params.fetchDescriptionFromLink);
  const lines = [
    "Smoke Test: Latest Proposal",
    `DAO: ${params.daoLabel}`,
    `Title: ${params.proposal.name}`,
    `Description: ${ellipsize(description, 1200)}`,
    `Proposal: ${proposalUrl(params.realmPubkey, params.proposal.pubkey)}`
  ];
  return ellipsize(lines.join("\n"), 1900);
}

async function sendDiscordMessage(params: {
  token: string;
  channelId: string;
  content: string;
}): Promise<void> {
  const endpoint = `https://discord.com/api/v10/channels/${encodeURIComponent(params.channelId)}/messages`;
  const payload = JSON.stringify({ content: params.content });
  const headers = {
    "content-type": "application/json",
    authorization: `Bot ${params.token}`
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: payload
  });

  if (res.status === 429) {
    const body = (await res.json()) as { retry_after?: number };
    const waitMs = Math.ceil((body.retry_after || 1) * 1000);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const retry = await fetch(endpoint, {
      method: "POST",
      headers,
      body: payload
    });
    if (!retry.ok) {
      const text = await retry.text();
      throw new Error(`Discord API retry failed ${retry.status}: ${text}`);
    }
    return;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API failed ${res.status}: ${text}`);
  }
}

function createStateStore(config: AppConfig): StateStore {
  if (config.stateStore === "redis") {
    return new RedisStateStore(config.stateKey);
  }
  return new FileStateStore(config.stateFilePath);
}

export type RunStats = {
  targets: number;
  proposalsFetched: number;
  tracked: number;
  createdPosted: number;
  votingPosted: number;
  seededWithoutAlert: number;
  stateInitializedBeforeRun: boolean;
  fetchErrors: number;
  newTargetsSeeded: number;
  testPostLatestPosted: number;
  testPostLatestSkippedAlreadyDone: number;
  testPostLatestResetApplied: number;
  sendErrors: number;
};

export async function runCronOnce(config = getConfig()): Promise<RunStats> {
  const stateStore = createStateStore(config);
  const state = await stateStore.load();
  const stateInitializedBeforeRun = state.initialized;

  const targetResults = await Promise.all(
    config.daoTargets.map(async (target) => {
      try {
        const proposals = await fetchRealmProposals({
          shyftUrl: config.shyftGraphqlUrl,
          programNamespace: target.programNamespace,
          realmPubkey: target.realmPubkey,
          limit: config.proposalScanLimit
        });
        return { target, proposals, fetchError: false };
      } catch (error) {
        console.error(
          `[cron] failed to fetch ${target.label} (${target.realmPubkey}, ${target.programNamespace}):`,
          error
        );
        return { target, proposals: [] as ProposalRecord[], fetchError: true };
      }
    })
  );

  let proposalsFetched = 0;
  let createdPosted = 0;
  let votingPosted = 0;
  let seededWithoutAlert = 0;
  let fetchErrors = 0;
  let newTargetsSeeded = 0;
  let testPostLatestPosted = 0;
  let testPostLatestSkippedAlreadyDone = 0;
  let testPostLatestResetApplied = 0;
  let sendErrors = 0;

  if (config.testPostLatestProposalReset) {
    state.testPostLatestProposalDone = false;
    state.testPostLatestProposalDoneByTarget = {};
    testPostLatestResetApplied = 1;
  }

  if (config.testPostLatestProposalOnce) {
    if (config.testPostLatestProposalEachDao) {
      for (const { target, proposals } of targetResults) {
        if (proposals.length === 0) continue;
        const targetKey = targetStateKey(target);
        if (state.testPostLatestProposalDoneByTarget[targetKey]) {
          testPostLatestSkippedAlreadyDone += 1;
          continue;
        }

        const proposal = proposals[0];
        try {
          const content = await buildLatestProposalTestMessage({
            daoLabel: target.label,
            proposal,
            realmPubkey: target.realmPubkey,
            fetchDescriptionFromLink: config.fetchDescriptionFromLink
          });
          await sendDiscordMessage({
            token: config.discordToken,
            channelId: config.discordChannelId,
            content
          });
          testPostLatestPosted += 1;
          state.testPostLatestProposalDoneByTarget[targetKey] = true;
        } catch (error) {
          sendErrors += 1;
          console.error(`[cron] failed test latest proposal send for ${target.label} ${proposal.pubkey}:`, error);
        }
      }
    } else if (!state.testPostLatestProposalDone) {
      let latest: { target: DaoTarget; proposal: ProposalRecord } | null = null;
      for (const { target, proposals } of targetResults) {
        for (const proposal of proposals) {
          if (!latest || proposal.draftAt > latest.proposal.draftAt) {
            latest = { target, proposal };
          }
        }
      }

      if (latest) {
        try {
          const content = await buildLatestProposalTestMessage({
            daoLabel: latest.target.label,
            proposal: latest.proposal,
            realmPubkey: latest.target.realmPubkey,
            fetchDescriptionFromLink: config.fetchDescriptionFromLink
          });
          await sendDiscordMessage({
            token: config.discordToken,
            channelId: config.discordChannelId,
            content
          });
          testPostLatestPosted = 1;
          state.testPostLatestProposalDone = true;
        } catch (error) {
          sendErrors += 1;
          console.error("[cron] failed test latest proposal send:", error);
        }
      }
    } else {
      testPostLatestSkippedAlreadyDone = 1;
    }
  }

  for (const { target, proposals, fetchError } of targetResults) {
    if (fetchError) fetchErrors += 1;
    proposalsFetched += proposals.length;
    const targetKey = targetStateKey(target);
    const targetWasSeeded = Boolean(state.seededTargets[targetKey]);

    for (const proposal of proposals) {
      const key = proposalStateKey(target, proposal);
      const known = state.proposals[key];
      const nowVoting = isVotingState(proposal.state);

      if (!known) {
        const shouldAnnounceCreate = !state.initialized
          ? config.announceExistingOnStart
          : targetWasSeeded;
        if (shouldAnnounceCreate) {
          const message = await buildCreatedMessage({
            daoLabel: target.label,
            proposal,
            realmPubkey: target.realmPubkey,
            fetchDescriptionFromLink: config.fetchDescriptionFromLink
          });
          try {
            await sendDiscordMessage({
              token: config.discordToken,
              channelId: config.discordChannelId,
              content: message
            });
            createdPosted += 1;
          } catch (error) {
            sendErrors += 1;
            console.error(`[cron] failed created send for ${target.label} ${proposal.pubkey}:`, error);
          }
        } else {
          seededWithoutAlert += 1;
        }

        state.proposals[key] = {
          lastState: proposal.state,
          announcedCreated: shouldAnnounceCreate,
          announcedVoting: nowVoting
        };
        continue;
      }

      const wasVoting = isVotingState(known.lastState);
      if (!wasVoting && nowVoting && !known.announcedVoting) {
        const message = await buildVotingMessage({
          daoLabel: target.label,
          proposal,
          realmPubkey: target.realmPubkey,
          fetchDescriptionFromLink: config.fetchDescriptionFromLink
        });
        try {
          await sendDiscordMessage({
            token: config.discordToken,
            channelId: config.discordChannelId,
            content: message
          });
          known.announcedVoting = true;
          votingPosted += 1;
        } catch (error) {
          sendErrors += 1;
          console.error(`[cron] failed voting send for ${target.label} ${proposal.pubkey}:`, error);
        }
      }

      known.lastState = proposal.state;
    }

    if (!fetchError && !targetWasSeeded) {
      state.seededTargets[targetKey] = true;
      newTargetsSeeded += 1;
    }
  }

  if (!state.initialized) {
    state.initialized = true;
  }
  await stateStore.save(state);

  return {
    targets: config.daoTargets.length,
    proposalsFetched,
    tracked: Object.keys(state.proposals).length,
    createdPosted,
    votingPosted,
    seededWithoutAlert,
    stateInitializedBeforeRun,
    fetchErrors,
    newTargetsSeeded,
    testPostLatestPosted,
    testPostLatestSkippedAlreadyDone,
    testPostLatestResetApplied,
    sendErrors
  };
}
