import { readFile, writeFile } from "node:fs/promises";

const base = new URL("../evaluation/demo-repair/holdout/", import.meta.url);
const origin = process.env.SCOUT_ORIGIN || "http://127.0.0.1:4173";
const code = process.env.DEMO_ACCESS_CODE;
if (!code) throw new Error("Set DEMO_ACCESS_CODE to use the local Scout inference API");
for (const id of ["holdout-01", "holdout-02", "holdout-03"]) {
  const bytes = await readFile(new URL(`${id}.jpg`, base));
  const response = await fetch(`${origin}/api/scout/infer`, {
    method: "POST", headers: { "content-type": "image/jpeg", "x-demo-access-code": code }, body: bytes,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${id}: ${body.error || response.status}`);
  await writeFile(new URL(`${id}.roboflow.json`, base), JSON.stringify(body, null, 2) + "\n");
  console.log(JSON.stringify({ id, predictions: body.predictions?.length || 0, ms: body.scout_timing?.roboflow_request_ms ?? null }));
}
