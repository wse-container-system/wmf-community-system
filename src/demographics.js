"use strict";
/**
 * Who is in the WMF database: city (Abu Dhabi / Dubai), women / men, Emirati / Arab / Expat.
 * City: the home city given at registration when it says Dubai, otherwise where the person rides most
 * (Abu Dhabi unless the ride or event is in Dubai, the rule agreed on 1 Oct 2026).
 */
const { pool } = require("./db");

const genderOf = (g) => {
  const s = String(g || "").toLowerCase();
  if (/\b(f|female|woman|women|lady|ladies|girl)\b/.test(s)) return "women";
  if (/\b(m|male|man|men|boy)\b/.test(s)) return "men";
  return "unknown";
};
const groupOf = (community, gender) => {
  const s = (String(community || "") + " " + String(gender || "")).toLowerCase();
  if (/emirati|uae national/.test(s)) return "emirati";
  if (/\barab/.test(s)) return "arab";
  if (/expat|expatriate|international/.test(s)) return "expat";
  return "unknown";
};

/** One row per member with city, gender and group. joinedFrom/joinedTo (ISO days) limit to people who joined then. */
async function memberProfiles({ joinedFrom, joinedTo } = {}) {
  const args = [], where = ["m.merged_into IS NULL"];
  if (joinedFrom) { args.push(joinedFrom); where.push(`m.first_seen >= $${args.length}::date`); }
  if (joinedTo) { args.push(joinedTo); where.push(`m.first_seen < ($${args.length}::date + 1)`); }
  const r = await pool.query(`SELECT m.member_id, m.gender, m.community, m.first_seen,
      count(p.member_id) FILTER (WHERE p.loc = 'Dubai')::int AS dxb, count(p.member_id) FILTER (WHERE p.loc = 'Abu Dhabi')::int AS auh
    FROM members m LEFT JOIN (
      SELECT p.member_id, CASE WHEN coalesce(a.location, '') ILIKE '%dubai%' OR p.activity_name ~* '(^|[^a-z])(dubai|dxb)([^a-z]|$)' OR coalesce(p.activity_id, '') ~* 'dxb|dubai'
        THEN 'Dubai' ELSE 'Abu Dhabi' END AS loc
      FROM participation p LEFT JOIN activities a ON a.activity_id = p.activity_id
      WHERE p.voided_at IS NULL AND p.member_id IS NOT NULL AND p.record_type IN ('Attendance', 'Event Registration')) p ON p.member_id = m.member_id
    WHERE ${where.join(" AND ")} GROUP BY m.member_id`, args);
  return r.rows.map((m) => ({
    id: m.member_id,
    city: /dubai|dxb/i.test(m.community || "") ? "Dubai" : /abu dhabi|auh/i.test(m.community || "") ? "Abu Dhabi" : m.dxb > m.auh ? "Dubai" : "Abu Dhabi",
    gender: genderOf(m.gender), group: groupOf(m.community, m.gender),
  }));
}

function summarise(list) {
  const n = (f) => list.filter(f).length;
  return {
    total: list.length,
    city: { auh: n((m) => m.city === "Abu Dhabi"), dxb: n((m) => m.city === "Dubai") },
    gender: { women: n((m) => m.gender === "women"), men: n((m) => m.gender === "men"), unknown: n((m) => m.gender === "unknown") },
    group: { emirati: n((m) => m.group === "emirati"), arab: n((m) => m.group === "arab"), expat: n((m) => m.group === "expat"), unknown: n((m) => m.group === "unknown") },
  };
}
const databaseMix = async (opts) => summarise(await memberProfiles(opts));

module.exports = { genderOf, groupOf, memberProfiles, summarise, databaseMix };
