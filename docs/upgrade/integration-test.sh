#!/bin/bash
# TMO Integration Test — Phase 11 final (rebuild edition)
# Tests all upgrade DoD across Phases 0-10. Run: bash integration-test.sh
# NOTE: /api/workspace trả {ok, data:{active:...}}; /api/openclaw/tools = 11-tool registry;
#       /api/tools = 79-tool catalog (nơi 'shell' nằm).
TOKEN=$(grep TMO_API_TOKEN /home/z/tmo-app/.env | cut -d= -f2)
BASE=http://localhost:3000
PASS=0; FAIL=0

cleanup() {
  curl -s -X POST $BASE/api/opencode/preview/stop -H "Content-Type: application/json" -H "x-tmo-api-token: $TOKEN" -d '{"root":"/tmp/test-phase3b"}' > /dev/null 2>&1
  rm -rf /tmp/test-integ11 /tmp/integ11-rename.txt /tmp/integ-stream*.txt 2>/dev/null
}
trap cleanup EXIT

check() {
  local desc="$1"; local actual="$2"; local expected="$3"
  if echo "$actual" | grep -q "$expected"; then
    echo "[PASS] $desc"; PASS=$((PASS+1))
  else
    echo "[FAIL] $desc — expected '$expected', got: $(echo "$actual" | head -c 150)"; FAIL=$((FAIL+1))
  fi
}

echo "=== TMO INTEGRATION TEST (Phase 11) ==="

# 1-2: Auth
check "1. Auth: no token → 401" "$(curl -s -o /dev/null -w "%{http_code}" -X POST $BASE/api/opencode/execute -H 'Content-Type: application/json' -d '{"command":"echo x"}' --max-time 10)" "401"
check "2. Auth: with token → not 401" "$(curl -s -o /dev/null -w "%{http_code}" -X POST $BASE/api/opencode/execute -H 'Content-Type: application/json' -H "x-tmo-api-token: $TOKEN" -d '{"command":"echo x"}' --max-time 15)" "200"

# 3: Workspace active
WS=$(curl -s $BASE/api/workspace -H "x-tmo-api-token: $TOKEN" --max-time 10 | python3 -c "import json,sys; print(json.load(sys.stdin).get('data',{}).get('active',{}).get('rootPath',''))" 2>/dev/null)
check "3. Workspace active rootPath non-empty" "$WS" "/"

# 4-6: Preview
PSTART=$(curl -s -X POST $BASE/api/opencode/preview/start -H 'Content-Type: application/json' -H "x-tmo-api-token: $TOKEN" -d '{"root":"/tmp/test-phase3b"}' --max-time 30)
PORT=$(echo "$PSTART" | python3 -c "import json,sys; print(json.load(sys.stdin).get('port',0))" 2>/dev/null)
PORTOK=$(python3 -c "print('PORT_OK' if $PORT >= 3005 else 'PORT_FAIL')" 2>/dev/null)
check "4. Preview start port >= 3005" "$PORTOK" "PORT_OK"
sleep 3
check "5. Preview HTTP serves on port" "$(curl -s http://127.0.0.1:3005/ --max-time 10 | head -c 300)" "Phase 3 Preview Test"
check "6. Preview stop" "$(curl -s -X POST $BASE/api/opencode/preview/stop -H 'Content-Type: application/json' -H "x-tmo-api-token: $TOKEN" -d '{"root":"/tmp/test-phase3b"}' --max-time 10)" '"ok"'

# 7-9: Terminal
SID=$(curl -s -X POST $BASE/api/opencode/terminal/start -H 'Content-Type: application/json' -H "x-tmo-api-token: $TOKEN" -d '{"cwd":"/tmp"}' --max-time 15 | python3 -c "import json,sys; print(json.load(sys.stdin).get('sessionId',''))" 2>/dev/null)
SIDOK=$(python3 -c "print('SID_OK' if len('$SID') > 10 else 'SID_FAIL')" 2>/dev/null)
check "7. Terminal session create" "$SIDOK" "SID_OK"
(timeout 8 curl -s -N "$BASE/api/opencode/terminal/stream?sessionId=$SID" -H "x-tmo-api-token: $TOKEN" > /tmp/integ-stream.txt 2>&1 &
sleep 1
curl -s -X POST $BASE/api/opencode/terminal/input -H 'Content-Type: application/json' -H "x-tmo-api-token: $TOKEN" -d "{\"sessionId\":\"$SID\",\"data\":\"echo integ_test_11\\n\"}" > /dev/null --max-time 10
sleep 3)
check "8. Terminal input → SSE output" "$(grep -o 'integ_test_11' /tmp/integ-stream.txt | head -1)" "integ_test_11"
check "9. Terminal stop" "$(curl -s -X POST $BASE/api/opencode/terminal/stop -H 'Content-Type: application/json' -H "x-tmo-api-token: $TOKEN" -d "{\"sessionId\":\"$SID\"}" --max-time 10)" '"ok"'

