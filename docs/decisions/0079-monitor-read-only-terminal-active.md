# 0079 Stance: the monitor stays read-only, the terminal is active

Status: Accepted (CAW, 2026-11-14). Owner: foundation area (fnd), by decision of the repository owner (spec section 1 and Q2). Amends the "read-only, never starts
or stops a session" principle of 0026, 0031 and 0045 for the terminal part only. The Status lines of those ADRs are updated by the documentation package of the program.

## Context
Until now the product was "a local, read-only monitor": it reads transcripts in place, never starts, stops or signals a session, and every route is a read-only
`GET` apart from a body-less ingest nudge (0026, 0031, 0045). The owner decided on 2026-11-14 to merge the terminal-panel product MTOP into this repository as
Claude Agent Workspace (CAW). The terminal part has to start `claude` processes, write keystrokes to them, resize them and kill them. Keeping one sentence that says
"never starts or stops a session" next to that feature would make the documents false and the guards meaningless, so the stance is stated once, narrowly.

## Decision
1. **The monitoring part is unchanged.** Transcript reading, the metadata database, the lifecycle facts, the query layer, the dashboard pages, the CLI read commands,
   the MCP server and the skill stay read-only: they never write to a transcript and never start, stop or signal a process.
2. **The terminal part is active, and only there.** The terminal service starts `claude` processes that the application itself launches (through the one PTY seam of
   0080), writes to their input, resizes them and kills them. It acts only on processes it started and registered; it never signals a process it did not start and
   never touches a session that was started elsewhere. A session started in the terminal is observed by the monitor exactly like any other (read-only).
3. **No other component gains a write power.** The MCP server and the skill never open, write to, resize or kill a terminal: they have no route to the terminal
   service and no tool that names one. The dashboard pages of the monitor do not either.
4. **Every write route needs the access code.** A route that starts, writes to or kills a terminal, and the terminal WebSocket, require the per-start random access
   code (spec Q6) in addition to the `Host` and `Origin` checks, which stay a safeguard and not authentication. A request without the code is refused before any
   handler runs. Authorization of the write surface is enforced in the server; the web UI only hides controls.
5. **Scope and lifetime.** Terminals live in the user-wide instance only and die when the instance stops (spec Q11). The terminal always runs on the loopback
   address; no outbound network code is added.
6. **No new statement of "read-only" may be broader than this ADR.** Documents say "the monitoring is read-only, the terminal is active", not "the application is
   read-only" and not "the application starts sessions".

## Consequences
- `CLAUDE.md` and `docs/architecture.md` are reworded in the same change (the product description, the read-only bullet, the security posture).
- Later packages add the write routes, the access code and the guard tests; each of them cites this ADR for the stance and 0045 for the request checks.
- A reviewer can reject any change that gives the MCP server, the skill or a monitoring page a power over a terminal by pointing at item 3.
- The tests that assert "all routes are `GET`" are narrowed to the monitoring routes by the packages that add the write routes, never loosened further.

## Alternatives rejected
- A second product in a separate repository: the owner wants one application with the monitor's data next to the terminal (state and tokens per session row,
  "resume in terminal").
- Calling the whole product "read-only" and hiding the terminal behind a flag: the terminal is always on (Q2), so the claim would be untrue.
- Letting the MCP server open terminals for the model: a model-driven way to start processes with the user's credentials is out of scope and needs its own decision.

## Evidence
- The owner's decisions of 2026-11-14 (program specification, sections 1 and 3, Q2 and Q6). Design 01 (the terminal service) and design 02 (the server surface and the
  access code) specify the mechanisms; this ADR fixes only the stance they rely on.
