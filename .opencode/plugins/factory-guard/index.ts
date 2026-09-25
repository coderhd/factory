import { Plugin } from "@opencode/plugin"
import { appendFileSync, mkdirSync } from "node:fs"

function labelTask(text: string): string {
  if (/(hotfix|prod.*down|migration|auth|payment|security)/i.test(text)) return "complex"
  if (/(explore|search|explain|summar|list|read)/i.test(text)) return "trivial"
  return "routine"
}

export default Plugin.define({
  id: "factory-guard",
  async setup(ctx) {
    await ctx.session.hook("prompt", (event) => {
      const label = labelTask(event.prompt.text)
      event.metadata = { ...event.metadata, complexity: label, factory: "WO-pending" }
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
