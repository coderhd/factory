import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  budgetAllows,
  candidatesFor,
  classifyTask,
  jevShadowSuggest,
  parseRouteOverride,
  parseTaskHint,
  selectModel,
} from "./router.js";

const FULL = { monthlyRemaining: 1, weeklyRemaining: 1, fiveHourRemaining: 1 };

describe("routing matrix", () => {
  it("exploration -> mimo flash first", () => {
    assert.equal(candidatesFor({ task: "exploration", complexity: "normal", risk: "low", context: "small" })[0], "mimo-v2.6-flash");
  });
  it("simple implementation -> glm flash first", () => {
    assert.equal(candidatesFor({ task: "implementation", complexity: "simple", risk: "low", context: "small" })[0], "glm-5.3-flash");
  });
  it("normal implementation -> qwen flash first", () => {
    assert.equal(candidatesFor({ task: "implementation", complexity: "normal", risk: "low", context: "medium" })[0], "qwen3.8-flash");
  });
  it("complex implementation -> deepseek flash first", () => {
    assert.equal(candidatesFor({ task: "implementation", complexity: "complex", risk: "medium", context: "medium" })[0], "deepseek-v4.1-flash");
  });
  it("debugging -> deepseek flash first", () => {
    assert.equal(candidatesFor({ task: "debugging", complexity: "complex", risk: "medium", context: "large" })[0], "deepseek-v4.1-flash");
  });
  it("planning -> glm 5.3 first", () => {
    assert.equal(candidatesFor({ task: "planning", complexity: "complex", risk: "medium", context: "medium" })[0], "glm-5.3");
  });
  it("architecture -> glm 5.3 first", () => {
    assert.equal(candidatesFor({ task: "architecture", complexity: "complex", risk: "medium", context: "medium" })[0], "glm-5.3");
  });
  it("normal review -> mimo pro first", () => {
    assert.equal(candidatesFor({ task: "code-review", complexity: "normal", risk: "low", context: "medium" })[0], "mimo-v2.6-pro");
  });
  it("high-risk review -> qwen max first", () => {
    assert.equal(candidatesFor({ task: "code-review", complexity: "complex", risk: "high", context: "medium" })[0], "qwen3.8-max");
  });
  it("second opinion -> gpt-6 luna first", () => {
    assert.equal(candidatesFor({ task: "second-opinion", complexity: "normal", risk: "low", context: "small" })[0], "gpt-6-luna");
  });
  it("test generation -> qwen flash first", () => {
    assert.equal(candidatesFor({ task: "test-generation", complexity: "normal", risk: "low", context: "small" })[0], "qwen3.8-flash");
  });
});

describe("budget + fallback", () => {
  it("budget exhausted skips escalation", () => {
    const low = { monthlyRemaining: 0.1, weeklyRemaining: 0.1, fiveHourRemaining: 0.1 };
    assert.equal(budgetAllows("qwen3.8-max", low), false);
    assert.equal(budgetAllows("grok-4.7", low), false);
    assert.equal(budgetAllows("kimi-k3", low), false);
  });
  it("high-risk review falls back to mimo pro when escalation blocked", () => {
    const low = { monthlyRemaining: 0.1, weeklyRemaining: 0.1, fiveHourRemaining: 0.1 };
    const d = selectModel({ task: "code-review", complexity: "complex", risk: "high", context: "medium" }, low, []);
    assert.equal(d.selected, "mimo-v2.6-pro");
  });
  it("unavailable model falls back in order, not to most expensive", () => {
    const d = selectModel(
      { task: "implementation", complexity: "normal", risk: "low", context: "medium" },
      FULL,
      ["qwen3.8-flash"],
    );
    assert.equal(d.selected, "glm-5.3-flash");
  });
  it("routine tasks never select escalation models", () => {
    for (const task of ["exploration", "implementation", "test-generation", "documentation"] as const) {
      const d = selectModel({ task, complexity: "normal", risk: "low", context: "small" }, FULL, []);
      assert.ok(!["qwen3.8-max", "grok-4.7", "kimi-k3"].includes(d.selected), `${task} -> ${d.selected}`);
    }
  });
});

