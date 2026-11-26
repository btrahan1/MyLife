/**
 * js/statementParser.js
 * In-Browser client-side statement and transaction parser for MyLife PWA.
 * Ported from StatementLens with section-aware extraction, merchant cleaning, and categorization.
 */

const StatementParser = {
    async parsePdfFile(file) {
        if (!window.pdfjsLib) {
            throw new Error('PDF.js is not loaded.');
        }

        const arrayBuffer = await file.arrayBuffer();
        const loadingTask = window.pdfjsLib.getDocument({ data: arrayBuffer });
        const pdfDoc = await loadingTask.promise;

        const lines = [];
        let headerTextBlob = '';

        for (let i = 1; i <= pdfDoc.numPages; i++) {
            const page = await pdfDoc.getPage(i);
            const textContent = await page.getTextContent();

            // Group text items by vertical position (Y coordinate) with 4.5px tolerance
            const rowGroups = [];
            for (const item of textContent.items) {
                if (!item.str || item.str.trim() === '') continue;
                const y = item.transform[5];
                const x = item.transform[4];

                let group = rowGroups.find(g => Math.abs(g.y - y) <= 4.5);
                if (!group) {
                    group = { y, items: [] };
                    rowGroups.push(group);
                }
                group.items.push({ x, str: item.str });
            }

            // Sort rows top-to-bottom
            rowGroups.sort((a, b) => b.y - a.y);

            for (const group of rowGroups) {
                group.items.sort((a, b) => a.x - b.x);
                const lineText = group.items.map(it => it.str).join(' ').trim();
                if (lineText.length > 0) {
                    lines.push(lineText);
                    if (i <= 2) headerTextBlob += ' ' + lineText;
                }
            }
        }

        const rawText = lines.join('\n');
        const summary = this.extractStatementSummary(rawText, file.name);
        const detectedYear = summary.statementDate ? summary.statementDate.split('-')[0] : this.detectStatementYear(headerTextBlob, file.name);
        const transactions = this.extractTransactionsFromLines(lines, file.name, detectedYear);

        return {
            summary,
            transactions,
            rawText,
            fileName: file.name
        };
    },

    extractStatementSummary(rawText, fileName = '') {
        // 1. Institution
        const instMatch = rawText.match(/\b(Bank of America|Chase|American Express|Amex|Capital One|Citibank|Citi|Discover|Wells Fargo|US Bank|Barclays|Fidelity|Vanguard|PNC|TD Bank|Charles Schwab|Navy Federal|USAA)\b/i);
        const institution = instMatch ? instMatch[1] : '';

        // 2. Card Brand / Product
        const cardMatch = rawText.match(/\b(Visa Signature|Visa Platinum|Visa Infinite|Visa|Mastercard|World Elite Mastercard|American Express|Discover)\b/i);
        const cardBrand = cardMatch ? cardMatch[1] : 'Credit Card';

        // 3. Last 4 digits of account
        const acctNumMatch = rawText.match(/(?:Account\s*(?:#|Number)?[\s:]*)(?:[0-9\s]{8,})?([0-9]{4})\b/i);
        const last4 = acctNumMatch ? acctNumMatch[1] : '';

        // 4. Balance (New Balance Total / Statement Balance)
        const balanceMatch = rawText.match(/(?:New Balance Total|New Balance|Statement Balance|Account Balance|Total Balance)[\s\S]{0,40}?\$\s*([0-9,]+\.[0-9]{2})/i);
        const balance = balanceMatch ? parseFloat(balanceMatch[1].replace(/,/g, '')) : null;

        // 5. Minimum Payment Due
        const minPayMatch = rawText.match(/(?:Total Minimum Payment Due|Minimum Payment Due|Current Payment Due|Minimum Payment)[\s\S]{0,40}?\$\s*([0-9,]+\.[0-9]{2})/i);
        const minPayment = minPayMatch ? parseFloat(minPayMatch[1].replace(/,/g, '')) : null;

        // 6. Payment Due Date
        const dueDateMatch = rawText.match(/(?:Payment Due Date|Due Date)[\s\S]{0,40}?([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4})/i);
        let dueDate = null;
        if (dueDateMatch) {
            const parts = dueDateMatch[1].split(/[\/\-]/);
            const m = parts[0].padStart(2, '0');
            const d = parts[1].padStart(2, '0');
            let y = parts[2];
            if (y.length === 2) y = '20' + y;
            dueDate = `${y}-${m}-${d}`;
        }

        // 7. Statement Date (Closing Date)
        const stmtDateMatch = rawText.match(/(?:Statement Closing Date|Closing Date|Statement Date)[\s\S]{0,40}?([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4})/i);
        let statementDate = null;
        if (stmtDateMatch) {
            const parts = stmtDateMatch[1].split(/[\/\-]/);
            const m = parts[0].padStart(2, '0');
            const d = parts[1].padStart(2, '0');
            let y = parts[2];
            if (y.length === 2) y = '20' + y;
            statementDate = `${y}-${m}-${d}`;
        } else {
            // Check filename e.g. eStmt_2026-11-15.pdf
            const fnDate = fileName.match(/\b(202\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/);
            if (fnDate) statementDate = fnDate[0];
        }

        // 8. Total Credit Line
        const creditLineMatch = rawText.match(/(?:Total Credit Line|Credit Limit)[\s\S]{0,40}?\$\s*([0-9,]+\.[0-9]{2})/i);
        const creditLine = creditLineMatch ? parseFloat(creditLineMatch[1].replace(/,/g, '')) : null;

        return {
            isStatement: true,
            institution,
            cardBrand,
            last4,
            balance,
            minPayment,
            dueDate,
            statementDate,
            creditLine
        };
    },

    detectStatementYear(text, fileName) {
        const yearMatches = text.match(/\b(202[0-9])\b/g);
        if (yearMatches && yearMatches.length > 0) {
            const counts = {};
            yearMatches.forEach(y => counts[y] = (counts[y] || 0) + 1);
            const sortedYears = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
            return sortedYears[0];
        }
        const fnMatch = fileName.match(/\b(202[0-9])\b/);
        if (fnMatch) return fnMatch[1];
        return new Date().getFullYear().toString();
    },

    extractTransactionsFromLines(lines, sourceName, defaultYear) {
        const transactions = [];
        let counter = 1;

        let currentSection = 'UNKNOWN';

        const isPaymentsCreditsHeader = (text) => {
            const u = text.toUpperCase();
            return (u.includes('PAYMENTS AND OTHER CREDITS') || u.includes('PAYMENTS & OTHER CREDITS') ||
                    u.includes('PAYMENTS AND CREDITS') || u.includes('DEPOSITS & CREDITS') || 
                    u.includes('DEPOSITS AND CREDITS') || u === 'PAYMENTS' || 
                    u.startsWith('PAYMENTS &') || u.startsWith('DEPOSITS'));
        };

        const isPurchasesWithdrawalsHeader = (text) => {
            const u = text.toUpperCase();
            return (u.includes('PURCHASES AND ADJUSTMENTS') || u.includes('PURCHASES & ADJUSTMENTS') || 
                    u === 'PURCHASES' || u.startsWith('PURCHASES &') || u.startsWith('STANDARD PURCHASES') ||
                    u.includes('WITHDRAWALS') || u.includes('ELECTRONIC WITHDRAWALS') || 
                    u.includes('CHECKS PAID') || u.includes('OTHER DEBITS') || 
                    u.includes('CHECK CARD PURCHASES'));
        };

        const isIgnoreSectionHeader = (text) => {
            const u = text.toUpperCase();
            return (u.includes('ACCOUNT SUMMARY') || u.includes('PAYMENT INFORMATION') || 
                    u.includes('DAILY BALANCE SUMMARY') || u.includes('BALANCE SUMMARY') || 
                    u.includes('SUMMARY OF ACCOUNTS') || u.includes('FEES SUMMARY') ||
                    u.includes('INTEREST CHARGED') || u.includes('INTEREST CHARGE CALCULATION') ||
                    u.includes('YEARS TOTAL') || u.includes('TOTALS YEAR-TO-DATE') ||
                    u.includes('YOUR REWARD SUMMARY') || u.includes('IMPORTANT MESSAGES') ||
                    u.includes('EASY STEPS TO BALANCE') || u.includes('IMPORTANT INFORMATION'));
        };

        const amountRegex = /(?:[\$\-\(])?(\d{1,3}(?:,\d{3})*\.\d{2})(?:\s*(?:CR|DR|\-|\)))?$/i;
        const globalAmountRegex = /(?:\$|\b)(-?\d{1,3}(?:,\d{3})*\.\d{2})\b/g;

        for (let line of lines) {
            line = line.trim();
            if (line.length < 3) continue;

            if (isPaymentsCreditsHeader(line)) {
                currentSection = 'PAYMENTS_CREDITS';
                continue;
            } else if (isPurchasesWithdrawalsHeader(line)) {
                currentSection = 'PURCHASES_WITHDRAWALS';
                continue;
            } else if (isIgnoreSectionHeader(line)) {
                currentSection = 'IGNORE';
                continue;
            }

            if (currentSection === 'IGNORE') continue;

            const upper = line.toUpperCase();
            if (upper.startsWith('TOTAL ') || upper.startsWith('PREVIOUS BALANCE') || 
                upper.startsWith('NEW BALANCE') || upper.startsWith('CURRENT PAYMENT') ||
                upper.startsWith('TRANSACTION DATE') || upper.startsWith('REFERENCE NUMBER') ||
                upper.includes('PAGE ') || upper.startsWith('SUBTOTAL')) {
                continue;
            }

            const firstDateMatch = line.match(/^(\d{1,2}[\/\-\.]\d{1,2}(?:[\/\-\.]\d{2,4})?)/);
            if (!firstDateMatch) continue;

            const primaryDateStr = firstDateMatch[1];
            let remainder = line.substring(this.primaryDateMatchEnd(line, primaryDateStr)).trim();

            const secondDateMatch = remainder.match(/^(\d{1,2}[\/\-\.]\d{1,2}(?:[\/\-\.]\d{2,4})?)\s+/);
            if (secondDateMatch) {
                remainder = remainder.substring(secondDateMatch[0].length).trim();
            }

            let amountVal = null;
            let rawAmountMatch = null;

            const endMatch = remainder.match(amountRegex);
            if (endMatch) {
                rawAmountMatch = endMatch[0];
                amountVal = parseFloat(endMatch[1].replace(/,/g, ''));
            } else {
                const allAmounts = remainder.match(globalAmountRegex);
                if (allAmounts && allAmounts.length > 0) {
                    rawAmountMatch = allAmounts[allAmounts.length - 1];
                    const numStr = rawAmountMatch.replace(/[\$,]/g, '');
                    amountVal = Math.abs(parseFloat(numStr));
                }
            }

            if (amountVal !== null && !isNaN(amountVal) && amountVal > 0) {
                let desc = remainder;
                if (rawAmountMatch) {
                    const lastIdx = desc.lastIndexOf(rawAmountMatch);
                    if (lastIdx !== -1) {
                        desc = desc.substring(0, lastIdx).trim();
                    }
                }

                desc = desc.replace(/\s+\d{4}\s+\d{4}$/, '');
                desc = desc.replace(/\s+\d{4}$/, '');
                desc = desc.replace(/[\$\*\#\-\–]/g, ' ').replace(/\s+/g, ' ').trim();

                if (/[a-zA-Z]{2,}/.test(desc)) {
                    let isIncome = (currentSection === 'PAYMENTS_CREDITS');
                    if (currentSection === 'PURCHASES_WITHDRAWALS') isIncome = false;
                    else if (upper.includes('PAYMENT') || upper.includes('CREDIT') || upper.includes('PAYROLL')) {
                        isIncome = true;
                    }

                    const normDate = this.normalizeDate(primaryDateStr, defaultYear);
                    const clean = this.heuristicCleanMerchant(desc);
                    const cat = isIncome ? 'Income' : this.heuristicCategory(desc);
                    const isSub = !isIncome && this.heuristicIsSubscription(desc);

                    transactions.push({
                        id: `tx_${Date.now()}_${counter++}`,
                        date: normDate,
                        originalText: desc,
                        cleanMerchant: clean,
                        category: cat,
                        amount: isIncome ? -amountVal : amountVal,
                        type: isIncome ? 'income' : 'expense',
                        isSubscription: isSub
                    });
                }
            }
        }

        return transactions;
    },

    primaryDateMatchEnd(line, dateStr) {
        const idx = line.indexOf(dateStr);
        return idx === -1 ? 0 : idx + dateStr.length;
    },

    normalizeDate(dateStr, defaultYear = '2026') {
        try {
            if (!dateStr) return `${defaultYear}-01-01`;
            dateStr = dateStr.trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
            
            const slashMatch = dateStr.match(/^(\d{1,2})[\/\-\.](\d{1,2})(?:[\/\-\.](\d{2,4}))?$/);
            if (slashMatch) {
                let m = slashMatch[1].padStart(2, '0');
                let d = slashMatch[2].padStart(2, '0');
                let y = slashMatch[3] ? slashMatch[3] : defaultYear;
                if (y.length === 2) y = '20' + y;
                return `${y}-${m}-${d}`;
            }

            const parsed = new Date(dateStr + ` ${defaultYear}`);
            if (!isNaN(parsed.getTime())) {
                return parsed.toISOString().split('T')[0];
            }
        } catch (e) { }
        return `${defaultYear}-01-01`;
    },

    heuristicCleanMerchant(desc) {
        let clean = desc;
        clean = clean.replace(/Card Purchase\s*/gi, '');
        clean = clean.replace(/Recurring Card Transaction\s*/gi, '');
        clean = clean.replace(/ACH Pmt\s*/gi, '');
        clean = clean.replace(/Payment\s*/gi, '');
        clean = clean.replace(/TST\*\s*/gi, '');
        clean = clean.replace(/SQ\s*\*\s*/gi, '');
        
        if (/HELP\.HBOMAX|HBOMAX/i.test(clean)) return 'HBO Max';
        if (/Netflix/i.test(clean)) return 'Netflix';
        if (/WENDYS/i.test(clean)) return "Wendy's";
        if (/KROGER/i.test(clean)) return 'Kroger';
        if (/SUBWAY/i.test(clean)) return 'Subway';
        if (/WALGREENS/i.test(clean)) return 'Walgreens';
        if (/PAPA JOHNS/i.test(clean)) return "Papa John's";
        if (/AMAZON PRIME/i.test(clean)) return 'Amazon Prime';
        if (/Kindle Unltd/i.test(clean)) return 'Amazon Kindle Unlimited';
        if (/AMAZON MKTPL|Amzn\.com/i.test(clean)) return 'Amazon';
        if (/INMAN-MURPHY PEST/i.test(clean)) return 'Inman-Murphy Pest Control';
        if (/LAS MARGARITAS/i.test(clean)) return 'Las Margaritas';
        if (/BURGER KING/i.test(clean)) return 'Burger King';
        if (/RYANS LAWN CARE/i.test(clean)) return "Ryan's Lawn Care";
        if (/TMX\*Terminix/i.test(clean)) return 'Terminix Pest Control';
        if (/Google\*ONE/i.test(clean)) return 'Google One Storage';
        if (/WEED MAN/i.test(clean)) return 'Weed Man Lawn Care';
        if (/Disney Plus/i.test(clean)) return 'Disney+';
        if (/Bank of America.*(?:Pmt|Payment)/i.test(clean) || /BA ELECTRONIC PAYMENT/i.test(clean)) return 'Bank of America Credit Card';
        if (/EB to Checking/i.test(clean)) return 'Transfer to Checking';
        if (/EB to Savings/i.test(clean)) return 'Transfer to Savings';
        if (/Bank Debit/i.test(clean)) return 'Bank Debit / Withdrawal';
        if (/State Farm/i.test(clean)) return 'State Farm Insurance';
        if (/Chickasaw Ec/i.test(clean)) return 'Chickasaw Electric Co-op';
        if (/T[- ]?Mobile/i.test(clean)) return 'T-Mobile';
        if (/Comcast/i.test(clean)) return 'Comcast / Xfinity';
        if (/Town of Oakland|Oakland, Town/i.test(clean)) return 'Town of Oakland Utilities';
        if (/Somerville Util/i.test(clean)) return 'Somerville Utilities';
        if (/Atc Fitness/i.test(clean)) return 'ATC Fitness';
        if (/Therapybrand/i.test(clean)) return 'TherapyBrands Payroll';
        if (/IRS.*Tax Ref|IRS Treas/i.test(clean)) return 'IRS Tax Refund';
        if (/Paypal.*Xsolla|Hero War/i.test(clean)) return 'Xsolla / Hero Wars';
        if (/Paypal.*Inst Xfer/i.test(clean)) return 'PayPal Transfer';
        if (/Paypal/i.test(clean)) return 'PayPal';
        if (/Chase.*(?:Pmt|Payment|Card)/i.test(clean)) return 'Chase Card Payment';
        if (/Citi.*(?:Pmt|Payment|Card)/i.test(clean)) return 'Citi Card Payment';
        if (/Capital One/i.test(clean)) return 'Capital One Payment';
        if (/Discover.*(?:Pmt|Payment)/i.test(clean)) return 'Discover Card Payment';
        if (/Geico/i.test(clean)) return 'GEICO Insurance';
        if (/Progressive/i.test(clean)) return 'Progressive Insurance';
        if (/Allstate/i.test(clean)) return 'Allstate Insurance';
        if (/AT&?T/i.test(clean)) return 'AT&T';
        if (/Spectrum/i.test(clean)) return 'Spectrum Internet';
        if (/Par\*smoothie Ki/i.test(clean)) return 'Smoothie King';
        if (/AMEX/i.test(clean)) return 'American Express';
        if (/Venmo/i.test(clean)) return 'Venmo';
        if (/Liberty Mutual/i.test(clean)) return 'Liberty Mutual Insurance';
        if (/Blizzard/i.test(clean)) return 'Blizzard Entertainment';
        if (/DD \*Cafebrazil|Doordash/i.test(clean)) return 'DoorDash';
        if (/The Cannabis Sh/i.test(clean)) return 'The Cannabis Shop';

        clean = clean.replace(/#\d+/g, '');
        clean = clean.replace(/\d{3}-\d{3}-\d{4}/g, '');
        clean = clean.replace(/\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g, '');
        clean = clean.replace(/\b(NYC|SF|LA|SEATTLE|CHICAGO|DALLAS|LEWISVILLE|OAKLAND|MEMPHIS)\b/gi, '');
        clean = clean.replace(/\s+/g, ' ').trim();

        return clean.length === 0 ? desc : clean;
    },

    heuristicCategory(desc) {
        const upper = desc.toUpperCase();

        if (upper.includes('PAYROLL') || upper.includes('TAX REF') || upper.includes('SALARY') ||
            upper.includes('DIRECT DEP') || upper.includes('THERAPYBRAND') || upper.includes('TREAS 310')) {
            return 'Income';
        }

        if (upper.includes('CHICKASAW') || upper.includes('ELEC') || upper.includes('ELECTRIC') || 
            upper.includes('POWER') || upper.includes('ENERGY') || upper.includes('ENTERGY') ||
            upper.includes('CONED') || upper.includes('WATER') || upper.includes('SEWER') || 
            upper.includes('WASTE') || upper.includes('UTILITIES') || upper.includes('UTIL') ||
            upper.includes('COMCAST') || upper.includes('XFINITY') || upper.includes('SPECTRUM') || 
            upper.includes('CHARTER') || upper.includes('COX') || upper.includes('INTERNET') ||
            upper.includes('T MOBILE') || upper.includes('T-MOBILE') || upper.includes('TMOBILE') ||
            upper.includes('VERIZON') || upper.includes('AT&T') || upper.includes('ATT') || 
            upper.includes('CELLULAR') || upper.includes('SPRINT') || upper.includes('CRICKET') ||
            upper.includes('TOWN OF OAKLAND') || upper.includes('OAKLAND, TOWN') || upper.includes('SOMERVILLE')) {
            return 'Utilities & Internet';
        }

        if (upper.includes('STATE FARM') || upper.includes('GEICO') || upper.includes('PROGRESSIVE') ||
            upper.includes('ALLSTATE') || upper.includes('LIBERTY MUTUAL') || upper.includes('NATIONWIDE') ||
            upper.includes('USAA') || upper.includes('FARMERS INS') || upper.includes('TRAVELERS') ||
            upper.includes('INSURANCE') || upper.includes('INS PREM') || upper.includes('AETNA') ||
            upper.includes('BLUE CROSS') || upper.includes('HUMANA')) {
            return 'Insurance';
        }

        if (upper.includes('EB TO CHECKING') || upper.includes('EB TO SAVINGS') || upper.includes('TRANSFER TO') ||
            upper.includes('TRANSFER FROM') || upper.includes('FUNDS TRANSFER') || upper.includes('ONLINE TRANSFER') ||
            upper.includes('BANK DEBIT') || upper.includes('ATM WITHDRAWAL') || upper.includes('INTERNAL TRANSFER') ||
            upper.includes('SAVINGS') || upper.includes('CHECKING TO') || upper.includes('ZELLE') || 
            upper.includes('VENMO') || upper.includes('PAYPAL INST XFER') || upper.includes('PAYPAL TRANSFER')) {
            return 'Transfers & Savings';
        }

        if (upper.includes('BANK OF AMERICA') || upper.includes('BOA') || upper.includes('CHASE CREDIT') || 
            upper.includes('CARD PMT') || upper.includes('ONLINE PMT') || upper.includes('PAYMENT TO') ||
            upper.includes('AUTOPAY') || upper.includes('CAPITAL ONE') || upper.includes('DISCOVER') ||
            upper.includes('CITI CARD') || upper.includes('AMEX') || upper.includes('CREDIT CARD') ||
            upper.includes('LOAN') || upper.includes('FINANCE') || upper.includes('BA ELECTRONIC PAYMENT')) {
            return 'Credit Card & Debt';
        }

        if (upper.includes('HBOMAX') || upper.includes('NETFLIX') || upper.includes('AMAZON PRIME') || 
            upper.includes('KINDLE') || upper.includes('GOOGLE*ONE') || upper.includes('DISNEY') || 
            upper.includes('BLIZZARD') || upper.includes('SPOTIFY') || upper.includes('APPLE') || 
            upper.includes('CHATGPT') || upper.includes('SUBSCRIPTION')) return 'Subscriptions & Software';

        if (upper.includes('WENDYS') || upper.includes('SUBWAY') || upper.includes('PAPA JOHNS') || 
            upper.includes('BURGER KING') || upper.includes('SMOOTHIE') || upper.includes('DOORDASH') || 
            upper.includes('CAFEBRAZIL') || upper.includes('RESTAURANT') || upper.includes('CHIPOTLE') || 
            upper.includes('STARBUCKS') || upper.includes('LAS MARGARITAS') || upper.includes('DINING') ||
            upper.includes('MCDONALDS') || upper.includes('TACO BELL') || upper.includes('CHICK-FIL-A')) return 'Dining & Bars';

        if (upper.includes('KROGER') || upper.includes('WALGREENS') || upper.includes('TRADER') || 
            upper.includes('WHOLEFDS') || upper.includes('GROCERY') || upper.includes('SAFEWAY') || 
            upper.includes('COSTCO') || upper.includes('ALDI') || upper.includes('HEB') || 
            upper.includes('PUBLIX') || upper.includes('WALMART')) return 'Groceries';

        if (upper.includes('PEST') || upper.includes('LAWN CARE') || upper.includes('WEED MAN') || 
            upper.includes('TERMINIX') || upper.includes('RENT') || upper.includes('APARTMENT') || 
            upper.includes('MORTGAGE') || upper.includes('HOA') || upper.includes('HOME DEPOT') ||
            upper.includes('LOWES')) return 'Housing';

        if (upper.includes('AMAZON') || upper.includes('AMZN') || upper.includes('CANNABIS') || 
            upper.includes('TARGET') || upper.includes('MACY') || upper.includes('BESTBUY') || 
            upper.includes('SHOPPING') || upper.includes('EBAY') || upper.includes('PAYPAL')) return 'Shopping';

        if (upper.includes('SHELL') || upper.includes('EXXON') || upper.includes('GAS') || 
            upper.includes('CHEVRON') || upper.includes('BP ') || upper.includes('SPEEDWAY') ||
            upper.includes('UBER') || upper.includes('LYFT') || upper.includes('AUTOZONE')) return 'Auto & Gas';

        if (upper.includes('CVS') || upper.includes('PHARMACY') || upper.includes('EQUINOX') || 
            upper.includes('GYM') || upper.includes('MEDICAL') || upper.includes('DENTAL') ||
            upper.includes('CLINIC') || upper.includes('HOSPITAL') || upper.includes('DOCTOR') ||
            upper.includes('ATC FITNESS') || upper.includes('ICLUB')) return 'Health & Medical';

        if (upper.includes('AMC') || upper.includes('THEATRE') || upper.includes('MOVIE') || 
            upper.includes('ENTERTAINMENT') || upper.includes('DIVA DALLAS') || upper.includes('CINEMA') ||
            upper.includes('STEAM') || upper.includes('PLAYSTATION') || upper.includes('XBOX') ||
            upper.includes('XSOLLA') || upper.includes('HERO WAR') || upper.includes('NINTENDO')) return 'Entertainment';

        return 'Miscellaneous';
    },

    heuristicIsSubscription(desc) {
        const upper = desc.toUpperCase();
        return (upper.includes('HBOMAX') || upper.includes('NETFLIX') || upper.includes('PRIME') || 
                upper.includes('KINDLE') || upper.includes('GOOGLE*ONE') || upper.includes('DISNEY') || 
                upper.includes('BLIZZARD') || upper.includes('RECURRING') || upper.includes('SUBSCRIPTION') || 
                upper.includes('SPOTIFY') || upper.includes('CHATGPT') || upper.includes('EQUINOX') || 
                upper.includes('INS PREM'));
    },

    // --- High-Level Ingestion: Detect Account & Ingest Transactions ---

    ingestStatement(parsedResult, sourceFileName) {
        const summary = parsedResult.summary;
        if (!summary || !summary.isStatement) {
            return null;
        }

        // 1. Check for pre-existing account
        let existingAccount = window.db.findAccountByStatement(summary);
        let accountId = null;
        let isNewAccount = false;
        let accountName = '';

        if (existingAccount) {
            accountId = existingAccount.id;
            accountName = existingAccount.name;
            // Always update balance to the latest statement balance
            if (summary.balance !== null) {
                window.db.updateAccountBalance(accountId, summary.balance, summary.statementDate);
            }
        } else {
            // Create new account
            isNewAccount = true;
            const brand = summary.institution ? `${summary.institution} ${summary.cardBrand}` : summary.cardBrand;
            accountName = `${brand}${summary.last4 ? ' (…' + summary.last4 + ')' : ''}`;
            accountId = window.db.insertAccount(
                accountName,
                'Credit Card',
                summary.institution || 'Bank',
                summary.balance || 0
            );
        }

        // 2. Always update/create the bill reminder with latest due date and amount
        window.db.updateOrCreateCardBill(
            accountName,
            summary.institution,
            summary.last4,
            summary.balance,
            summary.dueDate,
            summary.minPayment,
            summary.creditLine
        );

        // 3. Ingest all extracted transactions into SQLite
        let importedCount = 0;
        if (parsedResult.transactions && parsedResult.transactions.length > 0) {
            importedCount = window.db.insertTransactions(
                parsedResult.transactions,
                accountId,
                sourceFileName || 'Statement'
            );
        }

        return {
            isNewAccount,
            accountId,
            accountName,
            summary,
            importedCount,
            totalTransactions: parsedResult.transactions ? parsedResult.transactions.length : 0
        };
    }
};

window.StatementParser = StatementParser;
