import { existsSync } from 'node:fs';

import type { HerdrCli } from '../../../src/factory/workers/herdr';

/**
 * The one shared in-process `herdr` CLI fake (the hermetic seam, R5/R6) used by
 * the factory test suites. It records every invocation, tracks a workspace +
 * tabs, answers `agent get` with a configurable state, and lets a test decide
 * what `agent prompt` does (e.g. "the harness wrote its report and committed").
 *
 * It carries **no assertions**: an `expect` hidden inside a double masks the
 * failing test and owns its coverage opaquely. Tests own every assertion, over
 * `calls` / `openTabs()`.
 */

/** A workspace the fake herdr server tracks. */
export interface FakeWorkspace {
  id: string;
  label: string;
  tabs: FakeTab[];
}

/** A tab the fake herdr server tracks (so tests can assert zero tabs at rest). */
export interface FakeTab {
  id: string;
  pane: string;
  cwd: string;
  label: string;
  closed: boolean;
}

/** The parsed herdr CLI document shape the adapter consumes (`.result.*`). */
export type HerdrDoc = Record<string, unknown>;

export class FakeHerdrCli implements HerdrCli {
  calls: string[][] = [];
  workspaces = new Map<string, FakeWorkspace>();
  agentState = 'running';
  /** Test hook: drop `root_pane` from a `tab create` payload (malformed payload). */
  omitRootPane = false;
  /** Set by the test: invoked on `agent prompt <name> <text>` before settling. */
  onPrompt: ((prompt: string, cwd: string) => void) | null = null;
  /** Extra text a `--wait` prompt reports back; drives nothing but gets recorded. */
  onAnswer = true;
  /**
   * Set by the test: when non-null, the `agent prompt`/`send-keys` invocation
   * throws it. Simulates a harness whose channel dies mid-turn (e.g. a thrown
   * answer turn), so the adapter's error-surfacing paths can be pinned.
   */
  promptError: Error | null = null;

  callsMatching(prefix: string): string[][] {
    return this.calls.filter((args) => args[0] === prefix);
  }

  openTabs(): FakeTab[] {
    const tabs: FakeTab[] = [];
    for (const ws of this.workspaces.values()) tabs.push(...ws.tabs);
    return tabs.filter((tab) => !tab.closed);
  }

  async run(args: readonly string[]): Promise<HerdrDoc> {
    const argv = [...args];
    this.calls.push(argv);
    const value = (key: string): string => {
      const index = argv.indexOf(`--${key}`);
      if (index < 0 || argv[index + 1] === undefined) throw new Error(`missing --${key}`);
      return argv[index + 1]!;
    };
    const sub = argv[1];
    if (argv[0] === 'workspace' && sub === 'list') {
      return { result: [...this.workspaces.values()].map((ws) => ({ id: ws.id, label: ws.label })) };
    }
    if (argv[0] === 'workspace' && sub === 'create') {
      const label = value('label');
      const id = `ws_${label}`;
      if (this.workspaces.has(id)) throw new Error(`workspace already exists: ${label}`);
      this.workspaces.set(id, { id, label, tabs: [] });
      return { result: { workspace: id, tab: 't0', root_pane: 'p0' } };
    }
    if (argv[0] === 'tab' && sub === 'create') {
      const wsId = value('workspace');
      const ws = this.workspaces.get(wsId);
      if (!ws) throw new Error(`no such workspace: ${wsId}`);
      const cwd = value('cwd');
      if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
      const tab: FakeTab = {
        id: `tab_${ws.tabs.length}`,
        pane: `pane_${ws.tabs.length}`,
        cwd,
        label: (argv.indexOf('--label') >= 0 ? argv[argv.indexOf('--label') + 1] : undefined) ?? '',
        closed: false,
      };
      ws.tabs.push(tab);
      // A malformed create (`omitRootPane`) exercises the adapter's tab-teardown
      // guard: the tab exists and must be closed, never leaked.
      return this.omitRootPane ? { result: { tab: tab.id } } : { result: { tab: tab.id, root_pane: tab.pane } };
    }
    if (argv[0] === 'tab' && sub === 'list') {
      const wsId = value('workspace');
      const ws = this.workspaces.get(wsId);
      if (!ws) throw new Error(`no such workspace: ${wsId}`);
      return {
        result: ws.tabs.filter((tab) => !tab.closed).map((tab) => ({ id: tab.id, label: tab.label })),
      };
    }
    if (argv[0] === 'agent' && sub === 'start') {
      return { result: { agent: argv[2] } };
    }
    if (argv[0] === 'agent' && (sub === 'prompt' || sub === 'send-keys')) {
      // A harness whose channel died: the prompt invocation itself fails.
      if (this.promptError) throw this.promptError;
      // The real CLI shape is `agent prompt <name> <text>` — capture the text.
      const text = argv[3] ?? (argv[2] as string | undefined) ?? '';
      const tab = this.openTabs().at(-1);
      if (tab) this.onPrompt?.(text, tab.cwd);
      return { result: { ok: true } };
    }
    if (argv[0] === 'agent' && sub === 'get') {
      return { result: { state: this.agentState } };
    }
    if (argv[0] === 'agent' && sub === 'read') {
      return { result: { text: 'How should I handle the ambiguous acceptance criterion?' } };
    }
    if (argv[0] === 'tab' && sub === 'close') {
      const tabId = argv[2];
      for (const ws of this.workspaces.values()) {
        for (const tab of ws.tabs) if (tab.id === tabId) tab.closed = true;
      }
      return { result: {} };
    }
    throw new Error(`unexpected herdr invocation: ${argv.join(' ')}`);
  }
}
