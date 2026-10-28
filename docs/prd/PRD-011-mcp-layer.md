# PRD-011 — AI Connector / MCP Layer
**Burnout League · Corewright Labs LLC**
*Status: v1.4 — **Phase 1a APPROVED 2026-10-27** (Nath). Phase 1a part 1 (connector, four tools, personal tokens) built 2026-10-28; part 2 (OAuth for hosted AI apps) next. Phase 1b under discussion; not committed.*
*Authors: Product (Overlord thread) v1.0 · Build thread revisions v1.1–v1.3 · 2026-10-27/28*
*Repo: `NathW75/burnout-app` · `docs/prd/PRD-011-mcp-layer.md`*

---

## 1. Purpose

PRD-011 defines the Model Context Protocol (MCP) server that exposes a manager's Burnout League data, plus anonymized field data, to any MCP-capable AI client (Claude, ChatGPT, Gemini, or a local model with an MCP adapter).

The MCP layer is a product feature, not a developer tool. Burnout League's Terms of Service don't prohibit AI use; the MCP server turns that policy into a capability. A manager connects the AI assistant they already use to their live pool state and talks through strategy, which no other fantasy platform offers.

**Phase 1 scope**, in two parts (§3): **1a** (approved) ships after the web app's lineup flow is live; **1b** is under discussion and is not committed. If approved, it follows the projections decision (PRD-006 Q3) and attorney review.

---

## 2. Background & Strategic Rationale

### 2.1 Competitive differentiation

Gambit (TheoryTwelve LLC) puts AI analytics behind a $29/yr paywall inside its own platform. Our posture is the inverse: an open connector, the user brings their own AI, and we supply the data. This is a deliberate positioning choice in line with the brand principle of "liberating expertise from the few to many."

### 2.2 The proprietary data layer

Raw NFL stats are available from dozens of sources. Burnout League's data is proprietary because it captures:

- **Burn history:** which players a manager has consumed, and when, relative to the lock schedule
- **Pool state:** what remains available to the manager for the rest of the season
- **Field burn patterns:** anonymized aggregate burn behavior, showing when the crowd is spending talent and when it is hoarding
- **Lock-timing decisions:** whether a manager submitted before or after injury news

The MCP server's value is access to Burnout's own tables, not to MySportsFeeds.

### 2.3 Field aggregates scale with the platform

The burn pool is **per user, per season**, not per contest pool (PRD-001). Every manager in a season plays against the same player universe, so the natural field is **everyone with a season lineup**, free and paid. Narrower scopes, such as one contest pool's entrants or a private league (PRD-012), are filters on the same query. A minimum-field floor (§6.5) keeps every aggregate anonymous. The feature turns on per scope as fields grow past the floor, so no separate "cross-league" flag is needed.

### 2.4 Analytics and downstream use

The MCP server produces fantasy football analytics. The platform will never advertise, hint at, or build integrations for any use of these analytics outside Burnout League. *Attorney review: the exact wording of this posture for the ToS (§10).*

---

## 3. Scope

### 3.1 Phase 1a: connector + four read tools

- MCP server on the 2026-07-28 protocol revision, with stateless Streamable HTTP (§4)
- Two ways to sign in: OAuth 2.1 for hosted AI apps, and personal tokens for developer clients (§5)
- Tools: `get_my_pool`, `get_burn_history`, `get_pool_standings`, `get_field_burn_rates` (§6)
- Token and connection management in account settings (web app)
- Per-token rate limits and abuse controls (§7)

**Built in two patches (decided by the build thread, 2026-10-28):** part 1 is the connector, the four tools, personal tokens and the Account → AI connector page (built 2026-10-28). Part 2 is OAuth for hosted AI apps (§5.1), the consent page, and OAuth connections in account settings.

### 3.2 Phase 1b: analytics tools (under discussion, not committed)

- `get_burn_volatility_ratings` (BVR) and `get_optimal_burn_path`. Both depend on projections and strength-of-schedule data (PRD-006 Q3), and the burn path needs attorney sign-off (§10).
- Neither tool appears in `tools/list` until it is real. No `coming_soon` stubs: an AI client would present a stub's output to the user as if it were an answer.

### 3.3 Out of scope (tracked)

- Commissioner tools with non-anonymized league data (PRD-012)
- Prediction-market tools (Standing Markets PRD, post-MVP)
- Server-to-client push (`subscriptions/listen`). Clients poll in Phase 1.
- Any write tool. An AI can never submit, confirm or change a lineup, or touch payments: the three-gate rule (PRD-006 §9) requires the human.

