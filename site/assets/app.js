/* Market Phases dashboard. Plain JS, no build step. Data lives in data/*.json, rebuilt each morning. */
(() => {
  "use strict";
  const $app = document.getElementById("app");
  const cache = {};
  const charts = [];
  const load = (f) => cache[f] || (cache[f] = fetch("data/" + f, { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(f); return r.json(); }));

  // ---------- formatting ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const n0 = (v) => v == null ? "–" : v.toLocaleString("en-SG", { maximumFractionDigits: 0 });
  const nf = (v) => v == null ? "–" : Math.abs(v) >= 1000 || (Math.abs(v) >= 100 && Number.isInteger(v)) ? n0(v) : v.toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pc = (v, d = 1, sign = true) => v == null ? "–" : (sign && v > 0 ? "+" : "") + (v * 100).toFixed(d) + "%";
  const pp = (v, d = 1) => v == null ? "–" : (v > 0 ? "+" : "") + v.toFixed(d) + "%";
  const cls = (v) => v > 0 ? "pos" : v < 0 ? "neg" : "";
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dmy = (s) => { const d = new Date(s + "T00:00:00"); return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`; };
  const my = (s) => { const d = new Date(s + "T00:00:00"); return `${MON[d.getMonth()]} ${d.getFullYear()}`; };
  const dm = (s) => { const d = new Date(s + "T00:00:00"); return `${d.getDate()} ${MON[d.getMonth()]}`; };
  const daysTo = (s) => Math.max(0, Math.ceil((new Date(s + "T23:59:59+08:00") - new Date()) / 864e5));
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const keys = (arr) => `<ul class="keys">${arr.map((t) => `<li>${t}</li>`).join("")}</ul>`;
  const pill = (sig) => sig ? `<span class="pill in">Invested</span>` : `<span class="pill out">Cash</span>`;
  const phaseChip = (p) => `<span class="pill ${p === "Bull" ? "bull" : "bear"}">${p}</span>`;

  // ---------- theme ----------
  const themeBtn = document.getElementById("theme");
  const setTheme = (t) => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
  try { setTheme(localStorage.getItem("theme")); } catch (e) {}
  themeBtn.addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const t = dark ? "light" : "dark"; setTheme(t);
    try { localStorage.setItem("theme", t); } catch (e) {}
    route();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => route());

  // ---------- small SVG charts ----------
  function spark(vals, up) {
    if (!vals || vals.length < 2) return "";
    const w = 200, h = 44, mn = Math.min(...vals), mx = Math.max(...vals), k = (mx - mn) || 1;
    const pts = vals.map((v, i) => `${(i / (vals.length - 1) * w).toFixed(1)},${(h - 3 - (v - mn) / k * (h - 6)).toFixed(1)}`).join(" ");
    const col = up ? "var(--green2)" : "var(--red2)";
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
  }
  function meter(gap, signal) {
    // gap = close / line - 1. Centre is the line; +-10% each side.
    const g = Math.max(-0.1, Math.min(0.1, gap || 0));
    const x = 50 + g / 0.1 * 50;
    return `<div class="meter"><div class="meter-track"><div class="meter-mid"></div><div class="meter-dot" style="left:${x}%"></div></div>
      <div class="meter-lab"><span>10% below</span><span>Line</span><span>10% above</span></div></div>`;
  }
  function bars(items) {
    return `<div class="hbars">${items.map((it) => `<div class="hb"><div class="hb-l">${esc(it.label)}</div>
      <div class="hb-t"><i style="width:${Math.max(1, it.value * 100)}%;background:${it.color || "var(--blue)"}"></i>${it.ref != null ? `<b style="left:${it.ref * 100}%"></b>` : ""}</div>
      <div class="hb-v">${(it.value * 100).toFixed(0)}%</div>${it.note ? `<div class="hb-n">${esc(it.note)}</div>` : ""}</div>`).join("")}</div>`;
  }
  function ruleBars(rules) {
    const mr = Math.max(...rules.map((r) => r.cagr)), md = Math.min(...rules.map((r) => r.maxdd));
    return `<div class="rb"><div class="rb-h"><span></span><span>Per year</span><span>Worst fall</span></div>${rules.map((r) => `<div class="rb-r${r.head ? " hl" : ""}">
      <span class="rb-n"><i style="background:${r.key === "Buy and hold" ? "var(--gray)" : r.now ? "var(--green2)" : "var(--red2)"}"></i>${esc(r.name)}</span>
      <span class="rb-b"><i style="width:${r.cagr / mr * 100}%;background:var(--blue)"></i><em>${pc(r.cagr)}</em></span>
      <span class="rb-b"><i style="width:${r.maxdd / md * 100}%;background:var(--red2)"></i><em>${pc(r.maxdd, 0)}</em></span></div>`).join("")}</div>`;
  }
  function ladder(t, last, W) {
    // price ladder for a research ticker
    const pts = [
      ...t.scenarios.map((s) => ({ v: s.price, l: s.name, c: s.name === "Bear" ? "var(--red2)" : "var(--green2)" })),
      { v: t.fair_value, l: "Fair value", c: "var(--blue)" }, { v: t.street_target, l: "Street", c: "var(--gray)" },
    ];
    const all = [...pts.map((p) => p.v), t.stop, t.entry[0], t.entry[1], last, ...t.trims.flat()];
    const mn = Math.min(...all) * 0.94, mx = Math.max(...all) * 1.03;
    const w = W || 600, h = 150, L = 30, R = 30, X = (v) => L + (v - mn) / (mx - mn) * (w - L - R), y = 74;
    let s = `<svg class="svgchart" width="${w}" height="${h}" role="img" aria-label="Price ladder">`;
    s += `<line x1="${L}" x2="${w - R}" y1="${y}" y2="${y}" stroke="var(--line2)" stroke-width="2"/>`;
    s += `<rect x="${X(t.entry[0])}" y="${y - 9}" width="${X(t.entry[1]) - X(t.entry[0])}" height="18" rx="5" fill="color-mix(in srgb, var(--blue) 22%, transparent)"/>`;
    s += `<text x="${(X(t.entry[0]) + X(t.entry[1])) / 2}" y="${y + 30}" text-anchor="middle" style="fill:var(--blue);font-weight:600">Entry</text>`;
    t.trims.forEach(([a, b], i) => {
      s += `<rect x="${X(a) - 2}" y="${y - 9}" width="${Math.max(4, X(b) - X(a) + 4)}" height="18" rx="4" fill="color-mix(in srgb, var(--orange2) 30%, transparent)"/>`;
      s += `<text x="${X((a + b) / 2)}" y="${y + 30}" text-anchor="middle" style="fill:var(--orange);font-weight:600">Trim ${i + 1}</text>`;
    });
    s += `<line x1="${X(t.stop)}" x2="${X(t.stop)}" y1="${y - 14}" y2="${y + 14}" stroke="var(--red2)" stroke-width="3" stroke-linecap="round"/>`;
    s += `<text x="${X(t.stop)}" y="${y + 30}" text-anchor="middle" style="fill:var(--red);font-weight:600">Stop</text>`;
    const top = [];
    pts.sort((a, b) => a.v - b.v).forEach((p) => {
      let ly = y - 22; while (top.some((q) => Math.abs(q.x - X(p.v)) < (w < 500 ? 84 : 96) && q.y === ly)) ly -= 16;
      top.push({ x: X(p.v), y: ly });
      s += `<circle cx="${X(p.v)}" cy="${y}" r="4" fill="${p.c}"/><line x1="${X(p.v)}" x2="${X(p.v)}" y1="${y - 4}" y2="${ly + 4}" stroke="${p.c}" opacity=".4"/>`;
      s += `<text x="${X(p.v)}" y="${ly}" text-anchor="middle"><tspan style="fill:var(--text);font-weight:600">${p.l}</tspan> ${n0(p.v)}</text>`;
    });
    s += `<circle cx="${X(last)}" cy="${y}" r="8" fill="var(--card)" stroke="var(--text)" stroke-width="3"/>`;
    s += `<text x="${X(last)}" y="${y + 50}" text-anchor="middle" style="fill:var(--text);font-weight:700">Now ${nf(last)}</text>`;
    return s + "</svg>";
  }

  // ---------- uPlot line charts ----------
  function destroyCharts() { while (charts.length) { const c = charts.pop(); try { c.u.destroy(); c.ro.disconnect(); } catch (e) {} } }
  function lineChart(el, { t, series, log = false, bands = null, hlines = [], height = 300, yfmt = nf, rangeFrom = null }) {
    const text2 = css("--text3"), grid = css("--line");
    const font = `12px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif`;
    const opts = {
      width: el.clientWidth || 600, height, pxAlign: false, cursor: { y: false, points: { size: 7 } },
      legend: { show: false },
      scales: { x: { time: true, min: rangeFrom ?? undefined }, y: { distr: log ? 3 : 1, auto: true } },
      axes: [
        { stroke: text2, font, grid: { stroke: grid, width: 1 }, ticks: { show: false }, gap: 6 },
        { stroke: text2, font, grid: { stroke: grid, width: 1 }, ticks: { show: false }, size: 58, gap: 6, values: (u, v) => v.map((x) => x == null ? "" : x >= 1000 ? (x >= 1e4 ? Math.round(x / 1000) + "k" : (x / 1000).toFixed(1) + "k") : x >= 10 ? Math.round(x) : x.toFixed(x < 2 ? 2 : 1)) },
      ],
      series: [{ value: (u, v) => v == null ? "" : new Date(v * 1000).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" }) },
        ...series.map((s) => ({ label: s.label, stroke: s.color, width: s.width || 1.8, dash: s.dash, value: (u, v) => v == null ? "–" : yfmt(v), points: { show: false }, spanGaps: true }))],
      hooks: {
        setCursor: [(u) => {
          const i = u.cursor.idx, tip = el.querySelector(".tip");
          if (i == null || u.cursor.left < 0) { tip.style.display = "none"; return; }
          tip.innerHTML = `<div class="tip-d">${new Date(u.data[0][i] * 1000).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" })}</div>` +
            series.map((s, k) => u.data[k + 1][i] == null ? "" : `<div><i style="background:${s.color}"></i>${esc(s.label)} <b>${yfmt(u.data[k + 1][i])}</b></div>`).join("");
          tip.style.display = "block";
          const x = u.cursor.left + u.bbox.left / devicePixelRatio, w = tip.offsetWidth;
          tip.style.left = Math.min(Math.max(0, x - w / 2), el.clientWidth - w) + "px";
        }],
        drawClear: [(u) => {
          const ctx = u.ctx, { left, top, width, height: h } = u.bbox;
          ctx.save(); ctx.beginPath(); ctx.rect(left, top, width, h); ctx.clip();
          (bands || []).forEach((b) => {
            const x0 = u.valToPos(b.from, "x", true), x1 = u.valToPos(b.to, "x", true);
            if (x1 < left || x0 > left + width) return;
            ctx.fillStyle = b.color; ctx.fillRect(x0, b.y0 != null ? u.valToPos(b.y1, "y", true) : top, x1 - x0, b.y0 != null ? u.valToPos(b.y0, "y", true) - u.valToPos(b.y1, "y", true) : h);
          });
          ctx.restore();
        }],
        draw: [(u) => {
          const ctx = u.ctx, { left, width } = u.bbox;
          hlines.forEach((l, li) => {
            const y = u.valToPos(l.y, "y", true);
            ctx.save(); ctx.strokeStyle = l.color; ctx.lineWidth = 1.5 * devicePixelRatio; ctx.setLineDash([5 * devicePixelRatio, 4 * devicePixelRatio]);
            ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + width, y); ctx.stroke();
            ctx.setLineDash([]); ctx.fillStyle = l.color; ctx.font = `600 ${11 * devicePixelRatio}px -apple-system, Helvetica, Arial`;
            ctx.textAlign = "right"; ctx.fillText(l.label, left + width - 4 * devicePixelRatio, li % 2 ? y + 14 * devicePixelRatio : y - 5 * devicePixelRatio); ctx.restore();
          });
        }],
      },
    };
    el.innerHTML = '<div class="tip"></div>';
    const u = new uPlot(opts, [t, ...series.map((s) => s.data)], el);
    const ro = new ResizeObserver(() => { const w = el.clientWidth; if (w && Math.abs(w - u.width) > 2) u.setSize({ width: w, height }); });
    ro.observe(el); charts.push({ u, ro });
    return u;
  }
  const phaseBands = (phases, lastT) => phases.map((p) => ({
    from: Date.parse(p.start) / 1000, to: Date.parse(p.end) / 1000, color: p.kind === "Bull" ? "rgba(0,0,0,0)" : css("--bear"),
  }));

  // ---------- views ----------
  async function viewToday() {
    const o = await load("overview.json");
    const plan = o.plan;
    const inC = plan.filter((p) => p.signal), outC = plan.filter((p) => !p.signal);
    const close = plan.filter((p) => p.gap != null && Math.abs(p.gap) < 0.02);
    let lede = "";
    if (inC.length) lede += `<b>${inC.map((p) => p.label).join(" and ")}</b> ${inC.length > 1 ? "are" : "is"} still invested`;
    if (inC.length && close.some((c) => c.signal)) lede += `, but only ${pc(Math.abs(close.find((c) => c.signal).gap), 1, false)} above ${close.find((c) => c.signal).label === "US" ? "its" : "the"} line`;
    if (outC.length) lede += `${inC.length ? ". " : ""}<b>${outC.map((p) => p.label).join(" and ")}</b> ${outC.length > 1 ? "read" : "reads"} cash`;
    lede += `. Signals lock in at the <b>${dm(o.next_decision)}</b> close, ${daysTo(o.next_decision)} days away. New money still goes in every month.`;
    const gen = new Date(o.generated);
    let h = `<section class="hero"><p class="eyebrow">Closes to ${dmy(o.as_of)} · updated ${gen.toLocaleString("en-SG", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</p>
      <h1>Today</h1><p class="lede">${lede}</p></section>`;
    h += `<div class="grid g3">` + plan.map((p) => `
      <a class="card link" href="#/market/${p.key}">
        <div class="card-h"><div><h3>${esc(p.label)} holdings</h3><p class="sub">${esc(p.market)} · ${esc(p.rule)}</p></div>${pill(p.signal)}</div>
        <div class="big num">${nf(p.last)}</div>
        <p class="sub">Line for the ${dm(p.month_end)} close: <b class="num">${nf(p.level)}</b></p>
        ${meter(p.gap, p.signal)}
        <p class="sub">${p.gap >= 0 ? `${pc(p.gap, 1, false)} above the line.` : `${pc(Math.abs(p.gap), 1, false)} below the line.`} ${p.signal ? (p.gap >= 0 ? "A close under it moves these holdings to cash." : "") : (p.gap < 0 ? "A close over it means hold again." : "")}</p>
      </a>`).join("") + `</div>`;
    h += `<h2>Alerts</h2><div class="card">` + (o.alerts.length ? o.alerts.map((a) => `<div class="alert ${a.level}"><i></i><div><b>${esc(a.title)}</b><p>${esc(a.body)}</p></div></div>`).join("") : `<p class="sub">Nothing close to a flip.</p>`) + `</div>`;
    if (o.watch) {
      const w = o.watch;
      h += `<h2>Watchlist</h2><a class="card link" href="#/watch"><div class="card-h"><div><h3>${w.entry.length ? `${w.entry.length} at a good entry` : "Nothing at a good entry yet"}</h3>
        <p class="sub">NVIDIA, SpaceX and 16 crypto-linked names</p></div>${w.btc_ok ? `<span class="pill in">Bitcoin above average</span>` : `<span class="pill out">Bitcoin below average</span>`}</div>
        ${keys([
          w.entry.length ? `Good entry now: <b>${w.entry.join(", ")}</b>.` : `No name is above its entry line today.`,
          w.stage.length ? `Small monthly buys allowed while below the line: <b>${w.stage.join(", ")}</b> (analysts see 25%+ upside).` : "",
          w.btc ? (w.btc_ok ? `Bitcoin is above its 200-day average, so crypto entries are switched on.` : `Crypto entries wait for bitcoin to clear its 200-day average of <b>$${n0(w.btc.trigger)}</b>, ${pc(w.btc.gap, 0, false)} above today.`) : "",
          w.closest.length ? `Closest crypto names to an entry: ${w.closest.map((c) => `${c.ticker} (${pc(c.gap, 0, false)} away)`).join(", ")}.` : "",
        ].filter(Boolean))}</a>`;
    }
    h += `<h2>Markets</h2><div class="grid g4">` + o.markets.map((m) => `
      <a class="card link" href="#/market/${m.key}">
        <div class="tile-top"><span class="tile-name">${esc(m.name)}</span></div>
        <div class="tile-price">${nf(m.last)}</div>
        <div class="tile-meta"><span>${phaseChip(m.phase)}</span><span class="${cls(m.from_high)}">${pc(m.from_high)} from high</span></div>
        ${spark(m.spark, m.spark[m.spark.length - 1] >= m.spark[0])}
        <div class="tile-meta" style="margin-top:8px"><span>${m.signal ? "Rule: in" : "Rule: cash"}</span><span>${(m.p_up * 100).toFixed(0)}% up in 12m</span></div>
      </a>`).join("") + `</div>`;
    const usSum = o.summary.find((s) => s.market === "S&P 500");
    h += `<h2>Key points</h2><div class="card">${keys([
      (() => { const ms = o.markets, off = ms.filter((m) => m.from_high <= -0.1).length, worst = [...ms].sort((a, b) => a.from_high - b.from_high)[0], bears = ms.filter((m) => m.phase === "Bear");
        return `${off} of ${ms.length} markets are 10% or more below their 1-year high. Deepest: ${esc(worst.name)} at ${pc(worst.from_high)}.${bears.length ? ` In a 20% bear: ${bears.map((b) => esc(b.name)).join(", ")}.` : " None is in a 20% bear."}`; })(),
      `Since 1928 the S&P 500 spent ${usSum.time_in_bull_pct}% of its time in bull phases. The median bull lasted ${usSum.bull_median_months} months; the median bear ${usSum.bear_median_months} months and ${usSum.bear_median_loss_pct}%.`,
      `About ${Math.round(usSum.dip_to_bear_pct)}% of S&P 500 falls of 10% or more from a record went on to become 20% bears. Most dips do not.`,
      `Rules only act at month end, so a mid-month dip below a line is a warning, not a sell.`,
    ])}</div>`;
    return h;
  }

  async function viewMarkets() {
    const [o, f] = await Promise.all([load("overview.json"), load("funds.json")]);
    let h = `<section class="hero"><p class="eyebrow">Closes to ${dmy(o.as_of)}</p><h1>Markets</h1><p class="lede">Every market you can trade on POEMS, with its bull or bear phase, its trend rule and how far it sits from its high.</p></section>`;
    const regions = [["US", "United States"], ["SG", "Singapore"], ["CN", "China A shares"]];
    regions.forEach(([r, title]) => {
      h += `<h2>${title}</h2><div class="grid g3">` + o.markets.filter((m) => m.region === r).map((m) => `
        <a class="card link" href="#/market/${m.key}">
          <div class="card-h"><div><h3>${esc(m.name)}</h3><p class="sub">${m.plan ? `Decides ${esc(m.plan)} exits` : "Watch only"}</p></div>${pill(m.signal)}</div>
          <div class="tile-price">${nf(m.last)}</div>
          <div class="tile-meta"><span>${phaseChip(m.phase)}</span><span class="${cls(m.from_high)}">${pc(m.from_high)} from 1-year high</span></div>
          ${spark(m.spark, m.spark[m.spark.length - 1] >= m.spark[0])}
        </a>`).join("") + `</div>`;
    });
    h += `<h2>Singapore bonds and funds</h2><div class="grid g3">` + f.funds.map((x, i) => `
      <div class="card"><div class="card-h"><div><h3>${esc(x.fund)}</h3><p class="sub">${x.kind} · since ${x.history_from.slice(0, 4)}</p></div></div>
      <div class="chart" id="fund${i}"></div>
      <div class="kv"><span>Yearly return</span><span>${pp(x.yearly_return_pct)}</span></div>
      <div class="kv"><span>Worst drop</span><span>${pp(x.worst_drop_pct)} (${my(x.worst_drop_from)} to ${my(x.worst_drop_to)})</span></div>
      <div class="kv"><span>Below high now</span><span>${pp(x.now_below_high_pct)}</span></div>
      <div class="kv"><span>Last month</span><span>${pp(x.change_1m_pct)}</span></div></div>`).join("") + `</div>`;
    const bonds = f.funds.filter((x) => x.kind === "Bond");
    h += `<div class="card" style="margin-top:16px">${keys([
      `Bond funds fall far less than shares: the worst drop was ${bonds.map((b) => `${pp(b.worst_drop_pct, 0)} for ${b.fund.match(/\((\w+)\)/)[1]}`).join(" and ")}, against ${pp(f.funds[0].worst_drop_pct, 0)} for the STI fund.`,
      `They also earn less, about ${bonds.map((b) => pp(b.yearly_return_pct)).join(" and ")} a year. Your exit rule moves to SGD cash, not bonds, so these are an option for savings rather than part of the signal.`,
      `No Singapore unit-trust price history is available from Yahoo; POEMS or FSMOne exports would be needed to chart them.`,
    ])}</div>`;
    setTimeout(() => f.funds.forEach((x, i) => {
      const el = document.getElementById("fund" + i); if (!el) return;
      lineChart(el, { t: x.t, series: [{ label: "Price", data: x.c, color: css("--blue") }], height: 170 });
    }));
    return h;
  }

  async function viewMarket(key) {
    const m = await load(`m_${key}.json`);
    const s = m.summary || {};
    const ph = m.phase;
    const rules = m.rules.map((r) => ({ ...r, head: r.key === m.head_rule }));
    const head = rules.find((r) => r.head), bh = rules.find((r) => r.key === "Buy and hold");
    const nc = m.nowcast, cs = m.corrections.stats;
    let h = `<a class="back" href="#/markets">‹ Markets</a>
      <section class="hero"><p class="eyebrow">${esc(m.role)}</p><h1>${esc(m.name)}</h1>
      <p class="lede"><b>${nf(m.last)}</b> on ${dmy(m.as_of)}. ${ph.phase} phase since ${my(ph.since)}. ${esc(m.head_short)} rule: <b>${m.signal ? "invested" : "cash"}</b>${m.flip_level ? `, line ${nf(m.flip_level)} for the ${dm(m.month_end)} close` : ""}.</p></section>`;
    h += `<div class="card"><h3>Key takeaways</h3>${keys(m.takeaways)}</div>`;

    // 1. history
    h += `<h2>Bull and bear history</h2><div class="card"><div class="card-h"><div><h3>Price with 20% phases</h3><p class="sub">Monthly close, log scale. Shaded = 20% bear phases; the rest are bulls.</p></div>
      <div class="seg" id="rng"><button data-y="10">10Y</button><button data-y="30">30Y</button><button data-y="0" class="on">All</button></div></div>
      <div class="chart" id="c-hist"></div>
      <div class="legend"><span><i style="background:var(--bear)"></i>Bear phase</span><span><i class="ln" style="background:var(--blue)"></i>Close</span><span><i class="ln" style="background:var(--orange2)"></i>10-month average</span></div>
      ${s.bulls != null ? keys([
        `${s.bulls} bulls and ${s.bears} bears since ${s.history_from.slice(0, 4)}. It spent <b>${s.time_in_bull_pct}%</b> of the time in bull phases.`,
        `A typical bull lasted <b>${s.bull_median_months} months</b> and gained ${pp(s.bull_median_gain_pct, 0)}; the longest ran ${s.longest_bull_months} months.`,
        `A typical bear lasted <b>${s.bear_median_months} months</b> and fell ${pp(s.bear_median_loss_pct, 0)}; the worst fell ${pp(s.worst_bear_pct, 0)}.`,
        `Of ${s.dips_10} falls of 10% or more from a record, ${s.dips_became_bear} (${s.dip_to_bear_pct}%) became bears.`,
      ]) : keys([`Phases here come from month-end closes, since this fund's history is shorter.`])}</div>`;

    // 2. last two years
    const lastPh = m.phases.length ? m.phases[m.phases.length - 1] : null;
    h += `<h2>Where it stands now</h2><div class="card"><div class="card-h"><div><h3>Last two years</h3><p class="sub">Daily close with the 200-day average and this month's decision line</p></div>${pill(m.signal)}</div>
      <div class="chart" id="c-now"></div>
      <div class="legend"><span><i class="ln" style="background:var(--blue)"></i>Close</span><span><i class="ln" style="background:var(--orange2)"></i>200-day average</span><span><i class="ln" style="background:var(--red2)"></i>Rule line</span>${ph.phase === "Bull" ? `<span><i class="ln" style="background:var(--gray)"></i>20% bear line</span>` : ""}</div>
      ${keys([
        m.flip_level ? `The ${esc(m.head_short.toLowerCase())} line for the ${dm(m.month_end)} close is <b>${nf(m.flip_level)}</b>, ${pc(Math.abs(m.flip_gap), 1, false)} ${m.flip_gap >= 0 ? "below" : "above"} the latest close.` : `Signal: ${m.signal ? "invested" : "cash"}.`,
        `Other lines this month: ${Object.entries(m.flips).filter(([k, v]) => v && k !== m.head_short).map(([k, v]) => `${esc(k.toLowerCase())} ${nf(v)}`).join(", ")}.`,
        ph.phase === "Bull" ? `It is ${pp(Math.abs(ph.from_extreme_pct), 1).replace("+", "")} below the ${my(ph.extreme_date)} high. A 20% bear begins ${pp(Math.abs(ph.to_bear_line_pct)).replace("+", "")} lower.` : `It is ${pp(ph.from_extreme_pct)} off the ${my(ph.extreme_date)} low. A 20% rise from the low ends the bear.`,
        m.month_running ? `The month is still running, so today's reading is provisional.` : `This reading is a completed month end.`,
      ])}</div>`;

    // 3. rule vs hold
    h += `<h2>Does the rule pay?</h2><div class="grid g2"><div class="card"><h3>Growth of S$1</h3><p class="sub">Since ${m.backtest_from.slice(0, 4)}, log scale. Cash earns the SGD deposit proxy while out.</p>
      <div class="chart" id="c-eq"></div>
      ${keys([
        `${esc(head.name)}: <b>${pc(head.cagr)}</b> a year, worst fall <b>${pc(head.maxdd, 0)}</b>, invested ${pc(head.time_in, 0, false)} of the time.`,
        `Buy and hold: <b>${pc(bh.cagr)}</b> a year, worst fall <b>${pc(bh.maxdd, 0)}</b>.`,
        `About ${head.trades_per_decade.toFixed(0)} exits a decade; ${pc(head.false_exit_rate, 0, false)} of exits were followed by a higher price six months later. The rule pays by dodging deep bears, not by being right often.`,
      ])}</div>
      <div class="card"><h3>All rules compared</h3><p class="sub">Return a year and worst fall. Dot: green = in now, red = cash now.</p>${ruleBars(rules)}
      ${keys([
        (() => { const b = [...rules].sort((a, c) => c.cagr - a.cagr)[0]; return `Highest return: ${esc(b.name)} at ${pc(b.cagr)} a year.`; })(),
        (() => { const b = [...rules].sort((a, c) => c.maxdd - a.maxdd)[0]; return `Smallest worst fall: ${esc(b.name)} at ${pc(b.maxdd, 0)}.`; })(),
        `${rules.filter((r) => r.key !== "Buy and hold" && r.now).length} of ${rules.length - 1} rules read invested now.`,
      ])}</div></div>`;

    h += `<div class="card" style="margin-top:16px"><div class="scroll"><table class="tbl"><thead><tr><th>Rule</th><th>Now</th><th class="r">Per year</th><th class="r">Worst fall</th><th class="r">Invested</th><th class="r">Exits / decade</th><th class="r">Last change</th></tr></thead><tbody>
      ${rules.map((r) => `<tr class="${r.head ? "hl" : ""}"><td>${esc(r.name)}${r.head ? " ★" : ""}</td><td>${r.key === "Buy and hold" ? "–" : r.now ? '<span class="pos">In</span>' : '<span class="neg">Cash</span>'}</td><td class="r">${pc(r.cagr)}</td><td class="r">${pc(r.maxdd, 0)}</td><td class="r">${pc(r.time_in, 0, false)}</td><td class="r">${r.trades_per_decade.toFixed(1)}</td><td class="r">${r.last_change && r.last_change !== "[]" ? my(r.last_change) : "–"}</td></tr>`).join("")}
      </tbody></table></div><p class="small muted" style="margin:10px 0 0">★ the rule your plan uses for this market. Month-end closes, trade the next month, no costs or taxes, price index without dividends.</p></div>`;

    // 4. forecasts
    h += `<h2>Forecasts</h2><div class="grid g2"><div class="card"><h3>Does this dip become a bear?</h3><p class="sub">Share of past falls from a 1-year high that went on to a 20% bear</p>
      ${bars(["5%", "10%", "15%"].map((d) => ({ label: `Falls of ${d}`, value: cs[d].rate || 0, color: "var(--orange2)", note: `${cs[d].became_bear} of ${cs[d].episodes} episodes` })))}
      ${keys([
        `Now <b>${pc(Math.abs(m.corrections.current_dd_from_1y_high), 1, false)}</b> below the ${my(m.corrections.high_date)} high.`,
        (() => { const d = Math.abs(m.corrections.current_dd_from_1y_high); const b = d >= 0.15 ? "15%" : d >= 0.10 ? "10%" : d >= 0.05 ? "5%" : null; return b ? `Past falls this deep became bears ${pc(cs[b].rate, 0, false)} of the time. ${cs[b].median_days_to_recover_if_not ? `Those that did not recovered in about ${Math.round(cs[b].median_days_to_recover_if_not)} trading days.` : ""}` : `It is not yet in a 5% pullback.`; })(),
      ])}</div>
      <div class="card"><h3>Model odds</h3><p class="sub">Logistic model on trend features. The line marks the long-run base rate.</p>
      ${bars([
        { label: "Bull phase intact", value: nc.p_bull_now, color: "var(--blue)" },
        { label: "Higher in 12 months", value: nc.p_up_12m, ref: nc.base_rate_up_12m, color: "var(--green2)", note: `Base rate ${(nc.base_rate_up_12m * 100).toFixed(0)}%` },
        ...(nc.analogue_up_12m != null ? [{ label: "Similar past months", value: nc.analogue_up_12m, ref: nc.base_rate_up_12m, color: "var(--gray)", note: `${nc.analogue_n} months with the same trend side and dip depth` }] : []),
      ])}
      ${keys([
        nc.p_up_12m < nc.base_rate_up_12m ? `The odds of being higher in a year are <b>below</b> the long-run norm, which is what a weak trend looks like.` : `The odds of being higher in a year are <b>at or above</b> the long-run norm.`,
        nc.walkforward_brier >= nc.climatology_brier ? `Tested year by year, the model was no more accurate than simply using the base rate. Use it as colour, not as a trigger.` : `Tested year by year, the model beat the base rate slightly.`,
      ])}</div></div>`;

    // 5. bear capture + phases table
    if (m.bears.length) {
      h += `<h2>How the rule handled past bears</h2><div class="card"><div class="scroll"><table class="tbl"><thead><tr><th>Bear</th><th class="r">Fall</th><th class="r">Months to exit</th><th class="r">Fall avoided</th><th class="r">Months to re-enter</th></tr></thead><tbody>
        ${m.bears.slice(-10).reverse().map((b) => `<tr><td>${my(b.peak)} to ${my(b.trough)}</td><td class="r neg">${pc(b.fall, 0)}</td><td class="r">${b.months_to_exit ?? "never"}</td><td class="r">${pc(b.fall_avoided, 0, false)}</td><td class="r">${b.months_to_reenter ?? "–"}</td></tr>`).join("")}
        </tbody></table></div>
        ${(() => { const v = m.bears.filter((b) => b.months_to_exit != null); const avg = v.reduce((a, b) => a + b.fall_avoided, 0) / (v.length || 1); return keys([`Across ${m.bears.length} monthly bears the ${esc(m.head_short.toLowerCase())} rule avoided about <b>${pc(avg, 0, false)}</b> of the fall on average.`, `It usually exits a few months after the peak and re-enters a few months after the low, so it gives up the top and the first leg back.`]); })()}
        </div>`;
    }
    const prow = (p) => `<tr><td>${phaseChip(p.kind)}</td><td>${my(p.start)}</td><td>${my(p.end)}</td><td class="r ${p.change_pct > 0 ? "pos" : "neg"}">${pp(p.change_pct, 0)}</td><td class="r">${p.months}</td></tr>`;
    const allp = [...m.phases].reverse();
    const thead = `<thead><tr><th>Phase</th><th>From</th><th>To</th><th class="r">Change</th><th class="r">Months</th></tr></thead>`;
    h += `<h2>Recent phases</h2><div class="card"><div class="scroll"><table class="tbl">${thead}<tbody>
      <tr><td>${phaseChip(ph.phase)} <span class="muted small">now</span></td><td>${my(ph.since)}</td><td>–</td><td class="r ${ph.change_since_turn_pct > 0 ? "pos" : "neg"}">${pp(ph.change_since_turn_pct, 0)}</td><td class="r">–</td></tr>
      ${allp.slice(0, 9).map(prow).join("")}</tbody></table></div>
      ${allp.length > 9 ? `<details class="more"><summary>Show all ${allp.length + 1} phases</summary><div class="scroll"><table class="tbl">${thead}<tbody>${allp.slice(9).map(prow).join("")}</tbody></table></div></details>` : ""}</div>`;

    setTimeout(() => {
      const mo = m.monthly, lastT = mo.t[mo.t.length - 1];
      const bands = phaseBands(m.phases);
      if (lastPh || ph.since) bands.push({ from: Date.parse(ph.since) / 1000, to: lastT, color: ph.phase === "Bull" ? "rgba(0,0,0,0)" : css("--bear") });
      const hist = lineChart(document.getElementById("c-hist"), { t: mo.t, log: true, bands, height: 320,
        series: [{ label: "Close", data: mo.c, color: css("--blue") }, { label: "10-month avg", data: mo.sma, color: css("--orange2"), width: 1.3 }] });
      document.getElementById("rng").addEventListener("click", (e) => {
        const b = e.target.closest("button"); if (!b) return;
        document.querySelectorAll("#rng button").forEach((x) => x.classList.toggle("on", x === b));
        const y = +b.dataset.y, min = y ? lastT - y * 365.25 * 864e2 : mo.t[0];
        const i0 = mo.t.findIndex((t) => t >= min), vals = mo.c.slice(i0).filter((v) => v != null);
        hist.setScale("x", { min, max: lastT }); hist.setScale("y", { min: Math.min(...vals) * 0.92, max: Math.max(...vals) * 1.06 });
      });
      const d = m.daily, hl = [];
      if (m.flip_level) hl.push({ y: m.flip_level, label: `Rule line ${nf(m.flip_level)}`, color: css("--red2") });
      if (ph.phase === "Bull" && ph.to_bear_line_pct != null) hl.push({ y: m.last * (1 + ph.to_bear_line_pct / 100), label: "20% bear line", color: css("--gray") });
      const dvals = d.c.concat(hl.map((x) => x.y));
      const u2 = lineChart(document.getElementById("c-now"), { t: d.t, height: 280, hlines: hl,
        series: [{ label: "Close", data: d.c, color: css("--blue") }, { label: "200-day avg", data: d.ma, color: css("--orange2"), width: 1.3 }] });
      u2.setScale("y", { min: Math.min(...dvals) * 0.97, max: Math.max(...dvals) * 1.02 });
      const e = m.equity, cols = [css("--gray"), css("--blue"), css("--orange2")];
      lineChart(document.getElementById("c-eq"), { t: e.t, log: true, height: 260, yfmt: (v) => "S$" + nf(v),
        series: Object.entries(e.series).map(([k, v], i) => ({ label: k, data: v, color: cols[i], width: i === 1 ? 2.2 : 1.5 })) });
    });
    return h;
  }

  async function viewResearch() {
    const [r, st] = await Promise.all([load("research.json"), load("stocks.json")]);
    let h = `<section class="hero"><p class="eyebrow">Written ${dmy(r.written)} · prices update daily</p><h1>Research</h1>
      <p class="lede">Your December picks through your framework: why each stock is moving, four numbers, fair value and four price scenarios with entry, trim and stop levels.</p></section>`;
    h += `<div class="grid g3">` + r.tickers.map((t) => {
      const s = st[t.ticker] || {}, last = s.last ?? t.price;
      const inZone = last >= t.entry[0] && last <= t.entry[1], toFair = t.fair_value / last - 1;
      return `<a class="card link" href="#/research/${t.ticker}">
        <div class="card-h"><div><h3>${esc(t.name)}</h3><p class="sub">${t.ticker} · ${t.exchange}</p></div><span class="chip">${inZone ? "In entry zone" : last < t.entry[0] ? "Below entry zone" : "Above entry zone"}</span></div>
        <div class="tile-price">$${nf(last)}</div>
        <div class="tile-meta"><span class="${cls(s.chg30)}">${s.chg30 != null ? pc(s.chg30) + " in 30 days" : ""}</span><span>Fair ~$${nf(t.fair_value)} (${pc(toFair, 0)})</span></div>
        ${s.c ? spark(s.c.slice(-130), s.c[s.c.length - 1] >= s.c[s.c.length - 130]) : ""}
        <p class="sub" style="margin-top:12px">${esc(t.one_line)}</p></a>`;
    }).join("") + `</div>`;
    h += `<div class="card" style="margin-top:16px">${keys([
      `All three were inside or near their entry zones when written, after the November AI sell-off.`,
      `Microsoft looked cheapest against its own history, Yum China cheapest outright, and Amazon the most dependent on one moving part, its Anthropic stake.`,
      esc(r.disclosure), esc(r.note),
    ])}</div>`;
    return h;
  }

  async function viewTicker(tk) {
    const [r, st] = await Promise.all([load("research.json"), load("stocks.json")]);
    const t = r.tickers.find((x) => x.ticker === tk); if (!t) return viewResearch();
    const s = st[tk] || {}, last = s.last ?? t.price, toFair = t.fair_value / last - 1;
    const zone = last < t.entry[0] ? "below" : last > t.entry[1] ? "above" : "inside";
    let h = `<a class="back" href="#/research">‹ Research</a>
      <section class="hero"><p class="eyebrow">${t.ticker} · ${t.exchange} · ${esc(t.plan)}</p><h1>${esc(t.name)}</h1>
      <p class="lede"><b>$${nf(last)}</b>${s.as_of ? ` on ${dmy(s.as_of)}` : ""}, ${zone} the $${t.entry[0]}-${t.entry[1]} entry zone and ${pc(Math.abs(1 - last / t.fair_value), 0, false)} ${last <= t.fair_value ? "below" : "above"} my ~$${nf(t.fair_value)} fair value.</p></section>`;
    h += `<div class="card"><h3>Price ladder</h3><p class="sub">Where today's price sits against the stop, entry zone, fair value, trims and the four scenarios</p><div id="ladder" style="margin-top:8px"></div>
      ${keys([
        `Entry $${t.entry[0]}-${t.entry[1]}. ${esc(t.entry_text)}`,
        `Trim: ${esc(t.trim_text)}`,
        `Hard stop: ${esc(t.stop_text)}`,
        `Plan rule check: down 25% and below the 200-day average would trigger a replace at about $${nf(Math.round(last * 0.75 * 100) / 100)}.`,
      ])}</div>`;
    h += `<h2>Last 12 months</h2><div class="card"><div class="chart" id="c-stk"></div>
      <div class="legend"><span><i class="ln" style="background:var(--blue)"></i>Close</span><span><i class="ln" style="background:var(--orange2)"></i>200-day average</span><span><i style="background:color-mix(in srgb, var(--blue) 22%, transparent)"></i>Entry zone</span><span><i class="ln" style="background:var(--red2)"></i>Stop</span></div>
      ${s.ma200 ? keys([`The 200-day average is <b>$${nf(s.ma200)}</b>; the price is ${pc(Math.abs(last / s.ma200 - 1), 1, false)} ${last >= s.ma200 ? "above" : "below"} it.`, `30-day move: <b class="${cls(s.chg30)}">${pc(s.chg30)}</b>.`]) : ""}</div>`;
    h += `<h2>Why it has been moving</h2><div class="grid g2"><div class="card why">${t.why.map((w) => `<div><b>${esc(w.label)}</b>${esc(w.text)}</div>`).join("")}</div>
      <div class="card" style="display:flex;align-items:center"><p class="quote">“${esc(t.one_line)}”</p></div></div>`;
    h += `<h2>Fundamentals in four numbers</h2><div class="grid g4">${t.snapshot.map((x, i) => `<div class="card snap"><div class="label">${i + 1}. ${esc(x.label)}</div><div class="value">${esc(x.value)}</div><div class="vs">${esc(x.vs)}</div></div>`).join("")}</div>
      <div class="card" style="margin-top:16px"><h3>Fair value</h3><p class="sub" style="font-size:16px;color:var(--text)">${esc(t.fair_math)}</p></div>`;
    h += `<h2>Four scenarios</h2><div class="grid g2"><div class="card"><h3>Targets vs today</h3><div id="scen" style="margin-top:10px"></div></div>
      <div class="card"><div class="scroll"><table class="tbl"><thead><tr><th>Scenario</th><th>Horizon</th><th>Math</th><th class="r">Target</th><th class="r">vs now</th></tr></thead><tbody>
      ${t.scenarios.map((x) => `<tr><td><b>${x.name}</b></td><td>${x.horizon}</td><td class="muted">${esc(x.math)}</td><td class="r">$${nf(x.price)}</td><td class="r ${cls(x.price / last - 1)}">${pc(x.price / last - 1, 0)}</td></tr>`).join("")}
      </tbody></table></div>${keys([`Upside to the base case is ${pc(t.scenarios[1].price / last - 1, 0)}; downside to the bear case is ${pc(t.scenarios[0].price / last - 1, 0)}.`, `Street mean target: $${nf(t.street_target)} (${pc(t.street_target / last - 1, 0)}).`])}</div></div>`;
    h += `<p class="small muted" style="margin-top:20px">${esc(r.note)} ${esc(r.disclosure)} <a href="${esc(r.source_doc)}" target="_blank" rel="noopener">Full research with sources</a>.</p>`;
    setTimeout(() => {
      const draw = () => { const a = document.getElementById("ladder"), b = document.getElementById("scen"); if (a) a.innerHTML = ladder(t, last, a.clientWidth); if (b) b.innerHTML = scenBars(t, last, b.clientWidth); };
      draw(); const ro = new ResizeObserver(() => draw()); ro.observe(document.getElementById("ladder")); charts.push({ u: { destroy() {} }, ro });
      if (!s.t) return;
      const u = lineChart(document.getElementById("c-stk"), { t: s.t, height: 280,
        bands: [{ from: s.t[0], to: s.t[s.t.length - 1], y0: t.entry[0], y1: t.entry[1], color: "rgba(0,113,227,.13)" }],
        hlines: [{ y: t.stop, label: `Stop $${nf(t.stop)}`, color: css("--red2") }, { y: t.fair_value, label: `Fair ~$${nf(t.fair_value)}`, color: css("--gray") }],
        series: [{ label: "Close", data: s.c, color: css("--blue") }, { label: "200-day avg", data: s.ma, color: css("--orange2"), width: 1.3 }] });
      const v = s.c.concat([t.stop, t.fair_value]); u.setScale("y", { min: Math.min(...v) * 0.96, max: Math.max(...v) * 1.03 });
    });
    return h;
  }
  function scenBars(t, last, W) {
    const w = W || 520, h = 250, L = 10, B = 40, T = 26, mx = Math.max(...t.scenarios.map((s) => s.price), last) * 1.08;
    const bw = (w - L * 2) / t.scenarios.length, Y = (v) => T + (1 - v / mx) * (h - T - B);
    let s = `<svg class="svgchart" width="${w}" height="${h}" role="img" aria-label="Scenario targets">`;
    t.scenarios.forEach((x, i) => {
      const cx = L + bw * i + bw / 2, col = x.price < last ? "var(--red2)" : "var(--green2)";
      s += `<rect x="${cx - bw * 0.28}" y="${Y(x.price)}" width="${bw * 0.56}" height="${h - B - Y(x.price)}" rx="8" fill="${col}" opacity="${0.55 + i * 0.12}"/>`;
      s += `<text x="${cx}" y="${Y(x.price) - 8}" text-anchor="middle" style="fill:var(--text);font-weight:600">$${nf(x.price)}</text>`;
      s += `<text x="${cx}" y="${h - 22}" text-anchor="middle" style="fill:var(--text);font-weight:600">${x.name}</text><text x="${cx}" y="${h - 6}" text-anchor="middle">${x.horizon}</text>`;
    });
    s += `<line x1="${L}" x2="${w - L}" y1="${Y(last)}" y2="${Y(last)}" stroke="var(--text)" stroke-dasharray="4 4" opacity=".6"/><text x="${w - L}" y="${Y(last) - 6}" text-anchor="end" style="fill:var(--text)">Now $${nf(last)}</text>`;
    return s + "</svg>";
  }

  // ---------- watchlist ----------
  const wPill = (w) => w.status === "Entry" ? `<span class="pill in">Good entry</span>` : w.status === "Stage in" ? `<span class="pill stage">Small buys OK</span>`
    : w.status === "Above" ? `<span class="pill in">Above average</span>` : w.status === "Below" ? `<span class="pill out">Below average</span>` : `<span class="pill wait">Wait</span>`;
  const gapBar = (g) => { const v = Math.max(0, Math.min(1, 1 - g / 1)); return `<div class="gap"><i style="width:${(v * 100).toFixed(0)}%"></i></div>`; };
  async function viewWatch() {
    const w = await load("watchlist.json");
    const btc = w.tickers.find((t) => t.benchmark), rest = w.tickers.filter((t) => !t.benchmark);
    const entry = rest.filter((t) => t.status === "Entry"), exits = rest.filter((t) => t.exit_flag);
    let h = `<section class="hero"><p class="eyebrow">Closes to ${dmy(rest[0].as_of)} · analyst views as of ${dmy(w.as_of_analyst)}</p><h1>Watchlist</h1>
      <p class="lede">${entry.length ? `<b>${entry.map((t) => t.ticker).join(", ")}</b> ${entry.length > 1 ? "are" : "is"} at a good entry.` : `<b>Nothing is at a good entry yet.</b>`}
      ${btc && !btc.status.startsWith("Above") ? ` Bitcoin is ${pc(1 - btc.last / btc.trigger, 0, false)} below its 200-day average, and crypto names wait until it gets back above.` : ""}</p></section>`;
    if (btc) h += `<a class="card link" href="#/watch/BTC-USD"><div class="card-h"><div><h3>Bitcoin gate</h3><p class="sub">Crypto entries switch on only while bitcoin is above its 200-day average</p></div>${wPill(btc)}</div>
      <div class="grid g2" style="align-items:center"><div><div class="big num">$${n0(btc.last)}</div><p class="sub">Line: <b class="num">$${n0(btc.trigger)}</b> · ${pc(btc.from_high, 0)} from its 1-year high</p>${meter(btc.last / btc.trigger - 1)}</div>
      <div>${spark(btc.c.slice(-250), btc.c[btc.c.length - 1] >= btc.c[btc.c.length - 250])}</div></div></a>`;
    const groups = [["AI and space", rest.filter((t) => !t.crypto)], ["Bitcoin and ether funds", rest.filter((t) => /ETF/.test(t.group))],
      ["Exchanges, brokers and treasuries", rest.filter((t) => t.crypto && !/ETF|Miner|miner/.test(t.group))], ["Miners and AI hosting", rest.filter((t) => /Miner|miner/.test(t.group))]];
    groups.forEach(([title, list]) => {
      if (!list.length) return;
      h += `<h2>${title}</h2><div class="card wl">` + list.map((t) => `<a class="wl-r" href="#/watch/${t.ticker}">
        <div class="wl-n"><b>${t.ticker}</b><span>${esc(t.name)}</span></div>
        <div class="wl-s">${spark(t.c.slice(-130), t.c[t.c.length - 1] >= t.c[Math.max(0, t.c.length - 130)])}</div>
        <div class="wl-p num">$${nf(t.last)}<span class="${cls(t.chg30)}">${pc(t.chg30, 0)} 30d</span></div>
        <div class="wl-g">${t.status === "Entry" ? `<span class="small pos">Above line</span>` : `<span class="small muted">${pc(t.pct_to_trigger, 0, false)} to entry</span>`}${gapBar(Math.max(0, t.pct_to_trigger))}</div>
        <div class="wl-f">${wPill(t)}${t.exit_flag ? `<span class="chip">Exit ${my(t.exit_month)}</span>` : ""}${t.trim_flag ? `<span class="chip">Trim</span>` : ""}</div></a>`).join("") + `</div>`;
    });
    h += `<h2>How the flags work</h2><div class="card">${keys([
      `<b>Good entry:</b> the daily close is above the 200-day average (50-day for SpaceX, which listed in June). Crypto names also need bitcoin above its own 200-day average.`,
      `<b>Small buys OK:</b> NVIDIA and SpaceX only. Small monthly amounts are fine below the line while analysts see 25% or more upside.`,
      `<b>Trim:</b> up 30% or more from your cost with analyst upside under 10%, or the price more than 40% above its 200-day average. The dashboard flags the 40% stretch; the cost test needs your buy price.`,
      `<b>Exit:</b> a month-end close below the 10-month average after being above it, or 25% below your cost.`,
      exits.length ? `${exits.length} names gave that exit signal at the end of October (${exits.map((t) => t.ticker).join(", ")}). It only matters if you hold them.` : "",
      `POEMS may ask for a knowledge assessment before you can buy bitcoin and ether ETFs such as IBIT.`,
    ].filter(Boolean))}</div>`;
    return h;
  }
  async function viewWatchTicker(tk) {
    const w = await load("watchlist.json");
    const t = w.tickers.find((x) => x.ticker === tk); if (!t) return viewWatch();
    const above = t.last >= t.trigger, isBtc = t.benchmark, cur = isBtc ? "$" : "$";
    let h = `<a class="back" href="#/watch">‹ Watchlist</a><section class="hero"><p class="eyebrow">${esc(t.group)}${t.crypto ? " · crypto" : ""}</p><h1>${esc(t.name)}</h1>
      <p class="lede"><b>${cur}${nf(t.last)}</b> on ${dmy(t.as_of)}, ${pc(Math.abs(t.last / t.trigger - 1), 1, false)} ${above ? "above" : "below"} its ${esc(t.trigger_basis)} of ${cur}${nf(t.trigger)}.</p></section>`;
    h += `<div class="card"><div class="card-h"><div><h3>Last 12 months</h3><p class="sub">Daily close with the entry line (${esc(t.trigger_basis)})</p></div>${wPill(t)}</div>
      <div class="chart" id="c-w"></div>
      <div class="legend"><span><i class="ln" style="background:var(--blue)"></i>Close</span><span><i class="ln" style="background:var(--orange2)"></i>${esc(t.trigger_basis)}</span>${t.ten_month_avg ? `<span><i class="ln" style="background:var(--gray)"></i>10-month average</span>` : ""}</div>
      ${keys([
        isBtc ? (above ? `Bitcoin is above its 200-day average, so crypto names can flag a good entry.` : `Bitcoin needs to close above <b>$${n0(t.trigger)}</b> (${pc(t.pct_to_trigger, 0, false)} higher) before crypto names can flag an entry.`)
          : t.status === "Entry" ? `<b>Good entry.</b> The close is above the entry line${t.crypto ? " and bitcoin is above its average" : ""}.`
          : t.status === "Stage in" ? `Below the line, but analysts see ${t.analyst_upside_pct.toFixed(0)}% upside, so small monthly buys are allowed under the plan.`
          : `<b>Wait.</b> It needs to rise ${pc(t.pct_to_trigger, 0, false)} to reach the entry line${t.crypto && !w.btc_ok ? ", and bitcoin needs to clear its own average too" : ""}.`,
        t.ten_month_avg ? `10-month average: <b>${cur}${nf(t.ten_month_avg)}</b>. A month-end close below it after being above is the exit signal.${t.exit_flag ? ` That happened at the end of ${my(t.exit_month)}.` : ""}` : `Too new for a 10-month average; the 50-day line stands in for entries.`,
        t.trim_flag ? `<b>Trim flag:</b> more than 40% above its average.` : `Trim flag at ${cur}${nf(t.trigger * 1.4)} (40% above the average).`,
        `${pc(t.from_high, 0)} from its 1-year high; ${pc(t.chg30, 0)} over 30 days.`,
        t.analyst_upside_pct != null ? `Analysts' average target was ${t.analyst_upside_pct.toFixed(0)}% above the price on ${dmy(w.as_of_analyst)} (rating ${t.rating.toFixed(1)} on a 1 = strong buy to 5 = sell scale).` : "",
      ].filter(Boolean))}</div>`;
    h += `<p class="small muted" style="margin-top:20px">Educational, not advice. Levels follow the watchlist rules set in the daily review and recompute every morning.</p>`;
    setTimeout(() => {
      const hl = [{ y: t.trigger, label: `Entry line ${cur}${nf(t.trigger)}`, color: css("--orange2") }];
      if (t.ten_month_avg) hl.push({ y: t.ten_month_avg, label: "10-month avg", color: css("--gray") });
      const u = lineChart(document.getElementById("c-w"), { t: t.t, height: 300, hlines: hl,
        series: [{ label: "Close", data: t.c, color: css("--blue") }, { label: t.trigger_basis, data: t.ma, color: css("--orange2"), width: 1.3 }] });
      const v = t.c.concat([t.trigger]); u.setScale("y", { min: Math.min(...v) * 0.95, max: Math.max(...v) * 1.04 });
    });
    return h;
  }

  async function viewPlan() {
    const [p, o] = await Promise.all([load("plan.json"), load("overview.json")]);
    const ym = new Date().toISOString().slice(0, 7);
    let h = `<section class="hero"><p class="eyebrow">${esc(p.budget)}</p><h1>Plan</h1><p class="lede">Buy every month. Let the trend rules decide only when to step aside into SGD cash.</p></section>`;
    h += `<div class="grid g3">${o.plan.map((x) => `<a class="card link" href="#/market/${x.key}"><div class="card-h"><div><h3>${x.label}</h3><p class="sub">${esc(x.market)} · ${esc(x.rule)}</p></div>${pill(x.signal)}</div>
      <p class="sub">${x.signal ? "Hold. Move to cash if the" : "Stay in cash. Hold again if the"} ${dm(x.month_end)} close is ${x.signal ? "below" : "above"} <b class="num">${nf(x.level)}</b>.</p></a>`).join("")}</div>`;
    h += `<h2>Rules</h2><div class="grid g2">${p.rules.map((r) => `<div class="card"><h3>${esc(r.title)}</h3><p class="sub" style="font-size:16px">${esc(r.text)}</p></div>`).join("")}</div>`;
    h += `<h2>Buying rotation</h2><div class="card"><ul class="timeline">${p.rotation.map((r) => `<li class="${r.month === ym ? "now" : ""}"><span class="m">${my(r.month + "-01")}</span><span>${esc(r.buy)}${r.note ? ` <span class="muted">· ${esc(r.note)}</span>` : ""}</span></li>`).join("")}</ul></div>`;
    h += `<h2>Daily routine</h2><div class="card">${keys([
      `This dashboard refreshes at <b>7:35 AM Singapore time, Tuesday to Saturday</b>, after the US close.`,
      `Check <a href="#/today">Today</a>: a red alert means a rule is within 2% of its line or has crossed it.`,
      `Act only on the month-end close. The rule decides, then trade on the next trading day.`,
      esc(p.fees),
    ])}</div>`;
    return h;
  }

  // ---------- router ----------
  async function route() {
    destroyCharts();
    const parts = (location.hash.replace(/^#\/?/, "") || "today").split("/");
    const tab = { market: "markets", research: "research", plan: "plan", markets: "markets", watch: "watch" }[parts[0]] || "today";
    document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === tab));
    try {
      let html;
      if (parts[0] === "market" && parts[1]) html = await viewMarket(parts[1]);
      else if (parts[0] === "markets") html = await viewMarkets();
      else if (parts[0] === "research" && parts[1]) html = await viewTicker(parts[1]);
      else if (parts[0] === "research") html = await viewResearch();
      else if (parts[0] === "plan") html = await viewPlan();
      else if (parts[0] === "watch" && parts[1]) html = await viewWatchTicker(decodeURIComponent(parts[1]));
      else if (parts[0] === "watch") html = await viewWatch();
      else html = await viewToday();
      $app.innerHTML = html;
    } catch (e) {
      console.error(e);
      $app.innerHTML = `<section class="hero"><h1>Couldn't load</h1><p class="lede">${esc(e.message)}. Check your connection and refresh.</p></section>`;
    }
  }
  let lastHash = location.hash;
  window.addEventListener("hashchange", () => { const scroll = lastHash.split("/")[1] !== location.hash.split("/")[1] || true; lastHash = location.hash; route().then(() => scroll && window.scrollTo(0, 0)); });
  route();
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
