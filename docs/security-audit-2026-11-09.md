# Security audit, 9 November 2026

Trigger: a MAX user had his AI agent build a SOCKS5 proxy and a reverse tunnel to an external relay, turning the server into an exit
proxy. The audit was done the way an attacker would do it: from inside an agent sandbox (a normal uid inside the hub container),
then on the host.

## Findings and fixes

| # | Finding | Severity | Fix |
|---|---|---|---|
| 1 | Sandboxes could reach **cloud metadata** (`169.254.169.254`), which serves the VPS cloud-init **user-data** (26 KB provisioning script: it generates the root password at first boot and registers the host with the provider panel; no static password or key in it, `meta_data.json` has no keys) | medium (information about the provider's provisioning, no secret found) | egress firewall (`deploy/graphy-firewall.sh`), verified before and after |
| 2 | Sandboxes could connect to the **host** (ssh, caddy) and to the **other docker networks** (the VPN containers) | high | same firewall (`GRAPHY-HOSTGUARD`, private ranges dropped) |
| 3 | `/data/hub` (hub.json, `llm.log` with learners' texts, anonymous tokens) was readable by every sandbox uid (`755`) | high | data dir `0700`, files `0600`, tightened at start |
| 4 | Processes a user started (nohup, setsid) outlived his agent and kept running | high | all processes of a sandbox uid are killed when the agent stops or is evicted; a watcher kills user processes that hold a listening port longer than 45 s and alerts the admin |
| 5 | Files of one user were readable by the others (`umask 022`, shared `/tmp`) | high | agents start through a wrapper with `umask 077` |
| 6 | No per-user process or file-size limits (fork bomb or disk fill would take the whole container) | medium | `ulimit -u 100 -f 2 GiB -n 2048` per agent, container `--pids-limit 512`, disk watcher with an admin alert at 1000 MB per user |
| 7 | `/data` and `/workspace` were world-writable (`1777`) | medium | `0755` at start |
| 8 | `X-Forwarded-For` was believed from any private address, so a sandbox could fake its IP and dodge per-IP limits | medium | only the docker bridge gateway (the real reverse proxy) is trusted |
| 9 | The hub container could not kill agents (no `CAP_KILL`): evicted agents stayed alive and held ports ("Address already in use") | high | `--cap-add KILL`, port probing, retry |
| 10 | SSH on the Internet with passwords: **7 821 failed logins from 63 addresses in 24 h**, no fail2ban, no firewall | high | fail2ban (`sshd` jail, 4 tries, 6 h ban, your address never banned), `MaxAuthTries 3`, `LoginGraceTime 20` |
| 11 | Open access (`/open`) lets anyone register | policy | new users get 40 requests a day; limits, blocking, kill switch, alerts |
| 12 | The agent could be talked into abusive work | policy | safety section in the system prompt (stop, refuse, no variants), tool `report_to_admin` (message to the admin in MAX), hosted-mode bash policy that blocks tunnels, proxies, scanners, reverse shells and access to server internals |

## Injection and similar classes

| Class | Result |
|---|---|
| SQL injection | Not applicable: there is no SQL database (the hub keeps JSON files, the agent JSONL sessions). |
| Command injection | The hub starts processes with argument arrays only (no shell with user text). The one place where a user's text reaches a shell is the agent's `bash` tool, which is the intended capability: it runs under the user's own uid, behind the egress firewall, with ulimits, a hosted-mode command policy and a watcher. |
| Path traversal | Identifiers are matched by strict patterns before they touch a path (MAX ids are digits, class codes and assignment ids are fixed-length hex), file names of uploads are stored under generated ids. |
| SSRF | `web_read` refuses loopback, private, link-local (cloud metadata) targets and internal-looking names, also after redirects (unit tests); the egress firewall now blocks the same ranges for everything in the sandbox network. |
| XSS | HTML materials render in `sandbox=""` iframes (no scripts); widgets render in `sandbox="allow-scripts"` without `allow-same-origin`, so they cannot read the app's storage or the session token. |
| Prompt injection | The system prompt marks sources, tool results and in-chat "system" messages as data and puts the safety section first; verified with direct and disguised requests on two models. Not a guarantee: the other layers exist for the case where a model is talked round. |
| Authorization (IDOR) | School endpoints check the class owner or the addressed student on every request (tests); a blocked user gets 403 `blocked` everywhere. |

Not covered: a third-party penetration test, fuzzing of the Rust core, and a review of the Markdown/KaTeX renderer's sanitiser beyond reading its use sites.

## What was checked and found fine

- Service keys are not in the agents' environment (`MAX_BOT_TOKEN`, `GRAPHY_LLM_KEY`, the admin claim are only in the hub process). The agent receives only its own tokens.
- Other users' directories are `0700`; `/data/hub/secret` is root-only; `/proc/<pid>/environ` of other users' processes is not readable.
- No docker socket mount, no privileged hub container. `ubuntu` has its password locked. Caddy's admin API listens on loopback only.
- Session and login tokens are HMAC-signed with a server secret; comparisons are constant-time.
