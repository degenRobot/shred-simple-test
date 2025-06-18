const { createPublicSyncClient, shredsWebSocket } = require('shreds/viem');
const { createWalletClient, createPublicClient, http, parseEther, formatEther } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { sepolia } = require('viem/chains');
const fs = require('fs');
require('dotenv').config({ path: '../.env' });
const { getStartingNonce, saveNonce } = require('./nonce-manager');

// Hardcoded gas settings for speed
const GAS_PRICE = 114n; // 0.000000114 gwei
const GAS_LIMIT = 21000n; // Standard ETH transfer

// Test configuration
const NUM_TRANSACTIONS = 20;
const TRANSFER_AMOUNT = parseEther('0.0001'); // 0.0001 ETH per transfer

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

async function testParallelEthTransfer() {
    console.log('Starting parallel ETH transfer test with shreds...\n');
    
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
    
    // Get initial balance
    const initialBalance = await publicClient.getBalance({ 
        address: account.address,
        blockTag: 'pending',
    });
    console.log('Initial balance:', formatEther(initialBalance), 'ETH');
    
    // Get initial nonce using nonce manager
    const startNonce = await getStartingNonce(publicClient, account.address);
    
    // Generate random recipient addresses
    const recipients = Array.from({ length: NUM_TRANSACTIONS }, () => {
        const randomWallet = privateKeyToAccount(`0x${Buffer.from(Array(32).fill(0).map(() => Math.floor(Math.random() * 256))).toString('hex')}`);
        return randomWallet.address;
    });
    
    console.log('\nSending parallel transactions...\n');
    
    const startTime = Date.now();
    const transactionPromises = [];
    const rpcCallPromises = [];
    
    // Send all transactions in parallel
    for (let i = 0; i < NUM_TRANSACTIONS; i++) {
        const nonce = startNonce + i;
        const recipient = recipients[i];
        
        const txPromise = (async () => {
            const txStartTime = Date.now();
            
            try {
                // Prepare transaction
                const request = await walletClient.prepareTransactionRequest({
                    to: recipient,
                    value: TRANSFER_AMOUNT,
                    nonce: nonce,
                    gas: GAS_LIMIT,
                    gasPrice: GAS_PRICE,
                });
                
                // Sign transaction
                const signedTx = await walletClient.signTransaction(request);
                
                // Send transaction using sendRawTransactionSync
                console.log(`[TX ${i + 1}] Sending to ${recipient.substring(0, 10)}... with nonce ${nonce}`);
                const receipt = await syncClient.sendRawTransactionSync({
                    serializedTransaction: signedTx,
                });
                
                const txEndTime = Date.now();
                
                // Track RPC call asynchronously to check recipient balance
                const rpcPromise = (async () => {
                    const rpcStartTime = Date.now();
                    try {
                        // Get recipient balance after transaction
                        const recipientBalance = await publicClient.getBalance({ 
                            address: recipient,
                            blockTag: 'pending',
                        });
                        const rpcEndTime = Date.now();
                        
                        // Expected balance should be at least the transfer amount
                        const expectedMinBalance = TRANSFER_AMOUNT;
                        const hasExpectedBalance = recipientBalance >= expectedMinBalance;
                        
                        return {
                            txIndex: i + 1,
                            txHash: receipt.transactionHash,
                            recipient: recipient,
                            rpcDuration: rpcEndTime - rpcStartTime,
                            rpcResult: formatEther(recipientBalance),
                            expectedMinBalance: formatEther(expectedMinBalance),
                            hasExpectedBalance: hasExpectedBalance,
                            success: true
                        };
                    } catch (error) {
                        return {
                            txIndex: i + 1,
                            txHash: receipt.transactionHash,
                            recipient: recipient,
                            error: error.message,
                            success: false
                        };
                    }
                })();
                
                rpcCallPromises.push(rpcPromise);
                
                return {
                    index: i + 1,
                    txHash: receipt.transactionHash,
                    nonce: nonce,
                    recipient: recipient,
                    amount: formatEther(TRANSFER_AMOUNT),
                    startTime: txStartTime,
                    endTime: txEndTime,
                    duration: txEndTime - txStartTime,
                    blockNumber: parseInt(receipt.blockNumber),
                    blockHash: receipt.blockHash,
                    gasUsed: parseInt(receipt.gasUsed),
                    status: receipt.status,
                    from: receipt.from,
                    to: receipt.to,
                    success: receipt.status === 'success'
                };
                
            } catch (error) {
                console.error(`[TX ${i + 1}] Error:`, error.message);
                return {
                    index: i + 1,
                    nonce: nonce,
                    recipient: recipient,
                    error: error.message,
                    success: false
                };
            }
        })();
        
        transactionPromises.push(txPromise);
    }
    
    // Wait for all transactions to complete
    const results = await Promise.all(transactionPromises);
    const totalTime = Date.now() - startTime;
    
    // Wait for all RPC calls to complete
    console.log('\nWaiting for RPC call results...');
    const rpcResults = await Promise.all(rpcCallPromises);
    
    // Get final balance
    const finalBalance = await publicClient.getBalance({ 
        address: account.address,
        blockTag: 'pending',
    });
    console.log('\nFinal balance:', formatEther(finalBalance), 'ETH');
    
    // Combine transaction and RPC data
    const combinedResults = results.map((tx) => {
        const rpcData = rpcResults.find(rpc => rpc.txIndex === tx.index) || {};
        return {
            ...tx,
            rpc: {
                duration: rpcData.rpcDuration,
                rpcResult: rpcData.rpcResult,
                expectedMinBalance: rpcData.expectedMinBalance,
                hasExpectedBalance: rpcData.hasExpectedBalance,
                error: rpcData.error
            }
        };
    });
    
    // Calculate statistics
    const successfulTxs = results.filter(tx => tx.success);
    const failedTxs = results.filter(tx => !tx.success);
    
    const durations = successfulTxs.filter(tx => tx.duration).map(tx => tx.duration);
    const avgDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    const minDuration = durations.length > 0 ? Math.min(...durations) : 0;
    const maxDuration = durations.length > 0 ? Math.max(...durations) : 0;
    
    const rpcDurations = rpcResults.filter(r => r.rpcDuration).map(r => r.rpcDuration);
    const avgRpcDuration = rpcDurations.length > 0 ? rpcDurations.reduce((a, b) => a + b, 0) / rpcDurations.length : 0;
    
    const balancesCorrect = rpcResults.filter(r => r.hasExpectedBalance).length;
    
    console.log('\n=== Test Summary ===');
    console.log(`Total transactions: ${NUM_TRANSACTIONS}`);
    console.log(`Successful: ${successfulTxs.length}`);
    console.log(`Failed: ${failedTxs.length}`);
    console.log(`Total time for all transactions: ${totalTime}ms`);
    console.log(`Average time per transaction: ${(totalTime / NUM_TRANSACTIONS).toFixed(2)}ms`);
    console.log(`Average confirmation time: ${avgDuration.toFixed(2)}ms`);
    console.log(`Min confirmation time: ${minDuration}ms`);
    console.log(`Max confirmation time: ${maxDuration}ms`);
    console.log(`Average RPC time: ${avgRpcDuration.toFixed(2)}ms`);
    console.log(`Recipients with expected balance: ${balancesCorrect}/${rpcResults.length}`);
    console.log(`Total ETH sent: ${formatEther(TRANSFER_AMOUNT * BigInt(successfulTxs.length))} ETH`);
    console.log(`Balance change: ${formatEther(finalBalance - initialBalance)} ETH`);
    
    // Save detailed results
    const summary = {
        testType: 'parallel-eth-transfer-with-shreds',
        timestamp: new Date().toISOString(),
        configuration: {
            numTransactions: NUM_TRANSACTIONS,
            transferAmount: formatEther(TRANSFER_AMOUNT),
            gasPrice: GAS_PRICE.toString(),
            gasLimit: GAS_LIMIT.toString()
        },
        summary: {
            totalTransactions: NUM_TRANSACTIONS,
            successful: successfulTxs.length,
            failed: failedTxs.length,
            totalTimeMs: totalTime,
            avgTimePerTxMs: totalTime / NUM_TRANSACTIONS,
            avgConfirmationTimeMs: avgDuration,
            minConfirmationTimeMs: minDuration,
            maxConfirmationTimeMs: maxDuration,
            avgRpcDurationMs: avgRpcDuration,
            recipientsWithExpectedBalance: balancesCorrect,
            totalRecipients: rpcResults.length,
            initialBalance: formatEther(initialBalance),
            finalBalance: formatEther(finalBalance),
            totalEthSent: formatEther(TRANSFER_AMOUNT * BigInt(successfulTxs.length)),
            expectedBalanceChange: formatEther(-(TRANSFER_AMOUNT * BigInt(successfulTxs.length) + BigInt(successfulTxs.length) * GAS_LIMIT * GAS_PRICE)),
            actualBalanceChange: formatEther(finalBalance - initialBalance)
        },
        transactions: combinedResults
    };
    
    // Save the final nonce for next run
    const finalNonce = startNonce + NUM_TRANSACTIONS;
    saveNonce(account.address, finalNonce);
    console.log(`\nSaved nonce ${finalNonce} for next run`);
    
    // Custom JSON stringifier to handle BigInt
    const jsonString = JSON.stringify(summary, (key, value) => {
        if (typeof value === 'bigint') {
            return value.toString();
        }
        return value;
    }, 2);
    
    fs.writeFileSync('eth-transfer-shreds-test-results.json', jsonString);
    console.log('\nDetailed results saved to eth-transfer-shreds-test-results.json');
    
    process.exit(0);
}

// Run the test
testParallelEthTransfer().catch(console.error);