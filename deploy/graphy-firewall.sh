#!/bin/sh
# Egress policy for the graphy-net docker network.
# Agent sandboxes run inside the hub container, so whatever a user starts there leaves through this network.
# They may use the Internet and the sibling services (searxng, stt), but not:
#   - cloud metadata / link-local (169.254.0.0/16): it serves the VPS cloud-init user-data
#   - the host itself (ssh, caddy admin, anything listening on a host address)
#   - other private networks: the other docker networks (VPN containers) and any LAN
# Own chains only: "remove" restores the previous state exactly.
set -eu
NET=graphy-net
# Addresses that get no traffic in either direction: GRAPHY_BLOCK_IPS and/or one address per line in /etc/graphy-blocklist (kept off the repository on purpose)
BLOCK_IPS="${GRAPHY_BLOCK_IPS:-} $(grep -Eh '^[0-9a-fA-F:.]+(/[0-9]+)?$' /etc/graphy-blocklist 2>/dev/null | tr '\n' ' ')"
SUBNET=$(docker network inspect "$NET" -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}')
[ -n "$SUBNET" ] || { echo "network $NET not found" >&2; exit 1; }

remove() {
  for ip in $BLOCK_IPS; do
    iptables -D INPUT -s "$ip" -j DROP 2>/dev/null || true; iptables -D OUTPUT -d "$ip" -j DROP 2>/dev/null || true
    iptables -D FORWARD -s "$ip" -j DROP 2>/dev/null || true; iptables -D FORWARD -d "$ip" -j DROP 2>/dev/null || true
  done
  iptables -D DOCKER-USER -s "$SUBNET" -j GRAPHY-EGRESS 2>/dev/null || true
  iptables -D INPUT -s "$SUBNET" -j GRAPHY-HOSTGUARD 2>/dev/null || true
  for c in GRAPHY-EGRESS GRAPHY-HOSTGUARD; do iptables -F "$c" 2>/dev/null || true; iptables -X "$c" 2>/dev/null || true; done
}
apply() {
  remove
  iptables -N GRAPHY-EGRESS
  iptables -A GRAPHY-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  iptables -A GRAPHY-EGRESS -d "$SUBNET" -j RETURN                 # siblings in the same network
  for r in 169.254.0.0/16 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10; do
    iptables -A GRAPHY-EGRESS -d "$r" -j DROP
  done
  iptables -A GRAPHY-EGRESS -j RETURN                              # everything else: the Internet
  iptables -I DOCKER-USER 1 -s "$SUBNET" -j GRAPHY-EGRESS

  iptables -N GRAPHY-HOSTGUARD
  iptables -A GRAPHY-HOSTGUARD -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  iptables -A GRAPHY-HOSTGUARD -j DROP                              # new connections from containers to the host: never needed
  iptables -I INPUT 1 -s "$SUBNET" -j GRAPHY-HOSTGUARD
  for ip in $BLOCK_IPS; do
    iptables -I INPUT 1 -s "$ip" -j DROP; iptables -I OUTPUT 1 -d "$ip" -j DROP
    iptables -I FORWARD 1 -s "$ip" -j DROP; iptables -I FORWARD 1 -d "$ip" -j DROP
  done
}
case "${1:-}" in
  apply) apply ;;
  remove) remove ;;
  status) iptables -S DOCKER-USER; iptables -S GRAPHY-EGRESS 2>/dev/null; iptables -S GRAPHY-HOSTGUARD 2>/dev/null; iptables -S INPUT | grep GRAPHY || true ;;
  *) echo "usage: $0 apply|remove|status" >&2; exit 2 ;;
esac
