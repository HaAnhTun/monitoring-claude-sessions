# Attention: how the app tells you that a session needs you

When you run several Claude Code sessions, most of the time is spent waiting, and the costly moment is the one you miss: a
session that stopped at a permission prompt twenty minutes ago. The attention center of the web UI watches the sessions and
tells you in a few quiet ways. It only reads what the monitor already knows; it never writes to a transcript and never
touches a process (ADR 0079). The rules are recorded in ADR 0107.

## The three levels

| Level | Meaning | How long it holds |
|---|---|---|
| **Needs you** | The session cannot go on until a person decides or answers: a permission prompt, a question, or a terminal that never linked to the monitor. | As long as the session is blocked. |
| **Failed** | The session or its last turn ended with an error. | Until you have seen it. |
| **Done** | A turn or the whole session finished. | Until you have seen it. |

A session whose turn is over and whose prompt is empty is **Ready for prompt**, not "Needs you": nothing is blocked. A
state the monitor is not sure about (`unknown`, `stale`) never raises a signal.

"Seen" means: you looked at the session (its terminal selected in the Workspace, or its session page open) for one second
on a visible, focused page, or you pressed **Mark as seen** or **Dismiss all**. The browser remembers the last 64 sessions
you have seen.

## The signals

| Signal | What you see | Default |
|---|---|---|
| Tab title | A count in front of the page name: `(2 need you)`, else `(1 failed)`, else `(3 done)`. | on |
| Tab icon | A dot on the icon while a session needs you or failed. "Done" has no dot. | on |
| Announcement | One polite sentence for screen readers ("build-1 needs you"). | always |
| "Needs you" strip | In the Workspace, above the filter of the project column: up to five sessions, the blocked ones first, then "and N more". A row links to the session; a failed or finished row has **Mark as seen**. The strip is not drawn at all while nothing needs you. | always |
| Folder chip | A closed folder that hides such a session shows a word with a count ("Needs you 1") instead of its live count. | always |
| System notification | One notification of the operating system while you are away from the page. | **off** |

Rules that keep the signals trustworthy:

- **Opening the page is silent.** What already failed or finished before you opened the page is old news. A session that
  already needs you is counted at once, but not announced.
- **A signal waits.** A state must hold for 5 seconds (Settings, 0 to 60) before it is announced or counted. A permission
  that is answered inside that time says nothing.
- **The session you are looking at is silent.**
- **Nothing fires twice**, and everything that is due at the same moment is one announcement.

The key **n** in the Workspace selects the next session of the strip and gives its terminal the focus; at the end it starts
again from the top. With an empty strip it says "No session needs you". Inside the terminal the key belongs to the program,
like every other key: leave the terminal first (`Ctrl+Shift+Space`).

## Settings

Settings, Display preferences, card **Attention**. Everything is kept in this browser only; nothing is sent to the server.

- **Count in the tab title**, **Dot on the tab icon**: on by default.
- **System notification while you are away**: off by default. The browser asks for its permission only when you press
  **Allow notifications**. While the browser blocks notifications the checkbox is disabled.
- **Which sessions count**: the terminals started here (default) or every monitored session. One choice for the title,
  the icon and the notification. A task instance has no terminals and always counts every session of its list.
- **Seconds to wait before telling you**: 5 by default.
- **Session titles in the Workspace**: a live session shows its title on its row and in the header of the terminal. The
  default shows only titles somebody or something gave the session (a custom title, an AI title, a rule). "Every title" also
  shows a title taken from the first prompt.

## Privacy

- A system notification holds the application title and one fixed sentence with a count ("A Claude session needs you",
  "3 Claude sessions need you"). It never holds the name, the title or the folder of a session, and never text of a
  transcript, a tool call or the registry. Notifications stay in the notification center of the operating system and can
  show on a lock screen: that is why the text is fixed.
- The tab title gets a count only. Tab titles appear in the task bar, in window switchers and in screen sharing.
- An announcement in the page names the terminal, or the title you allow, or the first 8 characters of the session id. It
  never leaves the page.
- A title taken from a first prompt can hold something private; that is why it is not shown unless you choose "Every title".
- The seen list holds session ids and times, in the storage of this browser.
- There is no sound, and no network request beyond the ones the page already makes to its own loopback server.

## Limits

- **A hidden window may be late.** Browsers slow down the timers of a hidden tab, and Windows treats a fully covered
  window as hidden. A hidden Edge `--app` window may be throttled or frozen. Changes of monitored sessions arrive over the
  open stream; the list of terminals is asked for again every 30 seconds and when the window comes back, so a new terminal
  can show up late in a hidden window.
- **System notifications in an app window are unverified.** `Notification` on `http://127.0.0.1` inside an Edge or Chrome
  `--app` window was not verified on every platform. If no notification shows, the title, the icon and the strip still work.
- **Focus Assist and "Do not disturb" hide toasts.** Windows Focus Assist, macOS Focus and similar modes can keep a
  notification out of sight; it is then only in the notification center.
- A browser tab that was discarded or a browser that was closed tells you nothing. For a script or an agent that has to
  wait for a session, use `caw wait` and `caw events` instead ([watching.md](watching.md)).
- The signals are as good as the state of the monitor. A session without hooks is judged from its transcript and the
  registry; see the state model in [architecture.md](architecture.md).
