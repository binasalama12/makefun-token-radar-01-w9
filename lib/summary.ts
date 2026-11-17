// Undertow — the board's shape in a few numbers, for the run log and the page.
//
// Everything here is counted from the board's own rows: where the implied
// values sit, how the farm verdicts split at the headline deposit, and which
// categories hold the board's weight. Nothing is hand-written and no protocol
// name is ever special-cased.

/** One bucket of a breakdown: a label and how many rows fall in it. */
export interface SummaryBucket {
  label: string;
  count: number;
}

/** The slice of a board row the summary counts. */
export interface SummarisedRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  implied_value_usd: number;
  verdict: string;
}

/** The board, summarised. */
export interface BoardSummary {
  total: number;
  top_three: { rank: number; slug: string; name: string; implied_value_usd: number }[];
  median_implied_usd: number;
  value_bands: SummaryBucket[];
  verdict_counts: SummaryBucket[];
  top_categories: SummaryBucket[];
}

/** The middle value of a list of whole dollars, or 0 when it is empty. */
export function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function valueBands(rows: SummarisedRow[]): SummaryBucket[] {
  const bands: SummaryBucket[] = [
    { label: 'over $100M', count: 0 },
    { label: '$10M - $100M', count: 0 },
    { label: '$1M - $10M', count: 0 },
    { label: 'under $1M', count: 0 },
  ];
  for (const r of rows) {
    const v = r.implied_value_usd;
    if (v >= 100_000_000) bands[0]!.count += 1;
    else if (v >= 10_000_000) bands[1]!.count += 1;
    else if (v >= 1_000_000) bands[2]!.count += 1;
    else bands[3]!.count += 1;
  }
  return bands;
}

function verdictCounts(rows: SummarisedRow[]): SummaryBucket[] {
  const out: SummaryBucket[] = [
    { label: 'Worth farming', count: 0 },
    { label: 'Marginal', count: 0 },
    { label: 'Skip', count: 0 },
  ];
  for (const r of rows) {
    if (r.verdict === 'Worth farming') out[0]!.count += 1;
    else if (r.verdict === 'Marginal') out[1]!.count += 1;
    else out[2]!.count += 1;
  }
  return out;
}

function topCategories(rows: SummarisedRow[]): SummaryBucket[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = r.category ?? 'Other';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const top = sorted.slice(0, 5).map(([label, count]) => ({ label, count }));
  const rest = sorted.slice(5).reduce((n, [, c]) => n + c, 0);
  if (rest > 0) top.push({ label: 'Other', count: rest });
  return top;
}

/** The board's summary, from its rows alone. */
export function summarizeBoard(rows: SummarisedRow[]): BoardSummary {
  return {
    total: rows.length,
    top_three: rows.slice(0, 3).map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      implied_value_usd: r.implied_value_usd,
    })),
    median_implied_usd: medianOf(rows.map((r) => r.implied_value_usd)),
    value_bands: valueBands(rows),
    verdict_counts: verdictCounts(rows),
    top_categories: topCategories(rows),
  };
}

/** The summary as plain lines for the run log. */
export function summaryLines(s: BoardSummary): string[] {
  const top = s.top_three.map((t) => `#${t.rank} ${t.slug}`).join(', ');
  const bands = s.value_bands.map((b) => `${b.label}: ${b.count}`).join(', ');
  const verdicts = s.verdict_counts.map((b) => `${b.label}: ${b.count}`).join(', ');
  const cats = s.top_categories.map((b) => `${b.label} ${b.count}`).join(', ');
  return [
    `top three are ${top}`,
    `median implied value is $${s.median_implied_usd.toLocaleString('en-US')}`,
    `value bands - ${bands}`,
    `verdicts at the $10,000 deposit - ${verdicts}`,
    `top categories - ${cats}`,
  ];
}
