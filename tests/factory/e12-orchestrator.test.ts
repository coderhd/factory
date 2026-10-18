import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_FACTORY_CONFIG,
  parseFactoryConfig,
  resolveFactoryConfig,
  serializeFactoryConfig,
} from '../../src/factory/config/factoryConfig';

/**
 * E12 (#48) — the `orchestrator:` config section. The Factory carries the
 * desired identity of the natural-language orchestrator (its inference endpoint,
 * API family, model, and the *name* of the environment variable holding the API
 * key — never the key itself), so later tasks can compose a live orchestrator
 * from a validated `factory.yaml`. Present, every field must be well-formed;
 * absent, nothing is wired.
 */

/**
 * A minimal valid `factory.yaml` (the `factory init` template) with the given
 * `orchestrator:` block appended. The base is serialized from
 * `DEFAULT_FACTORY_CONFIG`, so the fixture can only fail for orchestrator
 * reasons.
 */
function configWith(block: string): string {
  const base = serializeFactoryConfig({ ...DEFAULT_FACTORY_CONFIG });
  return `${base}${block}`;
}

const VALID_ORCHESTRATOR = [
  'orchestrator:',
  '  baseUrl: https://opencode.ai/inference',
  '  apiFamily: openai',
  '  model: glm-5.3-flash',
  '  apiKeyEnv: OPENCODE_API_KEY',
  '  maxTokensPerMessage: 2048',
  '  poller:',
  '    label: factory:ready',
  '    intervalMs: 60000',
  '',
].join('\n');

