/**
 * Process-level singleton that holds the active pricing table.
 */

import { PricingRates, PricingTable, readBundledSnapshot } from '../config/pricing-config';

/**
 * llm.vendor values set only by that provider's own SDK, which calls no other provider. Their
 * calls are priced only from that provider's entries, never from another provider's entry for
 * the same model name, which can be priced very differently. The platform's pricing matcher
 * applies the same rule (as does traccia-py's cost engine).
 */
export const STRICT_VENDORS: ReadonlySet<string> = new Set(['groq']);

const REGION = /^(?:us|eu|apac|au|ca|jp|global|us-gov)\./;
const SUFFIX = /(?:-\d{4}-\d{2}-\d{2}|-\d{8}|-latest)$/;

export class CostResolver {
  private table: PricingTable;
  private source: string;
  private generatedAt: string;
  /** The vendor keys of the current table by base name, built on first use per vendor. */
  private vendorIndex?: { table: PricingTable; vendor: string; keys: Map<string, string[]> };
  // Per-table indexes, built on first lookup and dropped by update(). Bounded by the
  // table size, unlike a per-model cache keyed by caller-supplied names.
  private lowerIndex?: Map<string, string>;
  private tailIndex?: Map<string, string>;

  constructor(
    pricingTable: PricingTable,
    source: string = 'bundled',
    generatedAt: string = 'unknown'
  ) {
    this.table = pricingTable;
    this.source = source;
    this.generatedAt = generatedAt;
  }

  public get pricingTable(): PricingTable {
    return this.table;
  }

  public get getSource(): string {
    return this.source;
  }

  public get getGeneratedAt(): string {
    return this.generatedAt;
  }

  /**
   * Replace the active pricing table (e.g. after a background refresh).
   */
  public update(
    pricingTable: PricingTable,
    source?: string,
    generatedAt?: string
  ): void {
    this.table = pricingTable;
    this.lowerIndex = undefined;
    this.tailIndex = undefined;
    if (source) {
      this.source = source;
    }
    if (generatedAt) {
      this.generatedAt = generatedAt;
    }
  }

  /**
   * Return the estimated cost in USD, or undefined if the model has no pricing entry.
   * promptTokens is uncached input. Cache read and cache write use their own rates.
   * A vendor in STRICT_VENDORS is priced only from its own entries (see lookupVendorPrice);
   * any other vendor is not used.
   */
  public compute(
    model: string,
    promptTokens: number,
    completionTokens: number,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    vendor?: string,
  ): number | undefined {
    return this.computeDetailed(model, promptTokens, completionTokens, cacheReadTokens, cacheWriteTokens, vendor)?.cost;
  }

  public computeDetailed(
    model: string,
    promptTokens: number,
    completionTokens: number,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    vendor?: string,
  ): { cost: number; cacheFallback: boolean } | undefined {
    const matched = this.match(model, vendor);
    if (!matched) {
      return undefined;
    }

    const [, pricing] = matched;
    const inputRate = rate(pricing, "inputCost", "prompt");
    const outputRate = rate(pricing, "outputCost", "completion");
    let cost = 0;
    let cacheFallback = false;
    if (promptTokens) cost += (promptTokens / 1000) * inputRate;
    if (completionTokens) cost += (completionTokens / 1000) * outputRate;
    if (cacheReadTokens) {
      const cached = optionalRate(pricing, "cacheReadCost", "cached_prompt");
      if (cached == null) cacheFallback = true;
      cost += (cacheReadTokens / 1000) * (cached ?? inputRate);
    }
    if (cacheWriteTokens) {
      const write = optionalRate(pricing, "cacheWriteCost", "cache_write");
      if (write == null) cacheFallback = true;
      cost += (cacheWriteTokens / 1000) * (write ?? inputRate);
    }

    if (cost <= 0) return undefined;
    return { cost, cacheFallback };
  }

  public matchPricingModelKey(model: string, vendor?: string): string | undefined {
    return this.match(model, vendor)?.[0];
  }

  private match(model: string, vendor?: string): [string, PricingRates] | undefined {
    const strict = strictVendor(vendor);
    return strict ? this.lookupVendorPrice(model, strict) : this.lookupPrice(model);
  }

