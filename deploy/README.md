# Host hardening for the MAX hub server

The agent sandboxes of the hub run inside the `graphy-hub` container, so everything a user starts there leaves through
the `graphy-net` docker network. Install on the docker host (as root):

```bash
install -m 750 graphy-firewall.sh fw-check.sh /usr/local/sbin/
install -m 644 graphy-firewall.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now graphy-firewall.service
fw-check.sh          # everything the service needs must still work, everything a sandbox must not reach must be closed
```

`graphy-firewall.sh apply|remove|status` only touches its own chains (`GRAPHY-EGRESS`, `GRAPHY-HOSTGUARD`); `remove` restores the previous state.
It blocks, for traffic that starts in `graphy-net`: cloud metadata and link-local (169.254.0.0/16, the VPS user-data), other private
networks (including other docker networks such as VPN containers) and every new connection to the host itself.
The Internet and the sibling services (searxng, stt) stay reachable. `fw-check.sh` assumes sandbox uid 20056 exists
(any uid >= 20000 of an existing user works: edit the number) and the public URL of the site.

Also recommended on the host: `fail2ban` with an `sshd` jail (ignore your own address), SSH keys only
(`PasswordAuthentication no`) once a key is installed, and the hub container started with `--cap-add KILL --pids-limit 512`.

Blocklist: put attacker addresses, one per line, into `/etc/graphy-blocklist` (or set `GRAPHY_BLOCK_IPS`); `graphy-firewall.sh apply` drops all traffic to and from them.
