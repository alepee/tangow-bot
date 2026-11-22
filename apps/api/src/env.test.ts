import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const base = {
  DATABASE_URL: "postgres://tangow:tangow@127.0.0.1:5433/tangow",
  NODE_ENV: "test",
};

describe("loadEnv", () => {
  it("defaults the product path to workers, Docker, and Graphile Worker", () => {
    const env = loadEnv(base);
    expect(env.agentRuntime).toBe("worker");
    expect(env.sandboxProvider).toBe("docker");
    expect(env.wakeupDriver).toBe("graphile");
    expect(env.apiHost).toBe("127.0.0.1");
    expect(env.nodeEnv).toBe("test");
  });

  it("runs skill learning in shadow unless SKILL_LEARNING says otherwise", () => {
    expect(loadEnv(base).skillLearning).toBe("shadow");
    expect(loadEnv({ ...base, SKILL_LEARNING: "off" }).skillLearning).toBe("off");
    expect(loadEnv({ ...base, SKILL_LEARNING: "shadow" }).skillLearning).toBe("shadow");
    expect(loadEnv({ ...base, SKILL_LEARNING: "on" }).skillLearning).toBe("on");
  });

  it("keeps explicit emulator settings for pnpm test", () => {
    const env = loadEnv({
      ...base,
      AGENT_RUNTIME: "scripted",
      SANDBOX_PROVIDER: "fake",
      WAKEUP_DRIVER: "memory",
    });
    expect(env.agentRuntime).toBe("scripted");
    expect(env.sandboxProvider).toBe("fake");
    expect(env.wakeupDriver).toBe("memory");
  });
});