  /**
   * The vendor's own entry for a model: a vendor key with the same base name (lower-cased,
   * without the provider path, a region, or a date or -latest suffix), the key for the exact
   * dated name first, then the shortest. Undefined when the vendor has no such key.
   */
  private lookupVendorPrice(model: string, vendor: string): [string, PricingRates] | undefined {
    const wanted = modelName(String(model || ''));
    const keys = wanted ? this.vendorKeys(vendor).get(wanted.replace(SUFFIX, '')) : undefined;
    if (!keys || !keys.length) {
      return undefined;
    }
    const exact = (k: string): number => (modelName(k) === wanted ? 0 : 1);
    const [key] = [...keys].sort(
      (a, b) => exact(a) - exact(b) || a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
    );
    return [key, this.table[key]];
  }

  private vendorKeys(vendor: string): Map<string, string[]> {
    const cached = this.vendorIndex;
    if (cached && cached.table === this.table && cached.vendor === vendor) {
      return cached.keys;
    }
    const keys = new Map<string, string[]>();
    for (const [key, value] of Object.entries(this.table)) {
      if (inVendorFamily(key, value, vendor)) {
        const base = baseName(key);
        const bucket = keys.get(base);
        if (bucket) bucket.push(key);
        else keys.set(base, [key]);
      }
    }
    this.vendorIndex = { table: this.table, vendor, keys };
    return keys;
  }

  /**
   * Resolve a model name to a pricing key. Only exact IDs (case-insensitive),
   * provider-qualified IDs, explicit aliases and dated snapshot suffixes match.
   * There is no open prefix match: "gpt-4o-mini" must never price as "gpt-4".
   */
  private lookupPrice(model: string): [string, PricingRates] | undefined {
    const normalized = String(model || '').trim();
    if (!normalized) {
      return undefined;
    }
    // Every exact or alias candidate is tried before any provider-prefixed key, so
    // claude-3-opus prices as Anthropic's claude-3-opus-20240229, not vertex_ai/claude-3-opus.
    const candidates = modelCandidates(normalized);
    let key: string | undefined;
    for (const candidate of candidates) {
      key = this.matchExact(candidate);
      if (key !== undefined) break;
    }
    if (key === undefined) {
      for (const candidate of candidates) {
        key = this.matchProviderPrefixed(candidate);
        if (key !== undefined) break;
      }
    }
    return key === undefined ? undefined : [key, this.table[key]];
  }

  private matchExact(name: string): string | undefined {
    if (hasOwn(this.table, name)) {
      return name;
    }
    this.buildIndexes();
    return this.lowerIndex!.get(name.toLowerCase());
  }

  /** Provider-prefixed keys: grok-4.7 -> xai/grok-4.7. Shortest key wins. */
  private matchProviderPrefixed(name: string): string | undefined {
    this.buildIndexes();
    return this.tailIndex!.get(name.toLowerCase());
  }

  private buildIndexes(): void {
    if (this.lowerIndex && this.tailIndex) {
      return;
    }
    const lower = new Map<string, string>();
    const tail = new Map<string, string>();
    for (const key of Object.keys(this.table)) {
      const k = key.toLowerCase();
      if (!lower.has(k)) lower.set(k, key);
      const t = modelTail(key).toLowerCase();
      const prev = tail.get(t);
      if (prev === undefined || key.length < prev.length) tail.set(t, key);
    }
    this.lowerIndex = lower;
    this.tailIndex = tail;
  }

  public snapshot(): { table: PricingTable; source: string; generatedAt: string } {
    return {
      table: this.table,
      source: this.source,
      generatedAt: this.generatedAt
    };
  }
}

// Process-level singleton using globalThis
const GLOBAL_RESOLVER_KEY = Symbol.for('__TRACCIA_COST_RESOLVER__');

export function getResolver(): CostResolver {
  const globalAny = globalThis as any;
  if (!globalAny[GLOBAL_RESOLVER_KEY]) {
    // Before init() runs: the shipped snapshot, or an empty table (unpriced) if it is missing.
    const bundled = readBundledSnapshot();
    globalAny[GLOBAL_RESOLVER_KEY] = bundled
      ? new CostResolver(bundled.models, 'bundled', bundled.generatedAt ?? 'unknown')
      : new CostResolver({}, 'default', 'unknown');
  }
  return globalAny[GLOBAL_RESOLVER_KEY];
}

export function setResolver(resolver: CostResolver): void {
  const globalAny = globalThis as any;
  globalAny[GLOBAL_RESOLVER_KEY] = resolver;
}

