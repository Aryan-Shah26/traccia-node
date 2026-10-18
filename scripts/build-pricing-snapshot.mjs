#!/usr/bin/env node
/**
 * Release-time script: fetch LiteLLM model_prices_and_context_window.json,
 * normalize it into Traccia's per-1K-token schema, and write
 * data/pricing_snapshot.json (same format as traccia-py's snapshot).
 *
 * Run before each release:
 *     npm run pricing:snapshot [-- <url>]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const OUTPUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'pricing_snapshot.json');
const PER_1K = 1000;

const OPTIONAL = [
  ['cache_creation_input_token_cost', 'cache_write'],
  ['cache_read_input_token_cost', 'cached_prompt'],
  ['input_cost_per_audio_token', 'input_audio'],
  ['output_cost_per_audio_token', 'output_audio'],
  ['input_cost_per_image_token', 'input_image'],
];

const per1k = (value) => Math.round(Number(value) * PER_1K * 1e9) / 1e9;

export function normalize(raw) {
  const models = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') continue;
    const { input_cost_per_token: input, output_cost_per_token: output } = entry;
    if (input == null && output == null) continue;
    const out = {};
    if (input != null) out.prompt = per1k(input);
    if (output != null) out.completion = per1k(output);
    for (const [src, dst] of OPTIONAL) {
      if (typeof entry[src] === 'number') out[dst] = per1k(entry[src]);
    }
    if (entry.litellm_provider) out._provider = entry.litellm_provider;
    if (entry.mode) out._mode = entry.mode;
    if (entry.max_tokens) out._max_tokens = entry.max_tokens;
    if (entry.max_input_tokens) out._max_input_tokens = entry.max_input_tokens;
    models[id] = out;
  }
  return models;
}

async function main() {
  const url = process.argv[2] || LITELLM_URL;
  console.log(`Fetching ${url} ...`);
  const res = await fetch(url, { headers: { 'User-Agent': 'traccia-build/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const models = normalize(await res.json());
  if (!models['gpt-4o-mini']) throw new Error('Snapshot sanity check failed: gpt-4o-mini missing');

  const snapshot = {
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: 'litellm',
    source_url: url,
    models,
  };
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
  console.log(`Wrote ${Object.keys(models).length} models to ${OUTPUT}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
