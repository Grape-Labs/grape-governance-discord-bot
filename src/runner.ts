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

function isExecutedState(state: unknown): boolean {
  const normalized = String(state ?? "").trim().toUpperCase();
  if (normalized === "EXECUTING" || normalized === "EXECUTED") return true;
  return toNum(state) === 4;
}

function isCompletedState(state: unknown): boolean {
  const normalized = String(state ?? "").trim().toUpperCase();
  if (normalized === "COMPLETED") return true;
  return toNum(state) === 5;
}

function isCancelledState(state: unknown): boolean {
  const normalized = String(state ?? "").trim().toUpperCase();
  if (normalized === "CANCELLED") return true;
  return toNum(state) === 6;
}

function formatProposalStatus(state: unknown): string {
  const normalized = String(state ?? "").trim().toUpperCase();
  if (isCancelledState(state)) return "Cancelled";
  if (isCompletedState(state)) return "Completed";
  if (isExecutedState(state)) return "Executed";
  if (isVotingState(state)) return "Now Voting";
  if (normalized === "DRAFT" || toNum(state) === 0) return "Draft (To Be Reviewed)";
  if (!normalized) return "Unknown";
  return normalized.replace(/_/g, " ");
}

function formatProposalAction(state: unknown): string {
  if (isVotingState(state)) return "Action: DAO members, please vote now.";
  const normalized = String(state ?? "").trim().toUpperCase();
  if (normalized === "DRAFT" || toNum(state) === 0) {
    return "Action: Please review this draft proposal.";
  }
  return "Action: Please review this proposal.";
}

function formatProposalAuthor(proposal: ProposalRecord): string | null {
  const raw = proposal.authorWallet || proposal.tokenOwnerRecord;
  if (!raw) return null;
  const short = raw.length > 16 ? `${raw.slice(0, 6)}...${raw.slice(-6)}` : raw;
  return `Author: \`${short}\``;
}

function formatLabelLine(line: string): string {
  const idx = line.indexOf(": ");
  if (idx <= 0) return line;
  const label = line.slice(0, idx);
  const value = line.slice(idx + 2);
  return `**${label}**: ${value}`;
}

function isLinkSectionLine(line: string): boolean {
  return line.startsWith("Description: ") || line.startsWith("Proposal: ");
}

function renderMessage(title: string, lines: Array<string | null>): string {
  const rawLines = lines.filter((line): line is string => Boolean(line));
  const rendered: string[] = [`**${title}**`, ""];

  let inLinkSection = false;
  for (const line of rawLines) {
    const linkSectionLine = isLinkSectionLine(line);
    if (linkSectionLine && !inLinkSection) {
      rendered.push("");
      inLinkSection = true;
    }
    rendered.push(formatLabelLine(line));
  }

  while (rendered.length && rendered[rendered.length - 1] === "") {
    rendered.pop();
  }

  return ellipsize(rendered.join("\n"), 1900);
}

function formatProposalVotingEnd(proposal: ProposalRecord): string | null {
  if (proposal.votingAt == null || proposal.maxVotingTime == null) return null;
  const endsAt = formatDiscordTimestamp(proposal.votingAt + proposal.maxVotingTime);
  return endsAt ? `Ends At: ${endsAt}` : null;
}

function formatProposalInstructionCount(proposal: ProposalRecord): string | null {
  const count = proposal.instructionsCount;
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return null;
  return `Instructions: ${count}`;
}

