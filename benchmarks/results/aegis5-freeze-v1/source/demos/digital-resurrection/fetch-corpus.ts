// Fetches the Digital Resurrection corpus from Natural Earth at a pinned commit and derives each
// file's source of truth. Natural Earth is in the public domain. The .dbf files are the attribute
// tables of its shapefiles, in the dBase format. The truth is the attribute data in the GeoJSON that
// Natural Earth publishes alongside them, produced by its own pipeline, so it owes nothing to EXAPT.
// The results are committed; this script exists so the corpus can be reproduced.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sha256, writeJson } from "../../packages/shared/index.ts";

const COMMIT = "ca96624a56bd078437bca8184e78163e5039ad19";
const RAW = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${COMMIT}`;
const FILES: Array<[string, string]> = [
  ["110m_cultural", "ne_110m_admin_0_pacific_groupings"],
  ["110m_cultural", "ne_110m_admin_0_scale_rank"],
  ["110m_cultural", "ne_110m_admin_1_states_provinces_scale_rank"],
  ["110m_cultural", "ne_110m_admin_1_states_provinces"],
  ["110m_physical", "ne_110m_geography_regions_points"],
  ["110m_physical", "ne_110m_geography_regions_elevation_points"],
  ["110m_physical", "ne_110m_geographic_lines"],
  ["110m_physical", "ne_110m_rivers_lake_centerlines"],
  ["110m_physical", "ne_110m_lakes"],
  ["110m_physical", "ne_110m_land"],
  ["110m_physical", "ne_110m_coastline"],
  ["110m_physical", "ne_110m_geography_marine_polys"],
];

const dir = path.join(import.meta.dirname, "corpus");
fs.mkdirSync(dir, { recursive: true });
const fetchBytes = (url: string): Buffer => execFileSync("curl", ["-fsSL", "--max-time", "120", url], { maxBuffer: 64 * 1024 * 1024 });
const manifest: Array<Record<string, unknown>> = [];
for (const [folder, name] of FILES) {
  const dbf = fetchBytes(`${RAW}/${folder}/${name}.dbf`);
  const geo = JSON.parse(fetchBytes(`${RAW}/geojson/${name}.geojson`).toString("utf8")) as { features: Array<{ properties: Record<string, unknown> }> };
  const truth = geo.features.map((f) => JSON.stringify(f.properties)).join("\n") + "\n";
  fs.writeFileSync(path.join(dir, `${name}.dbf`), dbf);
  fs.writeFileSync(path.join(dir, `${name}.truth.ndjson`), truth);
  manifest.push({ name, source: `${folder}/${name}.dbf`, sha256: sha256(dbf), truthFrom: `geojson/${name}.geojson`, truthSha256: sha256(truth), records: geo.features.length, fields: Object.keys(geo.features[0]?.properties ?? {}).length });
  console.log(name, dbf.length, "bytes", geo.features.length, "records");
}
writeJson(path.join(dir, "MANIFEST.json"), { source: "https://github.com/nvkelso/natural-earth-vector", commit: COMMIT, license: "Public domain (Natural Earth, https://www.naturalearthdata.com/about/terms-of-use/)", files: manifest });
