export type ProposalRecord = {
  pubkey: string;
  governance: string;
  name: string;
  descriptionLink: string | null;
  tokenOwnerRecord: string | null;
  authorWallet: string | null;
  instructionsCount: number | null;
  state: string | number | null;
  draftAt: number;
  votingAt: number | null;
  maxVotingTime: number | null;
};

export type KnownProposalState = {
  lastState: string | number | null;
  announcedCreated: boolean;
  announcedVoting: boolean;
};

export type BotState = {
  initialized: boolean;
  proposals: Record<string, KnownProposalState>;
  seededTargets: Record<string, boolean>;
  testPostLatestProposalDone: boolean;
  testPostLatestProposalDoneByTarget: Record<string, boolean>;
};
