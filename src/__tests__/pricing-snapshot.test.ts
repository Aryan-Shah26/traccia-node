/**
 * TRC-284: the shipped pricing snapshot is loaded, models match exactly, and
 * unknown models stay unpriced instead of falling back to legacy rates.
 * Uses the real data/pricing_snapshot.json (no fs mock).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BUNDLED_SNAPSHOT_FILE,
  DEFAULT_PRICING,
  bundledSnapshotCandidates,
  getBundledGeneratedAt,
  loadBundledPricing,
  loadPricingWithSource,
  readBundledSnapshot,
} from '../config/pricing-config';
import { CostResolver, MODEL_ALIASES, getResolver, modelCandidates, setResolver } from '../processor/cost-resolver';
import { CostAnnotatingProcessor } from '../processor/cost-processor';

const REPO_ROOT = path.join(__dirname, '..', '..');
const SNAPSHOT_PATH = path.join(REPO_ROOT, 'data', BUNDLED_SNAPSHOT_FILE);
const snapshotJson = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));

function isolatedCacheDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'traccia-trc284-'));
}

describe('TRC-284 shipped pricing snapshot', () => {
  const originalCacheDir = process.env.TRACCIA_CACHE_DIR;

  beforeEach(() => {
    // Never let a developer's ~/.cache/traccia/pricing.json leak into these tests.
    process.env.TRACCIA_CACHE_DIR = isolatedCacheDir();
  });

  afterAll(() => {
    if (originalCacheDir === undefined) delete process.env.TRACCIA_CACHE_DIR;
    else process.env.TRACCIA_CACHE_DIR = originalCacheDir;
  });

  describe('packaging', () => {
    it('ships a non-trivial snapshot with a real generated_at', () => {
      expect(Object.keys(snapshotJson.models).length).toBeGreaterThan(1000);
      expect(Number.isNaN(Date.parse(snapshotJson.generated_at))).toBe(false);
      expect(snapshotJson.source).toBe('litellm');
    });

    it('lists the snapshot in package.json "files" so npm publishes it', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
      expect(pkg.files).toContain('data/pricing_snapshot.json');
    });

    it('resolves the snapshot from both src/config (sources) and dist (bundle)', () => {
      const fromSrc = bundledSnapshotCandidates(path.join(REPO_ROOT, 'src', 'config'));
      const fromDist = bundledSnapshotCandidates(path.join(REPO_ROOT, 'dist'));
      expect(fromSrc.map(path.normalize)).toContain(path.normalize(SNAPSHOT_PATH));
      expect(fromDist.map(path.normalize)).toContain(path.normalize(SNAPSHOT_PATH));
    });

    it('loads the snapshot and its own timestamp', () => {
      const bundled = readBundledSnapshot();
      expect(bundled).not.toBeNull();
      expect(path.normalize(bundled!.path)).toBe(path.normalize(SNAPSHOT_PATH));
      expect(loadBundledPricing()).toEqual(snapshotJson.models);
      expect(getBundledGeneratedAt()).toBe(snapshotJson.generated_at);
    });

    it('no longer carries legacy hardcoded rates', () => {
      expect(Object.keys(DEFAULT_PRICING)).toHaveLength(0);
    });
  });

  describe('loadPricingWithSource', () => {
    it('labels the bundled source with the snapshot timestamp, not the load time', async () => {
      const [pricing, source, generatedAt] = await loadPricingWithSource();
      expect(source).toBe('bundled');
      expect(generatedAt).toBe(snapshotJson.generated_at);
      expect(pricing['gpt-4o-mini']).toBeDefined();
    });

    it('keeps the snapshot timestamp under an override', async () => {
      const [pricing, source, generatedAt] = await loadPricingWithSource({ 'my-model': { inputCost: 1, outputCost: 2 } });
      expect(source).toBe('override');
      expect(generatedAt).toBe(snapshotJson.generated_at);
      expect(pricing['my-model']).toEqual({ inputCost: 1, outputCost: 2, _override: true });
      expect(pricing['gpt-4o-mini']).toBeDefined();
    });

    it('uses the local cache timestamp when a cache is present', async () => {
      const dir = process.env.TRACCIA_CACHE_DIR!;
      fs.writeFileSync(
        path.join(dir, 'pricing.json'),
        JSON.stringify({ generated_at: '2026-09-01T00:00:00Z', models: { 'gpt-4o-mini': { inputCost: 1, outputCost: 1 } } }),
      );
      const [pricing, source, generatedAt] = await loadPricingWithSource();
      expect(source).toBe('local_cache');
      expect(generatedAt).toBe('2026-09-01T00:00:00Z');
      expect(pricing['gpt-4o-mini']).toEqual({ inputCost: 1, outputCost: 1 });
      expect(pricing['gpt-4o']).toBeDefined(); // merged over the snapshot
    });

    it('ignores an empty local cache instead of relabelling the bundled table', async () => {
      fs.writeFileSync(
        path.join(process.env.TRACCIA_CACHE_DIR!, 'pricing.json'),
        JSON.stringify({ generated_at: '2026-09-01T00:00:00Z', models: {} }),
      );
      const [, source, generatedAt] = await loadPricingWithSource();
      expect(source).toBe('bundled');
      expect(generatedAt).toBe(snapshotJson.generated_at);
    });

    it("reports 'unknown' rather than now() for a cache with a bad timestamp", async () => {
      fs.writeFileSync(
        path.join(process.env.TRACCIA_CACHE_DIR!, 'pricing.json'),
        JSON.stringify({ generated_at: 'not-a-date', models: { x: { prompt: 1, completion: 1 } } }),
      );
      const [, source, generatedAt] = await loadPricingWithSource();
      expect(source).toBe('local_cache');
      expect(generatedAt).toBe('unknown');
    });
  });

  describe('ticket reproduction: 1,000 in + 1,000 out gpt-4o-mini tokens', () => {
    let resolver: CostResolver;

    beforeAll(async () => {
      const [pricing, source, generatedAt] = await loadPricingWithSource();
      resolver = new CostResolver(pricing, source, generatedAt);
    });

    it('costs $0.00075 (snapshot rates), not $0.09 (legacy gpt-4)', () => {
      expect(resolver.compute('gpt-4o-mini', 1000, 1000)).toBeCloseTo(0.00075, 10);
      expect(resolver.matchPricingModelKey('gpt-4o-mini')).toBe('gpt-4o-mini');
    });

    it('matches the Python SDK snapshot rate for rate', () => {
      for (const model of ['gpt-4o-mini', 'gpt-4o', 'gpt-4', 'gpt-4.1-nano', 'o3-mini', 'claude-sonnet-4-5', 'claude-haiku-4-5']) {
        const r = snapshotJson.models[model];
        const expected = r.prompt + r.completion;
        expect(resolver.compute(model, 1000, 1000)).toBeCloseTo(expected, 12);
        expect(resolver.matchPricingModelKey(model)).toBe(model);
      }
    });

    it('keeps sibling models apart (no prefix bleed)', () => {
      expect(resolver.matchPricingModelKey('gpt-4o')).toBe('gpt-4o');
      expect(resolver.matchPricingModelKey('gpt-4.1-mini')).toBe('gpt-4.1-mini');
      expect(resolver.matchPricingModelKey('gpt-4-turbo')).toBe('gpt-4-turbo');
      expect(resolver.compute('gpt-4o-mini', 1000, 0)).not.toBe(resolver.compute('gpt-4o', 1000, 0));
    });

    it('prices cached gpt-4o-mini input at the snapshot cached_prompt rate', () => {
      const r = snapshotJson.models['gpt-4o-mini'];
      const d = resolver.computeDetailed('gpt-4o-mini', 0, 0, 1000, 0)!;
      expect(d.cost).toBeCloseTo(r.cached_prompt, 12);
      expect(d.cacheFallback).toBe(false);
    });
  });

  describe('model matching against the real snapshot', () => {
    let resolver: CostResolver;

    beforeAll(async () => {
      const [pricing] = await loadPricingWithSource();
      resolver = new CostResolver(pricing, 'bundled', snapshotJson.generated_at);
    });

    it('prefers first-party alias targets over reseller keys with the same tail', () => {
      // deepinfra/anthropic/claude-3-7-sonnet-latest and vertex_ai/claude-3-opus exist in the snapshot.
      expect(snapshotJson.models['deepinfra/anthropic/claude-3-7-sonnet-latest']).toBeDefined();
      expect(resolver.matchPricingModelKey('claude-3-7-sonnet-latest')).toBe('claude-3-7-sonnet-20250219');
      expect(resolver.matchPricingModelKey('claude-3-opus')).toBe('claude-3-opus-20240229');
    });

    it('uses a provider-qualified exact id only when no first-party id exists', () => {
      expect(snapshotJson.models['claude-3-5-haiku-20241022']).toBeUndefined();
      expect(resolver.matchPricingModelKey('claude-3-5-haiku')).toMatch(/\/claude-3-5-haiku$/);
    });

    it.each([
      ['gpt-4o-mini-2024-07-18', 'gpt-4o-mini-2024-07-18'], // exact dated id
      ['GPT-4O-MINI', 'gpt-4o-mini'], // case-insensitive
      ['  gpt-4o-mini  ', 'gpt-4o-mini'], // whitespace
      ['openai/gpt-4o-mini', 'openai/gpt-4o-mini'], // exact provider key if present, else bare
      ['gpt-4o-mini-2031-01-01', 'gpt-4o-mini'], // unknown dated release -> same base model
      ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5-20250929'],
      ['claude-sonnet-4-0', 'claude-sonnet-4-20250514'], // Anthropic alias
      ['claude-opus-4-0', 'claude-opus-4-20250514'],
      ['claude-3-7-sonnet-latest', 'claude-3-7-sonnet-20250219'],
      ['claude-3-opus', 'claude-3-opus-20240229'],
      ['anthropic/claude-sonnet-4-0', 'claude-sonnet-4-20250514'],
    ])('%s -> %s', (model, expectedKey) => {
      const key = resolver.matchPricingModelKey(model);
      if (model === 'openai/gpt-4o-mini' && !snapshotJson.models['openai/gpt-4o-mini']) {
        expect(key).toBe('gpt-4o-mini');
      } else {
        expect(key).toBe(expectedKey);
      }
      expect(resolver.compute(model, 1000, 1000)).toBeGreaterThan(0);
    });

    it.each([
      'gpt-4o-mini-preview-custom', // former prefix match onto gpt-4o-mini / gpt-4
      'gpt-4-unknown-variant',
      'gpt-5.9-ultra',
      'claude-9-opus',
      'my-finetune',
      '',
      '   ',
      'constructor', // prototype keys must not resolve
      '__proto__',
      'toString',
    ])('leaves %p unpriced', (model) => {
      expect(resolver.matchPricingModelKey(model)).toBeUndefined();
      expect(resolver.compute(model, 1000, 1000)).toBeUndefined();
    });

    it('prices an OpenAI fine-tune id at its ft: key', () => {
      // The shared matcher names ft:<base>:<org>:<suffix>:<id> as ft:<base>, so a fine-tune takes
      // the fine-tune price, never the plain base model's.
      expect(resolver.matchPricingModelKey('ft:gpt-4o-mini:acme::abc123')).toBe('ft:gpt-4o-mini-2024-07-18');
      expect(snapshotJson.models['ft:gpt-4o-mini-2024-07-18']).toMatchObject({ prompt: 0.0003, completion: 0.0012 });
      expect(resolver.compute('ft:gpt-4o-mini:acme::abc123', 1000, 1000)).toBeCloseTo(0.0003 + 0.0012, 12);
    });
  });
});

describe('TRC-284 resolver matching rules (synthetic tables)', () => {
  afterEach(() => setResolver(new CostResolver({}, 'bundled', 'unknown')));

  it('reproduces the original bug shape: gpt-4o-mini vs a table holding only gpt-4', () => {
    const r = new CostResolver({ 'gpt-4': { inputCost: 0.03, outputCost: 0.06 } });
    expect(r.compute('gpt-4o-mini', 1000, 1000)).toBeUndefined();
    expect(r.matchPricingModelKey('gpt-4o-mini')).toBeUndefined();
    expect(r.matchPricingModelKey('gpt-4-0613')).toBeUndefined();
  });

  it('strips only ISO or compact date suffixes', () => {
    expect(modelCandidates('gpt-4o-2024-08-06')).toContain('gpt-4o');
    expect(modelCandidates('claude-3-opus-20240229')).toContain('claude-3-opus');
    expect(modelCandidates('claude-3-opus@20240229')).toContain('claude-3-opus');
    expect(modelCandidates('gpt-4-0613')).toEqual(['gpt-4-0613']);
    expect(modelCandidates('gpt-4o-mini')).toEqual(['gpt-4o-mini']);
    expect(modelCandidates('llama-3-70b')).toEqual(['llama-3-70b']);
    expect(modelCandidates('model-2024-8-6')).toEqual(['model-2024-8-6']);
  });

  it('prefers the exact dated price over the undated base price', () => {
    const r = new CostResolver({
      'gpt-4o': { inputCost: 0.0025, outputCost: 0.01 },
      'gpt-4o-2024-05-13': { inputCost: 0.005, outputCost: 0.015 },
    });
    expect(r.matchPricingModelKey('gpt-4o-2024-05-13')).toBe('gpt-4o-2024-05-13');
    expect(r.matchPricingModelKey('gpt-4o-2024-08-06')).toBe('gpt-4o');
  });

  it('resolves aliases case-insensitively and only to keys in the active table', () => {
    const r = new CostResolver({ 'claude-sonnet-4-20250514': { inputCost: 0.003, outputCost: 0.015 } });
    expect(r.matchPricingModelKey('Claude-Sonnet-4-0')).toBe('claude-sonnet-4-20250514');
    expect(r.matchPricingModelKey('claude-opus-4-0')).toBeUndefined();
    expect(Object.isFrozen(MODEL_ALIASES)).toBe(true);
  });

  it('an override key always wins over its alias target', () => {
    const r = new CostResolver({
      'claude-sonnet-4-0': { inputCost: 9, outputCost: 9 },
      'claude-sonnet-4-20250514': { inputCost: 0.003, outputCost: 0.015 },
    });
    expect(r.matchPricingModelKey('claude-sonnet-4-0')).toBe('claude-sonnet-4-0');
  });

  it('still maps bare names to provider-prefixed keys (grok-4.7 -> xai/grok-4.7)', () => {
    const r = new CostResolver({
      'xai/grok-4': { inputCost: 1, outputCost: 1 },
      'xai/grok-4.7': { inputCost: 2, outputCost: 2 },
    });
    expect(r.matchPricingModelKey('grok-4.7')).toBe('xai/grok-4.7');
    expect(r.matchPricingModelKey('grok-4.7-fast')).toBeUndefined();
  });

  it('invalidates memoized matches on update()', () => {
    const r = new CostResolver({});
    expect(r.matchPricingModelKey('gpt-4o-mini')).toBeUndefined();
    r.update({ 'gpt-4o-mini': { inputCost: 0.00015, outputCost: 0.0006 } });
    expect(r.matchPricingModelKey('gpt-4o-mini')).toBe('gpt-4o-mini');
    r.update({});
    expect(r.matchPricingModelKey('gpt-4o-mini')).toBeUndefined();
  });

  it('a fresh default resolver is backed by the shipped snapshot with its real timestamp', () => {
    const key = Symbol.for('__TRACCIA_COST_RESOLVER__');
    const g = globalThis as Record<symbol, unknown>;
    const saved = g[key];
    delete g[key];
    try {
      const r = getResolver();
      expect(r.getSource).toBe('bundled');
      expect(r.getGeneratedAt).toBe(snapshotJson.generated_at);
      expect(r.compute('gpt-4o-mini', 1000, 1000)).toBeCloseTo(0.00075, 10);
    } finally {
      g[key] = saved;
    }
  });

  it('annotates spans with the matched key and leaves unknown models without a cost', () => {
    const proc = new CostAnnotatingProcessor({
      pricingTable: { 'gpt-4': { inputCost: 0.03, outputCost: 0.06 } },
      pricingSource: 'bundled',
      pricingGeneratedAt: '2026-04-22T15:07:43Z',
    });
    const attrs: Record<string, unknown> = {
      'llm.model': 'gpt-4o-mini',
      'llm.usage.prompt_tokens': 1000,
      'llm.usage.completion_tokens': 1000,
    };
    const span = { attributes: attrs, setAttribute: (k: string, v: unknown) => (attrs[k] = v) };
    proc.onEnd(span as never);
    expect(attrs['llm.cost.usd']).toBeUndefined();
    expect(attrs['llm.pricing.model_key']).toBeUndefined();
  });
});

describe('TRC-284 missing snapshot', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('fs');
  });

  it('falls back to an empty table labelled default/unknown, never legacy rates', async () => {
    jest.resetModules();
    jest.doMock('fs', () => {
      const real = jest.requireActual('fs');
      return {
        ...real,
        existsSync: (p: string) => (String(p).endsWith('pricing_snapshot.json') || String(p).endsWith('pricing.json') ? false : real.existsSync(p)),
      };
    });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cfg = require('../config/pricing-config');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const res = require('../processor/cost-resolver');

    expect(cfg.readBundledSnapshot()).toBeNull();
    expect(cfg.loadBundledPricing()).toEqual({});
    expect(cfg.getBundledGeneratedAt()).toBeNull();

    const [pricing, source, generatedAt] = await cfg.loadPricingWithSource();
    expect(pricing).toEqual({});
    expect(source).toBe('default');
    expect(generatedAt).toBe('unknown');

    delete (globalThis as Record<symbol, unknown>)[Symbol.for('__TRACCIA_COST_RESOLVER__')];
    const r = res.getResolver();
    expect(r.getSource).toBe('default');
    expect(r.compute('gpt-4o-mini', 1000, 1000)).toBeUndefined();
    expect(r.compute('gpt-4', 1000, 1000)).toBeUndefined();
    res.setResolver(new res.CostResolver({}, 'bundled', 'unknown'));
  });
});
