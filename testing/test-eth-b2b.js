const { createPublicSyncClient, shredsWebSocket } = require('shreds/viem');
const { createWalletClient, createPublicClient, http, parseEther, formatEther } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { sepolia } = require('viem/chains');
const fs = require('fs');
require('dotenv').config({ path: '../.env' });
const { getStartingNonce, saveNonce } = require('./nonce-manager');

// Hardcoded gas settings for speed
const GAS_PRICE = 100n; // 100 wei
const GAS_LIMIT = 21000n; // Standard ETH transfer
const TRANSFER_AMOUNT = parseEther('0.01'); // 0.01 ETH

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

async function sendTransactionSync(syncClient, walletClient, publicClient, txRequest, expectedBalances, from) {
    try {
        const startTime = Date.now();
        
        // Sign the transaction
        const signedTx = await walletClient.signTransaction(txRequest);
        
        // Send the transaction using sendRawTransactionSync
        const receipt = await syncClient.sendRawTransactionSync({
            serializedTransaction: signedTx,
        });
        
        const endTime = Date.now();
        console.log(`Transaction confirmed in block: ${receipt.blockNumber} (${endTime - startTime}ms)`);
        
        // Get actual balances after transaction via RPC
        const rpcStartTime = Date.now();
        const actualBalances = {
            wallet1: await publicClient.getBalance({ 
                address: expectedBalances.wallet1Address,
                blockTag: 'pending',
            }),
            wallet2: await publicClient.getBalance({ 
                address: expectedBalances.wallet2Address,
                blockTag: 'pending',
            })
        };
        const rpcEndTime = Date.now();
        
        // Calculate differences
        const differences = {
            wallet1: formatEther(actualBalances.wallet1 - expectedBalances.wallet1),
            wallet2: formatEther(actualBalances.wallet2 - expectedBalances.wallet2)
        };
        
        // Calculate actual gas used
        const actualGasUsed = BigInt(receipt.gasUsed) * GAS_PRICE;
        
        return {
            receipt,
            duration: endTime - startTime,
            from: from,
            actualGasUsed: actualGasUsed,
            rpc: {
                duration: rpcEndTime - rpcStartTime,
                expectedBalances: {
                    wallet1: formatEther(expectedBalances.wallet1),
                    wallet2: formatEther(expectedBalances.wallet2)
                },
                rpcResult: {
                    wallet1: formatEther(actualBalances.wallet1),
                    wallet2: formatEther(actualBalances.wallet2)
                },
                differences: differences,
                balancesMatch: {
                    wallet1: actualBalances.wallet1 === expectedBalances.wallet1,
                    wallet2: actualBalances.wallet2 === expectedBalances.wallet2
                }
            }
        };
    } catch (error) {
        console.error('Error sending transaction:', error);
        throw error;
    }
}

