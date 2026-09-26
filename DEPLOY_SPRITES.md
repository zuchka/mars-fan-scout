# Deploy Mars Fan Scout on Fly Sprites

The official [Sprites MCP endpoint](https://fly.io/sprites/ecosystem/) is `https://sprites.dev/mcp`. Codex can add it with `codex mcp add sprites --url https://sprites.dev/mcp`; browser OAuth then connects it to a Fly organization. The Sprite CLI is also useful for the first deployment.

1. Sign in to Fly and select an organization with Sprites enabled. Install the [Sprite CLI](https://docs.fly.io/sprites/quickstart/) and run `sprite login`.
2. Create the Sprite and clone the public source repository:

   ```sh
   sprite create mars-fan-scout
   sprite use mars-fan-scout
   sprite exec -- git clone https://github.com/zuchka/mars-fan-scout.git /home/sprite/mars-fan-scout
   ```

3. Copy the existing local `.env.local` to a separate ignored `.env.sprite` file. Set `HOST=0.0.0.0`, `PORT=8080`, `DEMO_DAILY_LIMIT=100`, and a long, randomly generated `DEMO_ACCESS_CODE`. Keep `ROBOFLOW_API_KEY` and the model ID. Do not commit either environment file. Upload the deployment copy using `sprite file push .env.sprite /home/sprite/mars-fan-scout/.env.local`, then run `sprite exec -- chmod 600 /home/sprite/mars-fan-scout/.env.local`.
4. Register the server as a [Sprite Service](https://docs.sprites.dev/working-with-sprites/) so it restarts after sleep:

   ```sh
   sprite exec -- sprite-env services create mars-fan-scout --cmd node --args /home/sprite/mars-fan-scout/server.mjs
   ```

5. Use `sprite url` to obtain the private URL. Verify `/api/status` reports `scout_ready: true`, `access_required: true`, and `access_granted: false` without the code, then verify the code unlocks scanning. Once those checks pass, run `sprite url update --auth public` to share the demo URL. An unknown visitor can browse the images and evaluation, but paid model scans require the code.

The daily limit counts **Roboflow image-tile requests**, not whole uploads. A 3072-pixel image can use up to 16 tiles. The allowance resets at midnight UTC and is kept in the Sprite's persistent filesystem. The limit is a demonstration cost guard, not a substitute for a provider-side budget. A reserved tile counts even when Roboflow returns an error. Revisit this limit and use stronger user accounts before opening the app to unrestricted public inference.

For updates, push source changes to GitHub, pull inside the Sprite, and restart the Service. Never put the API key or meeting code into a public repository, browser asset, or URL. The served image upload is processed in memory, then sent to Roboflow as tiles; the server does not retain uploaded image files. Browser review decisions remain in that visitor's local storage.