describe("overrides", () => {
  it("/route override parses", () => {
    assert.equal(parseRouteOverride("/route grok-4.7 please"), "grok-4.7");
    assert.equal(parseRouteOverride("/route kimi-k3"), "kimi-k3");
    assert.equal(parseRouteOverride("no override here"), null);
  });
  it("task hints parse", () => {
    assert.equal(parseTaskHint("@plan this")?.task, "planning");
    assert.equal(parseTaskHint("@debug this")?.task, "debugging");
    assert.equal(parseTaskHint("@review this")?.task, "code-review");
  });
  it("classifier separates review from implementation", () => {
    assert.equal(classifyTask("please review this PR diff").task, "code-review");
    assert.equal(classifyTask("implement the login endpoint").task, "implementation");
  });
  it("classifier catches bug/crash/docs keywords", () => {
    assert.equal(classifyTask("find the bug in checkout").task, "debugging");
    assert.equal(classifyTask("the app crashes on startup").task, "debugging");
    assert.equal(classifyTask("update the docs for config").task, "documentation");
  });
  it("classifier handles adversarial phrasings", () => {
    assert.equal(classifyTask("the build is broken after the merge").task, "debugging");
    assert.equal(classifyTask("propose a new system architecture").task, "architecture");
    assert.equal(classifyTask("break down the epic into tickets").task, "planning");
    assert.equal(classifyTask("LGTM the diff").task, "code-review");
    assert.equal(classifyTask("summarize the reproduction steps").task, "exploration");
    assert.equal(classifyTask("update the product roadmap").task, "planning");
    assert.equal(classifyTask("update the product roadmap").risk, "low");
  });
  it("classifier routes questions and shows as exploration", () => {
    assert.equal(classifyTask("what does this regex do").task, "exploration");
    assert.equal(classifyTask("show me the auth flow").task, "exploration");
    assert.equal(classifyTask("walk me through the deploy pipeline").task, "exploration");
  });
  it("classifier captures architecture review and build verbs", () => {
    assert.equal(classifyTask("review the architecture").task, "architecture");
    assert.equal(classifyTask("architect the new billing service").task, "architecture");
  });
  it("classifier separates fail-words into debugging vs CI", () => {
    assert.equal(classifyTask("the build failed on the release branch").task, "debugging");
    assert.equal(classifyTask("CI pipeline is red").task, "ci-troubleshooting");
    assert.equal(classifyTask("the spec suite fails randomly").task, "test-debugging");
  });
  it("classifier knows expanded review nouns and security verbs", () => {
    assert.equal(classifyTask("review the config file").task, "code-review");
    assert.equal(classifyTask("harden the login against brute force").task, "security-review");
    assert.equal(classifyTask("pen test the checkout API").task, "security-review");
    assert.equal(classifyTask("fuzz the upload parser").task, "adversarial-review");
    assert.equal(classifyTask("clean up the date utils").task, "refactoring");
    assert.equal(classifyTask("migrate the cache to redis").risk, "high");
  });
  it("classifier is not fooled by substrings", () => {
    assert.equal(classifyTask("explain this stack trace from prod").complexity, "normal");
    assert.equal(classifyTask("write a test that reproduces the crash").risk, "low");
    assert.equal(classifyTask("use dependency injection for the service").task, "implementation");
    assert.equal(classifyTask("read the specific file for details").task, "exploration");
    assert.equal(classifyTask("review the plan document").task, "planning");
    assert.equal(classifyTask("review the payment flow").task, "code-review");
  });
});

describe("jev + DecisionModel invariants", () => {
  it("jev shadow never claims active routing", () => {
    const s = jevShadowSuggest({ task: "planning", complexity: "complex", risk: "medium", context: "medium" });
    assert.match(s.note, /shadow-only/);
  });
});