async function main() {
    console.log('Starting ETH back-and-forth test with shreds...\n');
    
    // Create accounts from private keys
    const wallet1Account = privateKeyToAccount(process.env.PRIVATE_KEY);
    const wallet2Account = privateKeyToAccount(process.env.ALT_PRIVATE_KEY);
    
    console.log('Wallet 1 (Source):', wallet1Account.address);
    console.log('Wallet 2 (Destination):', wallet2Account.address);
    
    // Create wallet clients for signing transactions
    const walletClient1 = createWalletClient({
        account: wallet1Account,
        chain: riseTestnet,
        transport: http(process.env.RPC_URL),
    });
    
    const walletClient2 = createWalletClient({
        account: wallet2Account,
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
    
    // Check initial balances
    const initialBalance1 = await publicClient.getBalance({ 
        address: wallet1Account.address,
        blockTag: 'pending',
    });
    const initialBalance2 = await publicClient.getBalance({ 
        address: wallet2Account.address,
        blockTag: 'pending',
    });
    console.log(`\nInitial balance of Wallet 1: ${formatEther(initialBalance1)} ETH`);
    console.log(`Initial balance of Wallet 2: ${formatEther(initialBalance2)} ETH`);
    
    // Get initial nonces using nonce manager
    let nonce1 = await getStartingNonce(publicClient, wallet1Account.address);
    let nonce2 = await getStartingNonce(publicClient, wallet2Account.address);
    
    // Number of back-and-forth transfers to perform
    const NUM_ROUNDS = 3;
    const transactions = [];
    
    // Track expected balances throughout
    let expectedBalances = {
        wallet1: initialBalance1,
        wallet2: initialBalance2,
        wallet1Address: wallet1Account.address,
        wallet2Address: wallet2Account.address
    };
    
    // Calculate the gas cost
    const gasCost = GAS_LIMIT * GAS_PRICE;
    
    for (let round = 0; round < NUM_ROUNDS; round++) {
        console.log(`\n=== Round ${round + 1} ===`);
        
        // Step 1: Send ETH from wallet1 to wallet2
        console.log(`\nSending ${formatEther(TRANSFER_AMOUNT)} ETH from Wallet 1 to Wallet 2...`);
        
        const tx1 = await walletClient1.prepareTransactionRequest({
            to: wallet2Account.address,
            value: TRANSFER_AMOUNT,
            gasPrice: GAS_PRICE,
            gas: GAS_LIMIT,
            nonce: nonce1,
        });
        
        // Update expected balances for wallet1 -> wallet2 transfer
        expectedBalances.wallet1 -= (TRANSFER_AMOUNT + gasCost);
        expectedBalances.wallet2 += TRANSFER_AMOUNT;
        
        const result1 = await sendTransactionSync(
            syncClient, 
            walletClient1, 
            publicClient, 
            tx1, 
            expectedBalances,
            'wallet1'
        );
        
        transactions.push({
            round: round + 1,
            direction: 'wallet1 -> wallet2',
            ...result1
        });
        
        // Update expected balances with actual gas used if different
        if (result1.actualGasUsed !== gasCost) {
            const gasDifference = gasCost - result1.actualGasUsed;
            expectedBalances.wallet1 += gasDifference;
            console.log(`Gas adjustment for wallet1: ${formatEther(gasDifference)} ETH`);
        }
        
        nonce1++;
        
        // Check intermediate balances
        const intermediateBalance1 = await publicClient.getBalance({ 
            address: wallet1Account.address,
            blockTag: 'pending',
        });
        const intermediateBalance2 = await publicClient.getBalance({ 
            address: wallet2Account.address,
            blockTag: 'pending',
        });
        console.log(`\nWallet 1 balance after transfer: ${formatEther(intermediateBalance1)} ETH`);
        console.log(`Wallet 2 balance after transfer: ${formatEther(intermediateBalance2)} ETH`);
        
        // Step 2: Send ETH back from wallet2 to wallet1
        console.log(`\nSending ${formatEther(TRANSFER_AMOUNT)} ETH back from Wallet 2 to Wallet 1...`);
        
        // For return transfer, send slightly less to account for gas
        const amountToSendBack = round === 0 ? TRANSFER_AMOUNT - gasCost : TRANSFER_AMOUNT;
        
        const tx2 = await walletClient2.prepareTransactionRequest({
            to: wallet1Account.address,
            value: amountToSendBack,
            gasPrice: GAS_PRICE,
            gas: GAS_LIMIT,
            nonce: nonce2,
        });
        
        // Update expected balances for wallet2 -> wallet1 transfer
        expectedBalances.wallet1 += amountToSendBack;
        expectedBalances.wallet2 -= (amountToSendBack + gasCost);
        
        const result2 = await sendTransactionSync(
            syncClient, 
            walletClient2, 
            publicClient, 
            tx2, 
            expectedBalances,
            'wallet2'
        );
        
        transactions.push({
            round: round + 1,
            direction: 'wallet2 -> wallet1',
            ...result2
        });
        
        // Update expected balances with actual gas used if different
        if (result2.actualGasUsed !== gasCost) {
            const gasDifference = gasCost - result2.actualGasUsed;
            expectedBalances.wallet2 += gasDifference;
            console.log(`Gas adjustment for wallet2: ${formatEther(gasDifference)} ETH`);
        }
        
        nonce2++;
    }
    
    // Check final balances
    const finalBalance1 = await publicClient.getBalance({ 
        address: wallet1Account.address,
        blockTag: 'pending',
    });
    const finalBalance2 = await publicClient.getBalance({ 
        address: wallet2Account.address,
        blockTag: 'pending',
    });
    console.log(`\n=== Final Results ===`);
    console.log(`Final balance of Wallet 1: ${formatEther(finalBalance1)} ETH`);
    console.log(`Final balance of Wallet 2: ${formatEther(finalBalance2)} ETH`);
    
    // Print a summary
    const wallet1Diff = finalBalance1 - initialBalance1;
    const wallet2Diff = finalBalance2 - initialBalance2;
    console.log(`\nWallet 1 net change: ${formatEther(wallet1Diff)} ETH`);
    console.log(`Wallet 2 net change: ${formatEther(wallet2Diff)} ETH`);
    
    // Calculate total gas used
    const totalGasUsed = transactions.reduce((acc, tx) => acc + BigInt(tx.receipt.gasUsed), 0n);
    console.log(`Total gas used for all transactions: ${totalGasUsed}`);
    
    // Calculate accuracy metrics
    const totalDifferences = transactions.map(tx => 
        Math.abs(parseFloat(tx.rpc.differences.wallet1)) + Math.abs(parseFloat(tx.rpc.differences.wallet2))
    );
    const avgDifference = totalDifferences.reduce((a, b) => a + b, 0) / totalDifferences.length;
    console.log(`Average balance difference per transaction: ${avgDifference.toFixed(10)} ETH`);
    
    // Save results
    const results = {
        testType: 'eth-back-and-forth-with-shreds',
        timestamp: new Date().toISOString(),
        configuration: {
            transferAmount: formatEther(TRANSFER_AMOUNT),
            gasPrice: GAS_PRICE.toString(),
            gasLimit: GAS_LIMIT.toString()
        },
        wallets: {
            wallet1: wallet1Account.address,
            wallet2: wallet2Account.address
        },
        balances: {
            initial: {
                wallet1: formatEther(initialBalance1),
                wallet2: formatEther(initialBalance2)
            },
            final: {
                wallet1: formatEther(finalBalance1),
                wallet2: formatEther(finalBalance2)
            }
        },
        transactions: transactions.map(tx => ({
            round: tx.round,
            direction: tx.direction,
            from: tx.from,
            txHash: tx.receipt.transactionHash,
            blockNumber: parseInt(tx.receipt.blockNumber),
            gasUsed: parseInt(tx.receipt.gasUsed),
            actualGasUsed: tx.actualGasUsed.toString(),
            status: tx.receipt.status,
            duration: tx.duration,
            rpc: tx.rpc
        })),
        summary: {
            wallet1NetChange: formatEther(wallet1Diff),
            wallet2NetChange: formatEther(wallet2Diff),
            totalRounds: NUM_ROUNDS,
            totalTransactions: transactions.length,
            totalGasUsed: totalGasUsed.toString(),
            avgTransactionDurationMs: transactions.reduce((acc, tx) => acc + tx.duration, 0) / transactions.length,
            avgRpcDurationMs: transactions.reduce((acc, tx) => acc + tx.rpc.duration, 0) / transactions.length,
            avgBalanceDifference: avgDifference.toFixed(10),
            finalExpectedBalances: {
                wallet1: formatEther(expectedBalances.wallet1),
                wallet2: formatEther(expectedBalances.wallet2)
            },
            finalRpcResult: {
                wallet1: formatEther(finalBalance1),
                wallet2: formatEther(finalBalance2)
            },
            finalDifferences: {
                wallet1: formatEther(finalBalance1 - expectedBalances.wallet1),
                wallet2: formatEther(finalBalance2 - expectedBalances.wallet2)
            }
        }
    };
    
    // Custom JSON stringifier to handle BigInt
    const jsonString = JSON.stringify(results, (key, value) => {
        if (typeof value === 'bigint') {
            return value.toString();
        }
        return value;
    }, 2);
    
    fs.writeFileSync('eth-b2b-test-results.json', jsonString);
    console.log('\nDetailed results saved to eth-b2b-test-results.json');
    
    // Save the final nonces for next run
    saveNonce(wallet1Account.address, nonce1);
    saveNonce(wallet2Account.address, nonce2);
    console.log(`\nSaved nonces for next run: Wallet1=${nonce1}, Wallet2=${nonce2}`);
    
    process.exit(0);
}

// Execute the script
main().catch(console.error);