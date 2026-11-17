// Undertow — a Huber size curve fitted to the snapshot's own traded tokens,
// walk-forward tested, with farm plans netted to break-even (model v1).
//
// The board prices every pre-token protocol off the tokens that already trade.
// Anchors: protocols whose record carries a market cap, minus bridge, staking
// and exchange products, wrapped / staked / versioned names and names that
// begin with an exchange's name; records with a market cap of zero or less are
// dead records, set aside and counted; one anchor per ticker, the largest-TVL
// member of each symbol family. On those anchors the model fits
//
//   log10(mcap) = a + b * log10(tvl + $100,000,000)
//
// by ordinary least squares, then three Huber IRLS reweightings (k = 1.345 on
// the residual MAD, scaled to a standard deviation). Two carry terms follow,
// each kept only at the value a leave-one-out test on the anchors prefers:
//
//   growth carry   mult_g = (1 + clamp(change_7d - median anchor change,
//                        -60, 120) / 100) ^ g,   g on a grid 0, 0.1, ..., 0.8
//   seasoning      mult_s = S / (S + K * exp(-age_days / tau)),
//                        (S, K, tau) on a coarse grid; an unknown age uses
//                        the median anchor age
//   implied        = curve(tvl) * mult_g * mult_s, whole dollars, at least $1
//
// Validation is computed, never asserted: leave-one-out median |log10 error|
// for a flat multiple, the curve alone, curve + growth, the full model, and
// the previous round's hand-weighted formula on the same anchors; a
// walk-forward split by listing date in both directions; and 200 bootstrap
// refits (mulberry32, seed 20261117) for rank ranges, with per-row value
// bands from the residual spread inside each TVL decade.
//
// Farm economics are netted, not slogans: at a deposit D the slice of a launch
// is 10% of implied value times D / (D + TVL); costs are a per-chain fee table
// plus yield forgone at 4.5% a year over the plan's weeks. Net, break-even
// share and net per hour follow, and the verdict is Worth farming when the
// break-even share is at most 10%, Marginal at most 33%, else Skip.

import { summarizeBoard } from './summary.ts';
import type { BoardSummary } from './summary.ts';

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A whole day count from listing to the snapshot date; null when unknown. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The median of a non-empty list. */
export function medianOf(values: number[]): number {
  const t = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(t.length / 2);
  return t.length % 2 === 1 ? t[mid]! : (t[mid - 1]! + t[mid]!) / 2;
}

/** A quantile of a sorted list, linear interpolation between neighbours. */
function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

// ------------------------------------------------------------- the anchors

/** DefiLlama's version-marker rule: a name ending in a release is another protocol's pool. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** Whole words that mark a wrapped or staked product of some other token. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
/** Categories that are plumbing or exchange products, never launch candidates. */
const ANCHOR_EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
/** Names beginning with an exchange's name are that exchange's own product. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Whether a traded protocol survives the anchor filters (before the dead-record and family rules). */
function passesAnchorFilters(p: SnapshotProtocol): boolean {
  if (p.category !== null && ANCHOR_EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((e) => p.name.startsWith(e))) return false;
  return true;
}

/** One anchor: a traded protocol the curve is fitted to, with its model coordinates. */
export interface Anchor {
  slug: string;
  name: string;
  category: string | null;
  symbol: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  x: number;
  y: number;
}

/** How the anchor set was built, counted at each sieve. */
export interface AnchorCounts {
  traded_total: number;
  after_filters: number;
  dead_records: number;
  families: number;
}

/** The traded protocols the curve may learn from, and the counts along the way. */
export function buildAnchors(snapshot: Snapshot): { anchors: Anchor[]; counts: AnchorCounts } {
  const traded = snapshot.protocols.filter((p) => p.mcap_usd !== null);
  const filtered = traded.filter(passesAnchorFilters);
  const live = filtered.filter((p) => (p.mcap_usd ?? 0) > 0);
  const bySymbol = new Map<string, SnapshotProtocol>();
  for (const p of live) {
    const key = p.symbol ?? `slug:${p.slug}`;
    const held = bySymbol.get(key);
    if (held === undefined || p.tvl_usd > held.tvl_usd) bySymbol.set(key, p);
  }
  const anchors = [...bySymbol.values()]
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      symbol: p.symbol,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      age_days: ageDays(snapshot.as_of, p.listed_at),
      x: Math.log10(p.tvl_usd + TVL_OFFSET),
      y: Math.log10(p.mcap_usd!),
    }));
  return {
    anchors,
    counts: {
      traded_total: traded.length,
      after_filters: filtered.length,
      dead_records: filtered.length - live.length,
      families: anchors.length,
    },
  };
}

// ------------------------------------------------------------- the fit

/** The TVL offset inside the curve's logarithm, in dollars. */
export const TVL_OFFSET = 100_000_000;

