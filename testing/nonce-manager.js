const fs = require('fs');
const path = require('path');

const NONCE_FILE = path.join(__dirname, 'nonces.json');

/**
 * Get the stored nonce for an address, defaulting to 0 if not found
 */
function getStoredNonce(address) {
    try {
        if (fs.existsSync(NONCE_FILE)) {
            const nonces = JSON.parse(fs.readFileSync(NONCE_FILE, 'utf8'));
            return nonces[address.toLowerCase()] || 0;
        }
    } catch (error) {
        console.error('Error reading nonce file:', error);
    }
    return 0;
}

/**
 * Save the nonce for an address
 */
function saveNonce(address, nonce) {
    let nonces = {};
    try {
        if (fs.existsSync(NONCE_FILE)) {
            nonces = JSON.parse(fs.readFileSync(NONCE_FILE, 'utf8'));
        }
    } catch (error) {
        console.error('Error reading nonce file:', error);
    }
    
    nonces[address.toLowerCase()] = nonce;
    fs.writeFileSync(NONCE_FILE, JSON.stringify(nonces, null, 2));
}

/**
 * Get the starting nonce by taking the max of fetched and stored nonce
 */
async function getStartingNonce(publicClient, address) {
    const fetchedNonce = await publicClient.getTransactionCount({ 
        address,
        blockTag: 'pending',
    });
    const storedNonce = getStoredNonce(address);
    const startingNonce = Math.max(fetchedNonce, storedNonce);
    
    console.log(`Nonce for ${address}:`);
    console.log(`  Fetched from chain: ${fetchedNonce}`);
    console.log(`  Stored locally: ${storedNonce}`);
    console.log(`  Using: ${startingNonce}`);
    
    return startingNonce;
}

module.exports = {
    getStoredNonce,
    saveNonce,
    getStartingNonce
};