import { getConfig, type AppConfig, type DaoTarget } from "./config.js";
import { fetchRealmProposals } from "./shyft.js";
import { FileStateStore, RedisStateStore, type StateStore } from "./state-store.js";
import type { ProposalRecord } from "./types.js";

type DiscordAllowedMentions = {
  parse: Array<"everyone">;
  roles?: string[];
  users?: string[];
};

type DiscordMention = {
  content: string;
  allowedMentions: DiscordAllowedMentions;
};

type DiscordEmbed = {
  color: number;
  description: string;
  title: string;
};

type ProposalMessageVariant =
  | "created"
  | "voting"
  | "executed"
  | "completed"
  | "cancelled"
  | "latest";

type MessageSection = {
  heading?: string;
  lines: Array<string | null>;
};

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

function renderMessageBody(params: {
  prefaceLines?: Array<string | null>;
  sections: MessageSection[];
}): string {
  const rendered: string[] = [];
  const prefaceLines = (params.prefaceLines ?? []).filter((line): line is string => Boolean(line));

  if (prefaceLines.length) {
    rendered.push(...prefaceLines);
  }

  for (const section of params.sections) {
    const lines = section.lines.filter((line): line is string => Boolean(line));
    if (!lines.length) continue;
    rendered.push("");
    if (section.heading) {
      rendered.push(`__${section.heading}__`);
    }
    for (const line of lines) {
      rendered.push(formatLabelLine(line));
    }
  }

  return ellipsize(rendered.join("\n").trim(), 3800);
}

