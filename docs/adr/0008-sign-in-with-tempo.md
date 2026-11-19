# 0008: Sign in with Tempo: the athlete's Tempo password opens Cadence

**Status:** Accepted, 2026-11-09 (branch `feat/sign-in-with-tempo`).

## Context

Cadence had no login. The README said to run it on a home network or behind a VPN, and the homelab's Caddyfile kept it to a LAN-only name with the rule "Cadence has no login: never a public name". That held while every athlete lived in the house that ran it.

A tester who lives elsewhere now uses a Tempo and Cadence pair on the same homelab. Her Tempo is already public: it has a login, and the Tempo iOS app syncs her Apple Watch runs to it from anywhere. Her Cadence could not be, because anyone who found its address could read her training, her About you page and her conversation with Coach Cade, and spend the operator's Anthropic key.

Facts that shaped the choice:

- Tempo has one account per instance (registration locks after the first user), a username and password login that returns a JWT and sets a cookie, and an endpoint that tells a caller who it is from either that JWT or an API key.
- Cadence already holds the Tempo address and an API key for that same Tempo, so a Cadence instance belongs to exactly one Tempo account.
- Every browser request to Cadence's API goes through the Next.js `/api` rewrite, so the API is one choke point.
- Tempo has no limit on failed logins.

## Decision

- **Tempo is the identity provider, by relay.** Cadence shows its own sign-in page, posts the username and password to Tempo's login endpoint from the API, and on success sets a Cadence session. Tempo's token and cookie are dropped. The password is never stored.
- **One variable turns it on.** `CADENCE_AUTH_TEMPO_URL` names the Tempo API that checks passwords. Unset, Cadence behaves exactly as before, with no login, so the README's home-network promise still holds by default. Set, the Tempo connection in Settings is fixed to that address, so the runs and the password always come from the same Tempo, and a fresh instance has someone to sign in as before Settings is ever opened.
- **The session is Cadence's own signed cookie.** It holds issued-at, expires-at and a random nonce, with an HMAC-SHA256 signature under a key derived from `DATA_PROTECTION_SECRET_KEY` by the existing HKDF chain with its own label. No identity inside, since an instance has one athlete. No database table and no call to Tempo per request, so reading past weeks keeps working while Tempo is down. `HttpOnly`, `Secure`, `SameSite=Lax`, path `/`.
- **Thirty days, sliding.** Any request past the halfway point gets a fresh cookie, so an athlete who opens Cadence weekly never sees the sign-in page again.
- **The API is the gate.** A Hono middleware in front of every route answers `401 auth_required` without a valid session and clears the cookie. Only `/health`, `/ready`, `/auth/login` and `/auth/logout` are open; the disclaimer, onboarding and everything else sit behind it, so an anonymous visitor learns nothing about the athlete.
- **The Next.js proxy only redirects.** A page load without the cookie goes to `/login`. It checks presence, not the signature, so the signing key stays in the API container. A forged or expired cookie reaches the page, whose first API call gets the 401, and the shared response helper sends the browser to `/login`. The same path covers a session that expires with a page open.
- **One throttle for the instance.** Ten wrong passwords in a rolling 15 minutes close sign-in for 15 minutes, and every wrong password waits one second before the answer. It is counted for the whole instance, not per address: there is one athlete, so per-address fairness buys nothing, and it needs no trust in forwarded headers. In memory; a restart clears it. Tempo being unreachable is not counted.
- **Refuse to start when it cannot be safe.** With sign-in on, the API exits at startup if the URL does not parse or the data-protection secret is missing or still the published example value, since a cookie signed with a published key is no gate.
- **No CSRF token.** The cookie is same-origin and `SameSite=Lax`, so a cross-site POST, PUT or DELETE arrives without it. Those are how the athlete changes anything, and the coach calls that spend the model key are all POSTs.

## Alternatives

- **Share Tempo's own cookie.** Tempo can set its cookie on a parent domain, so Cadence on a sibling subdomain could read it and ask Tempo who it belongs to. That removes Cadence's sign-in form, but ties the two deployments to one parent domain, needs a return-to-Cadence flow Tempo's login page does not have, and makes every Cadence page load depend on Tempo answering.
- **Cloudflare Access in front of Cadence.** Free at this size and needs no code. It cannot sit in front of Tempo without breaking the iOS app, it only helps operators who use Cloudflare, and it does nothing for anyone else putting Cadence on the internet. Still a fine stopgap.
- **Cadence's own accounts.** A second password for the same athlete and a reset flow to build, for no gain while one Tempo account maps to one Cadence.
- **Per-request check against Tempo.** Changing the Tempo password would end Cadence sessions too, but Cadence would go down with Tempo, and the pilot does not need revocation beyond expiry.

## Consequences

- An operator can give a remote athlete a public Cadence with one variable and HTTPS. The homelab's "never a public name" rule for Cadence can be retired for instances that set it.
- The cookie is HTTPS-only. A browser on another machine reaching Cadence over plain `http://` cannot sign in; `http://localhost` can, since browsers treat it as secure.
- Sessions cannot be revoked one by one. Changing the Tempo password does not end a Cadence session; rotating `DATA_PROTECTION_SECRET_KEY` ends all of them (and, as before, makes saved keys unreadable).
- Tempo still has no login limit of its own. Cadence's throttle protects only the path through Cadence; Tempo's own login, which the iOS app needs public, wants its own limit.
- Multi-athlete hosting is not addressed. One Cadence still serves one athlete, and a shared host would need a user model in both Tempo and Cadence.
