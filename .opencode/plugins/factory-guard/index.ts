import { Plugin } from "@opencode/plugin"
import { appendFileSync, mkdirSync } from "node:fs"
import {
  classifyTask,
  jevShadowSuggest,
  parseRouteOverride,
  parseTaskHint,
  selectModel,
  toGoModel,
  type BudgetState,
  type ModelId,
} from "./router.js"

// Budget state is supplied by the developer/session until live Go usage
// telemetry is wired in. Defaults = healthy budgets (no artificial scarcity).
let budgetState: BudgetState = { monthlyRemaining: 1, weeklyRemaining: 1, fiveHourRemaining: 1 };
const unavailable = new Set<ModelId>();

function logRoute(line: string) {
  try {
    mkdirSync(".factory", { recursive: true })
    appendFileSync(".factory/routing.log", line + "\n")
  } catch {}
}

export default Plugin.define({
  id: "factory-guard",
  async setup(ctx) {
    await ctx.session.hook("prompt", (event) => {
      const text = event.prompt.text
      const override = parseRouteOverride(text)
      const hint = parseTaskHint(text)
      const classified = classifyTask(text)
      const input = { ...classified, ...hint }
      // Jev stays shadow-only: logged, never applied.
      const shadow = jevShadowSuggest(input)
      let selected: ModelId
      let reason: string
      if (override && !unavailable.has(override)) {
        selected = override
        reason = `manual override /route ${override} (takes precedence).`
      } else {
        const decision = selectModel(input, budgetState, [...unavailable])
        selected = decision.selected
        reason = decision.reason
      }
      event.metadata = {
        ...event.metadata,
        ...input,
        route_model: toGoModel(selected),
        route_reason: reason,
        jev_shadow: shadow.note,
        factory: "WO-pending",
      }
      logRoute(JSON.stringify({ t: new Date().toISOString(), ...input, selected, reason, shadow: shadow.note }))
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