---

## 4. Protocol

- **Revision:** MCP **2026-07-28** (final 2026-07-28, verified against the spec 2026-10-28). The server must also answer clients on **2025-11-25**, which hosted clients still use at launch. Both are handled statelessly: no `Mcp-Session-Id`, and an `initialize` from an older client is answered as 2025-11-25 specifies, without creating a session.
- **Transport:** Streamable HTTP. One endpoint, `POST https://api.burnoutfantasy.com/mcp`, JSON-RPC 2.0. Modern (2026-07-28) requests get a JSON response; 2025-era requests get the single-event stream that revision uses. No long-lived streams in Phase 1, since every tool returns in one response. GET and DELETE return 405.
- **Methods:** `server/discover` (required by 2026-07-28), `tools/list` and `tools/call`; `initialize` for 2025-era clients.
  - `tools/list` returns tools in a fixed order, with `ttlMs` and `cacheScope: "private"`.
  - Each tool has an `inputSchema` and an `outputSchema`.
  - Results carry `resultType: "complete"`, `structuredContent`, and a short text rendering followed by the same data as JSON.
- **Headers:** `Mcp-Method` (every modern request) and `Mcp-Name` (`tools/call`) must match the body, and `MCP-Protocol-Version` must match the request's `_meta` version; a mismatch is HTTP 400 with HeaderMismatch `-32020`. 2025-era requests don't carry these and aren't checked for them.
- **Origin:** a request with an `Origin` header must come from one of the app's own origins (403 otherwise), which guards against DNS rebinding. Server-side AI clients send no `Origin`.
- **Annotations:** every tool carries `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true` and `openWorldHint: false`.
- **Not used:** sampling, elicitation, roots and logging. They are deprecated or irrelevant; the server makes no LLM calls.
- **Discovery:** no `/.well-known/mcp.json` manifest, which is not part of the standard. Clients find us through the server URL plus OAuth metadata (§5.1). If server cards are standardized later, add one.
- **Implementation (as built):** the official TypeScript SDK v2, `@modelcontextprotocol/server` (2.4, `createMcpHandler` with `legacy: 'stateless'`), which implements 2026-07-28 and serves 2025-era clients. The v1 package `@modelcontextprotocol/sdk` does not speak 2026-07-28 and is not used. Tool schemas are plain JSON Schema (`fromJsonSchema`). Our Express route adds the Origin check, MCP-only auth, rate limits and READ ONLY handlers, then hands the request to the SDK.

---

## 5. Authentication

Hosted AI apps (Claude, ChatGPT) connect remote MCP servers through **OAuth**, so a pasted token isn't enough for the consumer feature. Developer clients (Claude Code, Cursor, local models) can use a personal token. Both result in the same thing: a hashed, revocable, read-only credential bound to one user.

### 5.1 OAuth 2.1 (hosted AI apps) — part 2

The API is both the **resource server** and the **authorization server**, and it reuses PRD-006 sessions and 2FA.

- **Protected Resource Metadata** (RFC 9728) at `GET /.well-known/oauth-protected-resource`. A `401` from `/mcp` carries a `WWW-Authenticate` header with `resource_metadata` pointing to it. The metadata's `resource` must exactly match the URL the user enters, and the first listed authorization server is ours (Claude uses only the first).
- **Authorization Server Metadata** (RFC 8414) at `GET /.well-known/oauth-authorization-server`, with `code_challenge_methods_supported: ["S256"]`, `client_id_metadata_document_supported: true`, `"none"` in `token_endpoint_auth_methods_supported` (Claude uses CIMD only with both), and `authorization_response_iss_parameter_supported: true`.
- **Client registration:** **Client ID Metadata Documents**, as the 2026-07-28 revision prefers. Dynamic Client Registration (RFC 7591) is accepted as a fallback for clients that haven't moved (DCR clients must send `application_type`); it is deprecated, but still in the spec.
- **Flow:** authorization code with **PKCE (S256)**. The `resource` parameter (RFC 8707) binds tokens to the `/mcp` URI, and the server checks a token's audience is itself. The `iss` parameter is returned in the authorization response (RFC 9207).
- **Known redirect URIs:** `https://claude.ai/api/mcp/auth_callback`; ChatGPT `https://chatgpt.com/connector_platform_oauth_redirect` (when `iss` is advertised).
- **Consent:** a page on burnoutfantasy.com, served by the web app. It requires an active web session **and a fresh step-up** (PRD-006 §6.2), and shows the client's name, "read-only", and what is shared.
- **Scope:** `burnout.read` (the only scope).
- **Tokens:**
  - Access tokens are opaque and last 1 hour.
  - Refresh tokens last 30 days and rotate on every use. A reused refresh token revokes the whole grant.
  - Only SHA-256 hashes are stored.

