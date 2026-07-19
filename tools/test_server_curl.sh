#!/bin/bash
# tools/test_server_curl.sh
#
# Tests the full Volume 1 loop using only curl — no Postman, no client needed.
# Run this AFTER `docker compose up -d` and after applying migrations.
#
# Usage: ./tools/test_server_curl.sh

set -e

BASE_URL="http://127.0.0.1:7350"
SERVER_KEY="defaultkey"
DEVICE_ID="test-device-$(date +%s)"   # unique each run, so you always get a fresh player

echo "=============================================="
echo "STEP 1: Authenticate (creates a new guest player)"
echo "=============================================="
echo "Device ID being used: $DEVICE_ID"
echo ""

AUTH_RESPONSE=$(curl -s "$BASE_URL/v2/account/authenticate/device?create=true" \
  -u "$SERVER_KEY:" \
  -H "Content-Type: application/json" \
  -d "{\"id\": \"$DEVICE_ID\"}")

echo "Server replied:"
echo "$AUTH_RESPONSE"
echo ""

# Extract the token without needing jq — plain grep/sed, works everywhere.
TOKEN=$(echo "$AUTH_RESPONSE" | grep -o '"token":"[^"]*"' | sed 's/"token":"//;s/"//')

if [ -z "$TOKEN" ]; then
  echo "FAILED to get a token. Is the server running? (docker compose up -d)"
  exit 1
fi

echo "Got session token (first 20 chars): ${TOKEN:0:20}..."
echo ""

echo "=============================================="
echo "STEP 2: Call get_full_state (should show starter resources, no buildings)"
echo "=============================================="

curl -s "$BASE_URL/v2/rpc/get_full_state?unwrap" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
echo ""
echo ""

echo "=============================================="
echo "STEP 3: Call upgrade_building (gold_factory at slot 1_1)"
echo "=============================================="

curl -s "$BASE_URL/v2/rpc/upgrade_building?unwrap" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"buildingId": "gold_factory", "slot": "1_1"}'
echo ""
echo ""

echo "=============================================="
echo "STEP 4: Call upgrade_building AGAIN immediately (should fail: already_upgrading)"
echo "=============================================="

curl -s "$BASE_URL/v2/rpc/upgrade_building?unwrap" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"buildingId": "gold_factory", "slot": "1_1"}'
echo ""
echo ""

echo "=============================================="
echo "STEP 5: Waiting 31 seconds (seed data's level-1 upgrade time)..."
echo "=============================================="
sleep 31

echo "=============================================="
echo "STEP 6: Call get_full_state again (building should now show level 1, upgradeFinishTick null)"
echo "=============================================="

curl -s "$BASE_URL/v2/rpc/get_full_state?unwrap" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
echo ""
echo ""

echo "Done with Volume 1 checks. If Step 6 shows \"level\":1 and \"upgradeFinishTick\":null for gold_factory, Volume 1 works."
echo ""
echo ""
echo "=============================================="
echo "STEP 7 (Volume 2): Upgrade Crystal Factory (slot 2_1) — should fail,"
echo "castle level too low (unlocks at castle level 3, we're at level 1)"
echo "=============================================="

curl -s "$BASE_URL/v2/rpc/upgrade_building?unwrap" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"buildingId": "crystal_factory", "slot": "2_1"}'
echo ""
echo "(Expected: \"castle_level_too_low\" — this is CORRECT behavior, not a bug)"
echo ""

echo "=============================================="
echo "STEP 8 (Volume 2): Try building gold_factory at the WRONG slot (2_1,"
echo "which belongs to crystal_factory) — should fail: invalid_slot_for_building"
echo "=============================================="

curl -s "$BASE_URL/v2/rpc/upgrade_building?unwrap" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"buildingId": "gold_factory", "slot": "2_1"}'
echo ""
echo "(Expected: \"invalid_slot_for_building\" — this is CORRECT, proves slot-binding works)"
echo ""

echo "=============================================="
echo "STEP 9 (Volume 2): Upgrade Castle from level 1 to level 2 (slot 4_4)"
echo "=============================================="

curl -s "$BASE_URL/v2/rpc/upgrade_building?unwrap" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"buildingId": "castle", "slot": "4_4"}'
echo ""
echo "(Expected: ok:true — costs 300 gold, affordable with starting 500 gold)"
echo ""

echo "=============================================="
echo "STEP 10 (Volume 2): Check get_full_state — castleLevel should now be"
echo "reflected as \"upgrading to 2\" (upgradeFinishTick set on the castle entry)"
echo "=============================================="

curl -s "$BASE_URL/v2/rpc/get_full_state?unwrap" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
echo ""
echo ""
echo "Done. Castle upgrade to level 2 takes 300s per seed data — wait and"
echo "call get_full_state again if you want to see castleLevel actually hit 2."