/** A fitted line in log-log space: log10(value) = a + b * log10(tvl + offset). */
export interface CurveFit {
  a: number;
  b: number;
}

interface Pt {
  x: number;
  y: number;
}

/** Ordinary least squares on log-log points. */
export function fitOls(pts: Pt[]): CurveFit {
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const p of pts) {
    sxy += (p.x - mx) * (p.y - my);
    sxx += (p.x - mx) * (p.x - mx);
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  return { a: my - b * mx, b };
}

/**
 * The size curve: OLS, then three Huber IRLS iterations. Each iteration
 * weights a point 1 while its residual is within k = 1.345 robust sigmas of
 * the fit and k*sigma/|residual| beyond it, sigma from the residual MAD
 * scaled by 1.4826, then refits by weighted least squares.
 */
export function fitSizeCurve(pts: Pt[]): CurveFit {
  let fit = fitOls(pts);
  for (let iter = 0; iter < 3; iter++) {
    const residuals = pts.map((p) => p.y - (fit.a + fit.b * p.x));
    const centre = medianOf(residuals);
    const mad = medianOf(residuals.map((r) => Math.abs(r - centre)));
    let sigma = 1.4826 * mad;
    if (!(sigma > 0)) sigma = 1;
    const k = 1.345 * sigma;
    let sw = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < pts.length; i++) {
      const r = Math.abs(residuals[i]!);
      const w = r <= k ? 1 : k / r;
      const p = pts[i]!;
      sw += w;
      sx += w * p.x;
      sy += w * p.y;
      sxx += w * p.x * p.x;
      sxy += w * p.x * p.y;
    }
    const den = sw * sxx - sx * sx;
    if (den === 0) break;
    const b = (sw * sxy - sx * sy) / den;
    fit = { a: (sy - b * sx) / sw, b };
  }
  return fit;
}

/** The curve's dollar value at a TVL, before the carry terms. */
export function curveValue(fit: CurveFit, tvl: number): number {
  return Math.pow(10, fit.a + fit.b * Math.log10(tvl + TVL_OFFSET));
}

// ------------------------------------------------------------- carry terms

/** The growth exponent's grid. */
export const G_GRID = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
/** The seasoning grids: plateau S, young-age weight K, horizon tau in days. */
export const S_GRID = [2.0, 2.7, 3.5];
export const K_GRID = [4, 6, 9];
export const TAU_GRID = [600, 870, 1200];

/** The fitted model's parameters, as the dashboard states them. */
export interface ModelFit {
  ols: CurveFit;
  curve: CurveFit;
  g: number;
  S: number;
  K: number;
  tau: number;
  median_anchor_change: number;
  median_anchor_age: number;
}

/** Growth carry for one record: excess seven-day growth over the anchor median, damped by g. */
export function growthMult(change7d: number | null, medianChange: number, g: number): number {
  const change = change7d ?? medianChange;
  return Math.pow(1 + clamp(change - medianChange, -60, 120) / 100, g);
}

/** Seasoning for one record: the share of the curve a protocol of this age has earned. */
export function seasoningMult(age: number | null, medianAge: number, S: number, K: number, tau: number): number {
  const days = age ?? medianAge;
  return S / (S + K * Math.exp(-days / tau));
}

/** The full model's prediction for one anchor under a curve fit and carry parameters. */
function predictAnchor(fit: CurveFit, medChange: number, medAge: number, g: number, S: number, K: number, tau: number, p: Anchor): number {
  return curveValue(fit, p.tvl_usd) * growthMult(p.change_7d, medChange, g) * seasoningMult(p.age_days, medAge, S, K, tau);
}

// ------------------------------------------------------------- validation

/** One model's leave-one-out score: median |log10 error| and the same miss as a multiple. */
export interface LooScore {
  median_log10_err: number;
  miss_x: number;
}

const asScore = (medianErr: number): LooScore => ({ median_log10_err: round4(medianErr), miss_x: round2(Math.pow(10, medianErr)) });

interface FoldCache {
  fits: CurveFit[];
  medChange: number[];
  medAge: number[];
}

/** Per-fold curve refits and medians, computed once and shared by every grid evaluation. */
function foldCache(anchors: Anchor[]): FoldCache {
  const fits: CurveFit[] = [];
  const medChange: number[] = [];
  const medAge: number[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const rest = anchors.filter((_, j) => j !== i);
    fits.push(fitSizeCurve(rest));
    medChange.push(medianOf(rest.map((p) => p.change_7d ?? NaN).filter((v) => Number.isFinite(v))));
    medAge.push(medianOf(rest.map((p) => p.age_days).filter((v): v is number => v !== null)));
  }
  return { fits, medChange, medAge };
}