### 5.2 Personal tokens (developer clients) — built

- Format: `bl_mcp_` plus 64 hex characters (32 random bytes). Shown once.
- **Stored as SHA-256**, not bcrypt. A 256-bit random token can't be brute-forced, and the server has to find the row *by* hash. bcrypt salts every hash, so v1.0's "query `mcp_tokens` by hash" could not work with it. Session tokens already work this way (PRD-006).
- 90-day TTL with explicit renewal (Q3). At most 5 active per user (409 `MCP_TOKEN_LIMIT`).
- Creating a token requires a web session and a fresh step-up.
- `last_used_at` is shown in account settings, written at most once every 5 minutes.

### 5.3 Revocation and audit

- Users can revoke any token or OAuth connection from account settings.
- Revoking all sessions, changing or resetting the password, or suspending the account also revokes every MCP credential.
- Audit events (`security_audit_log`): `MCP_TOKEN_CREATED`, `MCP_TOKEN_REVOKED` (built); `OAUTH_GRANT_CREATED`, `OAUTH_GRANT_REVOKED`, `OAUTH_REFRESH_REUSE` (part 2).

### 5.4 Credential boundaries

- `/mcp` accepts **only** MCP bearer credentials. Session cookies and session bearer tokens are rejected (401 with `WWW-Authenticate`).
- `/v1/*` **never** accepts MCP credentials.
- An MCP credential cannot create or renew MCP credentials.

---

## 6. Tools (Phase 1a)

All tools read data and change nothing. The rules apply to every tool:

- **NIL:** players appear as text only (id, name, position, team). No images or likeness URLs, at any layer.
- **Identity:** managers appear by **handle** only. Never email or real name.
- **Pre-lock data:** the field's pre-lock data is never exposed. Another manager's unlocked pick is never readable, and field figures use only locked windows and recorded burns. A manager **may read their own** pending (unlocked) picks (Q4, decided 2026-10-27).
- **Positions:** `QB | RB | FB | WR | TE | K`. FB is eligible at RB and FLEX (decision 2026-10-27).
- **Slots:** `qb, rb1, rb2, wr1, wr2, wr3, te, flex, k`.
- **Season:** the current season (`CURRENT_SEASON`). *As built: a `season` argument for past seasons waits until there is a past season.*
- **Players are people:** another MSF ID for the same person counts as that person (PRD-006 §7.5).

### 6.1 `get_my_pool`

The manager's player universe, partitioned by state (PRD-001):

| State | Meaning |
|-------|---------|
| `available` | Selectable now. Includes `injury_status`. |
| `unavailable` | Out / IR (greyed out, never burned), no game this week, or (this week) the player's game has already started. Carries the reason: `INACTIVE`, `NO_GAME_THIS_WEEK`, `GAME_STARTED`. |
| `locked_pending_final` | Locked, game not Final. Not burned yet. |
| `burned` | Locked and Final. Permanently consumed (`burn_records`), with `burned_week`. |

