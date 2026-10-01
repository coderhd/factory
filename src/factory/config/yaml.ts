/**
 * Shared YAML decode shim + duplicate-key scan (E11.4 #41 review). The shim
 * replaces the duplicated Bun.YAML access in `factoryConfig.ts` and
 * `policyLoader.ts`. The scan closes a decode hazard relevant to policy: Bun's
 * YAML (like most decoders) silently lets a duplicate mapping key last-win, so
 * a written `deny` could be silently dropped in favor of a later `allow` — an
 * authority widening against the operator's intent. `findDuplicateYamlKeys`
 * detects duplicated block-mapping keys *before* decode, so policy text can be
 * rejected loudly instead.
 *
 * Pragmatic, emit-style-shaped scanner: block mappings/sequences at consistent
 * indentation (what `serializeFactoryConfig` writes and what operators
 * plausibly hand-write), plus duplicate keys inside a one-line `{…}` flow
 * group. No anchors/aliases; block scalars (`|`/`>` followers) are skipped. A
 * duplicate outside the requested root (or in syntax the scan does not model)
 * yields no finding — the engine's other fail-closed layers still hold.
 */

export function parseYamlText(text: string): { value: unknown } | { error: string } {
  try {
    const yaml = (Bun as unknown as { YAML: { parse(input: string): unknown } }).YAML;
    return { value: yaml.parse(text) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export interface YamlDuplicateKeyIssue {
  /** Full dotted key path of the repeated key (e.g. `policy.organization…`). */
  path: string;
}

interface KeyFrame {
  /** The indent at which this mapping's keys appear. */
  childIndent: number;
  /** The full key path of this mapping itself ('' for the document root). */
  path: string;
  seen: Set<string>;
  /** The most recent key of this mapping (names the child mapping's path). */
  lastKey?: string;
}

const BLOCK_KEY = /^(\s*)(-\s+)?("([^"]*)"|'([^']*)'|[^:#]*?)\s*:(\s|$)/;
/** `|`, `|-`, `|+`, `>`, `>-`, `>+` (optionally with an indentation digit). */
const BLOCK_SCALAR_VALUE = /^[|>][+-]?[0-9]*$/;

export function findDuplicateYamlKeys(
  text: string,
  /** When set, only duplicates at/under this root key path are reported. */
  rootFilter?: string,
): YamlDuplicateKeyIssue[] {
  const issues: YamlDuplicateKeyIssue[] = [];
  const report = (path: string): void => {
    if (rootFilter === undefined || path === rootFilter || path.startsWith(`${rootFilter}.`)) {
      issues.push({ path });
    }
  };
  const childPath = (parent: { path: string; lastKey?: string }): string =>
    `${parent.path}${parent.path ? '.' : ''}${parent.lastKey ?? ''}`;

  const frames: KeyFrame[] = [{ childIndent: 0, path: '', seen: new Set() }];
  let blockScalarIndent: number | null = null;

  for (const rawLine of text.split('\n')) {
    const line = /^\s*#/.test(rawLine) ? '' : rawLine.replace(/\s+$/, '');
    if (line.trim().length === 0) continue;
    const indent = line.length - line.trimStart().length;
    if (blockScalarIndent !== null) {
      if (indent > blockScalarIndent) continue;
      blockScalarIndent = null;
    }

    const match = BLOCK_KEY.exec(line);
    if (!match) continue; // scalars / flow-only content carry no block key
    const [, whitespace, dash, quoted] = match;
    const key = (quoted ?? '').replace(/^['"]|['"]$/g, '').trim();
    if (key.length === 0) continue;
    const keyIndent = whitespace!.length + (dash ? 2 : 0);
    if (BLOCK_SCALAR_VALUE.test(line.slice(match.index + match[0].length).trim())) {
      blockScalarIndent = indent;
    }

    if (dash) {
      // A new sequence item: its mapping is fresh — drop the previous item's
      // frame (and anything nested in it), then open a new one.
      while (frames.length > 1 && frames[frames.length - 1]!.childIndent >= keyIndent) {
        frames.pop();
      }
      frames.push({ childIndent: keyIndent, path: childPath(frames[frames.length - 1]!), seen: new Set() });
    } else {
      while (frames.length > 1 && frames[frames.length - 1]!.childIndent > keyIndent) {
        frames.pop();
      }
      const frame = frames[frames.length - 1]!;
      if (frame.childIndent !== keyIndent) {
        // Lazily open the child mapping this key introduces.
        frames.push({ childIndent: keyIndent, path: childPath(frame), seen: new Set() });
      }
    }
    // The mapping this key belongs to (for a dash key: the fresh item frame,
    // whose own dup set starts empty by construction).
    const owner = frames[frames.length - 1]!;
    const plainKey = !key.includes('{') && !key.includes('[') && !key.includes('|');
    // A duplicate inside a one-line `{…}` flow value on this same line.
    const flowKeys = flowKeysIn(line);
    const flowReported = new Set<string>();
    for (const flowKey of flowKeys) {
      if (flowReported.has(flowKey)) continue;
      if (flowKeys.filter((candidate) => candidate === flowKey).length > 1) {
        flowReported.add(flowKey);
        report(
          `${plainKey ? `${childPath({ path: owner.path, lastKey: key })}` : `${owner.path.replace(/\.$/, '')}.<flow-item>`}:${flowKey} (flow)`,
        );
      }
    }
    if (!plainKey) continue;
    if (!dash) {
      if (owner.seen.has(key)) {
        report(childPath({ path: owner.path, lastKey: key }));
      } else {
        owner.seen.add(key);
      }
    }
    owner.lastKey = key;
  }

  return issues;
}

/** Keys inside the first one-line `{…}` group of the line, top level only:
 * deduped by the pre-`:` key token (quotes/boundaries stop the walk). */
function flowKeysIn(line: string): string[] {
  const open = line.indexOf('{');
  if (open < 0) return [];
  const keys: string[] = [];
  let key = '';
  let depth = 0;
  for (let i = open; i < line.length; i += 1) {
    const char = line[i]!;
    if (char === '{' || char === '[') {
      depth += 1;
      continue;
    }
    if (char === '}' || char === ']') break;
    if (char === ',' && depth === 1) {
      if (key) keys.push(key.split(':')[0]!.trim());
      key = '';
      continue;
    }
    if (depth === 1) key += char;
  }
  if (key) keys.push(key.split(':')[0]!.trim());
  return keys.filter((entry) => entry.length > 0 && !entry.includes('{') && !entry.includes('['));
}