/** Median |log10 error| of a carry configuration under leave-one-out curve refits. */
function looMedian(anchors: Anchor[], cache: FoldCache, kind: 'curve' | 'growth' | 'full', g: number, S: number, K: number, tau: number): number {
  const errs: number[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const p = anchors[i]!;
    let pred = curveValue(cache.fits[i]!, p.tvl_usd);
    if (kind !== 'curve') pred *= growthMult(p.change_7d, cache.medChange[i]!, g);
    if (kind === 'full') pred *= seasoningMult(p.age_days, cache.medAge[i]!, S, K, tau);
    errs.push(Math.abs(Math.log10(pred) - p.y));
  }
  return medianOf(errs);
}

/** The growth exponent the anchors' leave-one-out test prefers. */
function selectGrowth(anchors: Anchor[], cache: FoldCache): number {
  let best = { g: 0, err: Infinity };
  for (const g of G_GRID) {
    const err = looMedian(anchors, cache, 'growth', g, S_GRID[0]!, K_GRID[0]!, TAU_GRID[0]!);
    if (err < best.err) best = { g, err };
  }
  return best.g;
}

/** The seasoning triple the anchors' leave-one-out test prefers, growth held at its chosen g. */
function selectSeasoning(anchors: Anchor[], cache: FoldCache, g: number): { S: number; K: number; tau: number } {
  let best = { S: S_GRID[0]!, K: K_GRID[0]!, tau: TAU_GRID[0]!, err: Infinity };
  for (const S of S_GRID) {
    for (const K of K_GRID) {
      for (const tau of TAU_GRID) {
        const err = looMedian(anchors, cache, 'full', g, S, K, tau);
        if (err < best.err) best = { S, K, tau, err };
      }
    }
  }
  return { S: best.S, K: best.K, tau: best.tau };
}

/** Fit the full model on a set of anchors: curve, then grid-chosen growth, then grid-chosen seasoning. */
export function fitModel(anchors: Anchor[]): ModelFit {
  const cache = foldCache(anchors);
  const g = selectGrowth(anchors, cache);
  const { S, K, tau } = selectSeasoning(anchors, cache, g);
  return {
    ols: fitOls(anchors),
    curve: fitSizeCurve(anchors),
    g,
    S,
    K,
    tau,
    median_anchor_change: round4(medianOf(anchors.map((p) => p.change_7d).filter((v): v is number => v !== null))),
    median_anchor_age: Math.round(medianOf(anchors.map((p) => p.age_days).filter((v): v is number => v !== null))),
  };
}

/** The best single mcap/TVL multiple's leave-one-out score: the flat baseline. */
function looFlat(anchors: Anchor[]): LooScore {
  const errs: number[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const rest = anchors.filter((_, j) => j !== i);
    const multiple = medianOf(rest.map((p) => p.mcap_usd / p.tvl_usd));
    errs.push(Math.abs(Math.log10(anchors[i]!.tvl_usd * multiple) - anchors[i]!.y));
  }
  return asScore(medianOf(errs));
}

/** The previous round's hand-weighted formula, scored on the same anchors for comparison. */
function w6Score(anchors: Anchor[]): LooScore {
  const errs = anchors.map((p) => {
    const growth = clamp(p.change_7d ?? 0, -60, 120);
    const age = p.age_days ?? 365;
    const pred = p.tvl_usd * 0.32 * (1 + (growth / 100) * 0.3) * (0.5 + 0.5 * (Math.min(age, 1825) / 1825));
    return Math.abs(Math.log10(Math.max(1, pred)) - p.y);
  });
  return asScore(medianOf(errs));
}

/** One walk-forward direction: fit on one dated block, score the other. */
export interface WalkForwardLeg {
  train_n: number;
  test_n: number;
  median_log10_err: number;
  miss_x: number;
}

/** Walk-forward by listing date: earliest 60% trains, latest 40% is tested, then reversed. */
function walkForward(anchors: Anchor[]): { forward: WalkForwardLeg; reverse: WalkForwardLeg } {
  const dated = anchors
    .filter((p) => p.listed_at !== null)
    .slice()
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : 1));
  const cut = Math.floor(dated.length * 0.6);
  const run = (train: Anchor[], test: Anchor[]): WalkForwardLeg => {
    const fit = fitModel(train);
    const errs = test.map((p) =>
      Math.abs(Math.log10(predictAnchor(fit.curve, fit.median_anchor_change, fit.median_anchor_age, fit.g, fit.S, fit.K, fit.tau, p)) - p.y),
    );
    const med = medianOf(errs);
    return { train_n: train.length, test_n: test.length, median_log10_err: round4(med), miss_x: round2(Math.pow(10, med)) };
  };
  return {
    forward: run(dated.slice(0, cut), dated.slice(cut)),
    reverse: run(dated.slice(dated.length - cut), dated.slice(0, dated.length - cut)),
  };
}

