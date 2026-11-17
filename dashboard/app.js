// Undertow — plain dashboard. It reads window.RADAR (written beside
// dashboard/ by main.ts) and renders the ranked board, the fitted model's
// method and validation panels, a log-log scatter, filter chips, a sortable
// table and a per-protocol detail view. Verdicts are recomputed in the page
// from each row's own fields whenever the deposit toggle moves, using the
// same netting constants main.ts publishes. No network: every byte it shows
// is in data.js.
//
// URL views: ?view=board (default), ?view=detail&slug=<slug>,
// ?view=filtered&filter=<chip> or &f=<text>.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var C = DATA.constants;
  var state = { q: '', chain: 'all', filter: 'all', deposit: C.headline_deposit, sort: 'rank', dir: 1, selected: null, view: 'board' };

  var usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usdFmt.format(n);
  }
  function fmtFull(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function fmtMoney(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var sign = n < 0 ? '-$' : '$';
    return sign + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y (' + days.toLocaleString('en-US') + 'd)';
    return days + 'd';
  }
  function verdictClass(v) { return v === 'Worth farming' ? 'worth' : v === 'Marginal' ? 'marginal' : 'skip'; }

  // The netting, recomputed in the page: the same fee table, slice share and
  // yield rate main.ts publishes in DATA.constants, applied to the row's own
  // implied value, TVL, chain and plan length.
  function feesFor(chain) {
    for (var i = 0; i < C.fee_groups.length; i++) {
      if (C.fee_groups[i].chains.indexOf(chain) >= 0) return C.fee_groups[i];
    }
    return C.fee_groups[C.fee_groups.length - 1];
  }
  function netting(row, deposit) {
    var chain = row.chains && row.chains.length ? row.chains[0] : 'its main chain';
    var g = feesFor(chain);
    var fees = Math.round((g.withdraw + 2 * g.action + g.weekly * row.weeks + g.exit) * 100) / 100;
    var yld = Math.round(deposit * C.yield_apr * (row.weeks / 52) * 100) / 100;
    var total = Math.round((fees + yld) * 100) / 100;
    var slice = Math.round(C.slice_fraction * row.implied_value_usd * (deposit / (deposit + row.tvl_usd)) * 100) / 100;
    var net = Math.round((slice - total) * 100) / 100;
    var be = slice > 0 ? Math.round((total / slice) * 10000) / 100 : 9999;
    var verdict = be <= C.verdict_worth_pct ? 'Worth farming' : be <= C.verdict_marginal_pct ? 'Marginal' : 'Skip';
    return { deposit: deposit, slice: slice, fees: fees, yield_forgone: yld, total_cost: total, net: net, breakeven_pct: be, net_per_hour: Math.round((net / row.farm.hours) * 100) / 100, verdict: verdict };
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function readParams() {
    var params = new URLSearchParams(window.location.search);
    var view = params.get('view');
    if (view === 'detail' || view === 'filtered' || view === 'board') state.view = view;
    if (params.get('slug')) state.selected = params.get('slug');
    if (params.get('f')) state.q = params.get('f');
    if (params.get('filter')) state.filter = params.get('filter');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('deposit') === String(C.alt_deposit)) state.deposit = C.alt_deposit;
  }
  function writeParams() {
    var params = new URLSearchParams();
    if (state.view !== 'board') params.set('view', state.view);
    if (state.selected) params.set('slug', state.selected);
    if (state.q) params.set('f', state.q);
    if (state.filter !== 'all') params.set('filter', state.filter);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.deposit !== C.headline_deposit) params.set('deposit', String(state.deposit));
    var next = params.toString();
    window.history.replaceState(null, '', next ? window.location.pathname + '?' + next : window.location.pathname);
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Undertow' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: DATA.model_version + ' model' })
      )
    );
  }

  function lede() {
    var c = DATA.counts;
    var loo = DATA.validation.loo;
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.title }),
        el('p', { text: 'Every pre-token protocol is priced off the tokens that already trade: a Huber size curve fitted to ' + c.families + ' one-per-ticker anchor families, carried by seven-day growth and by how long the protocol has run with no token, then walk-forward tested. Each row\'s farm plan is netted to the dollar at a $' + C.headline_deposit.toLocaleString('en-US') + ' deposit — most rows honestly come out Skip.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: c.watchlist_covered + ' / ' + c.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows ranked' }), el('b', { text: String(c.ranked) })),
        el('div', { class: 'fact' }, el('span', { text: 'Anchor families fitted' }), el('b', { text: String(c.families) })),
        el('div', { class: 'fact' }, el('span', { text: 'Protocols set aside' }), el('b', { text: String(c.set_aside) })),
        el('div', { class: 'fact' }, el('span', { text: 'LOO miss: full vs flat' }), el('b', { text: loo.full_model.miss_x + 'x vs ' + loo.flat_multiple.miss_x + 'x' }))
      )
    );
  }

  function methodPanel() {
    var f = DATA.fit;
    var c = DATA.counts;
    var feeRows = C.fee_groups.map(function (g) {
      return el('tr', null,
        el('td', { text: g.label }),
        el('td', { class: 'num', text: '$' + g.withdraw.toFixed(2) }),
        el('td', { class: 'num', text: '$' + g.action.toFixed(2) }),
        el('td', { class: 'num', text: '$' + g.weekly.toFixed(2) }),
        el('td', { class: 'num', text: '$' + g.exit.toFixed(2) })
      );
    });
    return el('section', { class: 'panel' },
      el('h2', { text: 'How a value is built — fitSizeCurve()' }),
      el('div', { class: 'formula', text: 'log10(mcap) = ' + f.a + ' + ' + f.b + ' * log10(tvl + $100,000,000)   ·   implied = curve(tvl) x growth carry x seasoning' }),
      el('p', { text: 'The curve is fitted to the snapshot\'s own traded tokens: ' + c.traded_total + ' protocols carry a market cap, ' + c.after_filters + ' survive the anchor filters (no bridge, staking or exchange categories, no wrapped / staked / versioned names, no exchange-prefixed names), ' + c.dead_records + ' dead records with a market cap of zero or less are set aside, and one anchor per ticker — the largest-TVL member of each symbol family — leaves ' + c.families + ' families. Ordinary least squares first (a = ' + f.ols_a + ', b = ' + f.ols_b + '), then three Huber IRLS iterations at k = 1.345 on the residual MAD pull the line to a = ' + f.a + ', b = ' + f.b + ': big protocols are worth more per TVL dollar, but less than proportionally.' }),
      el('p', { text: 'Growth carry multiplies the curve by (1 + clamp(change_7d − ' + f.median_anchor_change + ', −60, 120) / 100)^' + f.g + ' — growth is measured against the anchor median change, and the exponent g = ' + f.g + ' is the grid value (0 to 0.8 by 0.1) the anchors\' leave-one-out test prefers. Seasoning multiplies by ' + f.S + ' / (' + f.S + ' + ' + f.K + ' * exp(−age_days / ' + f.tau + ')), the coarse-grid triple the same test prefers with growth held at its chosen g; a protocol with no listing date is seasoned at the median anchor age of ' + f.median_anchor_age + ' days. The result is rounded to whole dollars, at least $1.' }),
      el('h3', { text: 'How a farm verdict is netted' }),
      el('p', { text: 'Slice if it launches = ' + (C.slice_fraction * 100) + '% of implied value x deposit / (deposit + TVL). Costs are the fee table below — a plan pays the withdrawal once, one action fee for each of its two opening actions, the weekly fee once per plan week, and the exit fee once — plus yield forgone at ' + (C.yield_apr * 100) + '% a year on the deposit over the plan\'s weeks. Plan length runs 6 to 12 weeks by age, younger longer. Net = slice − total cost; break-even = total cost / slice; net per hour divides by the plan\'s timed hours. Verdict: break-even at most ' + C.verdict_worth_pct + '% is Worth farming, at most ' + C.verdict_marginal_pct + '% is Marginal, anything above is Skip.' }),
      el('div', { class: 'table-wrap' }, el('table', { class: 'fees' },
        el('thead', null, el('tr', null, el('th', { text: 'Chain group' }), el('th', { text: 'Withdraw' }), el('th', { text: 'Per action' }), el('th', { text: 'Weekly' }), el('th', { text: 'Exit' }))),
        el('tbody', null, feeRows)
      ))
    );
  }

  function validationPanel() {
    var v = DATA.validation;
    var rows = [
      ['Flat multiple (best single mcap/TVL)', v.loo.flat_multiple],
      ['Size curve only', v.loo.curve_only],
      ['Curve + growth carry', v.loo.curve_growth],
      ['Full model (curve + growth + seasoning)', v.loo.full_model],
      ['Previous hand-weighted formula (0.32x)', v.loo.w6_formula]
    ].map(function (r) {
      return el('tr', null,
        el('td', { text: r[0] }),
        el('td', { class: 'num', text: r[1].median_log10_err.toFixed(4) }),
        el('td', { class: 'num', text: r[1].miss_x.toFixed(2) + 'x' })
      );
    });
    return el('section', { class: 'panel' },
      el('h2', { text: 'Out of sample — validateModel()' }),
      el('p', { text: 'Leave-one-out on the ' + DATA.counts.families + ' anchors: each anchor is priced by a curve refitted without it, and the median miss is reported. The full model misses by ' + v.loo.full_model.miss_x + 'x against the flat multiple\'s ' + v.loo.flat_multiple.miss_x + 'x and the previous hand-weighted formula\'s ' + v.loo.w6_formula.miss_x + 'x on the same anchors. Walk-forward by listing date: fitted on the earliest 60% of dated anchors (' + v.walk_forward.forward.train_n + '), the model misses the latest 40% (' + v.walk_forward.forward.test_n + ') by ' + v.walk_forward.forward.miss_x + 'x; reversed, fitted on the latest 60%, it misses the earliest 40% by ' + v.walk_forward.reverse.miss_x + 'x. Rank ranges come from ' + v.bootstrap.refits + ' bootstrap refits (seeded PRNG, seed ' + v.bootstrap.seed + '): each top-60 row carries its P10–P90 rank across refits, and every row\'s band is the residual spread of its TVL decade.' }),
      el('div', { class: 'table-wrap' }, el('table', null,
        el('thead', null, el('tr', null, el('th', { text: 'Model' }), el('th', { text: 'LOO median |log10 err|' }), el('th', { text: 'Median miss' }))),
        el('tbody', null, rows)
      ))
    );
  }

  function scatterPanel() {
    var W = 720, H = 300, L = 64, R = 12, T = 12, B = 34;
    var tvls = DATA.anchors.map(function (a) { return a.tvl_usd; }).concat(DATA.rows.map(function (r) { return r.tvl_usd; }));
    var vals = DATA.anchors.map(function (a) { return a.mcap_usd; }).concat(DATA.rows.map(function (r) { return r.implied_value_usd; }));
    var x0 = Math.log10(Math.min.apply(null, tvls)), x1 = Math.log10(Math.max.apply(null, tvls));
    var y0 = Math.log10(Math.min.apply(null, vals)), y1 = Math.log10(Math.max.apply(null, vals));
    function X(v) { return L + ((Math.log10(v) - x0) / (x1 - x0)) * (W - L - R); }
    function Y(v) { return T + (1 - (Math.log10(v) - y0) / (y1 - y0)) * (H - T - B); }
    var parts = ['<svg class="scatter" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Log-log scatter of TVL against value">'];
    for (var gx = Math.ceil(x0); gx <= Math.floor(x1); gx++) {
      var px = X(Math.pow(10, gx));
      parts.push('<line x1="' + px.toFixed(1) + '" y1="' + T + '" x2="' + px.toFixed(1) + '" y2="' + (H - B) + '" stroke="#c2d3cf" stroke-width="1"/>');
      parts.push('<text x="' + px.toFixed(1) + '" y="' + (H - B + 18) + '" font-size="10" fill="#54706a" text-anchor="middle">$' + (gx >= 9 ? (Math.pow(10, gx - 9)) + 'B' : gx >= 6 ? (Math.pow(10, gx - 6)) + 'M' : (Math.pow(10, gx - 3)) + 'K') + '</text>');
    }
    for (var gy = Math.ceil(y0); gy <= Math.floor(y1); gy++) {
      var py = Y(Math.pow(10, gy));
      parts.push('<line x1="' + L + '" y1="' + py.toFixed(1) + '" x2="' + (W - R) + '" y2="' + py.toFixed(1) + '" stroke="#c2d3cf" stroke-width="1"/>');
      parts.push('<text x="' + (L - 6) + '" y="' + (py + 3).toFixed(1) + '" font-size="10" fill="#54706a" text-anchor="end">$' + (gy >= 9 ? (Math.pow(10, gy - 9)) + 'B' : gy >= 6 ? (Math.pow(10, gy - 6)) + 'M' : (Math.pow(10, gy - 3)) + 'K') + '</text>');
    }
    var pts = [];
    for (var i = 0; i <= 24; i++) {
      var tvl = Math.pow(10, x0 + ((x1 - x0) * i) / 24);
      var val = Math.pow(10, DATA.fit.a + DATA.fit.b * Math.log10(tvl + DATA.fit.tvl_offset));
      pts.push((i === 0 ? 'M' : 'L') + X(tvl).toFixed(1) + ' ' + Y(val).toFixed(1));
    }
    parts.push('<path d="' + pts.join(' ') + '" fill="none" stroke="#0f766e" stroke-width="2"/>');
    DATA.rows.forEach(function (r) {
      parts.push('<circle cx="' + X(r.tvl_usd).toFixed(1) + '" cy="' + Y(r.implied_value_usd).toFixed(1) + '" r="2" fill="#d97706" fill-opacity="0.5"/>');
    });
    DATA.anchors.forEach(function (a) {
      parts.push('<circle cx="' + X(a.tvl_usd).toFixed(1) + '" cy="' + Y(a.mcap_usd).toFixed(1) + '" r="2.6" fill="#115e59"/>');
    });
    parts.push('</svg>');
    return el('section', { class: 'panel' },
      el('h2', { text: 'Traded tokens set the curve; the rest sit on it' }),
      el('p', { class: 'sub', text: 'Log-log: TVL across, value up. Teal dots are the traded anchors at their real market caps; amber dots are the pre-token rows at their implied values; the line is the fitted size curve before its carry terms.' }),
      el('div', { html: parts.join('') }),
      el('div', { class: 'legend' },
        el('span', null, el('span', { class: 'dot', style: 'background:#115e59' }), 'Traded anchors (actual mcap)'),
        el('span', null, el('span', { class: 'dot', style: 'background:#d97706' }), 'Pre-token rows (implied)'),
        el('span', null, el('span', { class: 'dot', style: 'background:#0f766e' }), 'Fitted curve')
      )
    );
  }

  function chipCounts() {
    var counts = { all: DATA.rows.length, watchlist: 0, above: 0, early: 0, worth: 0, marginal: 0, skip: 0 };
    DATA.rows.forEach(function (r) {
      if (r.watchlist) counts.watchlist++;
      else if (r.tvl_usd >= DATA.floor_usd) counts.above++;
      if (r.tvl_usd < DATA.floor_usd) counts.early++;
      var v = netting(r, state.deposit).verdict;
      if (v === 'Worth farming') counts.worth++;
      else if (v === 'Marginal') counts.marginal++;
      else counts.skip++;
    });
    return counts;
  }

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.filter === 'watchlist' && !r.watchlist) return false;
      if (state.filter === 'above' && (r.watchlist || r.tvl_usd < DATA.floor_usd)) return false;
      if (state.filter === 'early' && r.tvl_usd >= DATA.floor_usd) return false;
      if (state.filter === 'worth' && netting(r, state.deposit).verdict !== 'Worth farming') return false;
      if (state.filter === 'marginal' && netting(r, state.deposit).verdict !== 'Marginal') return false;
      if (state.filter === 'skip' && netting(r, state.deposit).verdict !== 'Skip') return false;
      if (state.chain !== 'all' && (!r.chains || r.chains[0] !== state.chain)) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      var na = netting(a, state.deposit), nb = netting(b, state.deposit);
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? -Infinity : a.age_days; bv = b.age_days === null ? -Infinity : b.age_days; }
      else if (key === 'implied') { av = a.implied_value_usd; bv = b.implied_value_usd; }
      else if (key === 'slice') { av = na.slice; bv = nb.slice; }
      else if (key === 'net') { av = na.net; bv = nb.net; }
      else if (key === 'be') { av = na.breakeven_pct; bv = nb.breakeven_pct; }
      else if (key === 'nph') { av = na.net_per_hour; bv = nb.net_per_hour; }
      else { av = a.rank; bv = b.rank; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function chips() {
    var counts = chipCounts();
    var defs = [
      ['all', 'All', counts.all],
      ['watchlist', 'Watchlist', counts.watchlist],
      ['above', 'Above floor', counts.above],
      ['early', 'Early', counts.early],
      ['worth', 'Worth farming', counts.worth],
      ['marginal', 'Marginal', counts.marginal],
      ['skip', 'Skip', counts.skip]
    ];
    return el('div', { class: 'chips' }, defs.map(function (d) {
      return el('button', {
        type: 'button', class: 'chip', 'aria-pressed': state.filter === d[0] ? 'true' : 'false',
        onclick: function () { state.filter = d[0]; state.view = d[0] === 'all' && !state.q ? 'board' : 'filtered'; writeParams(); render(); }
      }, d[1] + ' ', el('b', { text: String(d[2]) }));
    }));
  }

  function controls() {
    var chains = Array.from(new Set(DATA.rows.map(function (r) { return r.chains && r.chains.length ? r.chains[0] : 'none'; }))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; if (state.q) state.view = 'filtered'; writeParams(); render(); });
    var select = el('select', { id: 'chain', 'aria-label': 'Filter by primary chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { state.chain = select.value; writeParams(); render(); });
    function depBtn(amount) {
      return el('button', {
        type: 'button', 'aria-pressed': state.deposit === amount ? 'true' : 'false', text: '$' + amount.toLocaleString('en-US'),
        onclick: function () { state.deposit = amount; writeParams(); render(); }
      });
    }
    return el('div', null,
      chips(),
      el('div', { class: 'controls' },
        el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
        el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Primary chain' }), select),
        el('div', { class: 'field' }, el('span', { class: 'lab', text: 'Deposit (verdicts recompute)' }), el('div', { class: 'toggle' }, depBtn(C.alt_deposit), depBtn(C.headline_deposit))),
        el('span', { class: 'count', text: filteredRows().length + ' rows shown' })
      )
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = key === 'rank' || key === 'name' ? 1 : -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(filteredRows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'At this deposit no row clears the filter. Clear the search or pick another chip to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.chain = 'all'; state.filter = 'all'; state.view = 'board'; writeParams(); render(); } })
      ));
    }
    var tbody = el('tbody');
    list.forEach(function (r) {
      var n = netting(r, state.deposit);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false', tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num' }, String(r.rank), r.rank_range ? el('div', { class: 'band', text: r.rank_range[0] + '–' + r.rank_range[1] }) : null),
        el('td', null, el('div', { class: 'name' },
          el('b', null, r.name, r.watchlist ? el('span', { class: 'wl', text: 'WL' }) : null),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') : 'n/a') })
        )),
        el('td', { class: 'num' }, el('b', { text: fmtUsd(r.implied_value_usd) }), el('div', { class: 'band', text: 'P10 ' + fmtUsd(r.band_p10) + ' – P90 ' + fmtUsd(r.band_p90) })),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: fmtMoney(n.slice) }),
        el('td', { class: 'num ' + (n.net >= 0 ? 'pos' : 'neg'), text: fmtMoney(n.net) }),
        el('td', { class: 'num', text: n.breakeven_pct >= 9999 ? '—' : n.breakeven_pct.toFixed(1) + '%' }),
        el('td', { class: 'num', text: fmtMoney(n.net_per_hour) }),
        el('td', null, el('span', { class: 'verdict ' + verdictClass(n.verdict), text: n.verdict }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: 'Pre-token protocols ranked by implied value at a $' + state.deposit.toLocaleString('en-US') + ' deposit. Rank range is the P10–P90 rank across 200 bootstrap refits (top 60). Select a row for its detail.' }),
          el('thead', null, el('tr', null,
            sortHeader('rank', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('implied', 'Implied + band'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7D'),
            sortHeader('age', 'No token for'),
            sortHeader('slice', 'Slice'),
            sortHeader('net', 'Net'),
            sortHeader('be', 'Break-even'),
            sortHeader('nph', 'Net/hour'),
            el('th', { scope: 'col', text: 'Verdict' })
          )),
          tbody
        )
      )
    );
  }

  function detailSection(row) {
    var n10 = netting(row, C.headline_deposit);
    var n1 = netting(row, C.alt_deposit);
    var rec = row.record;
    function kv(label, value) { return [el('dt', { text: label }), el('dd', { text: value })]; }
    var record = el('dl', { class: 'kv' },
      kv('slug', rec.slug), kv('name', rec.name), kv('category', rec.category === null ? 'null' : rec.category),
      kv('chains', '[' + rec.chains.join(', ') + ']'), kv('tvl_usd', String(rec.tvl_usd)),
      kv('change_7d', rec.change_7d === null ? 'null' : String(rec.change_7d)),
      kv('mcap_usd', rec.mcap_usd === null ? 'null' : String(rec.mcap_usd)),
      kv('listed_at', rec.listed_at === null ? 'null' : rec.listed_at),
      kv('gecko_id', rec.gecko_id === null ? 'null' : rec.gecko_id),
      kv('symbol', rec.symbol === null ? 'null' : rec.symbol)
    );
    var comps = DATA.anchors
      .filter(function (a) { return a.category === row.category; })
      .sort(function (a, b) { return Math.abs(Math.log10(a.tvl_usd) - Math.log10(row.tvl_usd)) - Math.abs(Math.log10(b.tvl_usd) - Math.log10(row.tvl_usd)); })
      .slice(0, 5);
    var compRows = comps.map(function (a) {
      return el('tr', null,
        el('td', null, el('b', { text: a.name }), ' ', el('span', { class: 'sub', text: a.symbol || '' })),
        el('td', { class: 'num', text: fmtUsd(a.tvl_usd) }),
        el('td', { class: 'num', text: fmtUsd(a.mcap_usd) }),
        el('td', { class: 'num', text: fmtUsd(a.pred_usd) }),
        el('td', { class: 'num', text: (a.mcap_usd / a.pred_usd).toFixed(2) + 'x' })
      );
    });
    function depRow(label, f) {
      return el('tr', null, el('td', { text: label }), el('td', { class: 'num', text: f(n1) }), el('td', { class: 'num', text: f(n10) }));
    }
    var steps = row.farm_steps || [];
    return el('section', { class: 'panel', id: 'detail' },
      el('p', { class: 'note', text: 'Detail view — rank ' + row.rank + ' of ' + DATA.counts.ranked + (row.rank_range ? ', bootstrap rank range ' + row.rank_range[0] + '–' + row.rank_range[1] : '') + '. Back to the board to keep browsing.' }),
      el('h2', null, row.name, row.watchlist ? el('span', { class: 'wl', text: 'WATCHLIST' }) : null),
      el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + ' — listed ' + (row.listed_at || 'on an unknown date') + ', ' + fmtAge(row.age_days) + ' with no token on record. Implied value is a model, not a price.' }),
      el('h3', { text: 'Value decomposition — impliedValue()' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'Size curve at this TVL' }), el('b', { class: 'num', text: fmtFull(row.curve_usd) })),
        el('div', null, el('span', { text: 'Growth carry x' }), el('b', { class: 'num', text: String(row.mult_g) })),
        el('div', null, el('span', { text: 'Seasoning x' }), el('b', { class: 'num', text: String(row.mult_s) })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtFull(row.implied_value_usd) })),
        el('div', null, el('span', { text: 'Band P10 – P90' }), el('b', { class: 'num', text: fmtUsd(row.band_p10) + ' – ' + fmtUsd(row.band_p90) })),
        el('div', null, el('span', { text: 'Band P25 – P75' }), el('b', { class: 'num', text: fmtUsd(row.band_p25) + ' – ' + fmtUsd(row.band_p75) }))
      ),
      el('h3', { text: 'Snapshot record (all ten fields, as sealed)' }),
      record,
      el('h3', { text: 'Nearest traded comps by TVL, same category' }),
      comps.length ? el('div', { class: 'table-wrap' }, el('table', null,
        el('thead', null, el('tr', null, el('th', { text: 'Anchor' }), el('th', { text: 'TVL' }), el('th', { text: 'Actual mcap' }), el('th', { text: 'Model price' }), el('th', { text: 'Actual / model' }))),
        el('tbody', null, compRows)
      )) : el('p', { class: 'sub', text: 'No traded anchor shares this category; the curve still prices the row from all ' + DATA.counts.families + ' families.' }),
      el('h3', { text: 'Deposit table — netted at both sizes' }),
      el('div', { class: 'table-wrap' }, el('table', null,
        el('thead', null, el('tr', null, el('th', { text: 'At launch' }), el('th', { text: '$1,000 deposit' }), el('th', { text: '$10,000 deposit' }))),
        el('tbody', null,
          depRow('Slice of the launch', function (n) { return fmtMoney(n.slice); }),
          depRow('Chain fees', function (n) { return fmtMoney(n.fees); }),
          depRow('Yield forgone', function (n) { return fmtMoney(n.yield_forgone); }),
          depRow('Total cost', function (n) { return fmtMoney(n.total_cost); }),
          depRow('Net', function (n) { return fmtMoney(n.net); }),
          depRow('Break-even share', function (n) { return n.breakeven_pct >= 9999 ? '—' : n.breakeven_pct.toFixed(1) + '%'; }),
          depRow('Net per hour', function (n) { return fmtMoney(n.net_per_hour); }),
          depRow('Verdict', function (n) { return n.verdict; })
        )
      )),
      el('h3', { text: 'Farm timeline — ' + row.weeks + ' weeks, $10,000 deposit' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      })),
      el('p', { class: 'sub', text: 'Totals at $10,000: fees ' + fmtMoney(n10.fees) + ' + yield forgone ' + fmtMoney(n10.yield_forgone) + ' = total cost ' + fmtMoney(n10.total_cost) + '; slice ' + fmtMoney(n10.slice) + '; net ' + fmtMoney(n10.net) + '; break-even ' + (n10.breakeven_pct >= 9999 ? '—' : n10.breakeven_pct.toFixed(1) + '%') + '; ' + n10.hours + ' timed hours, net per hour ' + fmtMoney(n10.net_per_hour) + '; verdict ' + n10.verdict + '.' })
    );
  }

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    state.view = 'detail';
    writeParams();
    render();
    var section = document.getElementById('detail');
    if (section && typeof section.scrollIntoView === 'function') section.scrollIntoView();
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    if (state.view === 'detail' && state.selected) {
      var row = DATA.rows.filter(function (r) { return r.slug === state.selected; })[0];
      if (row) shell.appendChild(detailSection(row));
    }
    if (state.view === 'filtered') {
      var label = state.q ? 'matching "' + state.q + '"' : 'chip "' + state.filter + '"';
      shell.appendChild(el('p', { class: 'note', text: 'Filtered view — showing rows ' + label + ' at a $' + state.deposit.toLocaleString('en-US') + ' deposit.' }));
    }
    if (state.view === 'board') {
      shell.appendChild(methodPanel());
      shell.appendChild(validationPanel());
      shell.appendChild(scatterPanel());
    }
    shell.appendChild(controls());
    shell.appendChild(boardTable());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
  }

  readParams();
  render();
})();
