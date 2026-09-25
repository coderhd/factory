#!/bin/sh
set -e
grep -q "glm-5.3-flash" opencode.jsonc && echo CHEAP_OK
grep -qv "muse-spark" opencode.jsonc && echo NO_MUSE_OK
test -f .opencode/plugins/factory-guard/routing-notes.md && echo NOTES_OK