/** Everything the program claims about its own accuracy, computed from the anchors. */
export interface Validation {
  loo: {
    flat_multiple: LooScore;
    curve_only: LooScore;
    curve_growth: LooScore;
    full_model: LooScore;
    w6_formula: LooScore;
  };
  walk_forward: { forward: WalkForwardLeg; reverse: WalkForwardLeg };
  bootstrap: { refits: number; seed: number };
}

/** The validation block: ablation by leave-one-out, plus the walk-forward split. */
export function validateModel(anchors: Anchor[], fit: ModelFit): Validation {
  const cache = foldCache(anchors);
  return {
    loo: {
      flat_multiple: looFlat(anchors),
      curve_only: asScore(looMedian(anchors, cache, 'curve', 0, S_GRID[0]!, K_GRID[0]!, TAU_GRID[0]!)),
      curve_growth: asScore(looMedian(anchors, cache, 'growth', fit.g, S_GRID[0]!, K_GRID[0]!, TAU_GRID[0]!)),
      full_model: asScore(looMedian(anchors, cache, 'full', fit.g, fit.S, fit.K, fit.tau)),
      w6_formula: w6Score(anchors),
    },
    walk_forward: walkForward(anchors),
    bootstrap: { refits: BOOTSTRAP_REFITS, seed: BOOTSTRAP_SEED },
  };
}

// ------------------------------------------------------------- farm netting

/** The share of a launch a deposit is credited with. */
export const SLICE_FRACTION = 0.1;
/** Yield forgone on the deposit while it farms, per year. */
export const YIELD_APR = 0.045;
/** The headline deposit every board verdict is netted at, and the small alternative. */
export const HEADLINE_DEPOSIT = 10_000;
export const ALT_DEPOSIT = 1_000;
/** Verdict thresholds on the break-even share, in per cent. */
export const VERDICT_WORTH_PCT = 10;
export const VERDICT_MARGINAL_PCT = 33;

/** One row of the per-chain fee table, in dollars. */
export interface FeeGroup {
  label: string;
  chains: string[];
  withdraw: number;
  action: number;
  weekly: number;
  exit: number;
}

/**
 * The fee table, stated on the dashboard: Ethereum L1 is the priciest leg in
 * every plan, low-fee L2s and BNB Chain are cheap, Solana cheapest. A plan
 * pays withdraw once, one action fee for each of its two opening actions, the
 * weekly fee once per plan week, and the exit fee once.
 */
export const FEE_GROUPS: FeeGroup[] = [
  { label: 'Ethereum (L1)', chains: ['Ethereum'], withdraw: 25, action: 9, weekly: 6, exit: 22 },
  { label: 'Solana', chains: ['Solana', 'Eclipse', 'Fogo'], withdraw: 2, action: 0.5, weekly: 0.1, exit: 2 },
  { label: 'BNB Chain', chains: ['Binance', 'Op_Bnb', 'Boba_Bnb'], withdraw: 3, action: 1, weekly: 0.4, exit: 2 },
  {
    label: 'Low-fee L2 / sidechain',
    chains: [
      'Arbitrum', 'Arbitrum Nova', 'Base', 'Optimism', 'Polygon', 'Polygon zkEVM', 'zkSync Era', 'Linea', 'Scroll',
      'Mantle', 'Blast', 'Mode', 'Taiko', 'Metis', 'Boba', 'Fraxtal', 'Ink', 'Soneium', 'Unichain', 'World Chain',
      'Zora', 'Mint', 'Abstract', 'Sophon', 'Swellchain', 'Lisk', 'BOB', 'Manta', 'Starknet', 'Immutable zkEVM',
      'Cronos zkEVM', 'Astar zkEVM', 'Silicon zkEVM', 'Lens', 'MetalL2', 'ApeChain', 'Degen', 'Xai', 'Katana',
      'Etherlink', 'MegaETH', 'Monad', 'Plasma', 'X Layer', 'Robinhood Chain', 'Hemi', 'TAC', 'Bitlayer',
      'Plume Mainnet', 'Corn', 'Arc', 'Tempo', 'Stable',
      'Ronin', 'Proton', 'xDai', 'Celo', 'Sonic', 'Fantom', 'Aurora', 'Fuse', 'Moonbeam', 'Moonriver', 'Kava',
      'Canto', 'Harmony', 'Telos', 'Evmos', 'Mixin', 'Meter', 'ThunderCore', 'Astar', 'Shibarium', 'Vana',
      'Berachain', 'CORE', 'Hedera', 'Sei', 'Injective', 'Near', 'Aptos', 'Sui',
    ],
    withdraw: 4, action: 1, weekly: 0.6, exit: 3,
  },
  { label: 'Any other chain', chains: [], withdraw: 8, action: 3, weekly: 1.2, exit: 6 },
];

/** The fee group a chain belongs to; the last group is the default. */
export function feeGroupFor(chain: string): FeeGroup {
  for (const g of FEE_GROUPS) if (g.chains.includes(chain)) return g;
  return FEE_GROUPS[FEE_GROUPS.length - 1]!;
}

