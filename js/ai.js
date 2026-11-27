/**
 * js/ai.js
 * Life Co-Pilot & Daily Briefing Engine for MyLife PWA
 * 3-Tier AI: 1) Local LLM (port 8081 / Tailscale)  2) Cloud AI  3) 100% Offline Rule Engine
 */

class LifeAI {
    constructor() {
        this.isStreaming = false;
        this.webllmEngine = null;
        this.webllmLoading = false;
        this.litertEngine = null;
        this.litertLoading = false;
    }

    hasWebGPU() {
        return typeof navigator !== 'undefined' && !!navigator.gpu;
    }

    // Create a tracked stream to give real-time download percentage for multi-GB models
    async _createTrackedModelStream(url, hfToken, onProgress) {
        const headers = {};
        if (hfToken) headers['Authorization'] = `Bearer ${hfToken}`;
        const response = await fetch(url, { headers });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} fetching model weights: ${response.statusText}`);
        }
        const totalBytes = parseInt(response.headers.get('content-length') || '0', 10);
        let loadedBytes = 0;
        let lastReport = 0;
        const reader = response.body.getReader();

        return new ReadableStream({
            async start(controller) {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    loadedBytes += value.byteLength;
                    if (totalBytes > 0 && onProgress && (loadedBytes - lastReport > 6 * 1024 * 1024 || loadedBytes === totalBytes)) {
                        lastReport = loadedBytes;
                        onProgress(loadedBytes, totalBytes);
                    }
                    controller.enqueue(value);
                }
                controller.close();
            }
        });
    }

    // Shared LiteRT-LM initializer with live progress feedback
    async _getOrInitLiteRT(onProgressMsg) {
        if (this.litertEngine) return this.litertEngine;
        if (this.litertLoading) {
            throw new Error("Model is currently downloading/initializing. Please wait a moment...");
        }

        this.litertLoading = true;
        const modelKey = window.db.getSetting('webllm_model', 'litert-gemma-4-e4b');
        const isE2B = modelKey === 'litert-gemma-4-e2b';
        const modelLabel = isE2B ? 'Gemma 4 E2B' : 'Gemma 4 E4B';
        const modelFileName = isE2B ? 'gemma-4-E2B-it-web.litertlm' : 'gemma-4-E4B-it-web.litertlm';
        const repoName = isE2B ? 'litert-community/gemma-4-E2B-it-litert-lm' : 'litert-community/gemma-4-E4B-it-litert-lm';
        const modelUrl = `https://huggingface.co/${repoName}/resolve/main/${modelFileName}`;
        const hfToken = window.db.getSetting('hf_token', '');

