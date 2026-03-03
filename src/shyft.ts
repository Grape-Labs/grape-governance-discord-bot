import type { ProposalRecord } from "./types.js";

function escapeGqlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function toNum(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function chunk<T>(values: T[], size: number): T[][] {
  if (size <= 0) return [values];
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

async function fetchGraphql(url: string, query: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept-encoding": "gzip"
    },
    body: JSON.stringify({ query })
  });

  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as {
    data?: Record<string, unknown>;
    errors?: Array<{ message?: string }>;
  };

  if (json.errors?.length) {
    const message = json.errors.map((e) => e?.message || "Unknown GraphQL error").join("; ");
    throw new Error(message);
  }

  return json.data ?? {};
}

export async function fetchGovernancePubkeysForRealm(
  shyftUrl: string,
  programNamespace: string,
  realmPubkey: string
): Promise<string[]> {
  const realm = escapeGqlString(realmPubkey);
  const query = `
    query RealmGovernances {
      ${programNamespace}_GovernanceV2(where: { realm: { _eq: "${realm}" } }) {
        pubkey
      }
      ${programNamespace}_GovernanceV1(where: { realm: { _eq: "${realm}" } }) {
        pubkey
      }
    }
  `;

  const data = await fetchGraphql(shyftUrl, query);
  const v2Key = `${programNamespace}_GovernanceV2`;
  const v1Key = `${programNamespace}_GovernanceV1`;
  const rows = [
    ...(((data[v2Key] as Array<{ pubkey?: string }>) || [])),
    ...(((data[v1Key] as Array<{ pubkey?: string }>) || []))
  ];

  const keys = new Set<string>();
  for (const row of rows) {
    if (row?.pubkey) keys.add(row.pubkey);
  }

  return Array.from(keys);
}

function normalizeProposalRows(rows: unknown[]): ProposalRecord[] {
  const parsed: ProposalRecord[] = [];

  for (const row of rows as Array<Record<string, unknown>>) {
    const pubkey = String(row.pubkey || "");
    const governance = String(row.governance || "");
    if (!pubkey || !governance) continue;
    const tokenOwnerRecord = row.tokenOwnerRecord ? String(row.tokenOwnerRecord) : null;

    parsed.push({
      pubkey,
      governance,
      name: String(row.name || "Untitled Proposal"),
      descriptionLink: row.descriptionLink ? String(row.descriptionLink) : null,
      tokenOwnerRecord,
      authorWallet: null,
      instructionsCount: null,
      state: (row.state as string | number | null) ?? null,
      draftAt: toNum(row.draftAt),
      votingAt: row.votingAt != null ? toNum(row.votingAt) : null,
      maxVotingTime: row.maxVotingTime != null ? toNum(row.maxVotingTime) : null
    });
  }

  return parsed;
}

async function fetchProposalInstructionCountMap(params: {
  shyftUrl: string;
  programNamespace: string;
  proposalPubkeys: string[];
}): Promise<Map<string, number>> {
  const unique = Array.from(new Set(params.proposalPubkeys.filter(Boolean)));
  if (!unique.length) return new Map();

  const result = new Map<string, number>();
  const batches = chunk(unique, 200);

  for (const batch of batches) {
    const gqlList = batch.map((pubkey) => `"${escapeGqlString(pubkey)}"`).join(", ");
    const query = `
      query ProposalTransactions {
        ${params.programNamespace}_ProposalTransactionV2(where: { proposal: { _in: [${gqlList}] } }) {
          proposal
        }
        ${params.programNamespace}_ProposalTransactionV1(where: { proposal: { _in: [${gqlList}] } }) {
          proposal
        }
      }
    `;

    try {
      const data = await fetchGraphql(params.shyftUrl, query);
      const rows = [
        ...(((data[`${params.programNamespace}_ProposalTransactionV2`] as Array<Record<string, unknown>>) || [])),
        ...(((data[`${params.programNamespace}_ProposalTransactionV1`] as Array<Record<string, unknown>>) || []))
      ];

      for (const row of rows) {
        const proposal = row?.proposal ? String(row.proposal) : "";
        if (!proposal) continue;
        result.set(proposal, (result.get(proposal) || 0) + 1);
      }
    } catch (error) {
      console.error(
        `[shyft] proposal transaction lookup failed for program=${params.programNamespace} batchSize=${batch.length}:`,
        error
      );
    }
  }

  return result;
}