function formatProposalVotingEnd(proposal: ProposalRecord): string | null {
  if (proposal.votingAt == null || proposal.maxVotingTime == null) return null;
  return formatDiscordTimestamp(proposal.votingAt + proposal.maxVotingTime);
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

async function getDescriptionSummary(proposal: ProposalRecord, shouldFetch: boolean): Promise<string | null> {
  const link = proposal.descriptionLink;
  if (!link || !shouldFetch) return null;
  return fetchDescriptionText(link);
}

function buildVotingMention(raw: string | null | undefined): DiscordMention | null {
  const value = raw?.trim();
  if (!value) return null;
  if (value === "@everyone" || value === "@here") {
    return {
      content: value,
      allowedMentions: { parse: ["everyone"] }
    };
  }

  const roleMatch = value.match(/^<@&(\d+)>$/);
  if (roleMatch) {
    return {
      content: value,
      allowedMentions: { parse: [], roles: [roleMatch[1]] }
    };
  }

  const userMatch = value.match(/^<@!?(\d+)>$/);
  if (userMatch) {
    return {
      content: value,
      allowedMentions: { parse: [], users: [userMatch[1]] }
    };
  }

  return {
    content: value,
    allowedMentions: { parse: [] }
  };
}

function getMessageTitle(variant: ProposalMessageVariant): string {
  switch (variant) {
    case "created":
      return "NEW PROPOSAL CREATED";
    case "voting":
      return "PROPOSAL NOW VOTING";
    case "executed":
      return "PROPOSAL EXECUTION STARTED";
    case "completed":
      return "PROPOSAL COMPLETED";
    case "cancelled":
      return "PROPOSAL CANCELLED";
    case "latest":
      return "SMOKE TEST: LATEST PROPOSAL";
  }
}

function getMessageAction(variant: ProposalMessageVariant, proposal: ProposalRecord): string {
  switch (variant) {
    case "voting":
      return "Action: DAO members, please vote now.";
    case "executed":
      return "Action: Proposal execution is now in progress.";
    case "completed":
      return "Action: Proposal lifecycle is complete.";
    case "cancelled":
      return "Action: Proposal is cancelled. No vote/action is needed.";
    case "created":
    case "latest":
      return formatProposalAction(proposal.state);
  }
}

function getPrimaryLinkLabel(variant: ProposalMessageVariant): string {
  switch (variant) {
    case "created":
      return "Review Link";
    case "voting":
      return "Vote Link";
    case "executed":
      return "Execution Link";
    case "completed":
    case "cancelled":
      return "Record Link";
    case "latest":
      return "Proposal Link";
  }
}

function getPrefaceLines(variant: ProposalMessageVariant): Array<string | null> {
  switch (variant) {
    case "created":
      return ["> REVIEW PENDING"];
    case "voting":
      return ["> ACTION REQUIRED"];
    case "executed":
      return ["> EXECUTION IN PROGRESS"];
    case "completed":
      return ["> VOTING CLOSED"];
    case "cancelled":
      return ["> NO FURTHER ACTION"];
    case "latest":
      return ["> CURRENT SNAPSHOT"];
  }
}

function getEmbedColor(variant: ProposalMessageVariant): number {
  switch (variant) {
    case "created":
      return 0xf0b429;
    case "voting":
      return 0xed4245;
    case "executed":
      return 0x5865f2;
    case "completed":
      return 0x57f287;
    case "cancelled":
      return 0x747f8d;
    case "latest":
      return 0x3ba55d;
  }
}

function getLeadHeading(variant: ProposalMessageVariant): string {
  switch (variant) {
    case "created":
      return "NEXT STEP";
    case "voting":
      return "VOTE NOW";
    case "executed":
      return "EXECUTION";
    case "completed":
      return "CLOSED";
    case "cancelled":
      return "CANCELLED";
    case "latest":
      return "LATEST";
  }
}

function getOverviewHeading(variant: ProposalMessageVariant): string {
  switch (variant) {
    case "completed":
      return "FINAL STATE";
    case "cancelled":
      return "FINAL STATE";
    default:
      return "PROPOSAL";
  }
}

function getTimelineHeading(variant: ProposalMessageVariant): string {
  switch (variant) {
    case "created":
      return "DRAFT TIMELINE";
    case "completed":
    case "cancelled":
      return "LIFECYCLE";
    default:
      return "TIMELINE";
  }
}

function getContextHeading(variant: ProposalMessageVariant): string {
  switch (variant) {
    case "completed":
      return "ARCHIVE";
    case "cancelled":
      return "REFERENCE";
    default:
      return "CONTEXT";
  }
}

function shouldShowInstructions(variant: ProposalMessageVariant): boolean {
  switch (variant) {
    case "created":
    case "voting":
    case "executed":
    case "latest":
      return true;
    case "completed":
    case "cancelled":
      return false;
  }
}

async function buildProposalMessage(params: {
  variant: ProposalMessageVariant;
  daoLabel: string;
  proposal: ProposalRecord;
  realmPubkey: string;
  fetchDescriptionFromLink: boolean;
  votingMention: string | null;
}): Promise<{ content: string; allowedMentions: DiscordAllowedMentions; embeds: DiscordEmbed[] }> {
  const summary = await getDescriptionSummary(params.proposal, params.fetchDescriptionFromLink);
  const draftedAt = formatDiscordTimestamp(params.proposal.draftAt);
  const votingAt = formatDiscordTimestamp(params.proposal.votingAt);
  const endsAt = formatProposalVotingEnd(params.proposal);
  const instructions = formatProposalInstructionCount(params.proposal);
  const proposalLink = proposalUrl(params.realmPubkey, params.proposal.pubkey);
  const votingMention = params.variant === "voting" ? buildVotingMention(params.votingMention) : null;
  const action = getMessageAction(params.variant, params.proposal);
  const primaryLinkLabel = getPrimaryLinkLabel(params.variant);
  const summaryLimit = params.variant === "voting" ? 500 : 900;

  const leadSection: MessageSection = {
    heading: getLeadHeading(params.variant),
    lines: [
      action,
      `${primaryLinkLabel}: ${proposalLink}`,
      params.variant === "voting" && endsAt ? `Voting Ends: ${endsAt}` : null
    ]
  };

  const overviewSection: MessageSection = {
    heading: getOverviewHeading(params.variant),
    lines: [
      `DAO: ${params.daoLabel}`,
      `Title: ${params.proposal.name}`,
      formatProposalAuthor(params.proposal),
      `Status: ${formatProposalStatus(params.proposal.state)}`,
      shouldShowInstructions(params.variant) ? instructions : null
    ]
  };

  const timelineSection: MessageSection = {
    heading: getTimelineHeading(params.variant),
    lines: [
      draftedAt ? `Drafted At: ${draftedAt}` : null,
      votingAt ? `Voting Started: ${votingAt}` : null,
      params.variant === "voting" || !endsAt ? null : `Voting Ends: ${endsAt}`
    ]
  };

  const contextSection: MessageSection = {
    heading: getContextHeading(params.variant),
    lines: [
      summary ? `Summary: ${ellipsize(summary, summaryLimit)}` : null,
      params.proposal.descriptionLink ? `Description Link: ${params.proposal.descriptionLink}` : null
    ]
  };

  return {
    content: votingMention?.content ?? "",
    allowedMentions: votingMention?.allowedMentions ?? { parse: [] },
    embeds: [
      {
        title: getMessageTitle(params.variant),
        description: renderMessageBody({
          prefaceLines: getPrefaceLines(params.variant),
          sections: [leadSection, overviewSection, timelineSection, contextSection]
        }),
        color: getEmbedColor(params.variant)
      }
    ]
  };
}

async function sendDiscordMessage(params: {
  token: string;
  channelId: string;
  content: string;
  allowedMentions?: DiscordAllowedMentions;
  embeds?: DiscordEmbed[];
}): Promise<void> {
  const endpoint = `https://discord.com/api/v10/channels/${encodeURIComponent(params.channelId)}/messages`;
  const payloadBody: Record<string, unknown> = {
    allowed_mentions: params.allowedMentions ?? { parse: [] },
    // SUPPRESS_EMBEDS prevents Discord from unfurling link previews.
    flags: 4
  };

  if (params.content) {
    payloadBody.content = params.content;
  }
  if (params.embeds?.length) {
    payloadBody.embeds = params.embeds;
  }

  const payload = JSON.stringify(payloadBody);
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
  console.log(
    `[cron] config targets=${config.daoTargets.length} stateStore=${config.stateStore} testPostLatestProposalOnce=${config.testPostLatestProposalOnce} testPostLatestProposalEachDao=${config.testPostLatestProposalEachDao} testPostLatestVotingProposalOnce=${config.testPostLatestVotingProposalOnce} testPostLatestProposalReset=${config.testPostLatestProposalReset}`
  );
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
          const content = await buildProposalMessage({
            variant: "latest",
            daoLabel: target.label,
            proposal,
            realmPubkey: target.realmPubkey,
            fetchDescriptionFromLink: config.fetchDescriptionFromLink,
            votingMention: config.discordVotingMention
          });
          await sendDiscordMessage({
            token: config.discordToken,
            channelId: config.discordChannelId,
            content: content.content,
            allowedMentions: content.allowedMentions,
            embeds: content.embeds
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
          const content = await buildProposalMessage({
            variant: "latest",
            daoLabel: latest.target.label,
            proposal: latest.proposal,
            realmPubkey: latest.target.realmPubkey,
            fetchDescriptionFromLink: config.fetchDescriptionFromLink,
            votingMention: config.discordVotingMention
          });
          await sendDiscordMessage({
            token: config.discordToken,
            channelId: config.discordChannelId,
            content: content.content,
            allowedMentions: content.allowedMentions,
            embeds: content.embeds
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
          const message = await buildProposalMessage({
            variant: "voting",
            daoLabel: latestVoting.target.label,
            proposal: latestVoting.proposal,
            realmPubkey: latestVoting.target.realmPubkey,
            fetchDescriptionFromLink: config.fetchDescriptionFromLink,
            votingMention: config.discordVotingMention
          });
          await sendDiscordMessage({
            token: config.discordToken,
            channelId: config.discordChannelId,
            content: message.content,
            allowedMentions: message.allowedMentions,
            embeds: message.embeds
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
          const message = await buildProposalMessage({
            variant: "created",
            daoLabel: target.label,
            proposal,
            realmPubkey: target.realmPubkey,
            fetchDescriptionFromLink: config.fetchDescriptionFromLink,
            votingMention: config.discordVotingMention
          });
          try {
            await sendDiscordMessage({
              token: config.discordToken,
              channelId: config.discordChannelId,
              content: message.content,
              allowedMentions: message.allowedMentions,
              embeds: message.embeds
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
        const message = await buildProposalMessage({
          variant: "voting",
          daoLabel: target.label,
          proposal,
          realmPubkey: target.realmPubkey,
          fetchDescriptionFromLink: config.fetchDescriptionFromLink,
          votingMention: config.discordVotingMention
        });
        try {
          await sendDiscordMessage({
            token: config.discordToken,
            channelId: config.discordChannelId,
            content: message.content,
            allowedMentions: message.allowedMentions,
            embeds: message.embeds
          });
          known.announcedVoting = true;
          votingPosted += 1;
        } catch (error) {
          sendErrors += 1;
          console.error(`[cron] failed voting send for ${target.label} ${proposal.pubkey}:`, error);
        }
      }

      if (!wasExecuted && nowExecuted) {
        const message = await buildProposalMessage({
          variant: "executed",
          daoLabel: target.label,
          proposal,
          realmPubkey: target.realmPubkey,
          fetchDescriptionFromLink: config.fetchDescriptionFromLink,
          votingMention: config.discordVotingMention
        });
        try {
          await sendDiscordMessage({
            token: config.discordToken,
            channelId: config.discordChannelId,
            content: message.content,
            allowedMentions: message.allowedMentions,
            embeds: message.embeds
          });
          executedPosted += 1;
        } catch (error) {
          sendErrors += 1;
          console.error(`[cron] failed executed send for ${target.label} ${proposal.pubkey}:`, error);
        }
      }

      if (!wasCompleted && nowCompleted) {
        const message = await buildProposalMessage({
          variant: "completed",
          daoLabel: target.label,
          proposal,
          realmPubkey: target.realmPubkey,
          fetchDescriptionFromLink: config.fetchDescriptionFromLink,
          votingMention: config.discordVotingMention
        });
        try {
          await sendDiscordMessage({
            token: config.discordToken,
            channelId: config.discordChannelId,
            content: message.content,
            allowedMentions: message.allowedMentions,
            embeds: message.embeds
          });
          completedPosted += 1;
        } catch (error) {
          sendErrors += 1;
          console.error(`[cron] failed completed send for ${target.label} ${proposal.pubkey}:`, error);
        }
      }

      if (!wasCancelled && nowCancelled) {
        const message = await buildProposalMessage({
          variant: "cancelled",
          daoLabel: target.label,
          proposal,
          realmPubkey: target.realmPubkey,
          fetchDescriptionFromLink: config.fetchDescriptionFromLink,
          votingMention: config.discordVotingMention
        });
        try {
          await sendDiscordMessage({
            token: config.discordToken,
            channelId: config.discordChannelId,
            content: message.content,
            allowedMentions: message.allowedMentions,
            embeds: message.embeds
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
