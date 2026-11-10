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

/** A small trend line for a number box; the last point is marked. */
function spark(values, color = "var(--s1)") {
  const v = values.map((x) => +x || 0); if (v.length < 2) return "";
  const max = Math.max(1, ...v), min = Math.min(...v), W = 100, H = 24, P = 3;
  const pt = (x, i) => [(i / (v.length - 1)) * (W - 2 * P) + P, H - P - ((x - min) / Math.max(1, max - min)) * (H - 2 * P)];
  const pts = v.map(pt), last = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" points="${pts.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" ")}"/><circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.6" fill="${color}"/></svg>`;
}

/** Two bars per item (e.g. came vs registered), the second drawn behind as a lighter track. items: [{ name, a, b }]. */
function hbars2(items, { colorA, colorB, labelA, labelB, empty = "Nothing in this period." } = {}) {
  if (!items.length) return `<p class="muted">${h(empty)}</p>`;
  const max = Math.max(1, ...items.map((i) => Math.max(i.a || 0, i.b || 0)));
  return `<div class="legend"><span><i style="background:${colorA}"></i>${h(labelA)}</span><span><i style="background:${colorB}"></i>${h(labelB)}</span></div>
    <div role="list">${items.map((i) => `<div class="hbar hbar2" role="listitem"><span title="${h(i.name)}">${h(i.name)}</span><span class="hb2">
      ${i.b ? `<span class="bar" style="width:${((i.b / max) * 100).toFixed(1)}%;background:${colorB}"></span>` : ""}<span class="bar" style="width:${(((i.a || 0) / max) * 100).toFixed(1)}%;background:${colorA}"></span></span>
      <b>${i.a != null ? nf(i.a) : "—"}${i.b ? `<small> / ${nf(i.b)}</small>` : ""}</b></div>`).join("")}</div>`;
}

/** Line chart, one line per series (dashed lines tell series apart without colour). series: [{ name, color, values[], dash? }]. */
function lines({ categories, series, height = 210, label = "Chart", short = (c) => c }) {
  const W = Math.max(320, categories.length * 56 + 50), H = height, L = 34, B = 26, T = 16, R = 14;
  const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values.map((v) => v || 0))));
  const ph = H - B - T, x = (i) => L + (categories.length > 1 ? (i / (categories.length - 1)) * (W - L - R) : (W - L - R) / 2), y = (v) => T + ph - (v / max) * ph;
  let g = "";
  for (let k = 0; k <= 4; k++) { const v = (max / 4) * k; g += `<line class="gl" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${nf(v)}</text>`; }
  const dashes = ["", "6 4", "2 4", "10 4 2 4"];
  const ls = series.map((s, j) => {
    const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v || 0).toFixed(1)}`).join(" ");
    return `<polyline fill="none" stroke="${s.color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" ${s.dash || dashes[j % 4] ? `stroke-dasharray="${s.dash || dashes[j % 4]}"` : ""} points="${pts}"/>`
      + s.values.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v || 0).toFixed(1)}" r="3.4" fill="${s.color}" stroke="var(--surface,#fff)" stroke-width="1.5"><title>${h(short(categories[i]))} · ${h(s.name)}: ${nf(v || 0)}</title></circle>`).join("");
  }).join("");
  const labels = categories.map((c, i) => `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${h(short(c))}</text>`).join("");
  const legend = series.length > 1 ? `<div class="legend">${series.map((s, j) => `<span><i class="line" style="background:${s.color}${dashes[j % 4] ? ";opacity:.85" : ""}"></i>${h(s.name)}</span>`).join("")}</div>` : "";
  return `${legend}<div class="tw"><svg class="svgchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${h(label)}" style="max-height:${H + 40}px"><line class="ax" x1="${L}" x2="${W}" y1="${y(0)}" y2="${y(0)}"/>${g}${ls}${labels}</svg></div>`;
}

module.exports = { columns, hbars, spark, hbars2, lines };
