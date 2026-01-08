#!/bin/bash
# Test the QwickBrain proxy MCP server

echo "Starting proxy server..."
node dist/bin/cli.js serve &
PROXY_PID=$!
sleep 2

echo "Testing tools/list..."
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/bin/cli.js serve 2>/dev/null &
TEST_PID=$!
sleep 1

echo "Testing get_workflow..."
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_workflow","arguments":{"name":"feature"}}}' | node dist/bin/cli.js serve 2>/dev/null &
TEST_PID2=$!
sleep 2

echo "Checking cache..."
sqlite3 ~/.qwickbrain/cache/qwickbrain.db "SELECT doc_type, name FROM documents;"

echo "Cleanup..."
kill $PROXY_PID $TEST_PID $TEST_PID2 2>/dev/null || true

echo "Done!"
