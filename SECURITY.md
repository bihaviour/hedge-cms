# Security Policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/bihaviour/hedge-cms/security/advisories/new)
rather than opening a public issue.

Include what you can: affected version or commit, reproduction steps, and impact. We aim to
acknowledge reports within a few days and will keep you updated as we work on a fix.

## Scope

Hedge is early-stage software and has not been independently audited. Treat any deployment as
production-sensitive: it holds your content, your users' credentials, and your API keys.

## Operational notes

- `AUTH_SECRET` keys the HMAC used for session ids, API keys, and invite tokens. Set it with
  `wrangler secret put AUTH_SECRET` — never commit it, and rotate it if it leaks. Rotating it
  invalidates every session, API key, and outstanding invite.
- Passwords are hashed with PBKDF2-SHA256 (210,000 iterations), the strongest KDF available in
  the Workers runtime. API keys, session ids, and invite tokens are stored only as HMACs.
- `POST /api/v1/auth/setup` creates the first owner account and refuses to run once any user
  exists. Complete setup immediately after deploying.
- API keys are scoped. Grant `content:read` to public site consumers and nothing more.
