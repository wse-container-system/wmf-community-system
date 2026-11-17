"use strict";
/** Application questions for events that select participants (e.g. Ride It Forward): story + the gear that would help. */
const { h } = require("./views");

const EXPERIENCE = ["I've never ridden a bike", "I'm learning to ride", "I ride sometimes", "I ride regularly"];
const BIKE = ["Yes", "No", "I can borrow one"];
const GEAR = ["Bike", "Helmet", "Gloves", "Cycling jersey", "Cycling shorts", "Lights", "Water bottle", "Bike lock", "Cycling shoes"];
const SIZES = ["XS", "S", "M", "L", "XL", "XXL"];
const STORY_MIN = 30, STORY_MAX = 1500;

const opts = (list, v) => list.map((x) => `<option ${v === x ? "selected" : ""}>${h(x)}</option>`).join("");

function fields(v = {}) {
  const gear = [].concat(v.gear || []);
  return `<label>How much do you ride?<select name="experience" required><option value="">Choose…</option>${opts(EXPERIENCE, v.experience)}</select></label>
    <div class="row2"><label>Do you have a bike?<select name="has_bike" required><option value="">Choose…</option>${opts(BIKE, v.has_bike)}</select></label>
      <label>Clothing size <span class="hint">(optional)</span><select name="size"><option value="">—</option>${opts(SIZES, v.size)}</select></label></div>
    <fieldset style="border:1px solid var(--line);border-radius:10px;padding:10px 12px"><legend style="font-weight:600;color:var(--ink-2);font-size:14px">What would help you most?</legend>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:4px 12px">${GEAR.map((g) => `<label class="check"><input type="checkbox" name="gear" value="${h(g)}" ${gear.includes(g) ? "checked" : ""}> <span>${h(g)}</span></label>`).join("")}</div></fieldset>
    <label>Your story: why would you like to be selected? <span class="hint">(a few sentences)</span>
      <textarea name="story" required minlength="${STORY_MIN}" maxlength="${STORY_MAX}" rows="5">${h(v.story)}</textarea></label>
    <label class="check"><input type="checkbox" name="share_story" value="1" ${v.share_story ? "checked" : ""}> <span>WMF may share my story (first name only) to encourage others.</span></label>`;
}

/** { answers } or { err } */
function read(b) {
  const story = String(b.story || "").replace(/\r/g, "").trim().slice(0, STORY_MAX);
  if (!EXPERIENCE.includes(b.experience)) return { err: "Please tell us how much you ride." };
  if (!BIKE.includes(b.has_bike)) return { err: "Please tell us if you have a bike." };
  if (story.length < STORY_MIN) return { err: "Please share a few sentences about why you'd like to be selected." };
  const gear = [].concat(b.gear || []).filter((g) => GEAR.includes(g));
  return { answers: { experience: b.experience, has_bike: b.has_bike, gear, size: SIZES.includes(b.size) ? b.size : "", story, share_story: !!b.share_story } };
}

/** Short HTML summary for the staff list. */
function summary(a) {
  if (!a) return '<span class="muted">—</span>';
  return `<b>${h(a.experience)}</b> · bike: ${h(a.has_bike)}${a.size ? " · size " + h(a.size) : ""}<br>
    <span class="muted">Needs:</span> ${h((a.gear || []).join(", ") || "—")}
    <details><summary>Story${a.share_story ? " (OK to share)" : ""}</summary><p style="white-space:pre-wrap;margin:6px 0">${h(a.story)}</p></details>`;
}
const csvCols = ["Experience", "Has bike", "Gear needed", "Size", "Story", "OK to share story"];
const csvRow = (a = {}) => [a.experience, a.has_bike, (a.gear || []).join("; "), a.size, a.story, a.share_story ? "Yes" : a.story ? "No" : ""];

module.exports = { fields, read, summary, csvCols, csvRow, SELECTION: ["Selected", "Not selected"] };
