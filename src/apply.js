"use strict";
/** Application questions for events that select participants (e.g. Ride It Forward): riding experience, jersey and bib shorts sizes, their story. */
const { h } = require("./views");

const EXPERIENCE = ["I've never ridden a bike", "I'm learning to ride", "I ride sometimes", "I ride regularly"];
const BIKE = ["Yes", "No", "I can borrow one"];
const SIZES = ["XS", "S", "M", "L", "XL", "XXL"];
const STORY_MIN = 30, STORY_MAX = 1500;

const opts = (list, v) => list.map((x) => `<option ${v === x ? "selected" : ""}>${h(x)}</option>`).join("");

function fields(v = {}) {
  return `<label>How much do you ride?<select name="experience" required><option value="">Choose…</option>${opts(EXPERIENCE, v.experience)}</select></label>
    <label>Do you have a bike?<select name="has_bike" required><option value="">Choose…</option>${opts(BIKE, v.has_bike)}</select></label>
    <div class="row2"><label>Jersey size<select name="jersey_size" required><option value="">Choose…</option>${opts(SIZES, v.jersey_size)}</select></label>
      <label>Bib shorts size<select name="bib_size" required><option value="">Choose…</option>${opts(SIZES, v.bib_size)}</select></label></div>
    <label>Your story: why would you like to be selected? <span class="hint">(a few sentences)</span>
      <textarea name="story" required minlength="${STORY_MIN}" maxlength="${STORY_MAX}" rows="5">${h(v.story)}</textarea></label>
    <label class="check"><input type="checkbox" name="share_story" value="1" ${v.share_story ? "checked" : ""}> <span>WMF may share my story (first name only) to encourage others.</span></label>`;
}

/** { answers } or { err } */
function read(b) {
  const story = String(b.story || "").replace(/\r/g, "").trim().slice(0, STORY_MAX);
  if (!EXPERIENCE.includes(b.experience)) return { err: "Please tell us how much you ride." };
  if (!BIKE.includes(b.has_bike)) return { err: "Please tell us if you have a bike." };
  if (!SIZES.includes(b.jersey_size) || !SIZES.includes(b.bib_size)) return { err: "Please choose your jersey and bib shorts sizes." };
  if (story.length < STORY_MIN) return { err: "Please share a few sentences about why you'd like to be selected." };
  return { answers: { experience: b.experience, has_bike: b.has_bike, jersey_size: b.jersey_size, bib_size: b.bib_size, story, share_story: !!b.share_story } };
}

/** Short HTML summary for the staff list. */
function summary(a) {
  if (!a) return '<span class="muted">—</span>';
  return `<b>${h(a.experience)}</b> · bike: ${h(a.has_bike)}<br>
    <span class="muted">Jersey</span> ${h(a.jersey_size || "—")} · <span class="muted">Bib shorts</span> ${h(a.bib_size || "—")}
    <details><summary>Story${a.share_story ? " (OK to share)" : ""}</summary><p style="white-space:pre-wrap;margin:6px 0">${h(a.story)}</p></details>`;
}
const csvCols = ["Experience", "Has bike", "Jersey size", "Bib shorts size", "Story", "OK to share story"];
const csvRow = (a = {}) => [a.experience, a.has_bike, a.jersey_size, a.bib_size, a.story, a.share_story ? "Yes" : a.story ? "No" : ""];

module.exports = { fields, read, summary, csvCols, csvRow, SELECTION: ["Selected", "Not selected"] };
