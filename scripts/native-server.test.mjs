import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { sha } from "../scout/source-store.mjs";
const root = resolve(import.meta.dirname, "..");
test(
  "native HTTP routes gate uploads/jobs and return byte-identical originals",
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mars-http-")),
      probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    const server = spawn(process.execPath, ["server.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        DEMO_ACCESS_CODE: "test-only-code",
        DEMO_DAILY_LIMIT: "0",
        ROBOFLOW_API_KEY: "never-used",
        ROBOFLOW_MODEL_ID: "test/model",
        ROBOFLOW_MODEL_TRAINING: "1",
        ROBOFLOW_REPLAY: "0",
        SCOUT_DATA_DIR: join(directory, "scout"),
        REVIEW_AGENT_DATA_DIR: join(directory, "review"),
      },
    });
    let logs = "";
    server.stdout.on("data", (s) => (logs += s));
    server.stderr.on("data", (s) => (logs += s));
    try {
      for (let i = 0; !logs.includes("Mars Fan Scout ready"); i++) {
        if (i > 100 || server.exitCode !== null)
          throw new Error("Test server failed to start");
        await new Promise((r) => setTimeout(r, 50));
      }
      const base = `http://127.0.0.1:${port}`,
        headers = { "x-demo-access-code": "test-only-code" };
      const status = await (await fetch(base + "/api/status")).json();
      assert.equal(status.access_granted, false);
      assert.equal(status.scout_ready, false);
      assert.equal(status.native_pipeline, "native-v1");
      assert.equal(
        (
          await fetch(base + "/api/scout/sources", {
            method: "POST",
            body: "x",
          })
        ).status,
        401,
      );
      assert.equal(
        (await fetch(base + "/api/scout/jobs", { method: "POST", body: "{}" }))
          .status,
        401,
      );
      assert.equal(
        (
          await fetch(base + "/api/scout/jobs", {
            method: "POST",
            headers,
            body: "{}",
          })
        ).status,
        503,
      );
      const original = await sharp({
        create: { width: 320, height: 260, channels: 3, background: "#789abc" },
      })
        .png()
        .toBuffer();
      const uploaded = await fetch(base + "/api/scout/sources", {
        method: "POST",
        headers: { ...headers, "x-source-name": "API%20test.png" },
        body: original,
      });
      assert.equal(uploaded.status, 201);
      const source = await uploaded.json();
      assert.equal(source.width, 320);
      assert.equal(source.name, "API test.png");
      assert.equal((await fetch(base + source.original)).status, 401);
      const download = await fetch(base + source.original, { headers });
      assert.equal(download.status, 200);
      assert.equal(
        sha(Buffer.from(await download.arrayBuffer())),
        sha(original),
      );
      const region = await fetch(
        `${base}/api/scout/sources/${source.id}/region?x=17&y=21&width=256&height=129&max=512`,
        { headers },
      );
      assert.equal(region.status, 200);
      const metadata = await sharp(
        Buffer.from(await region.arrayBuffer()),
      ).metadata();
      assert.deepEqual([metadata.width, metadata.height], [256, 129]);
      assert.equal(
        (
          await fetch(
            `${base}/api/scout/sources/${source.id}/region?x=0&y=0&width=320&height=260&max=9000`,
            { headers },
          )
        ).status,
        400,
      );
      const sample = await (
        await fetch(base + "/api/scout/sources/sample")
      ).json();
      assert.equal(
        sha(
          Buffer.from(
            await (await fetch(base + sample.original)).arrayBuffer(),
          ),
        ),
        sha(await readFile(join(root, "assets/scout-native-16.png"))),
      );
    } finally {
      server.kill("SIGTERM");
      await once(server, "exit");
      await rm(directory, { recursive: true, force: true });
    }
  },
);