function rate(pricing: PricingRates, primary: keyof PricingRates, alias: keyof PricingRates): number {
  const value = pricing[primary] ?? pricing[alias];
  return typeof value === "number" ? value : 0;
}

function optionalRate(pricing: PricingRates, primary: keyof PricingRates, alias: keyof PricingRates): number | undefined {
  const value = pricing[primary] ?? pricing[alias];
  return typeof value === "number" ? value : undefined;
}

function strictVendor(vendor: unknown): string | undefined {
  const v = typeof vendor === 'string' ? vendor.trim().toLowerCase() : '';
  return STRICT_VENDORS.has(v) ? v : undefined;
}

/** Lower-cased, without the provider path or region; the date is kept. */
function modelName(name: string): string {
  return (name.trim().toLowerCase().split('/').pop() ?? '').replace(REGION, '');
}

function baseName(name: string): string {
  return modelName(name).replace(SUFFIX, '');
}

/**
 * Whether the entry is the vendor's: its provider (the entry's, else the key's first path
 * segment) is the vendor, or a variant after "_" or "-", as the platform's matcher counts
 * provider families.
 */
function inVendorFamily(key: string, pricing: PricingRates, vendor: string): boolean {
  let provider = pricing?._provider ?? pricing?.provider;
  if (!provider && key.includes('/')) {
    provider = key.split('/', 1)[0];
  }
  const p = typeof provider === 'string' ? provider.toLowerCase() : '';
  return p === vendor || p.startsWith(vendor + '_') || p.startsWith(vendor + '-');
}

/**
 * Explicit aliases for model names that providers accept but the pricing
 * snapshot only lists under a dated ID. A target missing from the active table
 * leaves the model unpriced.
 */
export const MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'claude-3-opus': 'claude-3-opus-20240229',
  'claude-3-opus-latest': 'claude-3-opus-20240229',
  'claude-3-haiku': 'claude-3-haiku-20240307',
  'claude-3-5-haiku': 'claude-3-5-haiku-20241022',
  'claude-3-5-haiku-latest': 'claude-3-5-haiku-20241022',
  'claude-3-5-sonnet': 'claude-3-5-sonnet-20241022',
  'claude-3-5-sonnet-latest': 'claude-3-5-sonnet-20241022',
  'claude-3-7-sonnet': 'claude-3-7-sonnet-20250219',
  'claude-3-7-sonnet-latest': 'claude-3-7-sonnet-20250219',
  'claude-sonnet-4': 'claude-sonnet-4-20250514',
  'claude-sonnet-4-0': 'claude-sonnet-4-20250514',
  'claude-opus-4': 'claude-opus-4-20250514',
  'claude-opus-4-0': 'claude-opus-4-20250514',
});

// Dated snapshot suffixes: gpt-4o-2024-08-06, claude-3-opus-20240229, claude-3-opus@20240229.
const DATED_SUFFIX = /^(.+?)[-@](?:\d{4}-\d{2}-\d{2}|\d{8})$/;

/**
 * Names to try, in order: the model itself, its alias, the name without a
 * provider prefix (openai/gpt-4o-mini), then the same without a dated suffix.
 */
export function modelCandidates(model: string): string[] {
  const out: string[] = [];
  const add = (name: string | undefined): void => {
    if (name && !out.includes(name)) out.push(name);
  };
  const withAlias = (name: string): void => {
    add(name);
    const lower = name.toLowerCase();
    if (hasOwn(MODEL_ALIASES, lower)) add(MODEL_ALIASES[lower]);
  };

  const bare = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : undefined;
  withAlias(model);
  if (bare) withAlias(bare);
  for (const name of [model, bare]) {
    const undated = name ? DATED_SUFFIX.exec(name)?.[1] : undefined;
    if (undated) withAlias(undated);
  }
  return out;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function modelTail(key: string): string {
  const tail = key.replace(/\\/g, "/").split("/").pop() ?? key;
  const dot = tail.indexOf(".");
  if (dot > 0) {
    const head = tail.slice(0, dot);
    const rest = tail.slice(dot + 1);
    // A dotted provider prefix (bedrock's "anthropic.claude-...") is letters and hyphens
    // only, as in traccia-py; in "llama-3.3-70b" the dot is part of the version.
    if (/^[a-z]+(-[a-z]+)*$/i.test(head) && rest.includes("-")) return rest;
  }
  return tail;
}