async function fetchTokenOwnerWalletMap(params: {
  shyftUrl: string;
  programNamespace: string;
  tokenOwnerRecordPubkeys: string[];
}): Promise<Map<string, string>> {
  const unique = Array.from(new Set(params.tokenOwnerRecordPubkeys.filter(Boolean)));
  if (!unique.length) return new Map();

  const result = new Map<string, string>();
  const batches = chunk(unique, 200);

  for (const batch of batches) {
    const gqlList = batch.map((pubkey) => `"${escapeGqlString(pubkey)}"`).join(", ");
    const query = `
      query TokenOwnerRecords {
        ${params.programNamespace}_TokenOwnerRecordV2(where: { pubkey: { _in: [${gqlList}] } }) {
          pubkey
          governingTokenOwner
        }
        ${params.programNamespace}_TokenOwnerRecordV1(where: { pubkey: { _in: [${gqlList}] } }) {
          pubkey
          governingTokenOwner
        }
      }
    `;

    try {
      const data = await fetchGraphql(params.shyftUrl, query);
      const rows = [
        ...(((data[`${params.programNamespace}_TokenOwnerRecordV2`] as Array<Record<string, unknown>>) || [])),
        ...(((data[`${params.programNamespace}_TokenOwnerRecordV1`] as Array<Record<string, unknown>>) || []))
      ];

      for (const row of rows) {
        const pubkey = row?.pubkey ? String(row.pubkey) : "";
        const owner = row?.governingTokenOwner ? String(row.governingTokenOwner) : "";
        if (pubkey && owner && !result.has(pubkey)) {
          result.set(pubkey, owner);
        }
      }
    } catch (error) {
      console.error(
        `[shyft] token owner lookup failed for program=${params.programNamespace} batchSize=${batch.length}:`,
        error
      );
    }
  }

  return result;
}

export async function fetchRealmProposals(params: {
  shyftUrl: string;
  programNamespace: string;
  realmPubkey: string;
  limit: number;
}): Promise<ProposalRecord[]> {
  const governancePubkeys = await fetchGovernancePubkeysForRealm(
    params.shyftUrl,
    params.programNamespace,
    params.realmPubkey
  );

  if (governancePubkeys.length === 0) return [];

  const gqlList = governancePubkeys
    .map((pubkey) => `"${escapeGqlString(pubkey)}"`)
    .join(", ");

  const safeLimit = Math.max(1, params.limit);
  const query = `
    query RealmProposals {
      ${params.programNamespace}_ProposalV2(
        where: { governance: { _in: [${gqlList}] } }
        order_by: { draftAt: desc }
        limit: ${safeLimit}
      ) {
        pubkey
        governance
        name
        descriptionLink
        tokenOwnerRecord
        state
        draftAt
        votingAt
        maxVotingTime
      }
      ${params.programNamespace}_ProposalV1(
        where: { governance: { _in: [${gqlList}] } }
        order_by: { draftAt: desc }
        limit: ${safeLimit}
      ) {
        pubkey
        governance
        name
        descriptionLink
        tokenOwnerRecord
        state
        draftAt
        votingAt
      }
    }
  `;

  const data = await fetchGraphql(params.shyftUrl, query);
  const v2Rows = (data[`${params.programNamespace}_ProposalV2`] as unknown[]) || [];
  const v1Rows = (data[`${params.programNamespace}_ProposalV1`] as unknown[]) || [];
  const normalized = [...normalizeProposalRows(v2Rows), ...normalizeProposalRows(v1Rows)];
  const tokenOwnerWalletMap = await fetchTokenOwnerWalletMap({
    shyftUrl: params.shyftUrl,
    programNamespace: params.programNamespace,
    tokenOwnerRecordPubkeys: normalized.map((proposal) => proposal.tokenOwnerRecord || "")
  });
  const proposalInstructionCountMap = await fetchProposalInstructionCountMap({
    shyftUrl: params.shyftUrl,
    programNamespace: params.programNamespace,
    proposalPubkeys: normalized.map((proposal) => proposal.pubkey)
  });
  const normalizedWithAuthors = normalized.map((proposal) => ({
    ...proposal,
    authorWallet: proposal.tokenOwnerRecord ? tokenOwnerWalletMap.get(proposal.tokenOwnerRecord) || null : null,
    instructionsCount: proposalInstructionCountMap.get(proposal.pubkey) ?? 0
  }));

  const deduped = new Map<string, ProposalRecord>();
  for (const proposal of normalizedWithAuthors) {
    if (!deduped.has(proposal.pubkey)) {
      deduped.set(proposal.pubkey, proposal);
      continue;
    }

    const current = deduped.get(proposal.pubkey)!;
    if (proposal.draftAt > current.draftAt) {
      deduped.set(proposal.pubkey, proposal);
    }
  }

  return Array.from(deduped.values()).sort((a, b) => b.draftAt - a.draftAt);
}
