// Cloudflare Worker attached to the custom domain mars.zuchka.dev.
// The Sprite URL remains the origin; Cloudflare provides the public hostname and TLS.
const UPSTREAM = "mcp-mars-fan-scout-b3l3w.sprites.app";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.hostname = UPSTREAM;
    url.protocol = "https:";
    return fetch(new Request(url.toString(), request));
  },
};
