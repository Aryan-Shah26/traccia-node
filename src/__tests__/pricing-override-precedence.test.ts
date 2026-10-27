/**
 * An explicit pricingOverride is the user's price: it wins over the bundled snapshot and over
 * provider matching, unless it is written for another provider.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadPricingWithSource, PricingTable } from '../config/pricing-config';
import { CostResolver } from '../processor/cost-resolver';

const LLAMA = 'llama-3.3-70b-versatile';
const THREE_DOLLARS = { inputCost: 1.0, outputCost: 2.0 }; // $3.00 for 1K in + 1K out

describe('pricingOverride precedence', () => {
  const savedCacheDir = process.env.TRACCIA_CACHE_DIR;
  let cacheDir: string;

  beforeAll(() => {
    // An empty cache directory, so a local `traccia pricing refresh` cache cannot change the base table.
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traccia-override-'));
    process.env.TRACCIA_CACHE_DIR = cacheDir;
  });

  afterAll(() => {
    if (savedCacheDir === undefined) delete process.env.TRACCIA_CACHE_DIR;
    else process.env.TRACCIA_CACHE_DIR = savedCacheDir;
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  async function resolverWith(override?: PricingTable): Promise<CostResolver> {
    const [table, source] = await loadPricingWithSource(override);
    if (override) expect(source).toBe('override');
    return new CostResolver(table);
  }

  it('prices a Groq call at the override (was $0.00138)', async () => {
    const r = await resolverWith({ [LLAMA]: THREE_DOLLARS });
    expect(r.compute(LLAMA, 1000, 1000, 0, 0, 'groq')).toBeCloseTo(3.0, 9);
    expect(r.matchPricingModelKey(LLAMA, 'groq')).toBe(LLAMA);
  });

  it('prices an OpenAI call at the override (was $0.02)', async () => {
    const r = await resolverWith({ 'gpt-4o': THREE_DOLLARS });
    expect(r.compute('gpt-4o', 1000, 1000, 0, 0, 'openai')).toBeCloseTo(3.0, 9);
    expect(r.compute('gpt-4o', 1000, 1000)).toBeCloseTo(3.0, 9);
  });

  it('prices a dated name at the override for its base name', async () => {
    const r = await resolverWith({ 'gpt-4o': THREE_DOLLARS });
    expect(r.compute('gpt-4o-2024-08-06', 1000, 1000, 0, 0, 'openai')).toBeCloseTo(3.0, 9);
  });

  it('applies an override through a vendor alias (google_gemini -> gemini)', async () => {
    const r = await resolverWith({ 'gemini/gemini-2.0-flash': THREE_DOLLARS });
    expect(r.compute('gemini-2.0-flash', 1000, 1000, 0, 0, 'google_gemini')).toBeCloseTo(3.0, 9);
  });

  it('keeps bundled prices without an override', async () => {
    const r = await resolverWith();
    expect(r.compute(LLAMA, 1000, 1000, 0, 0, 'groq')).toBeCloseTo(0.00138, 9);
  });

  it.each([
    ['groq', LLAMA, LLAMA, true],
    ['groq', LLAMA, `groq/${LLAMA}`, true],
    ['groq', LLAMA, `together_ai/${LLAMA}`, false], // the provider is only in the key
    ['groq', 'openai/gpt-oss-120b', 'openai/gpt-oss-120b', true], // "openai" is the model's org
    ['groq', 'openai/gpt-oss-120b', 'gpt-oss-120b', true],
    ['groq', 'openai/gpt-oss-120b', 'groq/openai/gpt-oss-120b', true],
    ['groq', 'openai/gpt-oss-120b', 'together_ai/openai/gpt-oss-120b', false],
    ['openai', 'gpt-4o', 'azure/gpt-4o', false],
    ['google_gemini', 'gemini-2.0-flash', 'vertex_ai/gemini-2.0-flash', false],
  ])('vendor %s, model %s: override %s is used = %s', async (vendor, model, key, used) => {
    const r = await resolverWith({ [key]: THREE_DOLLARS });
    expect(r.matchPricingModelKey(model, vendor) === key).toBe(used);
  });

  it('without a vendor, prices from the full table as traccia-py does', async () => {
    // Python runs the override pre-pass only for a call with a vendor; an override under another
    // key (azure/gpt-4o) does not price a vendor-less gpt-4o span.
    const bundled = (await resolverWith()).compute('gpt-4o', 1000, 1000);
    const r = await resolverWith({ 'azure/gpt-4o': { inputCost: 0.1, outputCost: 0.2 } });
    expect(r.matchPricingModelKey('gpt-4o')).toBe('gpt-4o');
    expect(r.compute('gpt-4o', 1000, 1000)).toBeCloseTo(bundled!, 12);
  });

  it('ranks override candidates by the exact dated name, as traccia-py does', async () => {
    const r = await resolverWith({ 'gpt-4o': THREE_DOLLARS, 'gpt-4o-2024-08-06': { inputCost: 0.5, outputCost: 0.5 } });
    expect(r.matchPricingModelKey('openai/gpt-4o-2024-08-06', 'openai')).toBe('gpt-4o-2024-08-06');
    expect(r.compute('openai/gpt-4o-2024-08-06', 1000, 1000, 0, 0, 'openai')).toBeCloseTo(1.0, 9);
    expect(r.matchPricingModelKey('openai/gpt-4o', 'openai')).toBe('gpt-4o');
  });

  it('skips an override whose _provider names another provider', async () => {
    const r = await resolverWith({ [LLAMA]: { ...THREE_DOLLARS, _provider: 'together_ai' } });
    expect(r.matchPricingModelKey(LLAMA, 'groq')).toBe(`groq/${LLAMA}`);
    expect(r.compute(LLAMA, 1000, 1000, 0, 0, 'groq')).toBeCloseTo(0.00138, 9);
  });
});