        try {
            if (onProgressMsg) onProgressMsg(`🌐 Loading @litert-lm/core WebGPU engine...`);
            const litert = await import("https://cdn.jsdelivr.net/npm/@litert-lm/core/+esm");

            if (onProgressMsg) onProgressMsg(`🌐 Connecting to Hugging Face for ${modelLabel} (~${isE2B ? '1.9GB' : '2.8GB'})...`);

            const stream = await this._createTrackedModelStream(modelUrl, hfToken, (loaded, total) => {
                const pct = Math.round((loaded / total) * 100);
                const mbLoaded = Math.round(loaded / (1024 * 1024));
                const mbTotal = Math.round(total / (1024 * 1024));
                if (onProgressMsg) {
                    onProgressMsg(`🌐 Downloading ${modelLabel}: ${pct}% (${mbLoaded}MB / ${mbTotal}MB)...`);
                }
            });

            if (onProgressMsg) onProgressMsg(`🧠 Compiling WebGPU shaders & loading VRAM with MTP Speculative Decoding...`);

            this.litertEngine = await litert.Engine.create({
                model: stream,
                speculativeDecodingConfig: {
                    mode: 'ON'
                }
            });

            this.litertLoading = false;
            return this.litertEngine;
        } catch (err) {
            this.litertLoading = false;
            throw err;
        }
    }

    // Pre-warm In-Browser WebGPU LLM (WebLLM or Google LiteRT) when user taps the chip
    async prewarmWebLLM() {
        if (!this.hasWebGPU()) return;
        const model = window.db.getSetting('webllm_model', 'Llama-3.2-1B-Instruct-q4f16_1-MLC');
        const indicator = document.getElementById('copilotModeIndicator');

        if (model.startsWith('litert')) {
            if (this.litertEngine || this.litertLoading) return;
            const isE2B = model === 'litert-gemma-4-e2b';
            const modelLabel = isE2B ? 'Gemma 4 E2B' : 'Gemma 4 E4B';
            try {
                await this._getOrInitLiteRT((msg) => {
                    if (indicator) {
                        indicator.innerText = `Engine: ${msg}`;
                        indicator.style.color = "var(--accent-amber)";
                    }
                });
                if (indicator) {
                    indicator.innerText = `Engine: 🌐 ${modelLabel} (LiteRT WebGPU Ready ⚡)`;
                    indicator.style.color = "var(--accent-emerald)";
                }
            } catch (err) {
                console.error("LiteRT prewarm error:", err);
                if (indicator) {
                    indicator.innerText = `Engine: 🌐 LiteRT GPU: ${err.message}`;
                    indicator.style.color = "var(--accent-rose)";
                }
            }
            return;
        }

        if (this.webllmEngine || this.webllmLoading) return;
        this.webllmLoading = true;
        if (indicator) {
            indicator.innerText = "Engine: 🌐 In-Browser GPU (Loading model into VRAM...)";
            indicator.style.color = "var(--accent-amber)";
        }
        try {
            const webllm = await import("https://esm.run/@mlc-ai/web-llm");
            this.webllmEngine = await webllm.CreateMLCEngine(model, {
                initProgressCallback: (report) => {
                    if (indicator) {
                        const pct = Math.round((report.progress || 0) * 100);
                        const isCache = (report.text || '').toLowerCase().includes('cache');
                        indicator.innerText = isCache
                            ? `Engine: 🌐 Loading from local disk cache (${pct}%)...`
                            : `Engine: 🌐 In-Browser GPU (${pct}%)...`;
                    }
                }
            });
            this.webllmLoading = false;
            if (indicator) {
                indicator.innerText = "Engine: 🌐 In-Browser GPU (Ready on GPU ⚡)";
                indicator.style.color = "var(--accent-emerald)";
            }
        } catch (err) {
            this.webllmLoading = false;
            console.error("WebLLM prewarm error:", err);
            if (indicator) {
                indicator.innerText = `Engine: 🌐 WebLLM GPU Error: ${err.message}`;
                indicator.style.color = "var(--accent-rose)";
            }
        }
    }

    // --- On-Device Briefing Calculator (0% AI / 100% Instant) ---

    generateBriefing() {
        const now = new Date();
        const userName = window.db.getSetting('user_name', 'Bart');

        const hour = now.getHours();
        const greetingPrefix = hour < 12 ? 'Good morning' : (hour < 18 ? 'Good afternoon' : 'Good evening');
        const greeting = `${greetingPrefix}, ${userName}!`;

        const options = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
        const formattedDate = now.toLocaleDateString('en-US', options);

        const parseDate = s => s ? new Date(s + 'T00:00:00') : new Date(0);
        const diffDays = d => Math.round((parseDate(d) - now) / (1000 * 60 * 60 * 24));

        // 1. Upcoming Bills (next 10 days)
        const allSubs = window.db.getSubscriptions();
        const upcomingBills = allSubs
            .filter(s => {
                const days = diffDays(s.next_billing_date);
                return days >= 0 && days <= 10;
            })
            .sort((a, b) => parseDate(a.next_billing_date) - parseDate(b.next_billing_date));

        // 2. Refills Due (next 7 days)
        const allRx = window.db.getPrescriptions();
        const refillsDue = allRx
            .filter(p => {
                const days = diffDays(p.next_refill_date);
                return days <= 7;
            })
            .sort((a, b) => parseDate(a.next_refill_date) - parseDate(b.next_refill_date));

        // 3. Milestones Due (next 14 days)
        const allMilestones = window.db.getMilestones();
        const upcomingMilestones = allMilestones
            .filter(m => {
                const days = diffDays(m.target_date);
                return days >= 0 && days <= 14;
            })
            .sort((a, b) => parseDate(a.target_date) - parseDate(b.target_date));

        // 4. Maintenance Due (next 14 days or overdue)
        const allMaint = window.db.getMaintenance();
        const maintenanceDue = allMaint
            .filter(m => diffDays(m.next_due_date) <= 14)
            .sort((a, b) => parseDate(a.next_due_date) - parseDate(b.next_due_date));

        // 5. Financial Totals
        const accounts = window.db.getAccounts();
        const totalNetWorth = accounts.reduce((acc, a) => acc + (Number(a.balance) || 0), 0);

        const totalMonthlyRecurring = allSubs.reduce((acc, s) => {
            const amt = Number(s.amount) || 0;
            return acc + (s.cadence === 'Annual' ? amt / 12 : amt);
        }, 0);

        // 6. Urgent Count (items in next 3 days)
        const urgentCount = upcomingBills.filter(b => diffDays(b.next_billing_date) <= 3).length
            + refillsDue.filter(r => diffDays(r.next_refill_date) <= 3).length
            + upcomingMilestones.filter(m => diffDays(m.target_date) <= 3).length
            + maintenanceDue.filter(m => diffDays(m.next_due_date) <= 0).length;

        return {
            greeting,
            formattedDate,
            urgentCount,
            upcomingBills,
            refillsDue,
            upcomingMilestones,
            maintenanceDue,
            totalNetWorth: totalNetWorth.toFixed(2),
            totalMonthlyRecurring: totalMonthlyRecurring.toFixed(2)
        };
    }

    // --- Co-Pilot Dispatcher ---

    async askCoPilot(prompt, onChunk = null) {
        const mode = window.db.getSetting('ai_mode', 'local');

        if (mode === 'disabled') {
            return "AI Co-Pilot is in Offline/Disabled mode. Enable Local Qwen or Cloud AI in Settings anytime!";
        }

        if (mode === 'offline') {
            return this._runOfflineRuleEngine(prompt);
        }

        if (mode === 'webllm') {
            const model = window.db.getSetting('webllm_model', 'Llama-3.2-1B-Instruct-q4f16_1-MLC');
            if (model.startsWith('litert')) {
                return this._callLiteRT(prompt, onChunk);
            }
            return this._callWebLLM(prompt, onChunk);
        }

        if (mode === 'nano') {
            return this._callChromeBuiltInAi(prompt, onChunk);
        }

        let endpoint = mode === 'local'
            ? window.db.getSetting('local_endpoint', '/api/llm/v1') + '/chat/completions'
            : window.db.getSetting('cloud_endpoint', 'https://api.openai.com/v1') + '/chat/completions';

        // If loaded directly from llama-server on LAN (e.g. port 8081)
        if (mode === 'local' && window.location.port === '8081') {
            endpoint = '/v1/chat/completions';
        }

        // Detect GitHub Pages static hosting
        const isStaticHost = window.location.hostname.includes('github.io');
        if (mode === 'local' && isStaticHost && endpoint.startsWith('/')) {
            return `📡 **Local Qwen 27B is running on your GMKtec machine, not in the cloud.**\n\nGitHub Pages hosts this PWA statically, but cannot run your 27B GGUF model.\n\n**Options:**\n• **On your PC / home Wi-Fi:** Open MyLife at \`http://127.0.0.1:5050\` (or your GMKtec IP:5050) to use full 27B Qwen power.\n• **On GitHub Pages:** Tap the **📦 Offline Rules** chip above for instant private on-device processing, or set up **☁️ Cloud AI** in Settings.`;
        }

        const apiKey = window.db.getSetting('cloud_api_key', '');
        const model = mode === 'local' ? 'qwen3.8-27b' : window.db.getSetting('cloud_model', 'gpt-4o-mini');

        const contextJson = window.db.getFullContextJson();

        const systemPrompt = `You are MyLife Co-Pilot, an intelligent, empathetic personal life assistant.
You help the user manage their finances, health, prescriptions, milestones, home/car maintenance, and daily schedule.

CURRENT LIFE CONTEXT DATA (from private SQLite vault):
\`\`\`json
${contextJson}
\`\`\`

INSTRUCTIONS:
- Answer clearly, concisely, and supportively.
- Use clear Markdown formatting with bullet points and bold text.
- Only reference facts in their life context. If not present, state so politely.
- Never leak context to third parties.`;

        const payload = {
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: prompt }
            ],
            temperature: 0.3,
            max_tokens: 1536,
            stream: !!onChunk
        };

        const headers = { 'Content-Type': 'application/json' };
        if (mode === 'cloud' && apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                return `(AI server returned HTTP ${res.status}. Check endpoint or server status in Settings.)`;
            }

            if (onChunk && res.body) {
                const reader = res.body.getReader();
                const decoder = new TextDecoder('utf-8');
                let fullText = '';
                let buffer = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop(); // keep partial line

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || !trimmed.startsWith('data: ')) continue;
                        const dataStr = trimmed.slice(6);
                        if (dataStr === '[DONE]') break;

                        try {
                            const json = JSON.parse(dataStr);
                            const delta = json.choices?.[0]?.delta;
                            if (delta) {
                                const chunk = delta.content || '';
                                if (chunk) {
                                    fullText += chunk;
                                    onChunk(chunk);
                                }
                            }
                        } catch { }
                    }
                }

                return fullText.trim() || "(No response generated.)";
            } else {
                const data = await res.json();
                return data.choices?.[0]?.message?.content || "(No response generated.)";
            }
        } catch (err) {
            console.warn('AI call failed, falling back to on-device engine:', err);
            return `*Note: Unable to reach ${endpoint} (${err.message}). Serving from on-device engine:*\n\n` + this._runOfflineRuleEngine(prompt);
        }
    }

    // --- WebLLM (In-Browser WebGPU LLM on Phone / PC) ---

    async _callWebLLM(prompt, onChunk) {
        if (!this.hasWebGPU()) {
            return `⚠️ **WebGPU is not available in this browser.**\n\n` +
                   `WebLLM requires WebGPU support:\n` +
                   `• **On PC:** Make sure "Hardware Acceleration" is enabled in Chrome Settings (\`chrome://settings/system\`).\n` +
                   `• **On Android:** Make sure you are using modern Chrome on Android 12+.\n\n` +
                   `Falling back to on-device rules:\n\n` + this._runOfflineRuleEngine(prompt);
        }

        const model = window.db.getSetting('webllm_model', 'Llama-3.2-1B-Instruct-q4f16_1-MLC');

        if (!this.webllmEngine) {
            if (this.webllmLoading) {
                return `⏳ WebLLM is currently initializing in the background. Please try again in a few seconds...`;
            }

            this.webllmLoading = true;
            try {
                if (onChunk) onChunk(`🌐 Loading WebLLM runtime into browser...`);
                const webllm = await import("https://esm.run/@mlc-ai/web-llm");

                if (onChunk) onChunk(`🧠 Initializing ${model} on device GPU... (Checking cache / downloading weights)`);

                this.webllmEngine = await webllm.CreateMLCEngine(model, {
                    initProgressCallback: (report) => {
                        if (onChunk && report.text) {
                            onChunk(`🧠 ${report.text}`);
                        }
                    }
                });
                this.webllmLoading = false;
            } catch (err) {
                this.webllmLoading = false;
                console.error("WebLLM load error:", err);
                return `⚠️ Failed to initialize WebLLM (${err.message}). Falling back to on-device rules:\n\n` + this._runOfflineRuleEngine(prompt);
            }
        }

        const contextJson = window.db.getFullContextJson();
        const systemPrompt = `You are MyLife Co-Pilot, an intelligent personal life assistant running directly inside the user's browser GPU via WebLLM.
All data is stored in the user's private SQLite vault on this device.
CURRENT LIFE CONTEXT DATA:
\`\`\`json
${contextJson}
\`\`\`
INSTRUCTIONS:
- Answer clearly, concisely, and supportively.
- Use clear Markdown formatting with bullet points and bold text.
- Reference facts and accurately calculate totals and upcoming dates from the data.`;

        try {
            if (onChunk) onChunk(""); // clear loading message before streaming answer
            const chunks = await this.webllmEngine.chat.completions.create({
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: prompt }
                ],
                temperature: 0.3,
                max_tokens: 1024,
                stream: true
            });

            let fullText = "";
            for await (const chunk of chunks) {
                const delta = chunk.choices[0]?.delta?.content || "";
                if (delta) {
                    fullText += delta;
                    if (onChunk) onChunk(delta);
                }
            }
            return fullText.trim() || "(No response generated.)";
        } catch (err) {
            console.error("WebLLM generation error:", err);
            return `⚠️ WebLLM generation error: ${err.message}. Falling back to on-device rules:\n\n` + this._runOfflineRuleEngine(prompt);
        }
    }

    // --- Google LiteRT-LM (Gemma 4 with MTP Speculative Decoding on WebGPU) ---

    async _callLiteRT(prompt, onChunk) {
        if (!this.hasWebGPU()) {
            return `⚠️ **WebGPU is not available in this browser.**\n\n` +
                   `LiteRT requires WebGPU support:\n` +
                   `• **On PC:** Make sure "Hardware Acceleration" is enabled in Chrome Settings (\`chrome://settings/system\`).\n` +
                   `• **On Android:** Make sure you are using modern Chrome on Android 12+.\n\n` +
                   `Falling back to on-device rules:\n\n` + this._runOfflineRuleEngine(prompt);
        }

        const modelKey = window.db.getSetting('webllm_model', 'litert-gemma-4-e4b');
        const isE2B = modelKey === 'litert-gemma-4-e2b';
        const modelLabel = isE2B ? 'Gemma 4 E2B' : 'Gemma 4 E4B';

        try {
            await this._getOrInitLiteRT((msg) => {
                if (onChunk) onChunk(msg);
                const indicator = document.getElementById('copilotModeIndicator');
                if (indicator) {
                    indicator.innerText = `Engine: ${msg}`;
                    indicator.style.color = "var(--accent-amber)";
                }
            });
        } catch (err) {
            console.error("LiteRT load error:", err);
            const isGatedError = err.message && (err.message.includes('401') || err.message.includes('403') || err.message.includes('gated') || err.message.includes('Unauthorized'));
            const hint = isGatedError
                ? `\n\n💡 *Tip: Gemma 4 requires accepting Google's license agreement on Hugging Face. Once accepted, enter your Hugging Face Access Token in Settings.*`
                : '';
            return `⚠️ Failed to initialize Google LiteRT ${modelLabel} (${err.message}).${hint}\n\nFalling back to on-device rules:\n\n` + this._runOfflineRuleEngine(prompt);
        }

        const contextJson = window.db.getFullContextJson();
        const systemPrompt = `You are MyLife Co-Pilot, an intelligent personal life assistant powered by ${modelLabel} with speculative decoding running locally on device WebGPU via Google LiteRT-LM.
All data is stored in the user's private SQLite vault on this device.

CURRENT LIFE CONTEXT DATA (from private SQLite vault):
\`\`\`json
${contextJson}
\`\`\`

INSTRUCTIONS:
- Answer clearly, concisely, and supportively using the context data above.
- Use clear Markdown formatting with bullet points and bold text.
- Reference facts and accurately calculate totals and upcoming dates from the data.`;

        const userPromptWithContext = `${systemPrompt}\n\nUSER QUESTION: ${prompt}`;

        try {
            if (onChunk) onChunk(""); // clear status text
            const conversation = await this.litertEngine.createConversation();

            const stream = conversation.sendMessageStreaming(userPromptWithContext);
            let fullText = "";
            for await (const chunk of stream) {
                let delta = '';
                if (typeof chunk === 'string') {
                    delta = chunk;
                } else if (chunk.content) {
                    delta = chunk.content.map(c => c.text || '').join('');
                } else if (chunk.text) {
                    delta = chunk.text;
                }
                if (delta) {
                    fullText += delta;
                    if (onChunk) onChunk(delta);
                }
            }
            return fullText.trim() || "(No response generated.)";
        } catch (err) {
            console.error("LiteRT generation error:", err);
            return `⚠️ LiteRT generation error: ${err.message}. Falling back to on-device rules:\n\n` + this._runOfflineRuleEngine(prompt);
        }
    }

    // --- Chrome Built-in AI (Gemini Nano on Device) ---

    async _callChromeBuiltInAi(prompt, onChunk) {
        const modelApi = (typeof ai !== 'undefined' && ai.languageModel) || (window.ai && window.ai.languageModel);

        if (!modelApi) {
            return `⚠️ **Chrome Built-in AI (Gemini Nano) not detected in this Chrome session.**\n\n` +
                   `To activate Gemini Nano in Android Chrome:\n` +
                   `1. Open a new tab in Chrome and go to: \`chrome://flags/#prompt-api-for-gemini-nano\`\n` +
                   `   ➔ Set to **Enabled**\n` +
                   `2. Go to: \`chrome://flags/#optimization-guide-on-device-model\`\n` +
                   `   ➔ Set to **Enabled BypassPerfRequirement**\n` +
                   `3. Tap **Relaunch** at the bottom of Chrome.\n` +
                   `4. Go to \`chrome://components\` and tap "Check for update" next to **Optimization Guide On Device Model**.\n\n` +
                   `Once enabled, Gemini Nano runs 100% locally on your phone's processor with zero servers!`;
        }

        try {
            const capabilities = await modelApi.capabilities();
            if (capabilities.available === 'no') {
                return `⚠️ Gemini Nano is not available on this device hardware (status: ${capabilities.available}).`;
            }

            const contextJson = window.db.getFullContextJson();
            const systemPrompt = `You are MyLife Co-Pilot, an intelligent personal assistant.
All data is stored in the user's private SQLite vault on this device.
Use this context to answer accurately:
${contextJson}`;

            if (onChunk) onChunk("🧠 Consulting on-device Gemini Nano...");

            const session = await modelApi.create({
                systemPrompt: systemPrompt
            });

            if (onChunk && session.promptStreaming) {
                const stream = session.promptStreaming(prompt);
                let fullText = '';
                for await (const chunk of stream) {
                    fullText = chunk;
                    onChunk(fullText);
                }
                return fullText;
            } else {
                return await session.prompt(prompt);
            }
        } catch (err) {
            return `⚠️ Gemini Nano error: ${err.message}. Falling back to on-device rules:\n\n` + this._runOfflineRuleEngine(prompt);
        }
    }

    // --- On-Device Smart Rule-Based Engine (Fallback / Zero-Server Mode) ---

    _runOfflineRuleEngine(prompt) {
        const lower = prompt.toLowerCase();
        const briefing = this.generateBriefing();

        if (lower.includes('bill') || lower.includes('subscription') || lower.includes('pay') || lower.includes('cost') || lower.includes('total')) {
            if (briefing.upcomingBills.length === 0) {
                return `🎉 **Great news!** You have no bills due in the next 10 days. Total monthly recurring is **$${briefing.totalMonthlyRecurring}**.`;
            }
            const sumUpcoming = briefing.upcomingBills.reduce((acc, b) => acc + (Number(b.amount) || 0), 0);
            const list = briefing.upcomingBills.map(b => `- **${b.name}**: $${Number(b.amount).toFixed(2)} (Due: **${b.next_billing_date}**)`).join('\n');
            return `💳 **Upcoming Bills Breakdown (Next 10 Days):**\n\n${list}\n\n` +
                   `💵 **Sum of Listed Upcoming Bills:** **$${sumUpcoming.toFixed(2)}**\n` +
                   `📅 **Total Monthly Recurring Subscriptions:** **$${briefing.totalMonthlyRecurring}**`;
        }

        if (lower.includes('health') || lower.includes('refill') || lower.includes('prescription') || lower.includes('med')) {
            const rx = window.db.getPrescriptions();
            if (rx.length === 0) return "You have no active prescriptions in your health vault.";
            const list = rx.map(p => `- **${p.medication_name}** (${p.dosage}): ${p.refills_remaining} refills left, next refill on **${p.next_refill_date}** (${p.pharmacy})`).join('\n');
            return `💊 **Prescription Status & Refills:**\n\n${list}`;
        }

        if (lower.includes('appointment') || lower.includes('doctor')) {
            const apts = window.db.getAppointments();
            if (apts.length === 0) return "You have no scheduled medical appointments.";
            const list = apts.map(a => `- **${a.appointment_date}** — **${a.provider_name}** (${a.specialty}): ${a.purpose}`).join('\n');
            return `🏥 **Upcoming Medical Appointments:**\n\n${list}`;
        }

        if (lower.includes('net worth') || lower.includes('balance') || lower.includes('money') || lower.includes('account')) {
            const accs = window.db.getAccounts();
            const list = accs.map(a => `- **${a.name}** (${a.institution}): **$${Number(a.balance).toLocaleString('en-US', { minimumFractionDigits: 2 })}**`).join('\n');
            return `💰 **Financial Snapshot:**\n\n${list}\n\n🏆 **Total Estimated Net Worth:** **$${Number(briefing.totalNetWorth).toLocaleString('en-US', { minimumFractionDigits: 2 })}**`;
        }

        if (lower.includes('maintenance') || lower.includes('car') || lower.includes('oil') || lower.includes('filter')) {
            const maint = window.db.getMaintenance();
            if (maint.length === 0) return "No maintenance records found.";
            const list = maint.map(m => `- **${m.title}** (${m.category}): Due **${m.next_due_date}** — Est. $${Number(m.cost).toFixed(2)} (${m.vendor})`).join('\n');
            return `🔧 **Vehicle & Home Maintenance:**\n\n${list}`;
        }

        if (lower.includes('milestone') || lower.includes('birthday') || lower.includes('anniversary')) {
            const ms = window.db.getMilestones();
            if (ms.length === 0) return "No milestones found.";
            const list = ms.map(m => `- **${m.title}** (${m.milestone_type}): **${m.target_date}** (For: ${m.person_or_item})`).join('\n');
            return `🎂 **Milestones & Reminders:**\n\n${list}`;
        }

        if (lower.includes('grocery') || lower.includes('shopping')) {
            const shop = window.db.getShoppingItems().filter(i => !i.is_completed);
            if (shop.length === 0) return "🛒 Your shopping list is currently empty!";
            const list = shop.map(s => `- [ ] **${s.title}** (${s.quantity || '1'})`).join('\n');
            return `🛒 **Current Shopping List:**\n\n${list}`;
        }

        return `Hello **${briefing.greeting.replace('!', '')}**! I am your **MyLife Co-Pilot**.\n\nHere is your quick summary today:\n- 💳 **Bills in next 10d:** ${briefing.upcomingBills.length}\n- 💊 **Prescriptions needing refills:** ${briefing.refillsDue.length}\n- 💰 **Net Worth:** $${Number(briefing.totalNetWorth).toLocaleString()}\n\nAsk me anything about your finances, health, vehicle, shopping list, or milestones!`;
    }

    // --- Multimodal Form Extraction Engine ---

    async extractFormData(text, targetType) {
        if (!text || !text.trim()) return {};

        const mode = window.db ? window.db.getSetting('ai_mode', 'local') : 'local';

        // 1. If LLM is available, attempt structured extraction
        if (mode === 'local' || mode === 'webllm' || mode === 'cloud') {
            try {
                const schemaGuide = {
                    subscription: '{"name":"string","amount":19.99,"cadence":"Monthly|Annual|Weekly","category":"Utilities|Streaming|Software|Shopping|Insurance","nextBillingDate":"YYYY-MM-DD","notes":"string"}',
                    account: '{"name":"string","accountType":"Checking|Savings|Credit Card|Retirement|Investment","institution":"string","balance":1250.00}',
                    prescription: '{"medicationName":"string","dosage":"string","frequency":"string","refillsRemaining":2,"nextRefillDate":"YYYY-MM-DD","pharmacy":"string"}',
                    milestone: '{"title":"string","milestoneType":"Birthday|Anniversary|Holiday|Goal","targetDate":"YYYY-MM-DD","giftIdeas":"string"}',
                    maintenance: '{"title":"string","category":"Vehicle|Home|Appliance|Tech","nextDueDate":"YYYY-MM-DD","cost":45.00,"vendor":"string"}',
                    family: '{"name":"string","relationship":"string","phone":"string","email":"string","isEmergency":true|false}'
                }[targetType] || '{}';

                const prompt = `You are a precise data extraction engine.
Extract information from the user's input to populate a "${targetType}" record.
Today's date is: ${new Date().toISOString().split('T')[0]}.
Return ONLY valid JSON matching this schema:
${schemaGuide}
Do not include markdown codeblocks or explanations. Only output raw JSON.

USER INPUT:
"""
${text}
"""`;

                let rawResponse = '';
                if (mode === 'webllm') {
                    const model = window.db ? window.db.getSetting('webllm_model', 'Llama-3.2-1B-Instruct-q4f16_1-MLC') : '';
                    if (model.startsWith('litert')) {
                        rawResponse = await this._callLiteRT(prompt);
                    } else {
                        rawResponse = await this._callWebLLM(prompt);
                    }
                } else {
                    rawResponse = await this.askCoPilot(prompt);
                }

                const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    return this._mergeAndValidateFields(parsed, text, targetType);
                }
            } catch (err) {
                console.warn('AI LLM form extraction error, falling back to deterministic parser:', err);
            }
        }

        // 2. Deterministic offline rule-based parser (always available and instant!)
        return this._extractFieldsOffline(text, targetType);
    }

    _mergeAndValidateFields(parsed, rawText, targetType) {
        const offline = this._extractFieldsOffline(rawText, targetType);
        const merged = { ...offline, ...parsed };

        for (const k in merged) {
            if (merged[k] === null || merged[k] === undefined || merged[k] === 'null' || merged[k] === '') {
                delete merged[k];
            }
        }
        return merged;
    }

    _parseFlexibleDate(text) {
        if (!text) return null;
        const now = new Date();

        // 1. ISO format: 2026-12-25
        const isoMatch = text.match(/\b(202\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/);
        if (isoMatch) return isoMatch[0];

        // 2. US slash format: 12/25/2026 or 12/25/26 or 12/25
        const slashMatch = text.match(/\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])(?:\/(\d{2,4}))?\b/);
        if (slashMatch) {
            const m = String(slashMatch[1]).padStart(2, '0');
            const d = String(slashMatch[2]).padStart(2, '0');
            let y = slashMatch[3] ? parseInt(slashMatch[3], 10) : now.getFullYear();
            if (y < 100) y += 2000;
            return `${y}-${m}-${d}`;
        }

        // 3. Named month: "December 15, 2026", "Dec 15th", "15 Dec 2026"
        const months = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
        const monthRegex = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?\b/i;
        const mMatch = text.match(monthRegex);
        if (mMatch) {
            const mKey = mMatch[1].toLowerCase().slice(0, 3);
            const m = String(months[mKey]).padStart(2, '0');
            const d = String(mMatch[2]).padStart(2, '0');
            const y = mMatch[3] ? parseInt(mMatch[3], 10) : now.getFullYear();
            return `${y}-${m}-${d}`;
        }

        // 4. "due on the 15th" or "on the 5th"
        const dayMatch = text.match(/\b(?:due\s+on\s+the|on\s+the)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
        if (dayMatch) {
            const day = parseInt(dayMatch[1], 10);
            let m = now.getMonth();
            let y = now.getFullYear();
            if (day < now.getDate()) m++;
            if (m > 11) { m = 0; y++; }
            return `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }

        // 5. "in X days" or "in X weeks"
        const relMatch = text.match(/\bin\s+(\d+)\s*(days?|weeks?|months?)\b/i);
        if (relMatch) {
            const num = parseInt(relMatch[1], 10);
            const unit = relMatch[2].toLowerCase();
            const d = new Date();
            if (unit.startsWith('day')) d.setDate(d.getDate() + num);
            else if (unit.startsWith('week')) d.setDate(d.getDate() + (num * 7));
            else if (unit.startsWith('month')) d.setMonth(d.getMonth() + num);
            return d.toISOString().split('T')[0];
        }

        // 6. "tomorrow" / "next week"
        if (/\btomorrow\b/i.test(text)) {
            const d = new Date();
            d.setDate(d.getDate() + 1);
            return d.toISOString().split('T')[0];
        }
        if (/\bnext week\b/i.test(text)) {
            const d = new Date();
            d.setDate(d.getDate() + 7);
            return d.toISOString().split('T')[0];
        }

        return null;
    }

    _extractFinancialStatement(text) {
        if (!text) return null;
        const isStatement = /(?:New Balance|Statement Balance|Account Balance|Payment Due Date|Minimum Payment|Credit Line|Billing Cycle|Total Due|Purchases and Adjustments)/i.test(text);
        if (!isStatement) return null;

        // Institution
        const instMatch = text.match(/\b(Bank of America|Chase|American Express|Amex|Capital One|Citibank|Citi|Discover|Wells Fargo|US Bank|Barclays|Fidelity|Vanguard|PNC|TD Bank|Charles Schwab|Navy Federal|USAA)\b/i);
        const institution = instMatch ? instMatch[1] : '';

        // Card Brand / Product
        const cardMatch = text.match(/\b(Visa Signature|Visa Platinum|Visa Infinite|Visa|Mastercard|World Elite Mastercard|American Express|Discover)\b/i);
        const cardBrand = cardMatch ? cardMatch[1] : 'Credit Card';

        // Last 4 digits of account
        const acctNumMatch = text.match(/(?:Account\s*(?:#|Number)?[\s:]*)(?:[0-9\s]{8,})?([0-9]{4})\b/i);
        const last4 = acctNumMatch ? acctNumMatch[1] : '';

        // Balance (New Balance Total / Statement Balance)
        const balanceMatch = text.match(/(?:New Balance Total|New Balance|Statement Balance|Account Balance|Total Balance)[\s\S]{0,40}?\$\s*([0-9,]+\.[0-9]{2})/i);
        const balance = balanceMatch ? parseFloat(balanceMatch[1].replace(/,/g, '')) : null;

        // Minimum Payment Due
        const minPayMatch = text.match(/(?:Total Minimum Payment Due|Minimum Payment Due|Current Payment Due|Minimum Payment)[\s\S]{0,40}?\$\s*([0-9,]+\.[0-9]{2})/i);
        const minPayment = minPayMatch ? parseFloat(minPayMatch[1].replace(/,/g, '')) : null;

        // Payment Due Date
        const dueDateMatch = text.match(/(?:Payment Due Date|Due Date)[\s\S]{0,40}?([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4})/i);
        let dueDate = null;
        if (dueDateMatch) {
            const parts = dueDateMatch[1].split(/[\/\-]/);
            const m = parts[0].padStart(2, '0');
            const d = parts[1].padStart(2, '0');
            let y = parts[2];
            if (y.length === 2) y = '20' + y;
            dueDate = `${y}-${m}-${d}`;
        }

        // Credit Line
        const creditLineMatch = text.match(/(?:Total Credit Line|Credit Limit)[\s\S]{0,40}?\$\s*([0-9,]+\.[0-9]{2})/i);
        const creditLine = creditLineMatch ? parseFloat(creditLineMatch[1].replace(/,/g, '')) : null;

        return {
            isStatement: true,
            institution,
            cardBrand,
            last4,
            balance,
            minPayment,
            dueDate,
            creditLine
        };
    }

    _extractFieldsOffline(text, targetType) {
        if (!text) return {};
        const res = {};
        const date = this._parseFlexibleDate(text);
        const stmt = this._extractFinancialStatement(text);

        // Dollar amount
        const amountMatch = text.match(/\$\s*(\d+(?:\.\d{1,2})?)|\b(\d+\.\d{2})\b|\b(\d+)\s*(?:dollars?|bucks)/i);
        const amountVal = amountMatch ? parseFloat(amountMatch[1] || amountMatch[2] || amountMatch[3]) : null;

        if (targetType === 'subscription') {
            // Priority 1: Financial / Credit Card Statement
            if (stmt && stmt.isStatement) {
                res.name = `${stmt.institution || 'Credit Card'} Card${stmt.last4 ? ' (…' + stmt.last4 + ')' : ''}`;
                if (stmt.balance !== null) res.amount = stmt.balance;
                else if (stmt.minPayment !== null) res.amount = stmt.minPayment;
                res.cadence = 'Monthly';
                res.category = 'Shopping';
                if (stmt.dueDate) res.nextBillingDate = stmt.dueDate;
                const notes = [];
                if (stmt.balance !== null) notes.push(`Statement Balance: $${stmt.balance.toFixed(2)}`);
                if (stmt.minPayment !== null) notes.push(`Min Due: $${stmt.minPayment.toFixed(2)}`);
                if (stmt.creditLine !== null) notes.push(`Limit: $${stmt.creditLine.toLocaleString()}`);
                res.notes = notes.join(' | ');
                return res;
            }

            if (amountVal !== null) res.amount = amountVal;
            if (date) res.nextBillingDate = date;

            // Cadence
            if (/annual|yearly|per year|\/yr/i.test(text)) res.cadence = 'Annual';
            else if (/weekly|per week|\/wk/i.test(text)) res.cadence = 'Weekly';
            else if (/monthly|per month|\/mo/i.test(text)) res.cadence = 'Monthly';

            // Category
            if (/electric|power|water|gas|utility|utilities|trash|sewer|internet|wifi/i.test(text)) res.category = 'Utilities';
            else if (/netflix|spotify|hulu|disney|hbo|paramount|youtube|streaming|apple tv/i.test(text)) res.category = 'Streaming';
            else if (/github|adobe|office|chatgpt|openai|software|hosting|aws|cloud/i.test(text)) res.category = 'Software';
            else if (/amazon|costco|walmart|shopping/i.test(text)) res.category = 'Shopping';
            else if (/insurance|geico|progressive|state farm|allstate/i.test(text)) res.category = 'Insurance';

            // Name
            let name = text.replace(/(i subscribed to|subscribed to|add subscription for|subscription|bill for|\$\s*\d+(\.\d{2})?|per month|monthly|due on.*)/gi, '').trim();
            name = name.split(/[\n,;]/)[0].trim();
            if (name.length > 1 && name.length < 50) res.name = name;
        }

        if (targetType === 'account') {
            // Priority 1: Financial / Credit Card Statement
            if (stmt && stmt.isStatement) {
                if (stmt.balance !== null) res.balance = stmt.balance;
                res.accountType = 'Credit Card';
                if (stmt.institution) res.institution = stmt.institution;
                const brand = stmt.institution ? `${stmt.institution} ${stmt.cardBrand}` : stmt.cardBrand;
                res.name = `${brand}${stmt.last4 ? ' (…' + stmt.last4 + ')' : ''}`;
                return res;
            }

            if (amountVal !== null) res.balance = amountVal;

            if (/checking/i.test(text)) res.accountType = 'Checking';
            else if (/savings|hysa|high yield/i.test(text)) res.accountType = 'Savings';
            else if (/credit card|card|visa|mastercard|amex/i.test(text)) res.accountType = 'Credit Card';
            else if (/401k|ira|roth|retirement/i.test(text)) res.accountType = 'Retirement';
            else if (/investment|brokerage|trading/i.test(text)) res.accountType = 'Investment';

            const instMatch = text.match(/\b(Chase|Fidelity|Vanguard|Charles Schwab|Schwab|Bank of America|BofA|Wells Fargo|Capital One|Citi|Discover|Ally)\b/i);
            if (instMatch) res.institution = instMatch[1];

            let name = text.replace(/(account|balance|\$\s*\d+(\.\d{2})?)/gi, '').trim();
            name = name.split(/[\n,;]/)[0].trim();
            if (name.length > 1 && name.length < 50) res.name = name;
        }

        if (targetType === 'prescription') {
            if (date) res.nextRefillDate = date;

            const dosageMatch = text.match(/\b(\d+(?:\.\d+)?\s*(?:mg|mcg|ml|g|units?))\b/i);
            if (dosageMatch) res.dosage = dosageMatch[1];

            const pharmMatch = text.match(/\b(CVS(?:\s+Pharmacy)?|Walgreens|Costco|Walmart|Rite Aid|Kroger|Publix|Target)\b/i);
            if (pharmMatch) res.pharmacy = pharmMatch[1];

            const refillMatch = text.match(/\b(\d+)\s*refills?\b/i);
            if (refillMatch) res.refillsRemaining = parseInt(refillMatch[1], 10);

            const freqMatch = text.match(/\b(once daily|twice daily|three times daily|every \d+ hours?|at bedtime|in the morning|with food|as needed|q\.?d\.?|b\.?i\.?d\.?)\b/i);
            if (freqMatch) res.frequency = freqMatch[1];

            const rxNameMatch = text.match(/\b([A-Z][a-z]{3,}(?:\s+[A-Z][a-z]+)?)\b/);
            if (rxNameMatch && !['Pharmacy', 'Daily', 'Refill', 'Tablet', 'Capsule', 'Rx', 'Prescription'].includes(rxNameMatch[1])) {
                res.medicationName = rxNameMatch[1];
            }
        }

        if (targetType === 'milestone') {
            if (date) res.targetDate = date;

            if (/birthday|bday/i.test(text)) res.milestoneType = 'Birthday';
            else if (/anniversary/i.test(text)) res.milestoneType = 'Anniversary';
            else if (/holiday|christmas|thanksgiving|easter/i.test(text)) res.milestoneType = 'Holiday';
            else if (/goal|target|deadline/i.test(text)) res.milestoneType = 'Goal';

            let title = text.split(/[\n,;]/)[0].replace(/(remind me|milestone|target date.*)/gi, '').trim();
            if (title.length > 1 && title.length < 60) res.title = title;
        }

        if (targetType === 'maintenance') {
            if (amountVal !== null) res.cost = amountVal;
            if (date) res.nextDueDate = date;

            if (/oil|tire|brake|car|truck|vehicle|wiper|transmission/i.test(text)) res.category = 'Vehicle';
            else if (/hvac|ac|heat|filter|plumb|roof|gutter|lawn|pipe/i.test(text)) res.category = 'Home';
            else if (/fridge|refrigerator|washer|dryer|dishwasher|oven|stove/i.test(text)) res.category = 'Appliance';
            else if (/pc|laptop|backup|router|wifi|battery|server/i.test(text)) res.category = 'Tech';

            const vendorMatch = text.match(/\b(DIY|Valvoline|Jiffy Lube|Firestone|Dealership|Home Depot|Lowe's|Best Buy|Geek Squad)\b/i);
            if (vendorMatch) res.vendor = vendorMatch[1];

            let title = text.split(/[\n,;]/)[0].replace(/(maintenance|service|\$\s*\d+.*)/gi, '').trim();
            if (title.length > 1 && title.length < 60) res.title = title;
        }

        if (targetType === 'family') {
            const phoneMatch = text.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
            if (phoneMatch) res.phone = phoneMatch[0];

            const emailMatch = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
            if (emailMatch) res.email = emailMatch[0];

            if (/spouse|wife|husband/i.test(text)) res.relationship = 'Spouse';
            else if (/son|daughter|child|kid/i.test(text)) res.relationship = 'Child';
            else if (/mother|father|mom|dad|parent/i.test(text)) res.relationship = 'Parent';
            else if (/brother|sister|sibling/i.test(text)) res.relationship = 'Sibling';
            else if (/friend/i.test(text)) res.relationship = 'Friend';

            if (/emergency|ice/i.test(text)) res.isEmergency = true;

            const nameMatch = text.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
            if (nameMatch) res.name = nameMatch[1];
        }

        return res;
    }
}

window.ai = new LifeAI();
