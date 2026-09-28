import { Plugin } from "@opencode/plugin"
import { appendFileSync, mkdirSync } from "node:fs"
import {
  APPEAL_MODEL,
  GO_PROVIDER,
  SPAN_TIMEOUT_MS,
  classifyTask,
  decideAction,
  jevShadowSuggest,
  parseRouteOverride,
  parseTaskHint,
  selectModel,
  toGoModel,
  type BudgetState,
  type ModelId,
  type SpanVerdict,
} from "./router.js"
import { requestSpanVerdict } from "./span.js"

// Budget state is supplied by the developer/session until live Go usage
// telemetry is wired in. Defaults = healthy budgets (no artificial scarcity).
let budgetState: BudgetState = { monthlyRemaining: 1, weeklyRemaining: 1, fiveHourRemaining: 1 };
const unavailable = new Set<ModelId>();

// Admission state: route once per task, pin the session, never re-route.
// Pinned sessions record only. Unknown sessions (no id) stay rules-only.
const pinnedSessions = new Set<string>();
const pinnedRoutes = new Map<string, { model: string; reason: string }>();

function logRoute(line: string) {
  try {
    mkdirSync(".factory", { recursive: true })
    appendFileSync(".factory/routing.log", line + "\n")
  } catch {}
}

async function spanTriage(text: string, apiKey: string): Promise<SpanVerdict | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SPAN_TIMEOUT_MS);
  try {
    return await requestSpanVerdict(
      text,
      apiKey,
      async (url, body, _timeoutMs, key) => {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "factory-router-trial/1.0",
            ...(key ? { Authorization: `Bearer ${key}` } : {}),
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`span HTTP ${res.status}`);
        return (await res.json()) as unknown;
      },
      SPAN_TIMEOUT_MS,
    );
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default Plugin.define({
  id: "factory-guard",
  async setup(ctx) {
    await ctx.session.hook("prompt", async (event) => {
      const text = event.prompt.text
      const override = parseRouteOverride(text)
      const hint = parseTaskHint(text)
      const classified = classifyTask(text)
      const input = { ...classified, ...hint }
      // Jev stays shadow-only: logged, never applied.
      const shadow = jevShadowSuggest(input)
      const sessionID: string | null =
        (event as any).sessionID ?? (event as any).session?.id ?? null
      const base = { ...input, jev_shadow: shadow.note, factory: "WO-pending" }
      const commit = (meta: object) => {
        event.metadata = { ...event.metadata, ...meta }
        logRoute(JSON.stringify({ t: new Date().toISOString(), ...input, ...meta }))
      }

      if (override && !unavailable.has(override)) {
        if (sessionID) {
          pinnedSessions.add(sessionID)
          pinnedRoutes.set(sessionID, {
            model: toGoModel(override),
            reason: `manual override /route ${override} (takes precedence).`,
          })
        }
        commit({
          ...base,
          route_model: toGoModel(override),
          route_reason: `manual override /route ${override} (takes precedence).`,
        })
        return
      }

      if (sessionID && pinnedSessions.has(sessionID)) {
        const pinned = pinnedRoutes.get(sessionID)
        commit({
          ...base,
          route_model: pinned?.model ?? toGoModel("glm-5.3-flash"),
          route_reason: pinned?.reason ?? "pinned session: record only, no re-routing.",
        })
        return
      }

      // Admission: Span default, rules fallback. Exactly one decision per task.
      const apiKey = process.env.SPAN_API_KEY ?? "";
      const verdict = sessionID && apiKey ? await spanTriage(text, apiKey) : null;
      const action = decideAction({
        sessionPinned: false,
        spanOk: verdict !== null,
        span: verdict ?? undefined,
        rules: input,
        budget: budgetState,
        unavailable: [...unavailable],
      });

      if (action.kind === "appeal") {
        if (sessionID) {
          try {
            await ctx.session.switchModel({
              sessionID,
              model: { providerID: GO_PROVIDER, id: APPEAL_MODEL },
            })
          } catch {}
          pinnedSessions.add(sessionID)
        }
        const model = toGoModel(action.decision.selected);
        const reason =
          `span margin ${action.brief && (action.brief as any).span
            ? ((action.brief as any).span.margin ?? "?") : "?"} < threshold; ` +
          `appealed to ${action.decision.selected}. ${action.decision.reason}`;
        if (sessionID) pinnedRoutes.set(sessionID, { model, reason });
        commit({ ...base, route_model: model, route_reason: reason });
        return;
      }

      const model = toGoModel(action.decision.selected);
      const reason =
        action.source === "span"
          ? `span triage (${action.decision.reason})`
          : `rules fallback, span unavailable (${action.decision.reason})`;
      if (sessionID) {
        pinnedSessions.add(sessionID)
        pinnedRoutes.set(sessionID, { model, reason })
      }
      commit({
        ...base,
        route_model: model,
        route_reason: reason,
        span_margin: action.source === "span" ? "ok" : "unavailable",
      });
    })
    await ctx.session.hook("context", (event) => {
      event.system.push({ type: "text", text: "Verify against acceptance criteria. Cite evidence paths. No success without evidence." })
    })
    await ctx.permission.hook("evaluate", async (event) => {
      const res = event.resources.join(" ")
      if (/push.*main/.test(res) && event.action === "shell") { event.effect = "deny"; event.message = "Direct main push blocked. Open a PR." }
      if (event.action === "edit" && /\.env/.test(res)) { event.effect = "deny"; event.message = "Secrets blocked." }
    })
    await ctx.tool.hook("execute.after", (event) => {
      if (event.status !== "completed") return
      try {
        mkdirSync(".factory", { recursive: true })
        appendFileSync(".factory/evidence.log", JSON.stringify({ t: new Date().toISOString(), tool: (event as any).tool, status: event.status }) + "\n")
      } catch {}
    })
    await ctx.session.hook("compaction", async (_event) => {})
    await ctx.session.hook("title", (event) => { event.result ??= "factory-task" })
  },
})
