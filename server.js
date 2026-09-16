const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database Connection Pool
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'annapurna_seeds',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Allowed Fixed Slabs
const VALID_SLABS = [330, 550, 950, 1320];

// ==========================================
// 1. BANK BINDING & LOCK (1 ID = 1 Lock Bank)
// ==========================================
app.post('/api/bank/bind', async (req, res) => {
    const { userId, holderName, accountNumber, ifscCode } = req.body;

    try {
        // Check if user already bound a bank
        const [existingUserBank] = await pool.execute(
            'SELECT id, is_locked FROM user_bank_details WHERE user_id = ?',
            [userId]
        );

        if (existingUserBank.length > 0 && existingUserBank[0].is_locked) {
            return res.status(400).json({ error: 'Bank account is already locked to this ID. Contact Admin for changes.' });
        }

        // Check if account number is already bound to another user
        const [duplicateBank] = await pool.execute(
            'SELECT id FROM user_bank_details WHERE account_number = ? AND user_id != ?',
            [accountNumber, userId]
        );

        if (duplicateBank.length > 0) {
            return res.status(400).json({ error: 'This bank account is already registered with another account!' });
        }

        // Insert & Lock
        await pool.execute(
            'INSERT INTO user_bank_details (user_id, holder_name, account_number, ifsc_code, is_locked) VALUES (?, ?, ?, ?, 1) ON DUPLICATE KEY UPDATE holder_name=?, account_number=?, ifsc_code=?, is_locked=1',
            [userId, holderName, accountNumber, ifscCode, holderName, accountNumber, ifscCode]
        );

        return res.json({ success: true, message: 'Bank account bound and permanently locked!' });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 2. DAILY TASKS EXECUTION (Sunday Holiday + Pay-Per-Task)
// ==========================================
app.post('/api/tasks/submit', async (req, res) => {
    const { userId } = req.body;

    // Sunday Holiday Check (0 = Sunday)
    const dayOfWeek = new Date().getDay();
    if (dayOfWeek === 0) {
        return res.status(400).json({ error: 'Sunday is a weekly holiday. Tasks resume on Monday!' });
    }

    try {
        // Fetch user active plan details
        const [user] = await pool.execute(
            `SELECT u.id, u.wallet_balance, p.daily_tasks, p.earning_per_task, u.plan_expires_at 
             FROM users u 
             JOIN investment_plans p ON u.active_plan_id = p.id 
             WHERE u.id = ?`,
            [userId]
        );

        if (user.length === 0) {
            return res.status(400).json({ error: 'No active investment plan found. Recharge to start tasks.' });
        }

        const plan = user[0];
        if (new Date(plan.plan_expires_at) < new Date()) {
            return res.status(400).json({ error: 'Your investment plan has expired!' });
        }

        const todayStr = new Date().toISOString().split('T')[0];

        // Fetch or create today's task record
        const [taskRecord] = await pool.execute(
            'SELECT * FROM daily_tasks_log WHERE user_id = ? AND task_date = ?',
            [userId, todayStr]
        );

        let completedToday = taskRecord.length > 0 ? taskRecord[0].tasks_completed : 0;

        if (completedToday >= plan.daily_tasks) {
            return res.status(400).json({ error: 'Daily task limit reached for today!' });
        }

        // Increment task and update wallet balance
        const reward = parseFloat(plan.earning_per_task);
        completedToday++;

        await pool.execute(
            `INSERT INTO daily_tasks_log (user_id, task_date, tasks_completed, amount_earned) 
             VALUES (?, ?, 1, ?) 
             ON DUPLICATE KEY UPDATE tasks_completed = tasks_completed + 1, amount_earned = amount_earned + ?`,
            [userId, todayStr, reward, reward]
        );

        await pool.execute(
            'UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?',
            [reward, userId]
        );

        return res.json({
            success: true,
            completed: completedToday,
            totalLimit: plan.daily_tasks,
            earned: reward,
            message: `Task completed! ₹${reward} credited to your wallet.`
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 3. WITHDRAWAL SYSTEM (Slabs + Days + 1 Request/Day)
// ==========================================
app.post('/api/withdrawal/request', async (req, res) => {
    const { userId, amount } = req.body;
    const withdrawAmount = parseInt(amount);

    // 1. Fixed Slab Check
    if (!VALID_SLABS.includes(withdrawAmount)) {
        return res.status(400).json({ error: 'Invalid withdrawal amount! Slabs allowed: ₹330, ₹550, ₹950, ₹1320.' });
    }

    try {
        // 2. Bank Bound Check
        const [bank] = await pool.execute(
            'SELECT id FROM user_bank_details WHERE user_id = ? AND is_locked = 1',
            [userId]
        );
        if (bank.length === 0) {
            return res.status(400).json({ error: 'Please bind and lock your bank account before requesting withdrawal.' });
        }

        // 3. One Withdrawal Per Day Check
        const todayStr = new Date().toISOString().split('T')[0];
        const [existingReq] = await pool.execute(
            'SELECT id FROM withdrawal_requests WHERE user_id = ? AND request_date = ?',
            [userId, todayStr]
        );
        if (existingReq.length > 0) {
            return res.status(400).json({ error: 'Only 1 withdrawal request is permitted per day!' });
        }

        // 4. Plan-Wise Day Check
        const [user] = await pool.execute(
            `SELECT u.wallet_balance, p.allowed_withdrawal_day, p.name AS plan_name 
             FROM users u 
             JOIN investment_plans p ON u.active_plan_id = p.id 
             WHERE u.id = ?`,
            [userId]
        );

        if (user.length === 0) {
            return res.status(400).json({ error: 'Active plan required to request withdrawals.' });
        }

        const currentDay = new Date().getDay(); // 1=Mon, 2=Tue
        if (currentDay !== user[0].allowed_withdrawal_day) {
            const allowedDayName = user[0].allowed_withdrawal_day === 1 ? 'Monday' : 'Tuesday';
            return res.status(400).json({
                error: `Withdrawal for ${user[0].plan_name} is only permitted on ${allowedDayName}!`
            });
        }

        // 5. Balance Check
        if (parseFloat(user[0].wallet_balance) < withdrawAmount) {
            return res.status(400).json({ error: 'Insufficient wallet balance!' });
        }

        // Deduct balance and insert request
        await pool.execute(
            'UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?',
            [withdrawAmount, userId]
        );

        await pool.execute(
            'INSERT INTO withdrawal_requests (user_id, amount, slab_check, request_date, status) VALUES (?, ?, ?, ?, "pending")',
            [userId, withdrawAmount, withdrawAmount.toString(), todayStr]
        );

        return res.json({ success: true, message: `Withdrawal request of ₹${withdrawAmount} submitted successfully!` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 4. RECHARGE APPROVAL & 3-TIER MLM COMMISSION
// ==========================================
// Model 2: L1 = 15%, L2 = 5%, L3 = 2%
app.post('/api/admin/recharge/approve', async (req, res) => {
    const { rechargeId } = req.body;

    try {
        const [recharge] = await pool.execute(
            'SELECT * FROM recharge_requests WHERE id = ? AND status = "pending"',
            [rechargeId]
        );

        if (recharge.length === 0) {
            return res.status(404).json({ error: 'Pending recharge request not found.' });
        }

        const rec = recharge[0];
        const [planData] = await pool.execute(
            'SELECT * FROM investment_plans WHERE id = ?',
            [rec.plan_id]
        );
        const plan = planData[0];

        // 1. Activate Plan for User
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + plan.validity_days);

        await pool.execute(
            'UPDATE users SET active_plan_id = ?, plan_activated_at = NOW(), plan_expires_at = ? WHERE id = ?',
            [plan.id, expiresAt, rec.user_id]
        );

        await pool.execute(
            'UPDATE recharge_requests SET status = "approved", processed_at = NOW() WHERE id = ?',
            [rechargeId]
        );

        // 2. Multi-Level Commission Execution (3 Levels)
        const commissionRates = [
            { level: 1, percent: 0.15 }, // Level 1: 15%
            { level: 2, percent: 0.05 }, // Level 2: 5%
            { level: 3, percent: 0.02 }  // Level 3: 2%
        ];

        let currentUserId = rec.user_id;

        for (const tier of commissionRates) {
            const [upline] = await pool.execute(
                'SELECT sponsor_id FROM users WHERE id = ?',
                [currentUserId]
            );

            if (upline.length === 0 || !upline[0].sponsor_id) break;

            const sponsorId = upline[0].sponsor_id;
            const commAmount = parseFloat((rec.amount * tier.percent).toFixed(2));

            // Credit Sponsor
            await pool.execute(
                'UPDATE users SET wallet_balance = wallet_balance + ?, total_commission = total_commission + ? WHERE id = ?',
                [commAmount, commAmount, sponsorId]
            );

            // Log Commission
            await pool.execute(
                'INSERT INTO commission_logs (sponsor_id, downline_user_id, level, recharge_id, commission_amount) VALUES (?, ?, ?, ?, ?)',
                [sponsorId, rec.user_id, tier.level, rechargeId, commAmount]
            );

            currentUserId = sponsorId; // Move to next upline level
        }

        return res.json({ success: true, message: 'Recharge approved and 3-level MLM commission distributed!' });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Annapurna Seeds Server active on port ${PORT}`));
