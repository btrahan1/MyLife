/**
 * js/voice.js
 * Voice Recognition, Audio Commands, and Speech Synthesis for MyLife PWA
 * Hands-free shopping list additions, voice memos, and Co-Pilot dictation
 */

class VoiceController {
    constructor() {
        this.recognition = null;
        this.isListening = false;
        this.targetMode = 'copilot'; // 'copilot', 'note', 'shopping'
        this.onResultCallback = null;
        this.onStatusChange = null;

        this._initSpeechRecognition();
    }

    _initSpeechRecognition() {
        const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRec) {
            console.warn('Web Speech API is not supported in this browser.');
            return;
        }

        this.recognition = new SpeechRec();
        this.recognition.continuous = false;
        this.recognition.interimResults = true;
        this.recognition.lang = 'en-US';

        this.recognition.onstart = () => {
            this.isListening = true;
            if (this.onStatusChange) this.onStatusChange(true);
        };

        this.recognition.onend = () => {
            this.isListening = false;
            if (this.onStatusChange) this.onStatusChange(false);
        };

        this.recognition.onerror = (e) => {
            console.warn('Speech recognition error:', e.error);
            this.isListening = false;
            if (this.onStatusChange) this.onStatusChange(false);
        };

        this.recognition.onresult = (event) => {
            let interimTranscript = '';
            let finalTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; ++i) {
                if (event.results[i].isFinal) {
                    finalTranscript += event.results[i][0].transcript;
                } else {
                    interimTranscript += event.results[i][0].transcript;
                }
            }

            const current = finalTranscript || interimTranscript;

            if (this.onResultCallback) {
                this.onResultCallback(current, !!finalTranscript);
            }

            if (finalTranscript) {
                this._handleNaturalVoiceCommand(finalTranscript.trim());
            }
        };
    }

    isSupported() {
        return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    }

    startListening(mode = 'copilot', onResult = null, onStatus = null) {
        if (!this.recognition) {
            alert('Voice recognition is not supported on this browser or requires HTTPS.');
            return;
        }

        this.targetMode = mode;
        this.onResultCallback = onResult;
        this.onStatusChange = onStatus;

        try {
            this.recognition.start();
        } catch (e) {
            console.warn('Recognition already started:', e);
        }
    }

    stopListening() {
        if (this.recognition && this.isListening) {
            this.recognition.stop();
        }
    }

    toggleListening(mode = 'copilot', onResult = null, onStatus = null) {
        if (this.isListening) {
            this.stopListening();
        } else {
            this.startListening(mode, onResult, onStatus);
        }
    }

    // Natural Language Voice Command Dispatcher
    _handleNaturalVoiceCommand(text) {
        const lower = text.toLowerCase();

        // 1. "Add to shopping list / Add to groceries: [item]"
        if (lower.startsWith('add to shopping list') || lower.startsWith('add to groceries') || lower.startsWith('add to grocery list')) {
            const itemText = text.replace(/^(add to (shopping list|groceries|grocery list)(:|\s+)?)/i, '').trim();
            if (itemText) {
                window.db.run('INSERT INTO shopping_items (title, category, added_date) VALUES (:t, :c, :d)', {
                    ':t': itemText,
                    ':c': 'Groceries',
                    ':d': new Date().toISOString().split('T')[0]
                });
                this.speak(`Added ${itemText} to your grocery list.`);
                if (window.App && window.App.renderShopping) window.App.renderShopping();
                return;
            }
        }

        // 2. "Take a note: [text]" or "Voice note: [text]"
        if (lower.startsWith('take note') || lower.startsWith('take a note') || lower.startsWith('voice note') || lower.startsWith('remember that')) {
            const noteText = text.replace(/^(take (a )?note(:|\s+)?|voice note(:|\s+)?|remember that(:|\s+)?)/i, '').trim();
            if (noteText) {
                window.db.run('INSERT INTO voice_notes (transcript, tags, created_at) VALUES (:t, :tags, :d)', {
                    ':t': noteText,
                    ':tags': 'Voice Memo',
                    ':d': new Date().toISOString().split('T')[0]
                });
                this.speak('Voice note saved.');
                if (window.App && window.App.renderVoiceNotes) window.App.renderVoiceNotes();
                return;
            }
        }

        // 3. Normal dictation into Co-Pilot
        if (this.targetMode === 'copilot' && window.App && window.App.submitVoiceToCopilot) {
            window.App.submitVoiceToCopilot(text);
        }
    }

    // Text to Speech Response
    speak(text) {
        if (!window.speechSynthesis) return;
        const voiceMuted = window.db ? window.db.getSetting('voice_feedback', 'true') === 'false' : false;
        if (voiceMuted) return;

        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.rate = 1.05;
        utter.pitch = 1.0;
        window.speechSynthesis.speak(utter);
    }
}

window.voice = new VoiceController();
