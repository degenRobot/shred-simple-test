#!/bin/bash

echo "=== Running Shreds Test Scripts ==="
echo ""

# Make sure we're in the testing directory
cd "$(dirname "$0")"

echo "1. Running sequential increment test..."
echo "-----------------------------------"
node test-increment.js

echo ""
echo ""
echo "2. Running parallel ETH transfer test..."
echo "---------------------------------------"
node test-eth-transfer.js

echo ""
echo ""
echo "3. Running ETH back-and-forth test..."
echo "------------------------------------"
node test-eth-b2b.js

echo ""
echo "=== All tests completed ==="
echo "Check the following files for detailed results:"
echo "- increment-shreds-test-results.json"
echo "- eth-transfer-shreds-test-results.json"
echo "- eth-b3x-test-results.json"