/** Plan length in weeks from age: younger protocols farm longer, 6 to 12 weeks. */
export function weeksForAge(age: number | null): number {
  if (age === null) return 9;
  if (age < 180) return 12;
  if (age < 365) return 11;
  if (age < 730) return 10;
  if (age < 1095) return 9;
  if (age < 1460) return 8;
  if (age < 1825) return 7;
  return 6;
}

/** The eight steps' minutes: fixed steps plus ten minutes a week of upkeep. */
export function planMinutes(weeks: number): number {
  return 20 + 30 + 25 + 20 + 10 * weeks + 15 + 10 + 45;
}

/** One deposit's netted farm economics. */
export interface FarmMath {
  deposit: number;
  slice: number;
  fees: number;
  yield_forgone: number;
  total_cost: number;
  net: number;
  breakeven_pct: number;
  net_per_hour: number;
  verdict: string;
  weeks: number;
  hours: number;
}

/** Net one deposit against one protocol: slice, costs, net, break-even share, net per hour, verdict. */
export function farmMath(implied: number, tvl: number, chain: string, weeks: number, deposit: number): FarmMath {
  const fees = feeGroupFor(chain);
  const feeTotal = round2(fees.withdraw + 2 * fees.action + fees.weekly * weeks + fees.exit);
  const yieldForgone = round2(deposit * YIELD_APR * (weeks / 52));
  const totalCost = round2(feeTotal + yieldForgone);
  const slice = round2(SLICE_FRACTION * implied * (deposit / (deposit + tvl)));
  const net = round2(slice - totalCost);
  const breakeven = slice > 0 ? round2((totalCost / slice) * 100) : 9999;
  const hours = round2(planMinutes(weeks) / 60);
  return {
    deposit,
    slice,
    fees: feeTotal,
    yield_forgone: yieldForgone,
    total_cost: totalCost,
    net,
    breakeven_pct: breakeven,
    net_per_hour: round2(net / hours),
    verdict: breakeven <= VERDICT_WORTH_PCT ? 'Worth farming' : breakeven <= VERDICT_MARGINAL_PCT ? 'Marginal' : 'Skip',
    weeks,
    hours,
  };
}

// ------------------------------------------------------------- farm steps

const usd0 = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;
const usd2 = (n: number): string => `$${n.toFixed(2)}`;

/** The main action for a category, sized with the main share of the deposit. */
function mainAction(p: SnapshotProtocol, amount: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const amt = usd0(amount);
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply ${amt} of USDC to ${p.name} on ${chain} and leave the supply position open.`;
  if (c.includes('bridge')) return `Bridge ${amt} of USDC to ${chain} through ${p.name} and hold the bridged balance in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake ${amt} of the chain's staking asset through ${p.name} on ${chain} and keep the receipt token in the wallet.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option')) return `Deposit ${amt} of USDC as margin on ${p.name} and open one small hedged position you can hold for weeks.`;
  if (c.includes('prediction')) return `Fund ${amt} on ${p.name} and place one position on its most liquid market.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('manager')) return `Deposit ${amt} into a ${p.name} vault on ${chain} and keep the vault shares untouched.`;
  if (c.includes('stable')) return `Mint or deposit ${amt} of the stable asset through ${p.name} on ${chain} and hold it in the wallet.`;
  if (c.includes('rwa')) return `Mint ${amt} of ${p.name}'s yield asset on ${chain} and hold it for the full plan.`;
  if (c.includes('insurance')) return `Buy ${amt} of cover from ${p.name} on ${chain} and keep the policy active.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('farm') || c.includes('liquidity')) return `Provide ${amt} of liquidity to ${p.name}'s main USDC pool on ${chain} and keep the LP position open.`;
  return `Deposit ${amt} of USDC into ${p.name} on ${chain} and keep the position open for the full plan.`;
}

/** A second, different action for the same protocol, sized with the rest of the deposit. */
function secondAction(p: SnapshotProtocol, amount: number, chain: string, secondChain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const amt = usd0(amount);
  const where = secondChain !== chain ? `on ${secondChain}` : `in a second pool on ${chain}`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Borrow ${amt} of stablecoin against the ${p.name} supply ${where}, then repay half of it after two weeks and borrow again.`;
  if (c.includes('bridge')) return `Bridge ${amt} back toward your home chain through ${p.name} after a month, then bridge in again ${where}.`;
  if (c.includes('staking') || c.includes('restak')) return `Place a second ${amt} stake through ${p.name} ${where} so the record is not a single deposit.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option')) return `Close the first hedge on ${p.name} after two weeks and open a fresh ${amt} hedge ${where}.`;
  if (c.includes('prediction')) return `Settle the first ${p.name} position and place a second ${amt} position on a different market.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('manager')) return `Deposit a second ${amt} into a different ${p.name} vault ${where} and hold both share balances.`;
  if (c.includes('stable')) return `Redeem ${amt} of the stable asset from ${p.name} after a month, then mint it back in ${where}.`;
  if (c.includes('rwa')) return `Reinvest the first yield payout from ${p.name} into the same asset, adding ${amt} of fresh capital ${where}.`;
  if (c.includes('insurance')) return `Renew the ${p.name} cover with a second ${amt} policy ${where} before the first one lapses.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('farm') || c.includes('liquidity')) return `Add a second ${amt} of liquidity ${where} through ${p.name}, in a different pair or range than the first.`;
  return `Make a second ${amt} deposit into ${p.name} ${where}, a month after the first, from the same wallet.`;
}

