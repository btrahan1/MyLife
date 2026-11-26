/**
 * js/db.js
 * Local-First SQLite WASM Database Engine with IndexedDB Persistent Storage
 * 100% Client-Side, Zero Cloud Leak, Compatible with standard SQLite .db files
 */

class LifeDatabase {
    constructor() {
        this.db = null;
        this.SQL = null;
        this.dbName = 'MyLife_SQLite_Vault';
        this.storeName = 'sqlite_file';
        this.isReady = false;
    }

    async init() {
        if (this.isReady) return;

        if (typeof initSqlJs === 'undefined') {
            throw new Error('SQLite WASM loader (initSqlJs) not found. Verify vendor/sql-wasm.js is loaded.');
        }

        this.SQL = await initSqlJs({
            locateFile: file => `vendor/${file}`
        });

        // Try restoring binary database from IndexedDB
        const savedBinary = await this._loadFromIndexedDB();

        if (savedBinary && savedBinary.byteLength > 0) {
            try {
                this.db = new this.SQL.Database(new Uint8Array(savedBinary));
                // Ensure any newly added tables exist
                this._createSchema();
            } catch (err) {
                console.warn('Failed restoring existing database, creating fresh one:', err);
                this.db = new this.SQL.Database();
                this._createSchema();
                this._seedInitialData();
                await this.persist();
            }
        } else {
            this.db = new this.SQL.Database();
            this._createSchema();
            this._seedInitialData();
            await this.persist();
        }

        this.isReady = true;
    }

    // --- Schema Creation ---

    _createSchema() {
        this.db.run(`
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                account_type TEXT NOT NULL,
                institution TEXT,
                balance REAL NOT NULL,
                last_updated TEXT
            );

            CREATE TABLE IF NOT EXISTS subscriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                category TEXT,
                amount REAL NOT NULL,
                cadence TEXT,
                next_billing_date TEXT,
                status TEXT DEFAULT 'Active',
                notes TEXT
            );

            CREATE TABLE IF NOT EXISTS prescriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                medication_name TEXT NOT NULL,
                dosage TEXT,
                frequency TEXT,
                doctor_name TEXT,
                pharmacy TEXT,
                rx_number TEXT,
                refills_remaining INTEGER DEFAULT 0,
                last_refill_date TEXT,
                days_supply INTEGER DEFAULT 30,
                next_refill_date TEXT,
                notes TEXT
            );

            CREATE TABLE IF NOT EXISTS appointments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                provider_name TEXT NOT NULL,
                specialty TEXT,
                appointment_date TEXT,
                location TEXT,
                purpose TEXT,
                notes TEXT,
                follow_up TEXT
            );

            CREATE TABLE IF NOT EXISTS milestones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                person_or_item TEXT,
                milestone_type TEXT,
                target_date TEXT,
                reminder_days_ahead INTEGER DEFAULT 7,
                notes TEXT,
                gift_ideas TEXT
            );

            CREATE TABLE IF NOT EXISTS maintenance (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                category TEXT,
                frequency_months INTEGER DEFAULT 6,
                last_serviced_date TEXT,
                next_due_date TEXT,
                cost REAL DEFAULT 0.0,
                vendor TEXT,
                notes TEXT
            );

            CREATE TABLE IF NOT EXISTS shopping_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                category TEXT DEFAULT 'Groceries',
                quantity TEXT DEFAULT '1',
                is_completed INTEGER DEFAULT 0,
                added_date TEXT,
                assigned_to TEXT,
                notes TEXT
            );

            CREATE TABLE IF NOT EXISTS voice_notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                transcript TEXT NOT NULL,
                tags TEXT,
                created_at TEXT,
                is_archived INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS family_members (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                relationship TEXT,
                phone TEXT,
                email TEXT,
                is_emergency_contact INTEGER DEFAULT 0,
                shared_access TEXT DEFAULT 'All',
                notes TEXT
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        `);
    }

    // --- Default Realistic Seeding ---

