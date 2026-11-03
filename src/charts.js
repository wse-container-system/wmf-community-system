"use strict";
/** Charts drawn on the server as inline SVG: no scripts, they print, and they follow the page theme. */
const { h, nf } = require("./views");

function niceMax(v) {
  if (v <= 5) return 5;
  const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/**
 * Column chart. series: [{ name, color, values[] }], stacked when more than one series and stacked=true.
 * The total sits above each column so the figures read without hovering.
 */
function columns({ categories, series, stacked = true, height = 220, label = "Chart", short = (c) => c }) {
  const W = Math.max(320, categories.length * 46 + 50), H = height, L = 34, B = 26, T = 18;
  const tot = categories.map((_, i) => stacked ? series.reduce((a, s) => a + (s.values[i] || 0), 0) : Math.max(...series.map((s) => s.values[i] || 0)));
  const max = niceMax(Math.max(1, ...tot)), ph = H - B - T, slot = (W - L) / Math.max(1, categories.length);
  const bw = Math.min(30, slot * 0.62) / (stacked ? 1 : series.length);
  const y = (v) => T + ph - (v / max) * ph;
  let g = "";
  for (let k = 0; k <= 4; k++) { const v = (max / 4) * k; g += `<line class="gl" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${nf(v)}</text>`; }
  let bars = "";
  categories.forEach((c, i) => {
    const cx = L + slot * i + slot / 2;
    let acc = 0;
    series.forEach((s, j) => {
      const v = s.values[i] || 0; if (!v) return;
      const x = stacked ? cx - bw / 2 : cx - (bw * series.length) / 2 + j * bw;
      const top = stacked ? y(acc + v) : y(v), hgt = stacked ? y(acc) - y(acc + v) : y(0) - y(v);
      bars += `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${(bw - (stacked ? 0 : 2)).toFixed(1)}" height="${Math.max(0, hgt - (stacked && acc ? 1 : 0)).toFixed(1)}" rx="2" fill="${s.color}"><title>${h(c)} · ${h(s.name)}: ${nf(v)}</title></rect>`;
      if (stacked) acc += v;
    });
    if (tot[i]) bars += `<text class="val" x="${cx}" y="${y(tot[i]) - 5}" text-anchor="middle">${nf(tot[i])}</text>`;
    bars += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${h(short(c))}</text>`;
  });
  const legend = series.length > 1 ? `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${h(s.name)}</span>`).join("")}</div>` : "";
  return `${legend}<div class="tw"><svg class="svgchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${h(label)}" style="min-width:${Math.min(W, 640)}px;max-height:${H + 40}px"><line class="ax" x1="${L}" x2="${W}" y1="${y(0)}" y2="${y(0)}"/>${g}${bars}</svg></div>`;
}

/** Horizontal bars with the value at the end; items: [{ name, value, color? }]. */
function hbars(items, { color = "var(--s1)", empty = "Nothing in this period." } = {}) {
  if (!items.length) return `<p class="muted">${h(empty)}</p>`;
  const max = Math.max(1, ...items.map((i) => i.value));
  return `<div role="list">${items.map((i) => `<div class="hbar" role="listitem"><span>${h(i.name)}</span><span><span class="bar" style="display:block;width:${((i.value / max) * 100).toFixed(1)}%;background:${i.color || color}"></span></span><b>${nf(i.value)}</b></div>`).join("")}</div>`;
}

module.exports = { columns, hbars };