/** How the deposit reaches the wallet, by the chain's fee group. */
function fundingRoute(groupLabel: string): string {
  if (groupLabel.startsWith('Ethereum')) return 'as a direct ERC-20 withdrawal, the priciest leg in this plan';
  if (groupLabel.startsWith('Solana')) return 'as a direct Solana withdrawal';
  if (groupLabel.startsWith('BNB')) return 'as a BEP-20 withdrawal';
  if (groupLabel.startsWith('Low-fee')) return 'as a direct withdrawal to the L2, with no bridge hop';
  return 'by the cheapest direct withdrawal route the exchange offers for that chain';
}

/**
 * A protocol's farm plan: eight steps at the headline $10,000 deposit, each
 * one string carrying its cost and its time. Step costs are exactly the fee
 * table's parts, so the steps sum to the netted fees on the row.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const secondChain = p.chains.length > 1 ? p.chains[1]! : chain;
  const group = feeGroupFor(chain);
  const weeks = weeksForAge(age);
  const weeklyTotal = round2(group.weekly * weeks);
  const floor80 = Math.round(p.tvl_usd * 0.8);
  const main = Math.round(HEADLINE_DEPOSIT * 0.6);
  const second = HEADLINE_DEPOSIT - main;
  return [
    `Verify ${p.name}'s official domain from its DefiLlama listing, bookmark it, and create a fresh wallet used only for this farm; keep the seed phrase offline and never reuse a wallet that holds other funds. Cost: $0.00. Time: 20 minutes.`,
    `Move the ${usd0(HEADLINE_DEPOSIT)} deposit into the fresh wallet on ${chain} (${fundingRoute(group.label)}); the two actions below are sized from the full deposit. Cost: ${usd2(group.withdraw)}. Time: 30 minutes.`,
    `${mainAction(p, main, chain)} Cost: ${usd2(group.action)}. Time: 25 minutes.`,
    `${secondAction(p, second, chain, secondChain)} Cost: ${usd2(group.action)}. Time: 20 minutes.`,
    `Make one qualifying action on ${p.name} every week for ${weeks} weeks - a small top-up, a rebalance or a claim-and-restake - so the wallet is active in every weekly snapshot of the plan. Cost: ${usd2(weeklyTotal)}. Time: 10 minutes a week for ${weeks} weeks.`,
    `STOP RULE: stop and begin the unwind early if ${p.name}'s TVL closes under ${usd0(floor80)} - 80% of its ${usd0(p.tvl_usd)} snapshot TVL - on two weekly checks, if the bookmarked domain moves without a signed announcement, or if a token is announced with no allocation for users. Cost: $0.00. Time: 15 minutes to check each week.`,
    `Claim only through the bookmarked official domain from step 1, typed by hand; ignore claim links from social posts, replies and direct messages, which are the standard drainer route for launch claims. Cost: $0.00. Time: 10 minutes.`,
    `Unwind over 7 days after any token event: withdraw in three tranches, sell into the deepest ${chain} pool first, then send the balance back to your exchange in the final tranche. Cost: ${usd2(group.exit)}. Time: 45 minutes of work spread over 7 days.`,
  ];
}

// ------------------------------------------------------------- bands + bootstrap

/** Bootstrap refits and their seeded PRNG: the only randomness in the program, and it is fixed. */
export const BOOTSTRAP_REFITS = 200;
export const BOOTSTRAP_SEED = 20261117;

/** mulberry32: a small seeded PRNG, identical on every run and every machine. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Residual quantiles (in log10) inside one TVL decade, falling back to the global spread. */
interface BandQuantiles {
  q10: number;
  q25: number;
  q75: number;
  q90: number;
}