    _seedInitialData() {
        const count = this.query("SELECT COUNT(*) AS c FROM subscriptions")[0]?.c || 0;
        if (count > 0) return;

        const now = new Date();
        const fmt = d => d.toISOString().split('T')[0];
        const addDays = days => {
            const d = new Date(now);
            d.setDate(d.getDate() + days);
            return fmt(d);
        };
        const addMonths = months => {
            const d = new Date(now);
            d.setMonth(d.getMonth() + months);
            return fmt(d);
        };

        // 1. Accounts
        this.run(`
            INSERT INTO accounts (name, account_type, institution, balance, last_updated) VALUES
            ('Primary Checking', 'Checking', 'Chase Bank', 4250.75, '${fmt(now)}'),
            ('High-Yield Savings', 'Savings', 'Ally Bank', 24800.50, '${fmt(now)}'),
            ('Sapphire Preferred', 'Credit Card', 'Chase', -1124.30, '${fmt(now)}'),
            ('401(k) Vanguard Target', 'Retirement', 'Vanguard', 184500.00, '${fmt(now)}');
        `);

        // 2. Subscriptions
        this.run(`
            INSERT INTO subscriptions (name, category, amount, cadence, next_billing_date, status, notes) VALUES
            ('Gigabit Fiber Internet', 'Utilities', 79.99, 'Monthly', '${addDays(2)}', 'Active', 'Auto-pay on credit card'),
            ('Netflix Standard 4K', 'Streaming', 22.99, 'Monthly', '${addDays(5)}', 'Active', 'Family plan'),
            ('Amazon Prime Membership', 'Shopping', 139.00, 'Annual', '${addDays(22)}', 'Active', 'Renews annually in December'),
            ('Spotify Duo', 'Music', 16.99, 'Monthly', '${addDays(11)}', 'Active', 'Shared account'),
            ('City Power & Electric', 'Utilities', 142.50, 'Monthly', '${addDays(6)}', 'Active', 'Budget billing');
        `);

        // 3. Prescriptions
        this.run(`
            INSERT INTO prescriptions (medication_name, dosage, frequency, doctor_name, pharmacy, rx_number, refills_remaining, last_refill_date, days_supply, next_refill_date, notes) VALUES
            ('Lisinopril', '10mg', 'Once daily in the morning', 'Dr. Sarah Jenkins', 'CVS Pharmacy #4102', 'RX-884219', 3, '${addMonths(-1)}', 30, '${addDays(4)}', 'Take with full glass of water'),
            ('Atorvastatin', '20mg', 'Once daily at bedtime', 'Dr. Sarah Jenkins', 'CVS Pharmacy #4102', 'RX-672910', 1, '${addMonths(-2)}', 90, '${addDays(18)}', 'Lipid panel check next visit');
        `);

        // 4. Appointments
        this.run(`
            INSERT INTO appointments (provider_name, specialty, appointment_date, location, purpose, notes, follow_up) VALUES
            ('Dr. Robert Vance, DDS', 'Dentistry', '${addDays(8)} 09:30 AM', 'Downtown Dental Suite 300', 'Semi-annual teeth cleaning & exam', 'X-rays due', 'Schedule 6-month checkup'),
            ('Dr. Sarah Jenkins, MD', 'Internal Medicine', '${addDays(24)} 02:00 PM', 'Memorial Health Plaza', 'Annual Physical & Bloodwork', 'Fasting required 8 hrs prior', 'Review cholesterol panel');
        `);

        // 5. Milestones
        this.run(`
            INSERT INTO milestones (title, person_or_item, milestone_type, target_date, reminder_days_ahead, notes, gift_ideas) VALUES
            ('Sarah''s Birthday', 'Sarah', 'Birthday', '${addDays(14)}', 7, 'Turning 38! Planning dinner party.', 'Espresso machine accessory, cashmere scarf'),
            ('Wedding Anniversary', 'Bart & Sarah', 'Anniversary', '${addDays(45)}', 14, '12 wonderful years together.', 'Weekend getaway in Sonoma');
        `);

        // 6. Maintenance
        this.run(`
            INSERT INTO maintenance (title, category, frequency_months, last_serviced_date, next_due_date, cost, vendor, notes) VALUES
            ('Synthetic Oil Change & Inspection', 'Vehicle', 6, '${addMonths(-5)}', '${addDays(12)}', 89.50, 'Precision Auto Care', 'Toyota RAV4 - Mobil 1 0W-20'),
            ('Whole-House HVAC Filter Replacement', 'Home', 3, '${addMonths(-3)}', '${addDays(3)}', 45.00, 'DIY', 'Filter size: 20x25x4 MERV 11');
        `);

        // 7. Shopping Items (New!)
        this.run(`
            INSERT INTO shopping_items (title, category, quantity, is_completed, added_date, assigned_to, notes) VALUES
            ('Almond Milk (Unsweetened)', 'Groceries', '2 cartons', 0, '${fmt(now)}', 'Bart', 'Organic preferred'),
            ('HVAC Filter 20x25x4', 'Hardware', '1 pack', 0, '${fmt(now)}', 'Bart', 'MERV 11 for spring allergens'),
            ('Fresh Ground Coffee Beans', 'Groceries', '1 bag', 0, '${fmt(now)}', 'Sarah', 'Medium roast Ethiopia');
        `);

        // 8. Voice Notes (New!)
        this.run(`
            INSERT INTO voice_notes (transcript, tags, created_at) VALUES
            ('Plumber checked water heater. Anode rod is good for another 2 years. Pressure valve was replaced.', 'Home, Maintenance', '${fmt(now)}');
        `);

        // 9. Family Circle (New!)
        this.run(`
            INSERT INTO family_members (name, relationship, phone, email, is_emergency_contact, shared_access, notes) VALUES
            ('Sarah', 'Spouse', '(555) 234-5678', 'sarah@example.com', 1, 'All', 'Co-organizer of household vault'),
            ('Emma', 'Child', '(555) 345-6789', 'emma@example.com', 0, 'Calendar & Shopping', 'High school sophomore');
        `);

        // 10. Settings
        this.run(`
            INSERT OR REPLACE INTO settings (key, value) VALUES
            ('user_name', 'Bart'),
            ('ai_mode', 'local'),
            ('local_endpoint', '/api/llm/v1'),
            ('cloud_endpoint', 'https://api.openai.com/v1'),
            ('cloud_model', 'gpt-4o-mini'),
            ('cloud_api_key', '');
        `);
    }

