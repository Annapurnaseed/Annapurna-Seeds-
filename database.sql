-- Annapurna Seeds Database Engine
CREATE DATABASE IF NOT EXISTS annapurna_seeds;
USE annapurna_seeds;

-- 1. Users Table (Core Auth & MLM Tree)
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    mobile VARCHAR(10) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    referral_code VARCHAR(15) NOT NULL UNIQUE,
    sponsor_id INT NULL,
    wallet_balance DECIMAL(10,2) DEFAULT 0.00,
    total_commission DECIMAL(10,2) DEFAULT 0.00,
    active_plan_id INT DEFAULT NULL,
    plan_activated_at DATETIME NULL,
    plan_expires_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sponsor_id) REFERENCES users(id) ON DELETE SET NULL
);

-- 2. Bank Details (1 ID = 1 Locked Bank, Duplicate Ban Across DB)
CREATE TABLE IF NOT EXISTS user_bank_details (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL UNIQUE,
    holder_name VARCHAR(100) NOT NULL,
    account_number VARCHAR(25) NOT NULL UNIQUE, -- System me dobara koi use nahi kar sakta
    ifsc_code VARCHAR(15) NOT NULL,
    is_locked TINYINT(1) DEFAULT 1,
    bound_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 3. Investment Plans Definition
CREATE TABLE IF NOT EXISTS investment_plans (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    daily_tasks INT NOT NULL,
    earning_per_task DECIMAL(10,2) NOT NULL,
    daily_earning DECIMAL(10,2) NOT NULL,
    validity_days INT NOT NULL,
    allowed_withdrawal_day TINYINT NOT NULL COMMENT '1=Monday, 2=Tuesday',
    is_active TINYINT(1) DEFAULT 1
);

-- Pre-seed Plans
INSERT INTO investment_plans (name, price, daily_tasks, earning_per_task, daily_earning, validity_days, allowed_withdrawal_day, is_active)
VALUES 
('Sprout Plan (A)', 520.00, 5, 10.00, 50.00, 60, 1, 1),
('Harvest Plan (B)', 1500.00, 10, 15.00, 150.00, 90, 2, 1),
('Golden Crop Plan (C)', 2500.00, 15, 20.00, 300.00, 120, 2, 1);

-- 4. Daily Task Execution Log (No Work = No Pay)
CREATE TABLE IF NOT EXISTS daily_tasks_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    task_date DATE NOT NULL,
    tasks_completed INT DEFAULT 0,
    amount_earned DECIMAL(10,2) DEFAULT 0.00,
    UNIQUE KEY user_daily_task (user_id, task_date),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 5. Recharge / Payment Submissions (Manual UPI & UTR)
CREATE TABLE IF NOT EXISTS recharge_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    plan_id INT NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    utr_number VARCHAR(12) NOT NULL UNIQUE,
    status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id) REFERENCES investment_plans(id)
);

-- 6. Withdrawal Requests (Strict Fixed Slabs & 1 Per Day Limit)
CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    slab_check ENUM('330', '550', '950', '1320') NOT NULL,
    request_date DATE NOT NULL,
    status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 7. Multi-Level Commission Ledger (15%, 5%, 2%)
CREATE TABLE IF NOT EXISTS commission_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sponsor_id INT NOT NULL,
    downline_user_id INT NOT NULL,
    level TINYINT NOT NULL COMMENT '1, 2, or 3',
    recharge_id INT NOT NULL,
    commission_amount DECIMAL(10,2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sponsor_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (downline_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (recharge_id) REFERENCES recharge_requests(id)
);
