#!/bin/sh
set -e
grep -q 'session.hook("prompt"' .opencode/plugins/factory-guard/index.ts && echo PROMPT_OK
grep -q 'permission.hook("evaluate"' .opencode/plugins/factory-guard/index.ts && echo PERM_OK
grep -q 'tool.hook("execute.after"' .opencode/plugins/factory-guard/index.ts && echo TOOL_OK
grep -q 'session.hook("compaction"' .opencode/plugins/factory-guard/index.ts && echo COMPACT_OK