function proposalRecencyKey(proposal: ProposalRecord): number {
  return proposal.votingAt ?? proposal.draftAt;
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

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function looksLikeHtmlDocument(value: string): boolean {
  const lower = value.trim().toLowerCase();
  if (!lower) return false;
  if (lower.startsWith("<!doctype html") || lower.startsWith("<html")) return true;
  return /<(html|head|body|script|style|meta|link)\b/.test(lower.slice(0, 2000));
}

function sanitizeDescriptionText(raw: string): string | null {
  let value = normalizeWhitespace(raw);
  if (!value) return null;
  if (looksLikeHtmlDocument(value)) return null;
  if (value.includes("github.githubassets.com") || value.includes("octolytics")) return null;

  value = value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(^|\s)#{1,6}\s+/g, " ")
    .replace(/(^|\s)[*-]\s+/g, " ");

  value = normalizeWhitespace(value);
  if (!value) return null;

  const angleBracketCount = (value.match(/[<>]/g) || []).length;
  if (angleBracketCount > Math.max(10, Math.floor(value.length * 0.05))) {
    return null;
  }

  return value;
}

function toUnixSeconds(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const raw = Math.floor(value);
  if (raw > 10_000_000_000) {
    return Math.floor(raw / 1000);
  }
  return raw;
}

function formatDiscordTimestamp(value: number | null | undefined): string | null {
  const unix = toUnixSeconds(value);
  if (!unix) return null;
  return `<t:${unix}:F> (<t:${unix}:R>)`;
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

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("application/json")) {
      const json = (await res.json()) as Record<string, unknown>;
      const description =
        (typeof json.description === "string" && json.description) ||
        (typeof json.body === "string" && json.body) ||
        (typeof json.content === "string" && json.content) ||
        null;
      if (!description) return null;
      return sanitizeDescriptionText(description);
    }

    const text = await res.text();
    if (contentType.includes("text/html")) return null;
    return sanitizeDescriptionText(text);
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
  const draftedAt = formatDiscordTimestamp(params.proposal.draftAt);
  const votingAt = formatDiscordTimestamp(params.proposal.votingAt);
  const endsAt = formatProposalVotingEnd(params.proposal);
  const instructions = formatProposalInstructionCount(params.proposal);
  return renderMessage("NEW PROPOSAL CREATED", [
    `DAO: ${params.daoLabel}`,
    `Title: ${params.proposal.name}`,
    formatProposalAuthor(params.proposal),
    `Status: ${formatProposalStatus(params.proposal.state)}`,
    formatProposalAction(params.proposal.state),
    draftedAt ? `Drafted At: ${draftedAt}` : null,
    votingAt ? `Voting At: ${votingAt}` : null,
    endsAt,
    instructions,
    `Description: ${ellipsize(description, 1200)}`,
    `Proposal: ${proposalUrl(params.realmPubkey, params.proposal.pubkey)}`
  ]);
}

async function buildVotingMessage(params: {
  daoLabel: string;
  proposal: ProposalRecord;
  realmPubkey: string;
  fetchDescriptionFromLink: boolean;
}): Promise<string> {
  const description = await getDescription(params.proposal, params.fetchDescriptionFromLink);
  const draftedAt = formatDiscordTimestamp(params.proposal.draftAt);
  const votingAt = formatDiscordTimestamp(params.proposal.votingAt);
  const endsAt = formatProposalVotingEnd(params.proposal);
  const instructions = formatProposalInstructionCount(params.proposal);
  return renderMessage("PROPOSAL NOW VOTING", [
    `DAO: ${params.daoLabel}`,
    `Title: ${params.proposal.name}`,
    formatProposalAuthor(params.proposal),
    `Status: ${formatProposalStatus(params.proposal.state)}`,
    formatProposalAction(params.proposal.state),
    draftedAt ? `Drafted At: ${draftedAt}` : null,
    votingAt ? `Voting At: ${votingAt}` : null,
    endsAt,
    instructions,
    `Description: ${ellipsize(description, 1200)}`,
    `Proposal: ${proposalUrl(params.realmPubkey, params.proposal.pubkey)}`
  ]);
}

async function buildExecutedMessage(params: {
  daoLabel: string;
  proposal: ProposalRecord;
  realmPubkey: string;
  fetchDescriptionFromLink: boolean;
}): Promise<string> {
  const description = await getDescription(params.proposal, params.fetchDescriptionFromLink);
  const draftedAt = formatDiscordTimestamp(params.proposal.draftAt);
  const votingAt = formatDiscordTimestamp(params.proposal.votingAt);
  const endsAt = formatProposalVotingEnd(params.proposal);
  const instructions = formatProposalInstructionCount(params.proposal);
  return renderMessage("PROPOSAL EXECUTION STARTED", [
    `DAO: ${params.daoLabel}`,
    `Title: ${params.proposal.name}`,
    formatProposalAuthor(params.proposal),
    `Status: ${formatProposalStatus(params.proposal.state)}`,
    "Action: Proposal execution is now in progress.",
    draftedAt ? `Drafted At: ${draftedAt}` : null,
    votingAt ? `Voting At: ${votingAt}` : null,
    endsAt,
    instructions,
    `Description: ${ellipsize(description, 1200)}`,
    `Proposal: ${proposalUrl(params.realmPubkey, params.proposal.pubkey)}`
  ]);
}