function bandQuantiles(anchors: Anchor[], fit: ModelFit): { global: BandQuantiles; byDecade: Map<number, BandQuantiles> } {
  const residuals = anchors.map((p) => p.y - Math.log10(predictAnchor(fit.curve, fit.median_anchor_change, fit.median_anchor_age, fit.g, fit.S, fit.K, fit.tau, p)));
  const quantiles = (rs: number[]): BandQuantiles => {
    const s = rs.slice().sort((a, b) => a - b);
    return { q10: quantileSorted(s, 0.1), q25: quantileSorted(s, 0.25), q75: quantileSorted(s, 0.75), q90: quantileSorted(s, 0.9) };
  };
  const byDecade = new Map<number, BandQuantiles>();
  const groups = new Map<number, number[]>();
  anchors.forEach((p, i) => {
    const d = Math.floor(Math.log10(p.tvl_usd));
    const arr = groups.get(d) ?? [];
    arr.push(residuals[i]!);
    groups.set(d, arr);
  });
  for (const [d, rs] of groups) if (rs.length >= 5) byDecade.set(d, quantiles(rs));
  return { global: quantiles(residuals), byDecade };
}

/** A row's P10/P25/P75/P90 dollar band from the residual spread of its TVL decade. */
function bandFor(implied: number, tvl: number, bands: { global: BandQuantiles; byDecade: Map<number, BandQuantiles> }): [number, number, number, number] {
  const q = bands.byDecade.get(Math.floor(Math.log10(tvl))) ?? bands.global;
  const vals = [q.q10, q.q25, q.q75, q.q90].map((qq) => Math.max(1, Math.round(implied * Math.pow(10, qq)))).sort((a, b) => a - b);
  return [vals[0]!, vals[1]!, vals[2]!, vals[3]!];
}

/** Rank ranges from the bootstrap refits: each row's P10-P90 rank across 200 resampled curve fits. */
function bootstrapRankRanges(anchors: Anchor[], scored: { slug: string; tvl_usd: number; mult_g: number; mult_s: number }[]): Map<string, [number, number]> {
  const rand = mulberry32(BOOTSTRAP_SEED);
  const pts = anchors.map((p) => ({ x: p.x, y: p.y }));
  const ranks = scored.map(() => [] as number[]);
  for (let refit = 0; refit < BOOTSTRAP_REFITS; refit++) {
    const sample: Pt[] = [];
    for (let i = 0; i < pts.length; i++) sample.push(pts[Math.floor(rand() * pts.length)]!);
    const fit = fitSizeCurve(sample);
    const preds = scored.map((r) => curveValue(fit, r.tvl_usd) * r.mult_g * r.mult_s);
    const order = scored.map((_, i) => i).sort((a, b) => preds[b]! - preds[a]! || (scored[a]!.slug < scored[b]!.slug ? -1 : 1));
    order.forEach((rowIdx, pos) => ranks[rowIdx]!.push(pos + 1));
  }
  const out = new Map<string, [number, number]>();
  scored.forEach((r, i) => {
    const s = ranks[i]!.slice().sort((a, b) => a - b);
    out.set(r.slug, [Math.round(quantileSorted(s, 0.1)), Math.round(quantileSorted(s, 0.9))]);
  });
  return out;
}

// ------------------------------------------------------------- the board

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** One row of board.json: the ranked board's row, netting and bands included. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  rank_range: [number, number] | null;
  band_p10: number;
  band_p25: number;
  band_p75: number;
  band_p90: number;
  curve_usd: number;
  mult_g: number;
  mult_s: number;
  weeks: number;
  farm: FarmMath;
  farm_alt: FarmMath;
  farm_steps: string[];
}

/** The dashboard's view of one row: the board row plus its watchlist flag and raw record. */
export interface RadarRow extends BoardRow {
  watchlist: boolean;
  record: SnapshotProtocol;
}

/** A traded anchor as the dashboard shows it beside a detail view: fact beside the model's price. */
export interface AnchorRow {
  slug: string;
  name: string;
  category: string | null;
  symbol: string | null;
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  pred_usd: number;
}

/** The model's public face: parameters and constants, as the dashboard states them. */
export interface PublicFit {
  a: number;
  b: number;
  ols_a: number;
  ols_b: number;
  g: number;
  S: number;
  K: number;
  tau: number;
  median_anchor_change: number;
  median_anchor_age: number;
  tvl_offset: number;
}

/** Counts of the whole snapshot's disposition. */
export interface BoardCounts extends AnchorCounts {
  protocols: number;
  ranked: number;
  set_aside: number;
  watchlist_size: number;
  watchlist_covered: number;
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  title: string;
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  counts: BoardCounts;
  fit: PublicFit;
  validation: Validation;
  constants: {
    slice_fraction: number;
    yield_apr: number;
    headline_deposit: number;
    alt_deposit: number;
    verdict_worth_pct: number;
    verdict_marginal_pct: number;
    fee_groups: FeeGroup[];
  };
  summary: BoardSummary;
  rows: RadarRow[];
  anchors: AnchorRow[];
}

/** The entry's title, on the README and the dashboard header alike. */
export const TITLE = 'Undertow — Huber size curve walk-forward tested, farm plans netted to break-even';
/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'undertow-1';

