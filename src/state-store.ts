import fs from "node:fs/promises";
import path from "node:path";
import { Redis } from "@upstash/redis";
import type { BotState } from "./types.js";

const EMPTY_STATE: BotState = {
  initialized: false,
  proposals: {},
  seededTargets: {},
  testPostLatestProposalDone: false,
  testPostLatestProposalDoneByTarget: {}
};

export interface StateStore {
  load(): Promise<BotState>;
  save(state: BotState): Promise<void>;
}

export class FileStateStore implements StateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<BotState> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as BotState;
      return {
        initialized: Boolean(parsed?.initialized),
        proposals: parsed?.proposals ?? {},
        seededTargets: parsed?.seededTargets ?? {},
        testPostLatestProposalDone: Boolean(parsed?.testPostLatestProposalDone),
        testPostLatestProposalDoneByTarget: parsed?.testPostLatestProposalDoneByTarget ?? {}
      };
    } catch {
      return { ...EMPTY_STATE };
    }
  }

  async save(state: BotState): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(state, null, 2), "utf8");
  }
}

export class RedisStateStore implements StateStore {
  private readonly redis: Redis;

  constructor(private readonly stateKey: string) {
    this.redis = Redis.fromEnv();
  }

  async load(): Promise<BotState> {
    try {
      const parsed = await this.redis.get<BotState>(this.stateKey);
      return {
        initialized: Boolean(parsed?.initialized),
        proposals: parsed?.proposals ?? {},
        seededTargets: parsed?.seededTargets ?? {},
        testPostLatestProposalDone: Boolean(parsed?.testPostLatestProposalDone),
        testPostLatestProposalDoneByTarget: parsed?.testPostLatestProposalDoneByTarget ?? {}
      };
    } catch {
      return { ...EMPTY_STATE };
    }
  }

  async save(state: BotState): Promise<void> {
    await this.redis.set(this.stateKey, state);
  }
}
