import { readdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const directory = resolve(root, process.env.REVIEW_AGENT_DATA_DIR || ".review-agent");
const days = Number(process.env.REVIEW_AGENT_RETENTION_DAYS || 30);
if (!Number.isSafeInteger(days) || days < 1) throw new Error("REVIEW_AGENT_RETENTION_DAYS must be a positive integer");
const apply = process.argv.includes("--apply");
const cutoff = Date.now() - days * 86400000;
let names=[];
try { names = await readdir(directory); }
catch (error) { if (error.code !== "ENOENT") throw error; }
for (const name of names) {
  if (!/^[a-f0-9-]{36}$/.test(name)) continue;
  try {
    const session=JSON.parse(await readFile(resolve(directory,name,"session.json"),"utf8"));
    if (session.id!==name || !Number.isFinite(Date.parse(session.created_at)) || Date.parse(session.created_at)>=cutoff) continue;
    console.log(`${apply?"Purging":"Would purge"} ${name} (${session.created_at})`);
    if (apply) await rm(resolve(directory,name),{recursive:true,force:true});
  } catch (error) { if (error.code!=="ENOENT") console.error(`Skipped ${name}: ${error.message}`); }
}
if (!apply) console.log("Dry run. Pass --apply to remove listed sessions.");