async function buildCompletedMessage(params: {
  daoLabel: string;
  proposal: ProposalRecord;
  realmPubkey: string;
  fetchDescriptionFromLink: boolean;
}): Promise<string> {
  const description = await getDescription(params.proposal, params.fetchDescriptionFromLink);
  const draftedAt = formatDiscordTimestamp(params.proposal.draftAt);
  const votingAt = formatDiscordTimestamp(params.proposal.votingAt);
  const endsAt = formatProposalVotingEnd(params.proposal);
  const instructions = formatProposalInstructionCount(params.proposal);
  return renderMessage("PROPOSAL COMPLETED", [
    `DAO: ${params.daoLabel}`,
    `Title: ${params.proposal.name}`,
    formatProposalAuthor(params.proposal),
    `Status: ${formatProposalStatus(params.proposal.state)}`,
    "Action: Proposal lifecycle is complete.",
    draftedAt ? `Drafted At: ${draftedAt}` : null,
    votingAt ? `Voting At: ${votingAt}` : null,
    endsAt,
    instructions,
    `Description: ${ellipsize(description, 1200)}`,
    `Proposal: ${proposalUrl(params.realmPubkey, params.proposal.pubkey)}`
  ]);
}

async function buildCancelledMessage(params: {
  daoLabel: string;
  proposal: ProposalRecord;
  realmPubkey: string;
  fetchDescriptionFromLink: boolean;
}): Promise<string> {
  const description = await getDescription(params.proposal, params.fetchDescriptionFromLink);
  const draftedAt = formatDiscordTimestamp(params.proposal.draftAt);
  const votingAt = formatDiscordTimestamp(params.proposal.votingAt);
  const endsAt = formatProposalVotingEnd(params.proposal);
  const instructions = formatProposalInstructionCount(params.proposal);
  return renderMessage("PROPOSAL CANCELLED", [
    `DAO: ${params.daoLabel}`,
    `Title: ${params.proposal.name}`,
    formatProposalAuthor(params.proposal),
    `Status: ${formatProposalStatus(params.proposal.state)}`,
    "Action: Proposal is cancelled. No vote/action is needed.",
    draftedAt ? `Drafted At: ${draftedAt}` : null,
    votingAt ? `Voting At: ${votingAt}` : null,
    endsAt,
    instructions,
    `Description: ${ellipsize(description, 1200)}`,
    `Proposal: ${proposalUrl(params.realmPubkey, params.proposal.pubkey)}`
  ]);
}

async function buildLatestProposalTestMessage(params: {
  daoLabel: string;
  proposal: ProposalRecord;
  realmPubkey: string;
  fetchDescriptionFromLink: boolean;
}): Promise<string> {
  const description = await getDescription(params.proposal, params.fetchDescriptionFromLink);
  const draftedAt = formatDiscordTimestamp(params.proposal.draftAt);
  const votingAt = formatDiscordTimestamp(params.proposal.votingAt);
  const endsAt = formatProposalVotingEnd(params.proposal);
  const instructions = formatProposalInstructionCount(params.proposal);
  return renderMessage("SMOKE TEST: LATEST PROPOSAL", [
    `DAO: ${params.daoLabel}`,
    `Title: ${params.proposal.name}`,
    formatProposalAuthor(params.proposal),
    `Status: ${formatProposalStatus(params.proposal.state)}`,
    formatProposalAction(params.proposal.state),
    draftedAt ? `Drafted At: ${draftedAt}` : null,
    votingAt ? `Voting At: ${votingAt}` : null,
    endsAt,
    instructions,
    `Description: ${ellipsize(description, 1200)}`,
    `Proposal: ${proposalUrl(params.realmPubkey, params.proposal.pubkey)}`
  ]);
}