- **Inputs:** `position?`, `week?` (state as of a past week), and as built `state?` (one list only) and `limit?` (players per list, default 50, maximum 300), because the full universe is several hundred players.
- **Each player:** `player_id`, `name`, `team`, `position`, `bye_week`, `injury_status`, `season_points` (as built: points so far this season). In Phase 1b, also `projected_points` (null until then).
- **Order:** by points so far this season.
- **Summary:** counts for every state (always the full counts), and `elite_remaining` per position. Elite means top 20 at the position. *As built: ranked by points so far this season (`elite_basis` says so), because prior-season totals aren't imported yet; switch to the prior season's totals once they are.*
- **Own lineup:** `my_lineup_this_week` lists the manager's current picks by slot, locked or not, with each pick's window, lock time, and locked / voided flags (Q4).
- **Sources:** `nfl_players`, `pool_entries`, `burn_records`, `season_submissions` (the manager's own rows), `game_windows`, `nfl_games`, `player_game_scores`. The availability logic is the lineup builder's own (`getPool`).

### 6.2 `get_burn_history`

Every burn the manager has recorded.

- **Inputs:** `week?`, `position?`.
- **Each burn:** `player_id`, `name`, `position`, `slot`, `week`, `submitted_at`, `locked_at`, `burned_at`, `points`.
  - `field_start_rate_at_lock`: the share of the field that started the same player in the same week. The field is every manager with a locked pick that week.
    - Shown only when the field meets the floor (§6.5); otherwise `null` with `field_below_minimum: true`.
  - `regret_index`: Phase 1b, null until then. It needs expected value at decision time, which needs projections.
- **Summary:** `total_burns`, `total_points`, `avg_points_per_burn`.
- **Sources:** `burn_records`, `season_submissions`, `player_game_scores`.

### 6.3 `get_pool_standings` (was `get_league_standings`)

The leaderboard of every contest pool the manager has entered, identical to the in-app view (PRD-003).

- **Inputs:** `pool_id?`.
- **Per pool:** `pool_id`, `name`, `week`, `status`, `total_entrants`, and `rows` of [`rank`, `handle`, `total_points`, `week_points`, `is_me`, `rank_change`] (top 100, plus the manager's own row if lower).
  - Also `my_rank` and `my_total_points`.
  - Prize standings honor `scoring_from_week`.
- **Access:** pools the manager has not entered are not readable (an error result). A manager with none gets an empty list.
- **No financial wording while in staging and testing (v1.4, Nath 2026-10-28; PRD-007 §5.8):** no `buy_in` or `free_play` fields, and the tool's description and text summary talk about the season board and "contests", never prizes, money or free play. A test checks every tool description.
- **As built, also `season_field`:** the season field board every signed-in manager sees in the app (PRD-007 §6.5): `field_size`, `my_rank`, `my_total_points` and the top 10 by handle. Free-play testers have no pools, so this is their standings.
- **Sources:** the leaderboard service (`contest_entries`, `user_week_scores`, `leaderboard_snapshots`), run on the handler's read-only connection. Same code path as the app.

### 6.4 `get_field_burn_rates`

The flagship analytics tool: what share of the field has burned each player, by position and week.

- **Inputs:**
  - `scope`: `season` (default; everyone with a season lineup) or `pool` (requires a `pool_id` the manager has entered).
  - `position?`, `week?` (through this week; default the latest week with burns), `top_n?` (default 20, maximum 100).
- **Field (as built):** managers in scope with at least one locked pick through the week; the week's field is those with a locked pick that week.
- **Each player:** `player_id`, `name`, `team`, `position`, `cumulative_burn_rate`, `week_burn_rate`, `i_have_burned`, `i_have_available`. Most burned first.
- **Also returned:**
  - `positional_summary`: `avg_burn_rate` and `most_burned` per position (over players the field has burned).
  - `field_size`: rounded down to the nearest 10.
- **Sources:** `burn_records` and `season_submissions` aggregates, plus the manager's own pool.

### 6.5 Anonymity floor

Aggregates are returned only when the field has at least **50 managers**, matching the existing ownership-analytics rule ("50-lineup minimum threshold"). Below the floor, the tool returns `field_below_minimum: true` and no figures (not even the field size).

- The floor applies **per slice**: the season field and the week's field must each have 50 managers, so a week filter can't narrow a scope below 50.
- Rates are rounded to whole percentages, so small changes can't be traced to one manager's burn.

### 6.6 Phase 1b tools (v1.0 spec kept for reference; under discussion, not committed)

- **`get_burn_volatility_ratings`** (BVR 0–100): ceiling, floor, remaining strength of schedule, usage stability. Computed **server-side with no LLM** (Q1), weekly, possibly cached in `player_bvr_cache`.
- **`get_optimal_burn_path`**:
  - Greedy expected-value search with schedule-weighted lookahead across the remaining season (Q2).
  - `risk_profile` and `locked_slots` inputs.
  - Rationale strings generated by rules, not an LLM.
  - A non-empty `warnings` array is always present.
  - Rate limit 5/min.
  - **Requires attorney review before release** (§10).

---

## 7. Rate Limits

Redis-backed, per credential (the same limiter as PRD-006):

| Tool | Limit |
|------|-------|
| `get_my_pool`, `get_burn_history` | 60/min |
| `get_pool_standings`, `get_field_burn_rates` | 30/min |
| `get_burn_volatility_ratings` (1b) | 30/min |
| `get_optimal_burn_path` (1b) | 5/min |
| All tools, per user (across credentials) | 120/min |
| OAuth `token` endpoint, per client | 30/min |

Over the limit: HTTP `429` with `Retry-After: 60`, plus a JSON-RPC error (`-32000`) carrying `data.retryAfterSeconds`. Only `tools/call` counts; listing and discovery don't (the API's per-IP limit still applies).

---

## 8. Routes

```
POST   /mcp                                     MCP (JSON-RPC 2.0, Streamable HTTP)          built
GET    /.well-known/oauth-protected-resource    RFC 9728                                     part 2
GET    /.well-known/oauth-authorization-server  RFC 8414                                     part 2
GET    /oauth/authorize                         → web consent page (session + step-up)       part 2
POST   /oauth/token                             code + PKCE exchange, refresh rotation       part 2
POST   /oauth/revoke                            RFC 7009                                     part 2
POST   /oauth/register                          DCR fallback (deprecated in spec)            part 2
GET    /v1/me/mcp                               list tokens (and OAuth connections, part 2)  built
POST   /v1/me/mcp/tokens                        create personal token (session + step-up)    built
DELETE /v1/me/mcp/tokens/:id                    revoke token                                 built
DELETE /v1/me/mcp/connections/:id               revoke OAuth grant                           part 2
```

The `/v1/me/mcp` routes follow PRD-006 conventions: cookie or session-bearer auth, CSRF header on unsafe methods, and step-up where noted.

**Web (as built):** Account → Connections → **AI connector** (`/account/connector`): what it is and that it's read-only; the server address with copy; how to add it (remote HTTP MCP server, `Authorization: Bearer` header); make a token (name optional, fresh code first, shown once with copy); the list with last used and expiry, and revoke. It notes that sign-in from the Claude and ChatGPT apps comes with part 2.

---

## 9. Database

New tables, through Prisma migrations with raw-SQL guards as in PRD-004/006:

- `mcp_credentials` (**built**, migration `20261107000000_mcp`): id, user_id (cascade), kind (`personal` | `oauth_access` | `oauth_refresh`), grant_id (null exactly for personal), token_hash (unique, SHA-256, checked hex), label, scope (`burnout.read` only), expires_at, last_used_at, created_at, revoked_at; partial index on active rows per user.
- `oauth_grants`: id, user_id, client_id, client_name, scope, resource, created_at, revoked_at. (part 2)
- `oauth_clients`: cached Client ID Metadata Documents and DCR registrations (client_id, metadata json, fetched_at). (part 2)
- `oauth_auth_codes`: code_hash, grant data, PKCE challenge, expires_at (60 s), used_at. (part 2)

**Read-only by construction.** Tool handlers run in a `READ ONLY` transaction (`SET TRANSACTION READ ONLY`) on the shared pool, so any write fails at the database. The append-only guarantees (`burn_records` write-once and the rest) are untouched. The one write on the MCP path, `last_used_at`, happens in the auth step outside the handler transaction and is throttled to once per 5 minutes per credential.

No existing table changes.

---

## 10. Compliance and attorney items

1. **Pick recommendations:** `get_optimal_burn_path` has the platform recommending specific players in paid contests. This needs review for DFS-classification and contest-integrity implications before Phase 1b ships. Recommendations must be identical for every user in the same pool state; no tier gets better advice.
2. **§2.4 posture:** the wording on downstream use of analytics, for the ToS.
3. **AI-use disclosure:** a ToS clause that AI assistance is permitted, that MCP output is informational, and that the user alone submits lineups.
4. **Data handling:** tool outputs are not logged, only method, tool name, credential id, status, latency and result size. No email or real name in any output.

---

## 11. Acceptance Criteria (Phase 1a)

- [ ] A hosted client completes the OAuth flow (CIMD client, PKCE, `resource`-bound token) and lists and calls all four tools. *(part 2)*
- [x] A personal token works from a developer client. Expired and revoked credentials return `401` with `WWW-Authenticate`.
- [x] Both 2026-07-28 (`server/discover`, no handshake) and 2025-11-25 (`initialize`) clients work, statelessly.
- [x] A mismatch between the `Mcp-Method`/`Mcp-Name` headers and the body returns the HeaderMismatch error.
- [x] Session cookies and session tokens are rejected on `/mcp`, MCP credentials are rejected on `/v1/*`, and an MCP credential cannot create credentials.
- [x] Revoking all sessions, changing the password or suspending the account revokes all MCP credentials. *(A reused refresh token revoking its grant: part 2.)*
- [x] No tool returns another manager's individual data, and no tool returns field data before lock.
- [x] `get_field_burn_rates` returns nothing below a 50-manager field, including after position and week filters.
- [x] A test proves a handler cannot write: the transaction is READ ONLY, and an attempted write fails.
- [x] No output contains image URLs, emails or real names (NIL/PII scan in tests).
- [x] Rate limits are enforced per credential and per user, with `Retry-After`.
- [x] Consent and token creation require a fresh step-up. *(Token creation built; consent with part 2.)*

---

## 12. Open Questions

| # | Question | Recommendation |
|---|----------|----------------|
| Q1 | BVR computed server-side or by a model? | Server-side, no LLM in the data path. |
| Q2 | Burn-path lookahead | Full remaining season, greedy, schedule-weighted EV. |
| Q3 | Token expiry UX | Explicit renewal, with an email reminder 14 days before expiry. OAuth refresh handles hosted clients automatically. *(The reminder email isn't built yet.)* |
| Q4 | ~~Own pending picks via MCP?~~ | **Decided 2026-10-27: yes, own picks only.** The field's pre-lock data stays hidden. |
| Q5 | ~~Step-up for consent and token creation?~~ | **Decided 2026-10-27: yes.** |
| Q6 | ~~Anonymity floor~~ | **Decided 2026-10-27: 50 managers per slice.** |
| Q7 | Attorney sign-off on recommendations (§10.1) | Required before Phase 1b. |
| Q8 | Phase 1b shape: BVR and burn path as specified, or another shape? | Under discussion (2026-10-27). |

---

## 13. Sequencing and dependencies

1. Railway deploy. Done.
2. **Schedule import** (`game_windows` from the MSF season schedule). Done.
3. Web app, through the lineup flow. Done.
4. **PRD-011 Phase 1a.** Part 1 built 2026-10-28; part 2 (OAuth, consent page) next.
5. Projections decision (PRD-006 Q3) and attorney review, then **Phase 1b**.

Depends on: PRD-001 (burn state), PRD-003 (standings), PRD-006 (sessions, step-up, rate limiter, audit), PRD-007 (Account pages).

---

## Change log

| Version | Date | Changes |
|---------|------|---------|
| 1.4 | 2026-10-28 | `get_pool_standings`: `buy_in` and `free_play` removed and the description reworded, so the connector says nothing financial while in staging and testing (PRD-007 §5.8). |
| 1.3 | 2026-10-28 | Phase 1a part 1 built: `/mcp` on the official SDK v2 (2026-07-28 plus stateless 2025-11-25), Origin check, MCP-only bearer auth, READ ONLY handlers, rate limits; personal tokens (`mcp_credentials`, create with step-up, list, revoke, audit, revoked by password change / sign out everywhere / suspension); the four tools; Account → AI connector page. Protocol details verified against the 2026-07-28 spec. As-built notes: `state`/`limit` inputs and `season_points` in `get_my_pool`; `elite_remaining` ranked on this season's points until prior-season totals are imported; `season_field` in `get_pool_standings`; floor applies to the season and the week slice. OAuth (§5.1) moves to part 2 with the hosted-client requirements recorded. Added to the repo. |
| 1.2 | 2026-10-27 | Nath's decisions: Phase 1a (four read tools) approved. Q4 yes (own pending picks; `my_lineup_this_week` added to `get_my_pool`), Q5 yes (step-up), Q6 yes (50-manager floor). Phase 1b under discussion, not committed (Q8). |
| 1.1 | 2026-10-27 | Build-thread revision:<br>• **Protocol:** aligned to MCP 2026-07-28 (stateless Streamable HTTP, `server/discover`, required headers, `resultType`), with 2025-11-25 compatibility. Dropped the non-standard `/.well-known/mcp.json` and the custom `{tool, params}` body.<br>• **Auth:** resolved the OAuth vs. bearer contradiction with both (OAuth 2.1 + CIMD for hosted apps; personal tokens for developer clients). Token hashing changed from bcrypt to SHA-256 (bcrypt can't be looked up by hash).<br>• **Data:** mapped to the real tables (`season_submissions`, `contest_entries`, leaderboard service); added FB and the real slot names. "League" became contest pool / season field, since the burn pool is per user per season. The cross-league flag was replaced by a 50-manager anonymity floor per slice.<br>• **Scope:** split into 1a (four tools) and 1b (BVR and burn path, no stubs).<br>• **Safety:** added READ ONLY transactions, credential boundaries, attorney items, Q4–Q7 and sequencing. |
| 1.0 | 2026-10-27 | First draft (Overlord thread). |

*End of PRD-011*
