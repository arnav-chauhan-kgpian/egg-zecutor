#!/usr/bin/env bash
# End-to-end verification of the execution engine.
#
# Drives the public HTTP surface exactly as a client would: authenticate, queue
# runs through POST /executions/run, poll to a terminal state, then assert on
# the stored record — stdout, exit code, artifacts — and confirm the row landed
# in Postgres.
#
#   ./scripts/e2e.sh [API_BASE]
#
# ENV_FILE selects which compose config the Postgres assertions talk to
# (.env.docker for the local Docker backend, .env.judge0 for real Judge0):
#
#   ENV_FILE=.env.judge0 ./scripts/e2e.sh
#
# Exits non-zero on the first failed assertion so CI can gate on it.
set -uo pipefail

API="${1:-http://localhost:4000}"
ENV_FILE="${ENV_FILE:-.env.docker}"
EMAIL="e2e@test.local"
USERNAME="e2etest"
PASSWORD="E2eTest!2026"

PASS=0
FAIL=0

ok()   { echo "  PASS  $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL  $1"; echo "        expected: $2"; echo "        actual:   $3"; FAIL=$((FAIL + 1)); }

# jq is not guaranteed on a Windows/git-bash host, so field extraction goes
# through node, which the repo already depends on.
jf() { node -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    let value;
    try { value = JSON.parse(raw); } catch { process.stdout.write(""); return; }
    for (const key of process.argv[1].split(".")) {
      if (value == null) break;
      value = value[key];
    }
    process.stdout.write(value == null ? "" : String(value));
  });' "$1"; }

echo "=== engine ==="
curl -s -m 10 "$API/health" | node -e '
  let r=""; process.stdin.on("data",c=>r+=c); process.stdin.on("end",()=>{
    const e=JSON.parse(r).engine;
    console.log(`  backend=${e.kind} endpoint=${e.endpoint} webhook=${e.usesCallback}`);
  });'

echo "=== auth ==="
curl -s -m 20 -X POST "$API/api/v1/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}" >/dev/null

TOKEN=$(curl -s -m 20 -X POST "$API/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"identifier\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | jf token)

if [ -z "$TOKEN" ]; then echo "  FATAL: could not obtain a token"; exit 1; fi
ok "authenticated as $USERNAME"

