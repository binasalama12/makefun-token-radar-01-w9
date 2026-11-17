[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

[![rank](https://make.fun/badge/token-radar-01/binasalama12/makefun-token-radar-01-w9/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

[![reward](https://make.fun/badge/token-radar-01/binasalama12/makefun-token-radar-01-w9/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Undertow — Huber size curve walk-forward tested, farm plans netted to break-even

A token launch radar for make.fun's token-radar-01 bounty. It prices every
pre-token protocol off the tokens that already trade in the same snapshot,
tests the pricing out of sample, and nets every farm plan to a verdict.

## The model

Anchors: of the snapshot's 758 protocols, 144 carry a market cap. The anchor
filters (no Bridge / Canonical Bridge / Liquid Staking / Liquid Restaking /
Restaked BTC / CEX categories, no whole-word wrapped / staked / staking, no
versioned names, no exchange-prefixed names) leave 102; 10 records with a
market cap of zero or less are dead records and are set aside; one anchor per
ticker — the largest-TVL member of each symbol family — leaves **92 anchor
families**.

```
fitSizeCurve()  log10(mcap) = a + b * log10(tvl + $100,000,000)
                OLS first, then 3 Huber IRLS iterations (k = 1.345 on the
                residual MAD). Fitted: a = 1.3396, b = 0.6793.
growth carry    x (1 + clamp(change_7d - median anchor change, -60, 120)
                / 100) ^ g, with g = 0.7 chosen on a 0-0.8 grid by
                leave-one-out on the anchors
seasoning       x S / (S + K * exp(-age_days / tau)), with S/K/tau =
                3.5 / 4 / 1200 chosen on a coarse grid by the same test;
                an unknown age uses the median anchor age (856 days)
implied         = curve(tvl) x growth carry x seasoning, whole dollars
```

Validation is computed by the program and printed on the board: leave-one-out
median miss of **3.17x** for the full model, against 4.65x for the best flat
multiple, 3.70x for the curve alone, 3.62x for curve + growth, and 4.45x for
the previous round's hand-weighted 0.32x formula on the same anchors.
Walk-forward by listing date misses by 3.34x forward (earliest 60% trains,
latest 40% tested) and 3.52x in reverse. Rank ranges come from 200 bootstrap
refits (mulberry32, seed 20261117); value bands are the residual spread inside
each TVL decade.

## The board

289 rows: every rankable pre-token protocol (no token on record, not a CEX,
not a versioned pool), including all 40 watchlist protocols, ranked by
implied value. Each row carries its bootstrap rank range (top 60), its
P10–P90 band, and a farm plan netted at a $10,000 deposit:

```
slice       = 10% x implied x deposit / (deposit + TVL)
costs       = per-chain fee table (withdrawal + 2 actions + weekly x weeks
              + exit; Ethereum L1 priciest, L2s and Solana cheap)
              + yield forgone at 4.5% a year over the plan's 6-12 weeks
net         = slice - total cost;  break-even = total cost / slice
verdict     = Worth farming (break-even <= 10%), Marginal (<= 33%), else Skip
```

At $10,000 the board nets out at 2 Worth farming, 60 Marginal, 227 Skip —
the netting is honest, so the few passes mean something. Every protocol gets
the same eight-step plan (verify the domain, fund, two actions, weekly
upkeep, a TVL stop rule at 80% of snapshot TVL, claim only via the bookmarked
domain, unwind over 7 days), each step one string with its cost and time.

## The dashboard

A static page with no network: header stats (40/40 watchlist, 289 ranked,
92 anchors, 325 set aside, headline validation), the method panel naming
`fitSizeCurve()` and the netting constants, the `validateModel()` ablation
and walk-forward panel, a log-log scatter drawn from the row data (traded
anchors against pre-token rows at implied value), filter chips (All /
Watchlist / Above floor / Early / Worth farming / Marginal / Skip) with
counts, search, a primary-chain select, and a $1,000 / $10,000 deposit toggle
that recomputes every verdict in the page. The sortable table carries rank
and rank range, implied value with its band, TVL, 7d change, time with no
token, slice, net, break-even, net per hour and verdict. The detail view
shows the value decomposition, the raw ten-field snapshot record, the
nearest traded comps by TVL in the same category, a $1K vs $10K deposit
table, and the eight-step farm timeline with totals.

URL views: `?view=board` (default), `?view=detail&slug=<slug>`,
`?view=filtered&filter=<chip>` or `&f=<text>`.

## How to run it

Node 22 or later, standard library only, no install:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
```

That writes `out/board.json`, `out/data.js`, `out/dashboard/`,
`out/screenshots/` and `out/dossier.json` (written last, via the vendored
`buildDossier`). The program runs twice and writes the same bytes both
times: no clock, no unseeded randomness, no network — the only randomness
is the seeded bootstrap, and everything derives from the snapshot.
