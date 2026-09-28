import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

mock.module("@opencode/plugin", () => ({
  Plugin: { define: (x: unknown) => x },
}));

type HookFn = (event: any) => Promise<void> | void;

function makeCtx() {
  const hooks: Record<string, HookFn> = {};
  const switchModelCalls: unknown[] = [];
  return {
    hooks,
    switchModelCalls,
    ctx: {
      session: {
        hook: async (name: string, fn: HookFn) => {
          hooks[name] = fn;
        },
        switchModel: async (args: unknown) => {
          switchModelCalls.push(args);
        },
      },
      permission: { hook: async () => {} },
      tool: { hook: async () => {} },
    },
  };
}

const REAL_FETCH = globalThis.fetch;
const REAL_KEY = process.env.SPAN_API_KEY;

const ALL_TASKS = [
  "exploration", "repository-analysis", "planning", "architecture",
  "implementation", "refactoring", "debugging", "test-generation",
  "test-debugging", "ci-troubleshooting", "documentation", "code-review",
  "security-review", "adversarial-review", "second-opinion",
  "large-context-analysis",
];
const ALL_CX = ["trivial", "simple", "normal", "complex"];

function stubFetch(answers: Record<string, { noul: number }>) {
  const full: Record<string, { noul: number }> = {};
  for (const t of ALL_TASKS) full[`task_${t}`] = { noul: 0.01 };
  for (const c of ALL_CX) full[`cx_${c}`] = { noul: 0.05 };
  full["cx_normal"] = { noul: 0.8 };
  full["high_risk"] = { noul: 0.1 };
  Object.assign(full, answers);
  (globalThis as any).fetch = async () => ({
    ok: true,
    json: async () => ({ answers: full }),
  });
}

function spanAnswers(top: string, topP: number) {
  return {
    [`task_${top}`]: { noul: topP },
    cx_normal: { noul: 0.8 },
    high_risk: { noul: 0.1 },
  };
}

beforeEach(() => {
  process.env.SPAN_API_KEY = "test-key";
});

afterEach(() => {
  (globalThis as any).fetch = REAL_FETCH;
  if (REAL_KEY === undefined) delete process.env.SPAN_API_KEY;
  else process.env.SPAN_API_KEY = REAL_KEY;
});

describe("prompt hook admission", () => {
  it("manual override pins the session and never calls span", async () => {
    let fetchCalls = 0;
    (globalThis as any).fetch = async () => {
      fetchCalls++;
      throw new Error("must not fetch");
    };
    const { ctx, hooks } = makeCtx();
    const plugin = (await import("./index.js")).default as any;
    await plugin.setup(ctx);
    const event: any = { prompt: { text: "/route grok-4.7 do it" }, metadata: {} };
    await hooks.prompt(event);
    expect(event.metadata.route_model).toBe("opencode-go/grok-4.7");
    expect(fetchCalls).toBe(0);
  });

  it("pinned sessions record only without refetching", async () => {
    let fetchCalls = 0;
    (globalThis as any).fetch = async () => {
      fetchCalls++;
      return { ok: true, json: async () => ({ answers: {} }) };
    };
    const { ctx, hooks, switchModelCalls } = makeCtx();
    const plugin = (await import("./index.js")).default as any;
    await plugin.setup(ctx);
    const first: any = {
      prompt: { text: "implement the login endpoint" },
      metadata: {},
      sessionID: "s-pin",
    };
    await hooks.prompt(first);
    const afterFirst = fetchCalls;
    expect(switchModelCalls.length).toBe(0);
    const second: any = {
      prompt: { text: "now debug the flaky test" },
      metadata: {},
      sessionID: "s-pin",
    };
    await hooks.prompt(second);
    expect(fetchCalls).toBe(afterFirst);
    expect(second.metadata.route_model).toBe(first.metadata.route_model);
  });

  it("high margin records the span route without switching", async () => {
    stubFetch({
      ...spanAnswers("debugging", 0.9),
      task_implementation: { noul: 0.05 },
    });
    const { ctx, hooks, switchModelCalls } = makeCtx();
    const plugin = (await import("./index.js")).default as any;
    await plugin.setup(ctx);
    const event: any = {
      prompt: { text: "anything at all" },
      metadata: {},
      sessionID: "s-span-ok",
    };
    await hooks.prompt(event);
    expect(event.metadata.route_model).toContain("opencode-go/");
    expect(event.metadata.route_reason).toMatch(/span triage/);
    expect(switchModelCalls.length).toBe(0);
  });

  it("low margin appeals via switchModel to glm-5.3-flash", async () => {
    stubFetch({
      task_debugging: { noul: 0.5 },
      task_implementation: { noul: 0.45 },
      cx_normal: { noul: 0.8 },
      high_risk: { noul: 0.1 },
    });
    const { ctx, hooks, switchModelCalls } = makeCtx();
    const plugin = (await import("./index.js")).default as any;
    await plugin.setup(ctx);
    const event: any = {
      prompt: { text: "anything at all" },
      metadata: {},
      sessionID: "s-appeal",
    };
    await hooks.prompt(event);
    expect(switchModelCalls.length).toBe(1);
    expect(switchModelCalls[0]).toEqual({
      sessionID: "s-appeal",
      model: { providerID: "opencode-go", id: "glm-5.3-flash" },
    });
    expect(event.metadata.route_reason).toMatch(/appealed/);
  });

  it("span failure falls back to rules without throwing", async () => {
    (globalThis as any).fetch = async () => {
      throw new Error("network down");
    };
    const { ctx, hooks, switchModelCalls } = makeCtx();
    const plugin = (await import("./index.js")).default as any;
    await plugin.setup(ctx);
    const event: any = {
      prompt: { text: "implement the login endpoint" },
      metadata: {},
      sessionID: "s-fallback",
    };
    await hooks.prompt(event);
    expect(event.metadata.route_model).toContain("opencode-go/");
    expect(event.metadata.route_reason).toMatch(/rules fallback/);
    expect(switchModelCalls.length).toBe(0);
  });
});
