import fs from "node:fs/promises";
import path from "node:path";
import type { BotState } from "./types.js";

const EMPTY_STATE: BotState = {
  initialized: false,
  proposals: {}
};

export class StateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<BotState> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as BotState;
      return {
        initialized: Boolean(parsed?.initialized),
        proposals: parsed?.proposals ?? {}
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
