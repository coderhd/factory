# Worker and Execution Architecture

A Worker is a controlled execution environment allocated by a Factory to perform Work. It can host agents, tools, processes, human interaction and domain-specific runtimes. An Agent is not a durable Root entity.

```text
Factory → Worker → Execution Runtime
```

Software uses the initial Herdr adapter and may host OpenCode/Codex/Claude Code/Pi. Quant uses research/compute runtimes. Growth may use browser/API/content runtimes.

No custom universal agent framework is required. Frameworks such as LangGraph, LangChain, CrewAI, AutoGen or BeeAI are optional implementation choices, not architecture prerequisites.
