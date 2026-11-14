# Airdrop Compass — farm-plan-first token radar

A token launch radar for make.fun's token-radar-01 bounty. It reads a sealed
DefiLlama snapshot, ranks the pre-token protocols by an implied value, and
gives every protocol an 8-step farm plan where each step states what it costs
and how long it takes.

## What it does

- **Board:** all 40 watchlist protocols (TVL at or above the $50M floor, no
  token on record) plus the 160 highest-TVL pre-token protocols below the
  floor — 200 rows, ranked by implied value.
- **Model:** `implied = round(tvl x 0.35 x (1 + clamp(change_7d, -60, 120) / 100
  x 0.6) x (0.6 + 0.4 x min(age_days, 1095) / 1095))`. Age is the days from
  `listed_at` to the snapshot's `as_of` date; an unlisted age defaults to 365
  days. The same function scores every protocol — no name is special-cased.
- **Farm plans:** 8 concrete steps per protocol, derived from its category,
  chains, TVL and age, each with a cost and a time.
- **Dashboard:** a warm sand page with a sortable, filterable board, a
  detail view per protocol (numbered farm checklist with cost/time chips),
  and URL views: `?view=board`, `?view=detail&slug=<slug>`,
  `?view=filtered&f=<text>`. No network, no framework.

## How to run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

`main.ts` reads the snapshot from `--input` (a file or a directory holding
`snapshot.json`, default `/input`), writes `board.json`, `data.js`,
`dashboard/`, `screenshots/` and `dossier.json` (written last, with the
vendored `vendor/makefun-board.ts`) into `--output` or `MAKEFUN_OUTPUT_DIR`
(default `/output`). It is deterministic: no clock, no randomness, no
network — two runs write byte-identical `board.json` and `dossier.json`.

## Layout

- `main.ts` — entrypoint: read, score, gate-check, write outputs.
- `lib/model.ts` — the model, the farm-plan derivation and the board builder.
- `vendor/makefun-board.ts` — make.fun's dossier library (copied from the kit).
- `dashboard/` — `index.html`, `app.css`, `app.js`: the static page.
- `screenshots/` — the board, a detail view and a filtered view.