    // --- Query Execution Helpers ---

    query(sql, params = {}) {
        if (!this.db) throw new Error('Database not initialized.');
        const stmt = this.db.prepare(sql);
        stmt.bind(params);
        const rows = [];
        while (stmt.step()) {
            rows.push(stmt.getAsObject());
        }
        stmt.free();
        return rows;
    }

    run(sql, params = {}) {
        if (!this.db) throw new Error('Database not initialized.');
        if (Object.keys(params).length > 0) {
            this.db.run(sql, params);
        } else {
            this.db.run(sql);
        }
        // Debounced or direct async persist
        this.persist();
    }

    // --- IndexedDB Persistence ---

    async persist() {
        if (!this.db) return;
        const binary = this.db.export();
        await this._saveToIndexedDB(binary);
    }

    _openIDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.dbName, 1);
            req.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async _saveToIndexedDB(uint8Array) {
        try {
            const idb = await this._openIDB();
            return new Promise((resolve, reject) => {
                const tx = idb.transaction(this.storeName, 'readwrite');
                const store = tx.objectStore(this.storeName);
                store.put(uint8Array, 'vault_binary');
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.error('Failed saving SQLite to IndexedDB:', e);
        }
    }

    async _loadFromIndexedDB() {
        try {
            const idb = await this._openIDB();
            return new Promise((resolve, reject) => {
                const tx = idb.transaction(this.storeName, 'readonly');
                const store = tx.objectStore(this.storeName);
                const req = store.get('vault_binary');
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        } catch (e) {
            console.warn('Could not read from IndexedDB:', e);
            return null;
        }
    }

    // --- Import / Export ---

    exportDatabaseBlob() {
        if (!this.db) throw new Error('Database not open.');
        const binary = this.db.export();
        return new Blob([binary], { type: 'application/x-sqlite3' });
    }

    async importDatabaseBuffer(arrayBuffer) {
        this.db.close();
        this.db = new this.SQL.Database(new Uint8Array(arrayBuffer));
        this._createSchema();
        await this.persist();
    }

    // --- Domain Helpers ---

    getAccounts() {
        return this.query('SELECT * FROM accounts ORDER BY balance DESC');
    }

    getSubscriptions() {
        return this.query('SELECT * FROM subscriptions ORDER BY next_billing_date ASC');
    }

    getPrescriptions() {
        return this.query('SELECT * FROM prescriptions ORDER BY next_refill_date ASC');
    }

    getAppointments() {
        return this.query('SELECT * FROM appointments ORDER BY appointment_date ASC');
    }

    getMilestones() {
        return this.query('SELECT * FROM milestones ORDER BY target_date ASC');
    }

    getMaintenance() {
        return this.query('SELECT * FROM maintenance ORDER BY next_due_date ASC');
    }

    getShoppingItems() {
        return this.query('SELECT * FROM shopping_items ORDER BY is_completed ASC, id DESC');
    }

    getVoiceNotes() {
        return this.query('SELECT * FROM voice_notes ORDER BY id DESC');
    }

    getFamilyMembers() {
        return this.query('SELECT * FROM family_members ORDER BY is_emergency_contact DESC, id ASC');
    }

    getSetting(key, defVal = '') {
        const rows = this.query('SELECT value FROM settings WHERE key = :key', { ':key': key });
        return rows.length > 0 ? rows[0].value : defVal;
    }

    setSetting(key, val) {
        this.run('INSERT OR REPLACE INTO settings (key, value) VALUES (:key, :val)', {
            ':key': key,
            ':val': String(val)
        });
    }

    deleteRecord(table, id) {
        // Sanitize table name against whitelist
        const allowed = ['accounts', 'subscriptions', 'prescriptions', 'appointments', 'milestones', 'maintenance', 'shopping_items', 'voice_notes', 'family_members'];
        if (!allowed.includes(table)) throw new Error('Invalid table: ' + table);
        this.run(`DELETE FROM ${table} WHERE id = :id`, { ':id': id });
    }

    // Full Life Vault JSON for Co-Pilot context
    getFullContextJson() {
        return JSON.stringify({
            accounts: this.getAccounts(),
            subscriptions: this.getSubscriptions(),
            prescriptions: this.getPrescriptions(),
            appointments: this.getAppointments(),
            milestones: this.getMilestones(),
            maintenance: this.getMaintenance(),
            shopping: this.getShoppingItems().filter(i => !i.is_completed),
            family: this.getFamilyMembers(),
            userName: this.getSetting('user_name', 'Bart')
        }, null, 2);
    }
}

// Global instance
window.db = new LifeDatabase();
