// Next dev compiles each page and API route on its first request. Spec files run in parallel, so
// the first navigation used to race that compilation ("Execution context was destroyed"). This
// global setup requests every page and route the specs use once, before any test starts. Bodies
// are deliberately malformed so the API refuses them before anything is recorded.
const origin = `http://localhost:${process.env.PROOF_E2E_WEB_PORT ?? "3101"}`;
const development = "/api/proof-sessions/session%3Adevelopment";

const gets = [
  "/",
  "/problems/new",
  "/sessions/session%3Adevelopment",
  "/sessions/session%3Adevelopment/tree",
  "/sessions/session%3Adevelopment/playback",
  "/sessions/session%3Adevelopment/proof",
  development,
  `${development}/history`,
  `${development}/suggestion-sets/warmup`,
  `${development}/export?confirmPrivateExport=true`,
];
const posts = [
  "/api/problem-drafts/validate",
  "/api/proof-sessions",
  "/api/artifacts",
  `${development}/observe`,
  `${development}/interaction-events`,
  `${development}/protocol-commands`,
  `${development}/commands`,
  `${development}/move-previews`,
  `${development}/backtrack`,
  `${development}/suggestion-sets`,
];

export default async function globalWarmup() {
  // Sequential: compiling everything at once is exactly the load being avoided.
  for (const path of gets) await fetch(`${origin}${path}`, { headers: { origin } });
  for (const path of posts) {
    await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: "{}",
    });
  }
}