/** Score and rank every rankable pre-token protocol. */
export function buildBoard(snapshot: Snapshot, anchors: Anchor[], fit: ModelFit): BoardRow[] {
  const bands = bandQuantiles(anchors, fit);
  const chosen = snapshot.protocols.filter(isRankable);
  const scored = chosen.map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const curve = curveValue(fit.curve, p.tvl_usd);
    const mg = growthMult(p.change_7d, fit.median_anchor_change, fit.g);
    const ms = seasoningMult(age, fit.median_anchor_age, fit.S, fit.K, fit.tau);
    return { p, age, curve, mg, ms, implied: Math.max(1, Math.round(curve * mg * ms)) };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const ranges = bootstrapRankRanges(
    anchors,
    scored.map((s) => ({ slug: s.p.slug, tvl_usd: s.p.tvl_usd, mult_g: s.mg, mult_s: s.ms })),
  );
  return scored.map((s, i) => {
    const rank = i + 1;
    const chain = s.p.chains.length > 0 ? s.p.chains[0]! : 'its main chain';
    const weeks = weeksForAge(s.age);
    const [p10, p25, p75, p90] = bandFor(s.implied, s.p.tvl_usd, bands);
    let range: [number, number] | null = null;
    if (rank <= 60) {
      const rr = ranges.get(s.p.slug)!;
      range = [Math.min(rr[0], rank), Math.max(rr[1], rank)];
    }
    return {
      rank,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token',
      age_days: s.age,
      implied_value_usd: s.implied,
      rank_range: range,
      band_p10: p10,
      band_p25: p25,
      band_p75: p75,
      band_p90: p90,
      curve_usd: Math.round(s.curve),
      mult_g: round4(s.mg),
      mult_s: round4(s.ms),
      weeks,
      farm: farmMath(s.implied, s.p.tvl_usd, chain, weeks, HEADLINE_DEPOSIT),
      farm_alt: farmMath(s.implied, s.p.tvl_usd, chain, weeks, ALT_DEPOSIT),
      farm_steps: farmSteps(s.p, s.age),
    };
  });
}

/** Everything the dashboard renders, plus the board and the run's own metadata. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData; meta: { counts: BoardCounts; fit: PublicFit; validation: Validation } } {
  const { anchors, counts: anchorCounts } = buildAnchors(snapshot);
  const fit = fitModel(anchors);
  const validation = validateModel(anchors, fit);
  const board = buildBoard(snapshot, anchors, fit);
  const watchlist = new Set(snapshot.watchlist);
  const covered = board.filter((r) => watchlist.has(r.slug)).length;
  const counts: BoardCounts = {
    ...anchorCounts,
    protocols: snapshot.protocols.length,
    ranked: board.length,
    set_aside: snapshot.protocols.length - board.length - anchorCounts.traded_total,
    watchlist_size: snapshot.watchlist.length,
    watchlist_covered: covered,
  };
  const publicFit: PublicFit = {
    a: round4(fit.curve.a),
    b: round4(fit.curve.b),
    ols_a: round4(fit.ols.a),
    ols_b: round4(fit.ols.b),
    g: fit.g,
    S: fit.S,
    K: fit.K,
    tau: fit.tau,
    median_anchor_change: fit.median_anchor_change,
    median_anchor_age: fit.median_anchor_age,
    tvl_offset: TVL_OFFSET,
  };
  const bySlugMap = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const rows: RadarRow[] = board.map((r) => ({ ...r, watchlist: watchlist.has(r.slug), record: bySlugMap.get(r.slug)! }));
  const anchorRows: AnchorRow[] = anchors
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      symbol: p.symbol,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      age_days: p.age_days,
      pred_usd: Math.round(predictAnchor(fit.curve, fit.median_anchor_change, fit.median_anchor_age, fit.g, fit.S, fit.K, fit.tau, p)),
    }))
    .sort((a, b) => b.mcap_usd - a.mcap_usd);
  const radar: RadarData = {
    title: TITLE,
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    counts,
    fit: publicFit,
    validation,
    constants: {
      slice_fraction: SLICE_FRACTION,
      yield_apr: YIELD_APR,
      headline_deposit: HEADLINE_DEPOSIT,
      alt_deposit: ALT_DEPOSIT,
      verdict_worth_pct: VERDICT_WORTH_PCT,
      verdict_marginal_pct: VERDICT_MARGINAL_PCT,
      fee_groups: FEE_GROUPS,
    },
    summary: summarizeBoard(board.map((r) => ({ rank: r.rank, slug: r.slug, name: r.name, category: r.category, implied_value_usd: r.implied_value_usd, verdict: r.farm.verdict }))),
    rows,
    anchors: anchorRows,
  };
  return { board, radar, meta: { counts, fit: publicFit, validation } };
}

// ------------------------------------------------------------- snapshot + gate

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const bySlugMap = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  for (const r of board) if (!bySlugMap.has(r.slug)) return `${r.slug} is not a snapshot protocol`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
