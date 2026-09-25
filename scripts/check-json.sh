#!/bin/sh
set -e
python3 -c "import json; lines=open('opencode.jsonc').read().splitlines(); lines=[l for l in lines if not l.strip().startswith('//')]; json.loads('\n'.join(lines)); print('JSON_OK')"
test -f .opencode/plugins/factory-guard/index.ts && echo PLUGIN_OK || (echo MISSING_PLUGIN; exit 1)
