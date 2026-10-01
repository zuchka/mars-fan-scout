# Deploy Mars Fan Scout on Fly Sprites

## RF-DETR and SAM 3 deployment

The live demo uses Roboflow RF-DETR Seg for proposals and an optional SAM 3 box-prompt call for the three featured regions. Both routes use the private ROBOFLOW_API_KEY and the existing meeting code. SAM 3 consumes one more daily scan allowance when clicked. The server no longer connects to the retired visual-review GPU, even if old JEV environment variables remain in the Sprite's private configuration. Pause or delete the separate Hugging Face endpoint in its control panel to stop any idle hosting charges; deploying this source alone does not change that endpoint.

Historical review sessions and evidence under /home/sprite/mars-fan-scout/.review-agent/ should be preserved for export. They are no longer used by the home page. The retired model code and evaluation artifacts remain in Git history and repository files for audit.

The live deployment is **[mars.zuchka.dev](https://mars.zuchka.dev/)**. Cloudflare Worker `mars-fan-scout-proxy` forwards requests to the origin **[mcp-mars-fan-scout-b3l3w.sprites.app](https://mcp-mars-fan-scout-b3l3w.sprites.app/)** in the `matt-abrams` Fly organization. The Sprite is named `mcp-mars-fan-scout`, and the auto-restarting service is named `mars-fan-scout`. Its source is cloned into `/home/sprite/mars-fan-scout`. The public URL requires a private meeting code for either live inference endpoint. The code and Roboflow API key are stored only in the Sprite's permission-restricted `.env.local` and an ignored local deployment copy.

The official [Sprites MCP endpoint](https://fly.io/sprites/ecosystem/) is `https://sprites.dev/mcp`. Codex can add it with `codex mcp add sprites --url https://sprites.dev/mcp`; browser OAuth then connects it to a Fly organization. The Sprite CLI is also useful for the first deployment. Fly requires a payment method to issue a Sprite CLI token for a lasting deployment. The no-card trial Sprite lasts two hours and is then destroyed, so it is unsuitable for a Monday meeting when created over the weekend.

1. Sign in to Fly and select an organization with Sprites enabled. Install the [Sprite CLI](https://docs.fly.io/sprites/quickstart/) and run `sprite login`.
2. Create the Sprite and clone the public source repository:

   ```sh
   sprite create mcp-mars-fan-scout
   sprite use mcp-mars-fan-scout
   sprite exec -- git clone https://github.com/zuchka/mars-fan-scout.git /home/sprite/mars-fan-scout
   ```

3. Copy the existing local `.env.local` to a separate ignored `.env.sprite` file. Set `HOST=0.0.0.0`, `PORT=8080`, `DEMO_DAILY_LIMIT=100`, and a long, randomly generated `DEMO_ACCESS_CODE`. Keep `ROBOFLOW_API_KEY` and the model ID. Do not commit either environment file. Upload the deployment copy using `sprite file push .env.sprite /home/sprite/mars-fan-scout/.env.local`, then run `sprite exec -- chmod 600 /home/sprite/mars-fan-scout/.env.local`.
4. Register the server as a [Sprite Service](https://docs.sprites.dev/working-with-sprites/) so it restarts after sleep:

   ```sh
   sprite exec -- sprite-env services create mars-fan-scout --cmd node --args /home/sprite/mars-fan-scout/server.mjs --http-port 8080
   ```

5. Use `sprite url` to obtain the private URL. Verify `/api/status` reports `scout_ready: true`, `access_required: true`, and `access_granted: false` without the code, then verify the code unlocks scanning. Once those checks pass, run `sprite url update --auth public` to share the demo URL. An unknown visitor can browse the images and evaluation, but paid model scans require the code.

The daily limit counts **Roboflow requests**: one for each RF-DETR image crop and one more when SAM 3 tracing is requested. The home page fits uploads to 1024 pixels before inference. The allowance resets at midnight UTC and is kept in the Sprite's persistent filesystem. The limit is a demonstration cost guard, not a substitute for a provider-side budget. A reservation counts even when Roboflow returns an error.

For updates, push source changes to GitHub, then run `sprite exec -- git -C /home/sprite/mars-fan-scout pull --ff-only` and `sprite exec -- sprite-env services restart mars-fan-scout`. Never put the API key or meeting code into a public repository, browser asset, or URL. The served image upload is processed in memory, then sent to Roboflow as tiles; the server does not retain uploaded image files. Browser review decisions remain in that visitor's local storage.

## Custom domain

Sprites currently provide a `*.sprites.app` URL but no native custom-hostname/certificate setup. The `zuchka studios` Cloudflare account has Worker `mars-fan-scout-proxy` with `mars.zuchka.dev` attached as a Production Custom Domain. Cloudflare automatically created the DNS record and certificate. The deployed Worker code is mirrored in [`cloudflare/mars-fan-scout-proxy.js`](cloudflare/mars-fan-scout-proxy.js); edit/deploy it in the Cloudflare Worker dashboard if its upstream URL changes. The Worker forwards the original path, method, body, and headers—including the meeting-code header—to the Sprite. The Sprite remains publicly reachable at its own URL.

Check `https://mars.zuchka.dev/api/status` for `scout_ready: true`. A successful page load also confirms the Cloudflare certificate and proxy route. The Worker itself does not store the Roboflow key or meeting code.
