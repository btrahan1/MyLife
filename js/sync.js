/**
 * js/sync.js
 * Zero-Knowledge Private Backup & Database Sync for MyLife PWA
 * Supports binary SQLite .db export/import and password-encrypted JSON vaults
 */

class SyncController {
    // 1. Export standard SQLite .db file directly for user backup or desktop app
    exportSqliteFile() {
        try {
            const blob = window.db.exportDatabaseBlob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const dateStr = new Date().toISOString().split('T')[0];
            a.href = url;
            a.download = `mylife-vault-${dateStr}.db`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            alert('Failed exporting SQLite database: ' + err.message);
        }
    }

    // 2. Import standard SQLite .db file
    async importSqliteFile(file) {
        if (!file) return;
        try {
            const arrayBuffer = await file.arrayBuffer();
            await window.db.importDatabaseBuffer(arrayBuffer);
            alert('Database imported successfully! Refreshing dashboard...');
            if (window.App && window.App.loadDashboard) {
                await window.App.loadDashboard();
            }
        } catch (err) {
            alert('Failed importing database: ' + err.message);
        }
    }

    // 3. Encrypted Export (AES-256-GCM with PBKDF2 user password)
    async exportEncryptedVault(password) {
        if (!password) {
            alert('Please provide a password to encrypt your vault.');
            return;
        }

        const dataStr = window.db.getFullContextJson();
        const enc = new TextEncoder();
        const salt = window.crypto.getRandomValues(new Uint8Array(16));
        const iv = window.crypto.getRandomValues(new Uint8Array(12));

        const key = await this._deriveKey(password, salt);
        const encrypted = await window.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            enc.encode(dataStr)
        );

        const payload = {
            version: 1,
            salt: Array.from(salt),
            iv: Array.from(iv),
            data: Array.from(new Uint8Array(encrypted)),
            exportedAt: new Date().toISOString()
        };

        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mylife-encrypted-vault-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // Key Derivation Helper
    async _deriveKey(password, salt) {
        const enc = new TextEncoder();
        const keyMaterial = await window.crypto.subtle.importKey(
            'raw',
            enc.encode(password),
            { name: 'PBKDF2' },
            false,
            ['deriveKey']
        );

        return window.crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt,
                iterations: 100000,
                hash: 'SHA-256'
            },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }
}

window.sync = new SyncController();
