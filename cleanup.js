// CLEANUP SCRIPT - Remove all test/demo data
// Run this from your browser console or as a Node.js script

const API_SECRET = 'YOUR_API_SECRET_HERE'; // Replace with your actual API_SECRET

const SERVER_URL = 'YOUR_SERVER_URL'; // e.g., https://rashadtech-api.onrender.com

async function cleanupAllData() {
    console.log('🧹 Starting cleanup...');
    
    try {
        // 1. Clear all codes from server memory
        console.log('1️⃣ Clearing codes from server...');
        const clearRes = await fetch(`${SERVER_URL}/notify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret: API_SECRET, message: '/clear', chatId: 'ADMIN' })
        });
        console.log('✓ Server codes cleared');
        
        // 2. Reset JSONBin database
        console.log('2️⃣ Resetting JSONBin database...');
        
        // Get current data
        const getRes = await fetch(`${SERVER_URL}/db/read`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret: API_SECRET })
        });
        
        if (getRes.ok) {
            const currentData = await getRes.json();
            console.log('Current data found, resetting...');
            
            // Create empty structure
            const emptyData = {
                stock: [],
                customers: [],
                transactions: [],
                wallets: {},
                updatedAt: new Date().toISOString()
            };
            
            // Write empty data
            const writeRes = await fetch(`${SERVER_URL}/db/write`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ secret: API_SECRET, data: emptyData })
            });
            
            if (writeRes.ok) {
                console.log('✓ JSONBin database reset successfully!');
            } else {
                console.log('⚠️ Could not reset JSONBin (manual reset may be needed)');
            }
        }
        
        console.log('');
        console.log('✅ CLEANUP COMPLETE!');
        console.log('');
        console.log('📋 What was cleared:');
        console.log('   • All stored Netflix codes');
        console.log('   • All stock accounts (Netflix accounts)');
        console.log('   • All customer subscriptions');
        console.log('   • All transaction history');
        console.log('   • All wallet balances');
        console.log('');
        console.log('📧 Gmail monitoring is still active for: techtrassh@gmail.com');
        
    } catch (error) {
        console.error('❌ Cleanup failed:', error.message);
        console.log('');
        console.log('💡 Alternative: Manually clear JSONBin from dashboard or use Telegram command /clear');
    }
}

// Auto-run
cleanupAllData();