// Preloaded before test/db.ts. mcp() needs an absolute resource URL, and
// tokens carry iss and aud built from this origin (design §7.5).
process.env.BETTER_AUTH_URL ??= "http://localhost:3210"