describe('E12 orchestrator: config section (#48)', () => {
  it('parses and resolves a configured orchestrator: section', () => {
    const text = configWith(VALID_ORCHESTRATOR);
    const parsed = parseFactoryConfig(text);
    if (!parsed.ok) {
      throw new Error(`fixture factory.yaml invalid: ${JSON.stringify(parsed.issues)}`);
    }
    expect(parsed.ok).toBe(true);

    const runtime = resolveFactoryConfig(parsed.config, { baseDir: process.cwd() });
    expect(runtime.orchestrator).toEqual({
      baseUrl: 'https://opencode.ai/inference',
      apiFamily: 'openai',
      model: 'glm-5.3-flash',
      apiKeyEnv: 'OPENCODE_API_KEY',
      maxTokensPerMessage: 2048,
      poller: { label: 'factory:ready', intervalMs: 60000 },
    });
    expect(runtime.orchestrator?.model).toBe('glm-5.3-flash');
  });

  it('defaults maxTokensPerMessage to 2048 and poller to absent when omitted', () => {
    const text = configWith(
      [
        'orchestrator:',
        '  baseUrl: https://opencode.ai/inference',
        '  apiFamily: anthropic',
        '  model: claude-sonnet-4',
        '  apiKeyEnv: ANTHROPIC_API_KEY',
        '',
      ].join('\n'),
    );
    const parsed = parseFactoryConfig(text);
    if (!parsed.ok) {
      throw new Error(`fixture factory.yaml invalid: ${JSON.stringify(parsed.issues)}`);
    }
    const runtime = resolveFactoryConfig(parsed.config, { baseDir: process.cwd() });
    expect(runtime.orchestrator?.maxTokensPerMessage).toBe(2048);
    expect(runtime.orchestrator?.poller).toBeUndefined();
  });

  it('leaves orchestrator undefined when the section is absent', () => {
    const parsed = parseFactoryConfig(configWith(''));
    if (!parsed.ok) {
      throw new Error(`baseline factory.yaml invalid: ${JSON.stringify(parsed.issues)}`);
    }
    expect(parsed.config.orchestrator).toBeUndefined();
    expect(
      resolveFactoryConfig(parsed.config, { baseDir: process.cwd() }).orchestrator,
    ).toBeUndefined();
  });

  it('rejects a baseUrl without an http(s) scheme at orchestrator.baseUrl', () => {
    const parsed = parseFactoryConfig(
      configWith(
        [
          'orchestrator:',
          '  baseUrl: opencode.ai/inference',
          '  apiFamily: openai',
          '  model: glm-5.3-flash',
          '  apiKeyEnv: OPENCODE_API_KEY',
          '',
        ].join('\n'),
      ),
    );
    if (parsed.ok) throw new Error('a scheme-less orchestrator.baseUrl must not parse');
    expect(parsed.issues.some((issue) => issue.path === 'orchestrator.baseUrl')).toBe(true);
  });

  it('rejects an unsupported apiFamily at orchestrator.apiFamily', () => {
    const parsed = parseFactoryConfig(
      configWith(
        [
          'orchestrator:',
          '  baseUrl: https://example.test/v1',
          '  apiFamily: gemini',
          '  model: gemini-2.0',
          '  apiKeyEnv: GEMINI_API_KEY',
          '',
        ].join('\n'),
      ),
    );
    if (parsed.ok) throw new Error('an unsupported orchestrator.apiFamily must not parse');
    expect(parsed.issues.some((issue) => issue.path === 'orchestrator.apiFamily')).toBe(true);
  });

  it('rejects an apiKeyEnv that is not an environment-variable name', () => {
    const parsed = parseFactoryConfig(
      configWith(
        [
          'orchestrator:',
          '  baseUrl: https://example.test/v1',
          '  apiFamily: openai',
          '  model: glm-5.3-flash',
          '  apiKeyEnv: 1X',
          '',
        ].join('\n'),
      ),
    );
    if (parsed.ok) throw new Error('a non-env-var orchestrator.apiKeyEnv must not parse');
    expect(parsed.issues.some((issue) => issue.path === 'orchestrator.apiKeyEnv')).toBe(true);
  });

  it('rejects unknown keys inside orchestrator', () => {
    const parsed = parseFactoryConfig(
      configWith(
        [
          'orchestrator:',
          '  baseUrl: https://example.test/v1',
          '  apiFamily: openai',
          '  model: glm-5.3-flash',
          '  apiKeyEnv: OPENCODE_API_KEY',
          '  temperature: 0.2',
          '',
        ].join('\n'),
      ),
    );
    if (parsed.ok) throw new Error('an unknown orchestrator key must not parse');
    expect(parsed.issues.some((issue) => issue.path === 'orchestrator.temperature')).toBe(true);
  });

  it('requires poller.label and a positive poller.intervalMs', () => {
    const missingLabel = parseFactoryConfig(
      configWith(
        [
          'orchestrator:',
          '  baseUrl: https://example.test/v1',
          '  apiFamily: openai',
          '  model: glm-5.3-flash',
          '  apiKeyEnv: OPENCODE_API_KEY',
          '  poller:',
          '    intervalMs: 60000',
          '',
        ].join('\n'),
      ),
    );
    if (missingLabel.ok) throw new Error('a poller without a label must not parse');
    expect(missingLabel.issues.some((issue) => issue.path === 'orchestrator.poller.label')).toBe(true);

    const badInterval = parseFactoryConfig(
      configWith(
        [
          'orchestrator:',
          '  baseUrl: https://example.test/v1',
          '  apiFamily: openai',
          '  model: glm-5.3-flash',
          '  apiKeyEnv: OPENCODE_API_KEY',
          '  poller:',
          '    label: factory:ready',
          '    intervalMs: 0',
          '',
        ].join('\n'),
      ),
    );
    if (badInterval.ok) throw new Error('a non-positive poller.intervalMs must not parse');
    expect(badInterval.issues.some((issue) => issue.path === 'orchestrator.poller.intervalMs')).toBe(
      true,
    );
  });

  it('round-trips the orchestrator: section through serialize → parse', () => {
    const parsed = parseFactoryConfig(configWith(VALID_ORCHESTRATOR));
    if (!parsed.ok) {
      throw new Error(`fixture factory.yaml invalid: ${JSON.stringify(parsed.issues)}`);
    }
    const serialized = serializeFactoryConfig(parsed.config);
    const reparsed = parseFactoryConfig(serialized);
    if (!reparsed.ok) {
      throw new Error(`round-tripped factory.yaml invalid: ${JSON.stringify(reparsed.issues)}`);
    }
    expect(reparsed.config.orchestrator).toEqual(parsed.config.orchestrator);
    expect(serializeFactoryConfig(reparsed.config)).toBe(serialized);
  });
});
