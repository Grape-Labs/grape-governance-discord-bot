import type { ProposalRecord } from "./types.js";

function escapeGqlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function toNum(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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

    parsed.push({
      pubkey,
      governance,
      name: String(row.name || "Untitled Proposal"),
      descriptionLink: row.descriptionLink ? String(row.descriptionLink) : null,
      state: (row.state as string | number | null) ?? null,
      draftAt: toNum(row.draftAt),
      votingAt: row.votingAt != null ? toNum(row.votingAt) : null,
      maxVotingTime: row.maxVotingTime != null ? toNum(row.maxVotingTime) : null
    });
  }

  return parsed;
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

  const deduped = new Map<string, ProposalRecord>();
  for (const proposal of normalized) {
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
