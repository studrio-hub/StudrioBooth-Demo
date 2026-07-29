# Studio Booth Print Agent

A small local service that runs on the kiosk Raspberry Pi, alongside
Chromium. The kiosk web app is static JS served from GitHub Pages — it has
no way to enumerate printers or send a job without a browser dialog. This
agent gives it one: the browser POSTs a finished, print-ready image to
`http://localhost:8787/print`, and the agent hands it straight to CUPS via
`lp`. No dialog appears at any point during normal kiosk operation.

## How it fits together

```
Chromium (kiosk, loads GitHub Pages)  --fetch()-->  print-agent (localhost:8787)  --lp-->  CUPS  -->  printer
                                                            ^
Admin page "Printer Setup" also opens -----------> http://localhost:631 (CUPS' own web UI) directly
```

Two separate local services, both already provided by a stock Raspberry Pi
OS + CUPS install:
- **This agent** (port 8787) — receives print jobs, has no printer UI of its
  own, just forwards to whichever printer is configured.
- **CUPS' own web interface** (port 631) — the *actual* native OS printer
  settings: add a printer, pick its driver, set default paper size,
  orientation, print quality. Admin's "Open Printer Settings" button just
  opens this directly — we don't reimplement it.

## First-time setup on the Pi

```bash
cd print-agent
sudo ./install.sh
```

This installs CUPS if it's missing, enables the CUPS web UI, installs this
agent as a systemd service (auto-starts on boot, restarts if it crashes),
and starts it.

Then, in a real desktop browser session on the Pi (not the kiosk
Chromium instance):

1. Visit `http://localhost:631/printers` → **Add Printer**, walk through
   driver selection and set the default paper size/orientation/quality
   there. This is the same native config screen you'd get on any desktop
   OS — it's just delivered as a local web page instead of a native window.
2. In the kiosk **Admin** page → *Printer Preferences* → *Printer Setup*,
   pick that printer from the dropdown and hit **Save Printer**. This
   writes `~/.studio-booth-print-agent/config.json` on the Pi so the agent
   knows which printer to use for every job, regardless of what CUPS'
   system default happens to be.
3. Confirm it's alive: `curl http://localhost:8787/health` should return
   `{"ok":true, ...}`.

## Manual run (without systemd, e.g. for testing)

```bash
cd print-agent
node server.js
# or: PORT=9000 node server.js
```

## Why localhost, and why this doesn't break on GitHub Pages HTTPS

The kiosk page is loaded over `https://` from GitHub Pages, and this agent
only serves plain `http://`. Normally a browser blocks an https page from
fetching http resources ("mixed content"), but Chrome carves out an
exception for `localhost`/`127.0.0.1` specifically, treating them as
"potentially trustworthy" — so this works without any TLS setup on the
agent. `server.js` also sends the `Access-Control-Allow-Private-Network`
header so Chrome's newer Private Network Access preflight doesn't block it
either.

This only works because the kiosk browser and the agent run **on the same
Raspberry Pi**. If you ever move the browser to a different machine than
the agent, `AGENT_BASE_URL` in `js/print-alignment.js` needs to point at
that machine's address instead, and you'd need to open the mixed-content/
PNA exceptions manually in Chrome's flags (or serve the agent over TLS).

## Endpoints

| Method | Path        | Purpose                                              |
|--------|-------------|-------------------------------------------------------|
| GET    | `/health`   | `{ ok, agentPrinter, cupsDefault }`                    |
| GET    | `/printers` | `{ printers: [{name,status,isCupsDefault}], configured }` |
| GET    | `/config`   | `{ printer }`                                          |
| POST   | `/config`   | body `{ printer }` — sets the saved target printer     |
| POST   | `/print`    | `?copies=N&printer=NAME` (printer optional), body = raw PNG bytes |

## Uninstall

```bash
sudo systemctl disable --now studio-booth-print-agent.service
sudo rm /etc/systemd/system/studio-booth-print-agent.service
sudo systemctl daemon-reload
rm -rf ~/studio-booth-print-agent ~/.studio-booth-print-agent
```
