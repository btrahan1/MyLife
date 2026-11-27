/**
 * js/app.js
 * Master UI Controller, Voice Coordination, and SQLite Data Rendering for MyLife PWA
 */

document.addEventListener('DOMContentLoaded', () => {
    App.init();
});

const App = {
    currentTab: 'briefing',
    isStreaming: false,

    async init() {
        this.initTabs();
        this.initModal();
        this.initEventListeners();
        this.updateHeaderDate();

        try {
            await window.db.init();
            document.getElementById('dbStatusBadge').innerText = 'SQLite Ready';
            await this.loadDashboard();
        } catch (err) {
            console.error('Database initialization error:', err);
            document.getElementById('dbStatusBadge').innerText = 'SQLite Error';
            alert('Failed to initialize local SQLite engine: ' + err.message);
        }
    },

    updateHeaderDate() {
        const now = new Date();
        const options = { weekday: 'short', month: 'short', day: 'numeric' };
        document.getElementById('navDateText').innerText = now.toLocaleDateString('en-US', options);
    },

    initTabs() {
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.getAttribute('data-tab');
                this.switchTab(tab);
            });
        });
    },

    switchTab(tab) {
        this.currentTab = tab;
        document.querySelectorAll('.nav-btn').forEach(b => {
            const isActive = b.getAttribute('data-tab') === tab;
            b.classList.toggle('active', isActive);
            if (isActive && window.innerWidth <= 768) {
                b.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
            }
        });

        document.querySelectorAll('.tab-pane').forEach(p => {
            p.classList.toggle('active', p.id === `tab-${tab}`);
        });

        // Reset scroll position to top of page when changing tabs
        const vp = document.getElementById('contentViewport');
        if (vp) vp.scrollTop = 0;

        // Re-render target tab if needed
        if (tab === 'shopping') this.renderShopping();
        if (tab === 'voice') this.renderVoiceNotes();
        if (tab === 'family') this.renderFamily();
    },

    initModal() {
        const btnAdd = document.getElementById('btnQuickAdd');
        if (btnAdd) {
            btnAdd.addEventListener('click', () => {
                this.openAddModal('subscription');
            });
        }

        const modal = document.getElementById('quickAddModal');
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this.closeAddModal();
                }
            });
        }

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeAddModal();
            }
        });

        document.querySelectorAll('.modal-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const type = btn.getAttribute('data-type');
                this.switchModalTab(type);
            });
        });

        this.initSmartInput();
    },

    openAddModal(defaultType = 'subscription') {
        document.getElementById('quickAddModal').classList.add('active');
        this.switchModalTab(defaultType);
    },

    closeAddModal() {
        document.getElementById('quickAddModal').classList.remove('active');
        const banner = document.getElementById('modalSmartStatus');
        if (banner) banner.style.display = 'none';
        const micBtn = document.getElementById('modalMicBtn');
        if (micBtn) micBtn.classList.remove('listening');
        if (window.voice && window.voice.isListening) {
            window.voice.stopListening();
        }
        this._lastExtractedText = null;
        this._lastSourceName = null;
    },

    switchModalTab(type) {
        document.querySelectorAll('.modal-tab-btn').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-type') === type);
        });

        document.querySelectorAll('.modal-form').forEach(f => {
            f.classList.remove('active');
        });

        const formId = 'form' + type.charAt(0).toUpperCase() + type.slice(1);
        const formEl = document.getElementById(formId);
        if (formEl) formEl.classList.add('active');

        // If a document or voice input was recently extracted, auto-fill this tab too!
        if (this._lastExtractedText) {
            this.autoFillFromText(this._lastExtractedText, this._lastSourceName || 'Document');
        }
    },

    initSmartInput() {
        const dropZone = document.getElementById('modalDropZone');
        const micBtn = document.getElementById('modalMicBtn');
        const cameraBtn = document.getElementById('modalCameraBtn');
        const cameraInput = document.getElementById('modalCameraInput');
        const uploadBtn = document.getElementById('modalUploadBtn');
        const fileInput = document.getElementById('modalFileInput');

        // 1. Voice Dictation
        if (micBtn) {
            micBtn.addEventListener('click', () => {
                if (!window.voice || !window.voice.isSupported()) {
                    alert('Voice recognition is not supported on this browser or requires HTTPS.');
                    return;
                }

                if (window.voice.isListening) {
                    window.voice.stopListening();
                } else {
                    this.showSmartStatus('🎙️ Listening... Speak naturally (e.g. "Electric bill $85 due Dec 15")', true);
                    window.voice.startListening('modal_autofill', (transcript, isFinal) => {
                        this.showSmartStatus(`🎙️ "${transcript}"`, true);
                        if (isFinal && transcript.trim()) {
                            this.autoFillFromText(transcript.trim(), 'Voice Dictation');
                        }
                    }, (listening) => {
                        micBtn.classList.toggle('listening', listening);
                        if (!listening) {
                            setTimeout(() => {
                                const banner = document.getElementById('modalSmartStatus');
                                if (banner && banner.innerText.includes('Listening')) {
                                    banner.style.display = 'none';
                                }
                            }, 2000);
                        }
                    });
                }
            });
        }

        // 2. Camera Button & Input
        if (cameraBtn && cameraInput) {
            cameraBtn.addEventListener('click', () => {
                cameraInput.click();
            });
            cameraInput.addEventListener('change', (e) => {
                const file = e.target.files?.[0];
                if (file) {
                    this.processInputFile(file, 'Camera Photo');
                }
                cameraInput.value = '';
            });
        }

        // 3. Upload File Button & Input
        if (uploadBtn && fileInput) {
            uploadBtn.addEventListener('click', () => {
                fileInput.click();
            });
            fileInput.addEventListener('change', (e) => {
                const file = e.target.files?.[0];
                if (file) {
                    this.processInputFile(file, 'Uploaded File');
                }
                fileInput.value = '';
            });
        }

        // 4. Drag & Drop on Drop Zone
        if (dropZone) {
            ['dragenter', 'dragover'].forEach(name => {
                dropZone.addEventListener(name, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dropZone.classList.add('drag-active');
                });
            });

            ['dragleave', 'drop'].forEach(name => {
                dropZone.addEventListener(name, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dropZone.classList.remove('drag-active');
                });
            });

            dropZone.addEventListener('drop', (e) => {
                const file = e.dataTransfer?.files?.[0];
                if (file) {
                    this.processInputFile(file, 'Drag & Drop');
                }
            });
        }
    },

    showSmartStatus(message, showSpinner = true, isHtml = false) {
        const banner = document.getElementById('modalSmartStatus');
        const spinner = document.getElementById('modalSmartSpinner');
        const text = document.getElementById('modalSmartStatusText');
        if (banner && text) {
            banner.style.display = 'flex';
            if (isHtml) {
                text.innerHTML = message;
            } else {
                text.innerText = message;
            }
            if (spinner) spinner.style.display = showSpinner ? 'block' : 'none';
        }
    },

    async processInputFile(file, sourceName) {
        if (!file) return;

        const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
        const isImage = file.type.startsWith('image/');

        if (isPdf) {
            this.showSmartStatus(`📄 Reading ${file.name} (PDF)...`, true);
            try {
                await this.initPdfEngine();
                const parsed = await window.StatementParser.parsePdfFile(file);

                if (parsed.summary && parsed.summary.isStatement) {
                    const ingest = window.StatementParser.ingestStatement(parsed, file.name);
                    
                    this.renderFinances();
                    this.loadDashboard();

                    let msg = ingest.isNewAccount
                        ? `✨ Created <strong>${this.escape(ingest.accountName)}</strong>: Balance $${Number(ingest.summary.balance).toFixed(2)}, due ${ingest.summary.dueDate}, and <strong>${ingest.importedCount} transactions</strong> imported! <button type="button" class="btn btn-sm btn-ghost" style="margin-left:8px; text-decoration:underline; color:var(--accent-cyan);" onclick="App.closeAddModal(); App.switchTab('finances');">View in Finances ➔</button>`
                        : `✨ <strong>${this.escape(ingest.accountName)}</strong> updated: Balance $${Number(ingest.summary.balance).toFixed(2)}, due ${ingest.summary.dueDate}, and <strong>${ingest.importedCount} transactions</strong> imported! <button type="button" class="btn btn-sm btn-ghost" style="margin-left:8px; text-decoration:underline; color:var(--accent-cyan);" onclick="App.closeAddModal(); App.switchTab('finances');">View in Finances ➔</button>`;

                    this.showSmartStatus(msg, false, true);
                    this._lastExtractedText = parsed.rawText;
                    this._lastSourceName = `${sourceName} (${file.name})`;
                    await this.autoFillFromText(parsed.rawText, this._lastSourceName);
                    return;
                }

                const text = parsed.rawText || '';
                this._lastExtractedText = text.trim();
                this._lastSourceName = `${sourceName} (${file.name})`;
                await this.autoFillFromText(text.trim(), this._lastSourceName);
            } catch (err) {
                console.error('PDF Read Error:', err);
                this.showSmartStatus(`⚠️ PDF parse error: ${err.message}`, false);
            }
        } else if (isImage) {
            this.showSmartStatus(`📷 Scanning image with OCR...`, true);
            try {
                const text = await this.extractTextFromImage(file, (msg) => {
                    this.showSmartStatus(`📷 ${msg}`, true);
                });
                if (!text || !text.trim()) {
                    this.showSmartStatus(`⚠️ No text detected in image. Please try another photo or dictate with voice.`, false);
                    return;
                }
                this._lastExtractedText = text.trim();
                this._lastSourceName = `${sourceName} (OCR)`;
                await this.autoFillFromText(text.trim(), this._lastSourceName);
            } catch (err) {
                console.error('OCR Error:', err);
                this.showSmartStatus(`⚠️ OCR scan error: ${err.message}`, false);
            }
        } else {
            // Text, CSV, JSON
            this.showSmartStatus(`📄 Reading ${file.name}...`, true);
            try {
                const reader = new FileReader();
                reader.onload = async () => {
                    const text = reader.result;
                    if (text && text.trim()) {
                        this._lastExtractedText = text.trim();
                        this._lastSourceName = sourceName;
                        await this.autoFillFromText(text.trim(), sourceName);
                    }
                };
                reader.readAsText(file);
            } catch (err) {
                this.showSmartStatus(`⚠️ Failed to read file: ${err.message}`, false);
            }
        }
    },

    async initPdfEngine() {
        if (!window.pdfjsLib) {
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'vendor/pdf.min.js';
                script.onload = () => resolve();
                script.onerror = () => reject(new Error('Failed to load local PDF parser.'));
                document.head.appendChild(script);
            });
        }
        if (window.pdfjsLib) {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
        }
    },

    async extractTextFromPdf(file, onProgress) {
        await this.initPdfEngine();

        const arrayBuffer = await file.arrayBuffer();
        const loadingTask = window.pdfjsLib.getDocument({ data: arrayBuffer });
        const pdf = await loadingTask.promise;

        let fullText = '';
        const numPages = Math.min(pdf.numPages, 4); // First 4 pages contain summary and transactions
        for (let i = 1; i <= numPages; i++) {
            if (onProgress) onProgress(`Reading PDF page ${i} of ${numPages}...`);
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            const pageText = content.items.map(item => item.str).join(' ');
            fullText += pageText + '\n\n';
        }
        return fullText;
    },

    async extractTextFromImage(file, onProgress) {
        if (!window.Tesseract) {
            if (onProgress) onProgress('Loading OCR engine (Tesseract WASM)...');
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
                script.onload = () => resolve();
                script.onerror = () => reject(new Error('Failed to load OCR library. Check network connection.'));
                document.head.appendChild(script);
            });
        }

        const worker = await window.Tesseract.createWorker('eng', 1, {
            logger: m => {
                if (m.status === 'recognizing text' && onProgress) {
                    const pct = Math.round((m.progress || 0) * 100);
                    onProgress(`Recognizing text (${pct}%)...`);
                }
            }
        });

        const ret = await worker.recognize(file);
        await worker.terminate();
        return ret.data?.text || '';
    },

    async autoFillFromText(rawText, sourceName) {
        const activeTabBtn = document.querySelector('.modal-tab-btn.active');
        const activeTab = activeTabBtn ? activeTabBtn.getAttribute('data-type') : 'subscription';

        this.showSmartStatus(`🧠 AI analyzing details for ${activeTab}...`, true);

        try {
            const data = await window.ai.extractFormData(rawText, activeTab);
            if (data && Object.keys(data).length > 0) {
                const filledCount = this.populateFormFields(activeTab, data);
                if (filledCount > 0) {
                    this.showSmartStatus(`✨ Auto-filled ${filledCount} field${filledCount > 1 ? 's' : ''} from ${sourceName}!`, false);
                } else {
                    this.showSmartStatus(`ℹ️ Found details, but no matching fields for ${activeTab}.`, false);
                }
            } else {
                this.showSmartStatus(`⚠️ Could not detect fields from input. You can enter them manually.`, false);
            }
        } catch (err) {
            console.error('Auto-fill error:', err);
            this.showSmartStatus(`⚠️ Extraction error: ${err.message}`, false);
        }
    },

    populateFormFields(type, data) {
        const formId = 'form' + type.charAt(0).toUpperCase() + type.slice(1);
        const form = document.getElementById(formId);
        if (!form) return 0;

        let filledCount = 0;

        for (const [key, val] of Object.entries(data)) {
            if (val === null || val === undefined || val === '') continue;

            const input = form.elements[key];
            if (!input) continue;

            if (input.type === 'checkbox') {
                input.checked = Boolean(val);
                filledCount++;
                input.classList.add('field-highlight');
                setTimeout(() => input.classList.remove('field-highlight'), 2500);
            } else if (input.tagName === 'SELECT') {
                const valLower = String(val).toLowerCase();
                for (let i = 0; i < input.options.length; i++) {
                    if (input.options[i].value.toLowerCase() === valLower || input.options[i].text.toLowerCase().includes(valLower)) {
                        input.selectedIndex = i;
                        filledCount++;
                        input.classList.add('field-highlight');
                        setTimeout(() => input.classList.remove('field-highlight'), 2500);
                        break;
                    }
                }
            } else {
                input.value = val;
                filledCount++;
                input.classList.add('field-highlight');
                setTimeout(() => input.classList.remove('field-highlight'), 2500);
            }
        }

        return filledCount;
    },

    initEventListeners() {
        const copilotInput = document.getElementById('copilotInput');
        copilotInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.sendCopilotMessage();
            }
        });
    },

    async loadDashboard() {
        const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        const currentAiMode = window.db.getSetting('ai_mode');
        if (!currentAiMode) {
            window.db.setSetting('ai_mode', isLocalHost ? 'local' : 'offline');
        }
        this.updateCopilotModeUI();

        // Auto-clear statement transactions once if pending user reset
        if (!window.db.getSetting('cleaned_stmts_v2')) {
            window.db.clearTransactionsAndStatements();
            window.db.setSetting('cleaned_stmts_v2', '1');
        }

        this.renderBriefing();
        this.renderFinances();
        this.renderHealth();
        this.renderMilestones();
        this.renderMaintenance();
        this.renderShopping();
        this.renderVoiceNotes();
        this.renderFamily();
        this.populateSettings();
    },

    setAiMode(mode) {
        window.db.setSetting('ai_mode', mode);
        this.updateCopilotModeUI();
        this.populateSettings();

        // If user selects WebLLM, pre-warm model into GPU memory in background
        if (mode === 'webllm' && window.ai?.prewarmWebLLM) {
            window.ai.prewarmWebLLM();
        }
    },

    updateCopilotModeUI() {
        const mode = window.db.getSetting('ai_mode', 'offline');
        const indicator = document.getElementById('copilotModeIndicator');
        const chipWebLLM = document.getElementById('chipWebLLM');
        const chipLocal = document.getElementById('chipLocal');
        const chipOffline = document.getElementById('chipOffline');

        if (chipLocal && chipOffline) {
            if (chipWebLLM) chipWebLLM.classList.toggle('active', mode === 'webllm');
            chipLocal.classList.toggle('active', mode === 'local');
            chipOffline.classList.toggle('active', mode === 'offline');
        }

        if (indicator) {
            if (mode === 'webllm') {
                const model = window.db.getSetting('webllm_model', 'Llama-3.2-1B-Instruct-q4f16_1-MLC');
                let shortName = 'Llama 3.2 1B';
                if (model === 'litert-gemma-4-e4b') {
                    shortName = 'Gemma 4 E4B (LiteRT MTP)';
                } else if (model === 'litert-gemma-4-e2b') {
                    shortName = 'Gemma 4 E2B (LiteRT MTP)';
                } else if (model.includes('-')) {
                    shortName = model.split('-')[0] + ' ' + (model.split('-')[1] || '');
                }
                indicator.innerText = `Engine: 🌐 In-Browser WebGPU (${shortName} on device)`;
                indicator.style.color = '#38bdf8';
            } else if (mode === 'local') {
                indicator.innerText = 'Engine: ⚡ Local Qwen 27B (port 8081)';
                indicator.style.color = 'var(--accent-cyan)';
            } else if (mode === 'cloud') {
                indicator.innerText = 'Engine: ☁️ Cloud AI';
                indicator.style.color = 'var(--accent-purple)';
            } else {
                indicator.innerText = 'Engine: 📦 Offline Rule Engine';
                indicator.style.color = 'var(--accent-amber)';
            }
        }
    },

    // --- 1. Briefing Rendering ---

    renderBriefing() {
        const b = window.ai.generateBriefing();

        document.getElementById('heroGreeting').innerText = b.greeting;
        document.getElementById('heroSub').innerText = b.formattedDate;
        document.getElementById('heroUrgentNum').innerText = b.urgentCount;

        const badge = document.getElementById('heroUrgentBadge');
        if (b.urgentCount > 0) {
            badge.style.background = 'rgba(244, 63, 94, 0.2)';
            badge.style.borderColor = 'rgba(244, 63, 94, 0.4)';
        } else {
            badge.style.background = 'rgba(16, 185, 129, 0.15)';
            badge.style.borderColor = 'rgba(16, 185, 129, 0.3)';
        }

        document.getElementById('statBillsDue').innerText = b.upcomingBills.length;
        document.getElementById('statRefillsDue').innerText = b.refillsDue.length;
        document.getElementById('statMilestonesDue').innerText = b.upcomingMilestones.length;

        const shopCount = window.db.getShoppingItems().filter(i => !i.is_completed).length;
        document.getElementById('statShoppingDue').innerText = shopCount;

        // Upcoming Bills Table
        const billsTotal = b.upcomingBills.reduce((acc, x) => acc + Number(x.amount || 0), 0);
        document.getElementById('badgeBillsTotal').innerText = `$${billsTotal.toFixed(2)}`;

        const billsTbody = document.getElementById('briefingBillsTableBody');
        if (b.upcomingBills.length === 0) {
            billsTbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 24px;">🎉 No bills due in the next 10 days!</td></tr>`;
        } else {
            billsTbody.innerHTML = b.upcomingBills.map(bill => `
                <tr>
                    <td><strong>${this.escape(bill.name)}</strong></td>
                    <td style="color: var(--accent-cyan); font-weight: 700;">$${Number(bill.amount).toFixed(2)}</td>
                    <td><span class="feed-badge badge-warning">${bill.next_billing_date}</span></td>
                    <td style="color: var(--text-secondary);">${this.escape(bill.category)}</td>
                </tr>
            `).join('');
        }

        // Refills Container
        const refillsContainer = document.getElementById('briefingRefillsContainer');
        document.getElementById('badgeRefillsCount').innerText = `${b.refillsDue.length} due`;

        if (b.refillsDue.length === 0) {
            refillsContainer.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 24px;">✓ All prescriptions stocked with refills.</div>`;
        } else {
            refillsContainer.innerHTML = b.refillsDue.map(p => `
                <div class="feed-item">
                    <div class="feed-left">
                        <span class="feed-icon">💊</span>
                        <div>
                            <div class="feed-title">${this.escape(p.medication_name)} (${this.escape(p.dosage)})</div>
                            <div class="feed-meta">${this.escape(p.pharmacy || 'Pharmacy')} • ${p.refills_remaining} refills left</div>
                        </div>
                    </div>
                    <span class="feed-badge badge-danger">Due: ${p.next_refill_date}</span>
                </div>
            `).join('');
        }
    },

    // --- 2. Finances Rendering ---

    renderFinances() {
        const accounts = window.db.getAccounts();
        const subs = window.db.getSubscriptions();

        const netWorth = accounts.reduce((acc, a) => acc + Number(a.balance || 0), 0);
        const recurring = subs.reduce((acc, s) => {
            const amt = Number(s.amount || 0);
            return acc + (s.cadence === 'Annual' ? amt / 12 : amt);
        }, 0);

        document.getElementById('finNetWorthDisplay').innerText = `$${netWorth.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
        document.getElementById('finRecurringDisplay').innerText = `$${recurring.toFixed(2)}/mo`;

        // Accounts Grid
        const accContainer = document.getElementById('accountsGrid');
        accContainer.innerHTML = accounts.map(a => `
            <div class="account-card">
                <div class="acc-top">
                    <div>
                        <div class="acc-name">${this.escape(a.name)}</div>
                        <div class="acc-inst">${this.escape(a.institution || 'Bank')}</div>
                    </div>
                    <span class="acc-type-pill">${a.account_type}</span>
                </div>
                <div class="acc-balance ${a.balance < 0 ? 'negative' : ''}">
                    $${Number(a.balance).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:12px;">
                    <span class="acc-updated">Updated: ${a.last_updated || 'Today'}</span>
                    <button class="btn btn-sm btn-ghost" style="color: var(--accent-rose);" onclick="App.deleteRecord('accounts', ${a.id})">Delete</button>
                </div>
            </div>
        `).join('');

        // Subscriptions Table
        const subTbody = document.getElementById('subsTableBody');
        subTbody.innerHTML = subs.map(s => `
            <tr>
                <td><strong>${this.escape(s.name)}</strong></td>
                <td><span class="feed-badge badge-normal">${this.escape(s.category)}</span></td>
                <td style="text-align: right; font-weight: 700; color: var(--accent-cyan);">$${Number(s.amount).toFixed(2)}</td>
                <td>${s.cadence}</td>
                <td>${s.next_billing_date}</td>
                <td><span class="feed-badge badge-normal" style="background: rgba(16,185,129,0.15); color: #34d399;">${s.status}</span></td>
                <td style="color: var(--text-secondary);">${this.escape(s.notes || '--')}</td>
                <td style="text-align: center;">
                    <button class="btn btn-sm btn-ghost" style="color: var(--accent-rose);" onclick="App.deleteRecord('subscriptions', ${s.id})">Delete</button>
                </td>
            </tr>
        `).join('');

        this.renderTransactions();
    },

    renderTransactions(filterAccountId = null, filterQuery = null) {
        const txTbody = document.getElementById('txTableBody');
        if (!txTbody) return;

        const accounts = window.db.getAccounts();
        const acctFilter = document.getElementById('txAccountFilter');
        if (acctFilter && acctFilter.options.length <= 1) {
            accounts.forEach(a => {
                const opt = document.createElement('option');
                opt.value = a.id;
                opt.textContent = a.name;
                acctFilter.appendChild(opt);
            });
        }

        const selectedAccountId = filterAccountId !== null ? filterAccountId : (acctFilter ? acctFilter.value : null);
        const searchInput = document.getElementById('txSearchInput');
        const query = (filterQuery !== null ? filterQuery : (searchInput ? searchInput.value : '')).toLowerCase().trim();

        let txList = window.db.getTransactions(selectedAccountId ? parseInt(selectedAccountId, 10) : null, 150);

        if (query) {
            txList = txList.filter(t => 
                (t.clean_merchant && t.clean_merchant.toLowerCase().includes(query)) ||
                (t.description && t.description.toLowerCase().includes(query)) ||
                (t.category && t.category.toLowerCase().includes(query))
            );
        }

        if (txList.length === 0) {
            txTbody.innerHTML = `
                <tr>
                    <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 24px;">
                        ${query ? 'No transactions matching "' + this.escape(query) + '"' : 'No transactions imported yet. Drop a credit card or bank statement PDF to import!'}
                    </td>
                </tr>
            `;
            return;
        }

        txTbody.innerHTML = txList.map(t => {
            const isIncome = t.type === 'income';
            const amountColor = isIncome ? '#34d399' : 'var(--text-primary)';
            const amountPrefix = isIncome ? '+$' : '$';
            return `
                <tr>
                    <td style="white-space: nowrap; font-size: 12px; color: var(--text-secondary);">${t.date}</td>
                    <td>
                        <strong style="color: var(--text-primary); font-size: 13px;">${this.escape(t.clean_merchant || t.description)}</strong>
                        ${t.clean_merchant && t.clean_merchant !== t.description ? `<div style="font-size: 11px; color: var(--text-muted);">${this.escape(t.description)}</div>` : ''}
                    </td>
                    <td><span class="feed-badge badge-normal" style="font-size: 11px;">${this.escape(t.category || 'General')}</span></td>
                    <td><span style="font-size: 11.5px; color: var(--text-secondary);">${this.escape(t.account_name || 'Card')}</span></td>
                    <td style="text-align: right; font-weight: 700; color: ${amountColor}; font-size: 13.5px;">
                        ${amountPrefix}${Number(t.amount).toFixed(2)}
                    </td>
                </tr>
            `;
        }).join('');
    },

    filterTransactions() {
        const acctFilter = document.getElementById('txAccountFilter');
        const searchInput = document.getElementById('txSearchInput');
        this.renderTransactions(acctFilter ? acctFilter.value : null, searchInput ? searchInput.value : null);
    },

    clearTransactionsAndStatements() {
        if (!confirm('Are you sure you want to clear all imported transactions and statement records?')) return;
        window.db.clearTransactionsAndStatements();
        this.renderFinances();
        this.renderBriefing();
        alert('All transactions and statement records have been cleared!');
    },

    // --- 3. Health Rendering ---

    renderHealth() {
        const rx = window.db.getPrescriptions();
        const apts = window.db.getAppointments();

        const rxContainer = document.getElementById('rxCardsGrid');
        rxContainer.innerHTML = rx.map(p => {
            const pct = Math.max(10, Math.min(100, Math.round((p.refills_remaining / 5) * 100)));
            return `
                <div class="rx-card">
                    <div>
                        <div class="rx-card-top">
                            <div>
                                <strong style="font-size: 16px;">${this.escape(p.medication_name)}</strong>
                                <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">${this.escape(p.frequency)}</div>
                            </div>
                            <span class="rx-dosage">${this.escape(p.dosage)}</span>
                        </div>
                        <div class="rx-progress-bar">
                            <div class="rx-progress-fill" style="width: ${pct}%;"></div>
                        </div>
                        <div style="display: flex; justify-content: space-between; font-size: 11.5px; color: var(--text-muted); margin-bottom: 12px;">
                            <span>Next Refill: <strong>${p.next_refill_date}</strong></span>
                            <span>${p.refills_remaining} refills left</span>
                        </div>
                    </div>
                    <div style="font-size: 12px; color: var(--text-secondary); border-top: 1px solid var(--border-color); padding-top: 10px; display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <div>📍 ${this.escape(p.pharmacy || 'Pharmacy')}</div>
                            <div>👨‍⚕️ ${this.escape(p.doctor_name || 'Doctor')}</div>
                        </div>
                        <button class="btn btn-sm btn-ghost" style="color: var(--accent-rose);" onclick="App.deleteRecord('prescriptions', ${p.id})">Delete</button>
                    </div>
                </div>
            `;
        }).join('');

        const aptTbody = document.getElementById('aptsTableBody');
        aptTbody.innerHTML = apts.map(a => `
            <tr>
                <td><strong>${this.escape(a.provider_name)}</strong></td>
                <td><span class="feed-badge badge-normal">${this.escape(a.specialty)}</span></td>
                <td><strong>${a.appointment_date}</strong></td>
                <td>${this.escape(a.location || '--')}</td>
                <td>${this.escape(a.purpose || '--')}</td>
                <td style="color: var(--text-secondary); font-size: 12px;">${this.escape(a.notes || '--')}</td>
            </tr>
        `).join('');
    },

    // --- 4. Milestones Rendering ---

    renderMilestones() {
        const milestones = window.db.getMilestones();
        const container = document.getElementById('milestonesGrid');
        container.innerHTML = milestones.map(m => `
            <div class="milestone-card">
                <div>
                    <div class="ms-card-top">
                        <div>
                            <strong style="font-size: 16px;">${this.escape(m.title)}</strong>
                            <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">For: ${this.escape(m.person_or_item)}</div>
                        </div>
                        <span class="feed-badge badge-normal">${m.milestone_type}</span>
                    </div>
                    <div style="font-size: 20px; font-weight: 800; color: var(--accent-cyan); margin: 8px 0;">
                        ${m.target_date}
                    </div>
                    ${m.gift_ideas ? `<div style="font-size: 12px; color: var(--text-secondary); margin-top: 6px;">🎁 <em>Gift Ideas:</em> ${this.escape(m.gift_ideas)}</div>` : ''}
                    ${m.notes ? `<div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">📝 ${this.escape(m.notes)}</div>` : ''}
                </div>
                <div style="margin-top: 16px; text-align: right;">
                    <button class="btn btn-sm btn-ghost" style="color: var(--accent-rose);" onclick="App.deleteRecord('milestones', ${m.id})">Delete</button>
                </div>
            </div>
        `).join('');
    },

    // --- 5. Maintenance Rendering ---

    renderMaintenance() {
        const maint = window.db.getMaintenance();
        const container = document.getElementById('maintGrid');
        container.innerHTML = maint.map(m => `
            <div class="maint-card">
                <div>
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                        <strong style="font-size: 15px;">${this.escape(m.title)}</strong>
                        <span class="feed-badge badge-warning">${m.category}</span>
                    </div>
                    <div style="font-size: 13px; color: var(--text-secondary); margin-bottom: 10px;">
                        Due: <strong style="color: var(--text-primary);">${m.next_due_date}</strong>
                        (Every ${m.frequency_months} mos)
                    </div>
                    <div style="font-size: 12px; color: var(--text-muted);">
                        <div>🏢 Vendor: ${this.escape(m.vendor || 'DIY')}</div>
                        <div>💵 Est. Cost: $${Number(m.cost).toFixed(2)}</div>
                        ${m.notes ? `<div style="margin-top: 4px;">📝 ${this.escape(m.notes)}</div>` : ''}
                    </div>
                </div>
                <div style="margin-top: 16px; text-align: right;">
                    <button class="btn btn-sm btn-ghost" style="color: var(--accent-rose);" onclick="App.deleteRecord('maintenance', ${m.id})">Delete</button>
                </div>
            </div>
        `).join('');
    },

    // --- 6. Shopping List Rendering (NEW!) ---

    renderShopping() {
        const items = window.db.getShoppingItems();
        const container = document.getElementById('shoppingItemsList');

        if (items.length === 0) {
            container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 32px;">🛒 Shopping list is empty. Add an item or tap the mic to speak!</div>`;
            return;
        }

        container.innerHTML = items.map(item => `
            <div class="shopping-item-row ${item.is_completed ? 'completed' : ''}">
                <div class="shopping-left">
                    <input type="checkbox" class="shopping-checkbox" ${item.is_completed ? 'checked' : ''} onchange="App.toggleShoppingItem(${item.id}, this.checked)">
                    <div>
                        <div class="shopping-title">${this.escape(item.title)}</div>
                        <div class="shopping-meta">
                            <span>📦 ${this.escape(item.quantity || '1')}</span> • 
                            <span class="feed-badge badge-normal" style="font-size: 10.5px;">${this.escape(item.category)}</span>
                            ${item.assigned_to ? ` • <span>👤 ${this.escape(item.assigned_to)}</span>` : ''}
                        </div>
                    </div>
                </div>
                <button class="btn btn-sm btn-ghost" style="color: var(--accent-rose);" onclick="App.deleteRecord('shopping_items', ${item.id})">✕</button>
            </div>
        `).join('');
    },

    handleQuickShoppingSubmit(e) {
        e.preventDefault();
        const title = document.getElementById('inputShoppingTitle').value.trim();
        const qty = document.getElementById('inputShoppingQty').value.trim() || '1';
        const category = document.getElementById('selectShoppingCategory').value;

        if (!title) return;

        window.db.run(`
            INSERT INTO shopping_items (title, category, quantity, added_date)
            VALUES (:t, :c, :q, :d)
        `, {
            ':t': title,
            ':c': category,
            ':q': qty,
            ':d': new Date().toISOString().split('T')[0]
        });

        document.getElementById('inputShoppingTitle').value = '';
        document.getElementById('inputShoppingQty').value = '';
        this.renderShopping();
    },

    toggleShoppingItem(id, isChecked) {
        window.db.run('UPDATE shopping_items SET is_completed = :c WHERE id = :id', {
            ':c': isChecked ? 1 : 0,
            ':id': id
        });
        this.renderShopping();
    },

    clearCompletedShopping() {
        window.db.run('DELETE FROM shopping_items WHERE is_completed = 1');
        this.renderShopping();
    },

    // --- 7. Voice Notes Rendering (NEW!) ---

    renderVoiceNotes() {
        const notes = window.db.getVoiceNotes();
        const container = document.getElementById('voiceNotesList');

        if (notes.length === 0) {
            container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 32px;">🎙️ No voice notes yet. Tap the microphone above to record your first memo!</div>`;
            return;
        }

        container.innerHTML = notes.map(n => `
            <div class="voice-note-card">
                <div class="voice-note-header">
                    <span>📅 ${n.created_at}</span>
                    <div>
                        <span class="feed-badge badge-normal">${this.escape(n.tags || 'Memo')}</span>
                        <button class="btn btn-sm btn-ghost" style="color: var(--accent-rose); margin-left: 8px;" onclick="App.deleteRecord('voice_notes', ${n.id})">Delete</button>
                    </div>
                </div>
                <div class="voice-note-text">
                    "${this.escape(n.transcript)}"
                </div>
            </div>
        `).join('');
    },

    toggleVoiceRecording() {
        const btn = document.getElementById('btnBigMic');
        const hint = document.getElementById('voiceStatusHint');

        window.voice.toggleListening(
            'note',
            (transcript, isFinal) => {
                hint.innerText = isFinal ? `Recorded: "${transcript}"` : `Listening: ${transcript}...`;
            },
            (isListening) => {
                btn.classList.toggle('listening', isListening);
                hint.innerText = isListening ? '🎙️ Listening... Speak naturally!' : 'Say: "Add to grocery list: Apples" or "Take note: [memo]"';
            }
        );
    },

    triggerQuickVoice() {
        const icon = document.getElementById('voiceHeaderIcon');
        window.voice.toggleListening(
            'copilot',
            (transcript, isFinal) => {
                if (isFinal) {
                    this.switchTab('copilot');
                    document.getElementById('copilotInput').value = transcript;
                    this.sendCopilotMessage();
                }
            },
            (isListening) => {
                icon.innerText = isListening ? '🔴' : '🎙️';
            }
        );
    },

    toggleCopilotMic() {
        const btn = document.getElementById('btnCopilotMic');
        const input = document.getElementById('copilotInput');

        window.voice.toggleListening(
            'copilot',
            (transcript, isFinal) => {
                input.value = transcript;
                if (isFinal) {
                    this.sendCopilotMessage();
                }
            },
            (isListening) => {
                btn.style.color = isListening ? 'var(--accent-rose)' : 'var(--text-primary)';
            }
        );
    },

    submitVoiceToCopilot(text) {
        this.switchTab('copilot');
        document.getElementById('copilotInput').value = text;
        this.sendCopilotMessage();
    },

    // --- 8. Family Circle Rendering (NEW!) ---

    renderFamily() {
        const members = window.db.getFamilyMembers();
        const container = document.getElementById('familyGrid');

        if (members.length === 0) {
            container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 32px;">👨‍👩‍👧 No family members configured yet. Tap "+ Add Member" to add household members.</div>`;
            return;
        }

        container.innerHTML = members.map(m => `
            <div class="family-card">
                <div>
                    <div class="family-card-header">
                        <div style="display: flex; gap: 12px; align-items: center;">
                            <div class="family-avatar">${m.name.charAt(0)}</div>
                            <div>
                                <strong style="font-size: 16px;">${this.escape(m.name)}</strong>
                                <div style="font-size: 12px; color: var(--text-secondary);">${this.escape(m.relationship)}</div>
                            </div>
                        </div>
                        ${m.is_emergency_contact ? '<span class="badge-ice">ICE CONTACT</span>' : ''}
                    </div>
                    <div style="font-size: 13px; color: var(--text-secondary); margin-top: 10px;">
                        ${m.phone ? `<div>📞 ${this.escape(m.phone)}</div>` : ''}
                        ${m.email ? `<div>✉️ ${this.escape(m.email)}</div>` : ''}
                        <div style="margin-top: 4px; font-size: 11.5px; color: var(--text-muted);">Access: ${this.escape(m.shared_access || 'All')}</div>
                    </div>
                </div>
                <div class="family-actions">
                    ${m.phone ? `<a href="tel:${m.phone.replace(/\D/g, '')}" class="btn-contact">📞 Call</a>` : ''}
                    ${m.phone ? `<a href="sms:${m.phone.replace(/\D/g, '')}" class="btn-contact">💬 Text</a>` : ''}
                    <button class="btn btn-sm btn-ghost" style="color: var(--accent-rose);" onclick="App.deleteRecord('family_members', ${m.id})">Delete</button>
                </div>
            </div>
        `).join('');
    },

    // --- 9. Co-Pilot Chat ---

    askQuickPrompt(text) {
        this.switchTab('copilot');
        document.getElementById('copilotInput').value = text;
        this.sendCopilotMessage();
    },

    async sendCopilotMessage() {
        const input = document.getElementById('copilotInput');
        const text = input.value.trim();
        if (!text || this.isStreaming) return;

        input.value = '';

        // User message
        this.appendUserMsg(text);

        // Assistant loading
        const msgId = 'copilot-' + Date.now();
        this.appendAssistantLoading(msgId);

        this.isStreaming = true;
        document.getElementById('btnSendCopilot').disabled = true;

        let streamingAcc = '';

        try {
            const answer = await window.ai.askCoPilot(text, (chunk) => {
                streamingAcc += chunk;
                this.updateStreamingMessage(msgId, streamingAcc);
            });

            this.finalizeAssistantMessage(msgId, answer || streamingAcc || "(No response generated.)");
        } catch (err) {
            this.finalizeAssistantMessage(msgId, `Error communicating with AI: ${err.message}`);
        } finally {
            this.isStreaming = false;
            document.getElementById('btnSendCopilot').disabled = false;
        }
    },

    appendUserMsg(text) {
        const transcript = document.getElementById('copilotTranscript');
        const div = document.createElement('div');
        div.className = 'chat-msg user';
        div.innerHTML = `
            <div class="msg-bubble">${this.escape(text)}</div>
            <div class="msg-avatar">👤</div>
        `;
        transcript.appendChild(div);
        transcript.scrollTop = transcript.scrollHeight;
    },

    appendAssistantLoading(id) {
        const transcript = document.getElementById('copilotTranscript');
        const div = document.createElement('div');
        div.className = 'chat-msg assistant';
        div.id = id;
        div.innerHTML = `
            <div class="msg-avatar">🤖</div>
            <div class="msg-bubble">
                <span style="color: var(--text-muted);"><span class="loading-pulse">●</span> Consulting your private SQLite vault...</span>
            </div>
        `;
        transcript.appendChild(div);
        transcript.scrollTop = transcript.scrollHeight;
    },

    updateStreamingMessage(id, text) {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = `
            <div class="msg-avatar">🤖</div>
            <div class="msg-bubble">${this.renderMarkdown(text)}</div>
        `;
        const transcript = document.getElementById('copilotTranscript');
        transcript.scrollTop = transcript.scrollHeight;
    },

    finalizeAssistantMessage(id, text) {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = `
            <div class="msg-avatar">🤖</div>
            <div class="msg-bubble">${this.renderMarkdown(text)}</div>
        `;
        const transcript = document.getElementById('copilotTranscript');
        transcript.scrollTop = transcript.scrollHeight;
    },

    clearCopilotChat() {
        document.getElementById('copilotTranscript').innerHTML = `
            <div class="chat-msg assistant">
                <div class="msg-avatar">🤖</div>
                <div class="msg-bubble">
                    <p>Chat cleared! Ready for questions about your SQLite life vault.</p>
                </div>
            </div>
        `;
    },

    async clearAppCache() {
        try {
            if ('caches' in window) {
                const keys = await caches.keys();
                await Promise.all(keys.map(k => caches.delete(k)));
            }
            if (navigator.serviceWorker) {
                const regs = await navigator.serviceWorker.getRegistrations();
                for (let r of regs) { await r.unregister(); }
            }
        } catch (e) {}
        window.location.reload(true);
    },

    // --- 10. Settings & Database Import/Export ---

    populateSettings() {
        document.getElementById('settingUserName').value = window.db.getSetting('user_name', 'Bart');
        document.getElementById('settingLocalEndpoint').value = window.db.getSetting('local_endpoint', 'http://127.0.0.1:8081/v1');
        document.getElementById('settingCloudKey').value = window.db.getSetting('cloud_api_key', '');
        
        const hfTokenInput = document.getElementById('settingHfToken');
        if (hfTokenInput) {
            hfTokenInput.value = window.db.getSetting('hf_token', '');
        }

        const webllmModelSelect = document.getElementById('settingWebLLMModel');
        if (webllmModelSelect) {
            webllmModelSelect.value = window.db.getSetting('webllm_model', 'Llama-3.2-1B-Instruct-q4f16_1-MLC');
        }

        const mode = window.db.getSetting('ai_mode', 'offline');
        if (mode === 'disabled') document.getElementById('aiModeDisabled').checked = true;
        else if (mode === 'webllm') document.getElementById('aiModeWebLLM').checked = true;
        else if (mode === 'local') document.getElementById('aiModeLocal').checked = true;
        else if (mode === 'cloud') document.getElementById('aiModeCloud').checked = true;
        else document.getElementById('aiModeOffline').checked = true;
    },

    saveSettings() {
        const mode = document.querySelector('input[name="aiProvider"]:checked')?.value || 'offline';
        const userName = document.getElementById('settingUserName').value.trim() || 'Bart';
        const localEndpoint = document.getElementById('settingLocalEndpoint').value.trim();
        const cloudApiKey = document.getElementById('settingCloudKey').value.trim();
        const hfToken = document.getElementById('settingHfToken')?.value.trim() || '';
        const webllmModel = document.getElementById('settingWebLLMModel')?.value || 'Llama-3.2-1B-Instruct-q4f16_1-MLC';

        window.db.setSetting('ai_mode', mode);
        window.db.setSetting('user_name', userName);
        window.db.setSetting('local_endpoint', localEndpoint);
        window.db.setSetting('cloud_api_key', cloudApiKey);
        window.db.setSetting('hf_token', hfToken);
        window.db.setSetting('webllm_model', webllmModel);

        alert('Settings saved successfully!');
        this.updateCopilotModeUI();
        this.loadDashboard();
    },

    async handleDbFileImport(event) {
        const file = event.target.files?.[0];
        if (file) {
            await window.sync.importSqliteFile(file);
        }
    },

    // --- Modal Form Handlers ---

    handleAddSubscription(e) {
        e.preventDefault();
        const f = e.target;
        window.db.run(`
            INSERT INTO subscriptions (name, category, amount, cadence, next_billing_date, notes)
            VALUES (:n, :c, :a, :cad, :d, :notes)
        `, {
            ':n': f.name.value,
            ':c': f.category.value,
            ':a': parseFloat(f.amount.value) || 0,
            ':cad': f.cadence.value,
            ':d': f.nextBillingDate.value,
            ':notes': f.notes.value || ''
        });
        this.closeAddModal();
        f.reset();
        this.loadDashboard();
    },

    handleAddAccount(e) {
        e.preventDefault();
        const f = e.target;
        window.db.run(`
            INSERT INTO accounts (name, account_type, institution, balance, last_updated)
            VALUES (:n, :t, :i, :b, :d)
        `, {
            ':n': f.name.value,
            ':t': f.accountType.value,
            ':i': f.institution.value || '',
            ':b': parseFloat(f.balance.value) || 0,
            ':d': new Date().toISOString().split('T')[0]
        });
        this.closeAddModal();
        f.reset();
        this.loadDashboard();
    },

    handleAddPrescription(e) {
        e.preventDefault();
        const f = e.target;
        window.db.run(`
            INSERT INTO prescriptions (medication_name, dosage, frequency, refills_remaining, next_refill_date, pharmacy)
            VALUES (:m, :d, :freq, :r, :nextD, :p)
        `, {
            ':m': f.medicationName.value,
            ':d': f.dosage.value || '',
            ':freq': f.frequency.value || '',
            ':r': parseInt(f.refillsRemaining.value, 10) || 0,
            ':nextD': f.nextRefillDate.value,
            ':p': f.pharmacy.value || ''
        });
        this.closeAddModal();
        f.reset();
        this.loadDashboard();
    },

    handleAddMilestone(e) {
        e.preventDefault();
        const f = e.target;
        window.db.run(`
            INSERT INTO milestones (title, milestone_type, target_date, gift_ideas)
            VALUES (:t, :type, :d, :g)
        `, {
            ':t': f.title.value,
            ':type': f.milestoneType.value,
            ':d': f.targetDate.value,
            ':g': f.giftIdeas.value || ''
        });
        this.closeAddModal();
        f.reset();
        this.loadDashboard();
    },

    handleAddMaintenance(e) {
        e.preventDefault();
        const f = e.target;
        window.db.run(`
            INSERT INTO maintenance (title, category, next_due_date, cost, vendor)
            VALUES (:t, :c, :d, :cost, :v)
        `, {
            ':t': f.title.value,
            ':c': f.category.value,
            ':d': f.nextDueDate.value,
            ':cost': parseFloat(f.cost.value) || 0,
            ':v': f.vendor.value || 'DIY'
        });
        this.closeAddModal();
        f.reset();
        this.loadDashboard();
    },

    handleAddFamily(e) {
        e.preventDefault();
        const f = e.target;
        window.db.run(`
            INSERT INTO family_members (name, relationship, phone, email, is_emergency_contact)
            VALUES (:n, :r, :p, :e, :ice)
        `, {
            ':n': f.name.value,
            ':r': f.relationship.value || '',
            ':p': f.phone.value || '',
            ':e': f.email.value || '',
            ':ice': f.isEmergency.checked ? 1 : 0
        });
        this.closeAddModal();
        f.reset();
        this.loadDashboard();
    },

    deleteRecord(table, id) {
        if (!confirm('Are you sure you want to delete this record?')) return;
        window.db.deleteRecord(table, id);
        this.loadDashboard();
    },

    // --- Markdown Renderer ---

    renderMarkdown(text) {
        if (!text) return '';
        let clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        let html = clean
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/^### (.*$)/gim, '<h3 style="margin-top:8px;font-size:14px;color:var(--accent-cyan);">$1</h3>')
            .replace(/^## (.*$)/gim, '<h2 style="margin-top:10px;font-size:15px;color:var(--accent-cyan);">$1</h2>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/^\s*[-*]\s+(.*)$/gim, '<li>$1</li>')
            .replace(/(<li>[\s\S]*?<\/li>)/gi, '<ul style="margin-left:18px;margin-bottom:6px;">$1</ul>')
            .replace(/<\/ul>\s*<ul>/gi, '')
            .replace(/\n{2,}/g, '</p><p style="margin-top:8px;">')
            .replace(/\n/g, '<br>');
        return `<p>${html}</p>`;
    },

    escape(str) {
        if (!str) return '';
        return str.toString()
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
};
