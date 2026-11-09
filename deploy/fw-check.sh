#!/bin/sh
# Connectivity checks after the firewall is applied. Exit 0 only when everything the service needs still works
# and everything a sandbox must not reach is closed.
ok=1
probe() { # name host port expected(open|closed)
  r=$(docker exec -u 20056 graphy-hub python3 -c "import socket,sys
s=socket.socket(); s.settimeout(3)
try: s.connect((sys.argv[1],int(sys.argv[2]))); print('open')
except Exception: print('closed')" "$2" "$3" 2>/dev/null)
  [ "$r" = "$4" ] && echo "  ok   $1: $r" || { echo "  FAIL $1: $r (expected $4)"; ok=0; }
}
echo "must stay open:"
probe "internet (1.1.1.1:443)" 1.1.1.1 443 open
probe "hub itself (127.0.0.1:5174)" 127.0.0.1 5174 open
probe "searxng" searxng 8080 open
probe "stt" stt 8000 open
echo "must be closed to sandboxes:"
probe "cloud metadata 169.254.169.254" 169.254.169.254 80 closed
probe "host ssh via gateway" 172.18.0.1 22 closed
probe "host caddy via gateway" 172.18.0.1 8443 closed
probe "VPN docker network 172.17.0.1" 172.17.0.1 22 closed
echo "service paths:"
code=$(docker exec graphy-hub node -e "fetch('https://openrouter.ai/api/v1/models',{signal:AbortSignal.timeout(8000)}).then(r=>console.log(r.status)).catch(()=>console.log(0))" 2>/dev/null)
[ "$code" = "200" ] && echo "  ok   OpenRouter reachable from the hub: $code" || { echo "  FAIL OpenRouter: $code"; ok=0; }
code=$(docker exec graphy-hub node -e "fetch('https://platform-api.max.ru/me',{signal:AbortSignal.timeout(8000)}).then(r=>console.log(r.status)).catch(()=>console.log(0))" 2>/dev/null)
[ "$code" != "0" ] && echo "  ok   MAX API reachable from the hub: HTTP $code" || { echo "  FAIL MAX API: $code"; ok=0; }
code=$(curl -sk -o /dev/null -m 8 -w "%{http_code}" https://78-17-61-24.sslip.io:8443/)
[ "$code" = "200" ] && echo "  ok   public site through caddy: $code" || { echo "  FAIL public site: $code"; ok=0; }
[ $ok = 1 ]