async function sendDiscordMessage(params: {
  token: string;
  channelId: string;
  content: string;
}): Promise<void> {
  const endpoint = `https://discord.com/api/v10/channels/${encodeURIComponent(params.channelId)}/messages`;
  const payload = JSON.stringify({
    content: params.content,
    // SUPPRESS_EMBEDS prevents Discord from unfurling link previews.
    flags: 4
  });
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
  executedPosted: number;
  completedPosted: number;
  cancelledPosted: number;
  seededWithoutAlert: number;
  stateInitializedBeforeRun: boolean;
  fetchErrors: number;
  newTargetsSeeded: number;
  testPostLatestPosted: number;
  testPostLatestSkippedAlreadyDone: number;
  testPostLatestVotingPosted: number;
  testPostLatestVotingSkippedAlreadyDone: number;
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
  let executedPosted = 0;
  let completedPosted = 0;
  let cancelledPosted = 0;
  let seededWithoutAlert = 0;
  let fetchErrors = 0;
  let newTargetsSeeded = 0;
  let testPostLatestPosted = 0;
  let testPostLatestSkippedAlreadyDone = 0;
  let testPostLatestVotingPosted = 0;
  let testPostLatestVotingSkippedAlreadyDone = 0;
  let testPostLatestResetApplied = 0;
  let sendErrors = 0;

  if (config.testPostLatestProposalReset) {
    state.testPostLatestProposalDone = false;
    state.testPostLatestProposalDoneByTarget = {};
    state.testPostLatestVotingProposalDone = false;
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

  if (config.testPostLatestVotingProposalOnce) {
    if (!state.testPostLatestVotingProposalDone) {
      let latestVoting: { target: DaoTarget; proposal: ProposalRecord } | null = null;
      for (const { target, proposals } of targetResults) {
        for (const proposal of proposals) {
          if (!isVotingState(proposal.state)) continue;
          if (!latestVoting || proposalRecencyKey(proposal) > proposalRecencyKey(latestVoting.proposal)) {
            latestVoting = { target, proposal };
          }
        }
      }

      if (latestVoting) {
        try {
          const content = await buildVotingMessage({
            daoLabel: latestVoting.target.label,
            proposal: latestVoting.proposal,
            realmPubkey: latestVoting.target.realmPubkey,
            fetchDescriptionFromLink: config.fetchDescriptionFromLink
          });
          await sendDiscordMessage({
            token: config.discordToken,
            channelId: config.discordChannelId,
            content
          });
          testPostLatestVotingPosted = 1;
          state.testPostLatestVotingProposalDone = true;
        } catch (error) {
          sendErrors += 1;
          console.error("[cron] failed test latest voting proposal send:", error);
        }
      }
    } else {
      testPostLatestVotingSkippedAlreadyDone = 1;
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
      const nowExecuted = isExecutedState(proposal.state);
      const nowCompleted = isCompletedState(proposal.state);
      const nowCancelled = isCancelledState(proposal.state);

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
      const wasExecuted = isExecutedState(known.lastState);
      const wasCompleted = isCompletedState(known.lastState);
      const wasCancelled = isCancelledState(known.lastState);
      if (!wasVoting && nowVoting) {
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

      if (!wasExecuted && nowExecuted) {
        const message = await buildExecutedMessage({
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
          executedPosted += 1;
        } catch (error) {
          sendErrors += 1;
          console.error(`[cron] failed executed send for ${target.label} ${proposal.pubkey}:`, error);
        }
      }

      if (!wasCompleted && nowCompleted) {
        const message = await buildCompletedMessage({
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
          completedPosted += 1;
        } catch (error) {
          sendErrors += 1;
          console.error(`[cron] failed completed send for ${target.label} ${proposal.pubkey}:`, error);
        }
      }

      if (!wasCancelled && nowCancelled) {
        const message = await buildCancelledMessage({
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
          cancelledPosted += 1;
        } catch (error) {
          sendErrors += 1;
          console.error(`[cron] failed cancelled send for ${target.label} ${proposal.pubkey}:`, error);
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
    executedPosted,
    completedPosted,
    cancelledPosted,
    seededWithoutAlert,
    stateInitializedBeforeRun,
    fetchErrors,
    newTargetsSeeded,
    testPostLatestPosted,
    testPostLatestSkippedAlreadyDone,
    testPostLatestVotingPosted,
    testPostLatestVotingSkippedAlreadyDone,
    testPostLatestResetApplied,
    sendErrors
  };
}
