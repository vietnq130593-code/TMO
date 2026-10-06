#!/bin/bash
cd /home/z/tmo-app
S=$(sqlite3 db/custom.db "SELECT sessionId FROM CodeTeamSession ORDER BY createdAt DESC LIMIT 1;")
echo "WF: $S  [$(date +%H:%M:%S)]"
sqlite3 db/custom.db "SELECT '  state=' || currentStep || ' agent=' || COALESCE(currentAgent,'-') || ' completed=' || completedAgents FROM CodeTeamSession WHERE sessionId='"$S"';"
sqlite3 db/custom.db "SELECT '  done ' || position || '/' || step || ' ' || agentName || ' ' || (duration/1000) || 's toolCallsLen=' || length(toolCalls) FROM CodeTeamWorklog WHERE sessionId='"$S"' ORDER BY createdAt;"
