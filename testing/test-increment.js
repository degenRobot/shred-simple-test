const { createPublicShredClient, createPublicSyncClient, shredsWebSocket } = require('shreds/viem');
const { createWalletClient, createPublicClient, http, parseAbi, formatEther, encodeFunctionData } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { sepolia } = require('viem/chains');
const fs = require('fs');
require('dotenv').config({ path: '../.env' });
const { getStartingNonce, saveNonce } = require('./nonce-manager');

// Contract details
const CONTRACT_ADDRESS = '0xc40680a15b6716db78624f1adc6b03118af1ffba';
const COUNTER_ABI = JSON.parse(fs.readFileSync('./Counter.abi.json', 'utf8'));

// Hardcoded gas settings for speed
const GAS_PRICE = 114n; // 0.000000114 gwei from deployment
const GAS_LIMIT = 10000000n;

// Test configuration
const NUM_TRANSACTIONS = 20;

// Custom chain config for RISE testnet
const riseTestnet = {
    ...sepolia,
    id: 11155931,
    name: 'RISE Testnet',
    rpcUrls: {
        default: { http: [process.env.RPC_URL] },
        public: { http: [process.env.RPC_URL] },
    }
};

async function testSequentialIncrement() {
    console.log('Starting sequential increment test with shreds...\n');
    
    // Create account from private key
    const account = privateKeyToAccount(process.env.PRIVATE_KEY);
    console.log('Wallet address:', account.address);
    
    // Create wallet client for signing transactions
    const walletClient = createWalletClient({
        account,
        chain: riseTestnet,
        transport: http(process.env.RPC_URL),
    });
    
    // Create public client for reading blockchain data
    const publicClient = createPublicClient({
        chain: riseTestnet,
        transport: http(process.env.RPC_URL),
    });
    
    // Create sync client for sending transactions with fast confirmation
    const syncClient = createPublicSyncClient({
        chain: riseTestnet,
        transport: shredsWebSocket(process.env.WEB_SOCKET_URL),
    });
    
    // Create shred client for watching events
    const shredClient = createPublicShredClient({
        chain: riseTestnet,
        transport: shredsWebSocket(process.env.WEB_SOCKET_URL),
    });
    
    // Get initial nonce using nonce manager
    let nonce = await getStartingNonce(publicClient, account.address);
    
    // Get initial counter value
    const initialCounterValue = await publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: COUNTER_ABI,
        functionName: 'number',
        blockTag: 'pending',
    });
    console.log(`Initial counter value: ${initialCounterValue}`);
    
    // Transaction tracking array
    const transactions = [];
    const eventLogs = [];
    const rpcCallPromises = [];
    
    // Subscribe to NewNumber events using watchContractShredEvent
    console.log('\nSetting up shred event subscription...');
    const unsubscribe = shredClient.watchContractShredEvent({
        abi: COUNTER_ABI,
        address: CONTRACT_ADDRESS,
        eventName: 'NewNumber',
        onLogs: (logs) => {
            logs.forEach(log => {
                console.log(`[SHRED EVENT] NewNumber: ${log.args.newNumber}, Block: ${log.blockNumber}, TxHash: ${log.transactionHash}`);
                eventLogs.push({
                    eventName: 'NewNumber',
                    newNumber: log.args.newNumber.toString(),
                    blockNumber: log.blockNumber,
                    transactionHash: log.transactionHash,
                    timestamp: Date.now()
                });
            });
        },
        onError: (error) => {
            console.error('[SHRED EVENT ERROR]', error);
        },
        strict: false
    });
    
    console.log('\nSending transactions...\n');
    
    for (let i = 0; i < NUM_TRANSACTIONS; i++) {
        const startTime = Date.now();
        
        try {
            // Prepare the transaction directly without simulation
            const request = await walletClient.prepareTransactionRequest({
                to: CONTRACT_ADDRESS,
                data: encodeFunctionData({
                    abi: COUNTER_ABI,
                    functionName: 'increment'
                }),
                nonce: nonce,
                gas: GAS_LIMIT,
                gasPrice: GAS_PRICE,
            });
            
            // Sign the transaction
            const signedTx = await walletClient.signTransaction(request);
            
            // Send transaction using sendRawTransactionSync for fast confirmation
            console.log(`[TX ${i + 1}] Sending transaction with nonce ${nonce}...`);
            const receipt = await syncClient.sendRawTransactionSync({
                serializedTransaction: signedTx,
            });
            
            const endTime = Date.now();
            
            // Track transaction details
            const txData = {
                index: i + 1,
                txHash: receipt.transactionHash,
                nonce: nonce,
                startTime: startTime,
                endTime: endTime,
                duration: endTime - startTime,
                blockNumber: parseInt(receipt.blockNumber),
                blockHash: receipt.blockHash,
                gasUsed: parseInt(receipt.gasUsed),
                status: receipt.status,
                contractAddress: receipt.contractAddress,
                from: receipt.from,
                to: receipt.to
            };
            
            transactions.push(txData);
            
            console.log(`[TX ${i + 1}] Confirmed in block ${receipt.blockNumber} (${txData.duration}ms)`);
            console.log(`         Gas used: ${receipt.gasUsed}, Status: ${receipt.status}`);
            
            // Track RPC call asynchronously
            const expectedValue = BigInt(initialCounterValue) + BigInt(i + 1);
            const rpcPromise = (async () => {
                const rpcStartTime = Date.now();
                try {
                    // Get the current counter value via RPC
                    const actualValue = await publicClient.readContract({
                        address: CONTRACT_ADDRESS,
                        abi: COUNTER_ABI,
                        functionName: 'number',
                        blockTag: 'pending',
                    });
                    const rpcEndTime = Date.now();
                    
                    return {
                        txIndex: i + 1,
                        txHash: receipt.transactionHash,
                        rpcDuration: rpcEndTime - rpcStartTime,
                        expectedValue: expectedValue.toString(),
                        rpcResult: actualValue.toString(),
                        valuesMatch: actualValue === expectedValue,
                        success: true
                    };
                } catch (error) {
                    return {
                        txIndex: i + 1,
                        txHash: receipt.transactionHash,
                        error: error.message,
                        expectedValue: expectedValue.toString(),
                        rpcResult: null,
                        valuesMatch: false,
                        success: false
                    };
                }
            })();
            
            rpcCallPromises.push(rpcPromise);
            
            // Increment nonce for next transaction
            nonce++;
            
        } catch (error) {
            console.error(`[TX ${i + 1}] Error:`, error.message);
            if (error.details) {
                console.error(`         Details:`, error.details);
            }
            break;
        }
    }
    
    // Wait a bit for any remaining events
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Wait for all RPC calls to complete
    console.log('\nWaiting for RPC call results...');
    const rpcResults = await Promise.all(rpcCallPromises);
    
    // Get final counter value
    const finalValue = await publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: COUNTER_ABI,
        functionName: 'number',
        blockTag: 'pending',
    });
    console.log(`\nFinal counter value: ${finalValue}`);
    
    // Combine transaction and RPC data
    const combinedResults = transactions.map((tx, index) => {
        const rpcData = rpcResults.find(rpc => rpc.txIndex === tx.index) || {};
        return {
            ...tx,
            rpc: {
                duration: rpcData.rpcDuration,
                expectedValue: rpcData.expectedValue,
                rpcResult: rpcData.rpcResult,
                valuesMatch: rpcData.valuesMatch,
                error: rpcData.error
            }
        };
    });
    
    // Calculate statistics
    const durations = transactions.map(tx => tx.duration);
    const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
    const minDuration = Math.min(...durations);
    const maxDuration = Math.max(...durations);
    
    const rpcDurations = rpcResults.filter(r => r.rpcDuration).map(r => r.rpcDuration);
    const avgRpcDuration = rpcDurations.length > 0 ? rpcDurations.reduce((a, b) => a + b, 0) / rpcDurations.length : 0;
    
    const matchingValues = rpcResults.filter(r => r.valuesMatch).length;
    
    console.log('\n=== Test Summary ===');
    console.log(`Total transactions sent: ${transactions.length}`);
    console.log(`Total events received: ${eventLogs.length}`);
    console.log(`Average transaction time: ${avgDuration.toFixed(2)}ms`);
    console.log(`Min transaction time: ${minDuration}ms`);
    console.log(`Max transaction time: ${maxDuration}ms`);
    console.log(`Average RPC time: ${avgRpcDuration.toFixed(2)}ms`);
    console.log(`RPC values matching expected: ${matchingValues}/${rpcResults.length}`);
    
    // Save detailed results
    const results = {
        testType: 'sequential-increment-with-shreds',
        timestamp: new Date().toISOString(),
        configuration: {
            contractAddress: CONTRACT_ADDRESS,
            numTransactions: NUM_TRANSACTIONS,
            gasPrice: GAS_PRICE.toString(),
            gasLimit: GAS_LIMIT.toString()
        },
        summary: {
            totalTransactions: transactions.length,
            totalEvents: eventLogs.length,
            avgTransactionDurationMs: avgDuration,
            minTransactionDurationMs: minDuration,
            maxTransactionDurationMs: maxDuration,
            avgRpcDurationMs: avgRpcDuration,
            rpcValuesMatching: matchingValues,
            rpcValuesTotal: rpcResults.length,
            initialCounterValue: initialCounterValue.toString(),
            finalCounterValue: finalValue.toString(),
            expectedFinalValue: (BigInt(initialCounterValue) + BigInt(transactions.length)).toString()
        },
        transactions: combinedResults,
        events: eventLogs
    };
    
    // Save the final nonce for next run
    saveNonce(account.address, nonce);
    console.log(`\nSaved nonce ${nonce} for next run`);
    
    // Custom JSON stringifier to handle BigInt
    const jsonString = JSON.stringify(results, (key, value) => {
        if (typeof value === 'bigint') {
            return value.toString();
        }
        return value;
    }, 2);
    
    fs.writeFileSync('increment-shreds-test-results.json', jsonString);
    console.log('\nDetailed results saved to increment-shreds-test-results.json');
    
    // Cleanup
    unsubscribe();
    
    process.exit(0);
}

// Run the test
testSequentialIncrement().catch(console.error);