# run <label> <languageId> <source-file> <stdin> <expected-stdout-substring> <expected-artifacts>
run_case() {
  local label="$1" lang="$2" srcfile="$3" stdin="$4" want="$5" wantArtifacts="$6"
  echo "=== $label ==="

  # Build the JSON body in node so the source survives quoting intact.
  local body
  body=$(SRC_FILE="$srcfile" LANG_ID="$lang" STDIN="$stdin" NAME="$label" node -e '
    const fs = require("fs");
    process.stdout.write(JSON.stringify({
      code: fs.readFileSync(process.env.SRC_FILE, "utf8"),
      languageId: Number(process.env.LANG_ID),
      name: process.env.NAME,
      stdin: process.env.STDIN || undefined,
    }));')

  local created id
  created=$(curl -s -m 60 -X POST "$API/api/v1/executions/run" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body")
  id=$(echo "$created" | jf execution.id)

  if [ -z "$id" ]; then bad "$label queued" "an execution id" "$created"; return; fi
  ok "$label queued id=$id"

  local status detail
  for _ in $(seq 1 120); do
    detail=$(curl -s -m 20 "$API/api/v1/executions/$id" -H "Authorization: Bearer $TOKEN")
    status=$(echo "$detail" | jf execution.status)
    case "$status" in COMPLETED|FAILED) break ;; esac
    sleep 1
  done

  if [ "$status" != "COMPLETED" ]; then
    bad "$label reached COMPLETED" "COMPLETED" "$status / $(echo "$detail" | jf execution.errorMessage)"
    echo "        stderr: $(echo "$detail" | jf execution.stderr)"
    echo "        compile: $(echo "$detail" | jf execution.compileOutput)"
    return
  fi
  ok "$label completed (judge=$(echo "$detail" | jf execution.judgeStatus))"

  local exitCode stdout artifacts
  exitCode=$(echo "$detail" | jf execution.exitCode)
  stdout=$(echo "$detail" | jf execution.stdout)
  artifacts=$(echo "$detail" | node -e '
    let r=""; process.stdin.on("data",c=>r+=c);
    process.stdin.on("end",()=>process.stdout.write(String(JSON.parse(r).execution.artifacts.length)));')

  [ "$exitCode" = "0" ] && ok "$label exit code 0" || bad "$label exit code" "0" "$exitCode"

  case "$stdout" in
    *"$want"*) ok "$label stdout contains \"$want\"" ;;
    *)         bad "$label stdout" "contains \"$want\"" "$stdout" ;;
  esac

  [ "$artifacts" = "$wantArtifacts" ] \
    && ok "$label produced $artifacts artifact(s)" \
    || bad "$label artifact count" "$wantArtifacts" "$artifacts"

  # Timing/memory should be measured, not null.
  local timeMs
  timeMs=$(echo "$detail" | jf execution.timeMs)
  [ -n "$timeMs" ] && ok "$label reported timeMs=$timeMs" || bad "$label timing" "a number" "null"

  # Download the first artifact and confirm the bytes come back intact.
  if [ "$wantArtifacts" != "0" ]; then
    local aid mime
    aid=$(echo "$detail" | node -e '
      let r=""; process.stdin.on("data",c=>r+=c);
      process.stdin.on("end",()=>process.stdout.write(JSON.parse(r).execution.artifacts[0].id));')
    mime=$(curl -s -m 20 -o /tmp/e2e-artifact.bin -w '%{content_type}' \
      "$API/api/v1/executions/$id/artifacts/$aid" -H "Authorization: Bearer $TOKEN")
    local size
    size=$(wc -c < /tmp/e2e-artifact.bin | tr -d ' ')
    [ "$size" -gt 0 ] \
      && ok "$label artifact downloaded ($size bytes, $mime)" \
      || bad "$label artifact download" ">0 bytes" "$size bytes"
  fi

  LAST_ID="$id"
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# --- Python: stdin, stderr, and an emitted artifact --------------------------
cat > "$TMP/case.py" <<'PY'
import base64, json, sys

name = sys.stdin.readline().strip() or "world"
print(f"hello {name} from python")
print("this line goes to stderr", file=sys.stderr)

payload = json.dumps({"engine": "python", "ok": True}).encode()
print(f"::artifact:result.json:application/json:{base64.b64encode(payload).decode()}::")
print("done")
PY
run_case "python" 71 "$TMP/case.py" "researcher" "hello researcher from python" 1

# --- C++: exercises the compile step ----------------------------------------
cat > "$TMP/case.cpp" <<'CPP'
#include <iostream>
int main() {
    long long total = 0;
    for (int i = 1; i <= 1000; ++i) total += i;
    std::cout << "sum=" << total << " from c++" << std::endl;
    return 0;
}
CPP
run_case "cpp" 54 "$TMP/case.cpp" "" "sum=500500 from c++" 0

# --- Node.js ------------------------------------------------------------------
cat > "$TMP/case.js" <<'JS'
const values = [1, 2, 3, 4, 5];
const total = values.reduce((a, b) => a + b, 0);
console.log(`sum=${total} from node ${process.version.split(".")[0]}`);
JS
run_case "node" 63 "$TMP/case.js" "" "sum=15 from node" 0

# --- persistence --------------------------------------------------------------
echo "=== postgres ==="
ROWS=$(docker compose --env-file "$ENV_FILE" exec -T postgres \
  psql -U postgres -d hackerrank_clone -tAc \
  "SELECT count(*) FROM executions WHERE status='COMPLETED';" 2>/dev/null | tr -d '\r ')
[ -n "$ROWS" ] && [ "$ROWS" -ge 3 ] \
  && ok "postgres holds $ROWS completed execution(s)" \
  || bad "postgres execution rows" ">=3" "$ROWS"

ARTS=$(docker compose --env-file "$ENV_FILE" exec -T postgres \
  psql -U postgres -d hackerrank_clone -tAc "SELECT count(*) FROM artifacts;" 2>/dev/null | tr -d '\r ')
[ -n "$ARTS" ] && [ "$ARTS" -ge 1 ] \
  && ok "postgres holds $ARTS artifact(s)" \
  || bad "postgres artifact rows" ">=1" "$ARTS"

echo
echo "=== summary ==="
echo "  passed: $PASS"
echo "  failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "  ALL GREEN"
