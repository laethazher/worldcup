# Architecture — Al-Hasani World Cup Challenge 2026

## Stack (matching in-house standards)
- **Backend:** Express.js + better-sqlite3 (WAL, synchronous — perfect at company scale), JWT in httpOnly cookie, SSE for live updates. Zero build step.
- **Frontend:** Vanilla TypeScript → `tsc` → native ES modules. No framework, no bundler. Six pages sharing one component layer (`src/client/*.ts`).
- **Fonts:** IBM Plex Sans Arabic self-hosted (woff2, arabic + latin subsets, immutable cache).

## Data model
`branches · employees · teams · matches · predictions · achievements · audit_logs · notifications(+reads) · rank_snapshots · settings`

Key invariants:
- `predictions UNIQUE(employee_id, match_id)` — upsert until kickoff, immutable after (enforced server-side: kickoff passed **or** status=finished).
- Joker is a flag on the prediction; single consumed joker enforced by query against locked matches; movable while open.
- Champion pick lives on `employees` with its own lock timestamp in `settings`.
- Points are **derived columns** (`points_base/qual/total`, `is_exact/direction`) — `recalcAll()` wipes and replays every finished match, so results are always correctable.

## Scoring engine (`server/scoring.js`)
`(exact 5 | direction 2) + qualification 2` → `× match.multiplier` → `× 2 if joker` → `+10` champion bonus after the final. Tie-breakers: exact count, then earliest first-prediction timestamp. Achievements computed inside the same pass; leaderboard deltas from `rank_snapshots`.

## Bracket propagation
FIFA match numbers 97–104 hard-mapped: winners of 97/98 → 101, 99/100 → 102; 101/102 winners → final 104, losers → bronze 103. Entering a result auto-fills the next round's team slot — employees can predict the semi minutes after the quarter ends.

## Live layer
One SSE endpoint (`/api/stream`, cookie-authenticated). Events: `leaderboard`, `match_result`, `matches_changed`, `notification`, broadcast; `achievement` targeted per employee (triggers gold toast + confetti). 25s keep-alive, client auto-reconnect.

## Security
scrypt + timingSafeEqual · JWT httpOnly SameSite=Lax · login rate-limit 6/min/IP · role middleware · integer/range validation · full audit trail (login, prediction, result, exports, admin ops) with IP · security headers · predictions immutable post-lock.

## Design system
Warm near-black `#0C0A0B`, brand crimson `#A51E2F` (gradients `#C82A3E→#6E1220`), warm gray `#9E8D87`, gold **only** for winners. Glass surfaces (4.5% white + blur 20), radius 22/16/11, Plex Arabic with `tabular-nums` everywhere numbers move. Signature element: the **stadium arc** — a crimson ring cresting behind the login and every hero, echoed by the countdown as the largest type on screen. Motion: staggered page rise, countdown tick, flag wave on hover, animated distribution bars, podium staged reveal (bronze→silver→gold + fireworks), confetti reserved for achievements. `prefers-reduced-motion` respected globally.
