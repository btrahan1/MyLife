/**
 * js/ai.js
 * Life Co-Pilot & Daily Briefing Engine for MyLife PWA
 * 3-Tier AI: 1) Local LLM (port 8081 / Tailscale)  2) Cloud AI  3) 100% Offline Rule Engine
 */

class LifeAI {
    constructor() {
        this.isStreaming = false;
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

        let endpoint = mode === 'local'
            ? window.db.getSetting('local_endpoint', '/api/llm/v1') + '/chat/completions'
            : window.db.getSetting('cloud_endpoint', 'https://api.openai.com/v1') + '/chat/completions';

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
}

window.ai = new LifeAI();