# 10-12: AI tools
SHELLOK=$(curl -s $BASE/api/tools -H "x-tmo-api-token: $TOKEN" --max-time 15 | python3 -c "
import json,sys
d=json.load(sys.stdin); names=[]
def walk(o):
    if isinstance(o,dict):
        if isinstance(o.get('name'),str): names.append(o['name'])
        [walk(v) for v in o.values()]
    elif isinstance(o,list): [walk(v) for v in o]
walk(d); print('SHELL_OK' if 'shell' in names else 'SHELL_MISSING')" 2>/dev/null)
check "10. shell tool registered (/api/tools)" "$SHELLOK" "SHELL_OK"
TOOLOK=$(curl -s $BASE/api/openclaw/tools -H "x-tmo-api-token: $TOKEN" --max-time 15 | python3 -c "
import json,sys
d=json.load(sys.stdin); names=[]
def walk(o):
    if isinstance(o,dict):
        if isinstance(o.get('name'),str): names.append(o['name'])
        [walk(v) for v in o.values()]
    elif isinstance(o,list): [walk(v) for v in o]
walk(d); print('TOOL_OK' if 'start_preview' in names and 'stop_preview' in names else 'TOOL_MISSING')" 2>/dev/null)
check "11-12. start_preview + stop_preview tools" "$TOOLOK" "TOOL_OK"

# 13: Files diff
rm -rf /tmp/test-integ11 && mkdir -p /tmp/test-integ11 && cd /tmp/test-integ11 && git init -q
echo "line1" > test.txt && git add . && git -c user.email=t@t -c user.name=t commit -qm init
printf 'line1\nline2 added\nline3\n' > test.txt
DIFFOK=$(curl -s "$BASE/api/opencode/files/diff?path=test.txt&root=/tmp/test-integ11" -H "x-tmo-api-token: $TOKEN" --max-time 15 | python3 -c "import json,sys; d=json.load(sys.stdin); print('DIFF_OK' if d.get('ok') and len((d.get('diff') or {}).get('hunks') or [])>=1 else 'DIFF_FAIL')" 2>/dev/null)
check "13. Git diff hunks" "$DIFFOK" "DIFF_OK"

# 14: Rename + delete
echo "rb" > /tmp/integ11-rename.txt
check "14a. Rename file" "$(curl -s -X POST $BASE/api/opencode/files/rename -H 'Content-Type: application/json' -H "x-tmo-api-token: $TOKEN" -d '{"oldPath":"/tmp/integ11-rename.txt","newPath":"/tmp/integ11-renamed.txt"}' --max-time 10)" '"ok"'
check "14b. Delete file" "$(curl -s -X POST $BASE/api/opencode/files/delete -H 'Content-Type: application/json' -H "x-tmo-api-token: $TOKEN" -d '{"path":"/tmp/integ11-renamed.txt"}' --max-time 10)" '"ok"'

# 15: Search
SEARCHN=$(curl -s -X POST $BASE/api/opencode/search -H 'Content-Type: application/json' -H "x-tmo-api-token: $TOKEN" -d '{"query":"test-phase3b","root":"/tmp/test-phase3b"}' --max-time 20 | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('results') or []))" 2>/dev/null)
SEARCHOK=$(python3 -c "print('SEARCH_OK' if $SEARCHN >= 1 else 'SEARCH_FAIL')" 2>/dev/null)
check "15. Search across files (rg)" "$SEARCHOK" "SEARCH_OK"

# 16-17: CORS
CORSEVIL=$(curl -s -D - -o /dev/null http://localhost:18790/health -H "Origin: http://evil.example.com" -H "X-TMO-API-Token: $TOKEN" --max-time 10 | grep -ci 'access-control-allow-origin')
if [ "$CORSEVIL" = "0" ]; then echo "[PASS] 16. CORS blocked (fake origin)"; PASS=$((PASS+1)); else echo "[FAIL] 16. CORS leaked"; FAIL=$((FAIL+1)); fi
check "17. CORS allowed origin" "$(curl -s -D - -o /dev/null http://localhost:18790/health -H "Origin: http://localhost:3000" -H "X-TMO-API-Token: $TOKEN" --max-time 10 | grep -i 'access-control-allow-origin' | head -1)" "http://localhost:3000"

# 18: Dangerous command
DANG=$(curl -s -X POST $BASE/api/opencode/execute -H 'Content-Type: application/json' -H "x-tmo-api-token: $TOKEN" -d '{"command":"rm -rf /home"}' --max-time 10)
check "18. Dangerous command blocked" "$DANG" "Blocked"

# 19-20: Health + homepage
check "19. Health endpoint" "$(curl -s $BASE/api/health --max-time 30 | head -c 100)" '"status"'
check "20. Homepage 200" "$(curl -s -o /dev/null -w "%{http_code}" $BASE/ --max-time 30)" "200"

echo ""
echo "=== Integration Test Summary ==="
echo "PASS: $PASS / FAIL: $FAIL"
[ "$FAIL" = "0" ] && echo "ALL GREEN" || exit 1
