// ==UserScript==
// @name         自动填写
// @namespace    http://tampermonkey.net/
// @version      2.1.0
// @description  记录手填问卷答案，按题回填，支持本地备份与恢复
// @author       You
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        GM_download
// @grant        GM_info
// ==/UserScript==

(function () {
    'use strict';

    const QUESTION = '.ques-all';
    const TEXT_FIELD = 'textarea, input[type="text"], input:not([type]), input[type="number"]';
    const origin = location.origin;
    const edited = new WeakMap();
    const pending = new Map();
    let panel;
    let activeQuestion;
    let running = false;
    let stopped = false;

    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const normalize = text => text.normalize('NFC').replace(/\s+/g, ' ').trim();
    const visible = element => element?.isConnected && element.getClientRects().length > 0 &&
        getComputedStyle(element).visibility === 'visible';
    const enabled = element => !element.matches(':disabled, [readonly]') &&
        !element.closest('.is-disabled');
    const unique = names => names.every(Boolean) && new Set(names).size === names.length;
    const orderById = (first, second) => first.id < second.id ? -1 : Number(first.id > second.id);
    const titleText = text => normalize(text)
        .replace(/^(?:第\s*[0-9０-９]+\s*题\s*[.、:：．]?\s*|[0-9０-９]+\s*[.、．)）](?![0-9０-９])\s*)/, '');

    function getTitle(element) {
        const label = element.querySelector('.original_subject') || element.querySelector('.el-form-item__label');
        if (!label) return '';
        const copy = label.cloneNode(true);
        copy.querySelectorAll('.questionType, input, textarea').forEach(node => node.remove());
        return titleText(copy.textContent);
    }

    function getType(question) {
        const label = question.querySelector('.questionType')?.textContent || '';
        if (label.includes('矩阵单选')) return 'matrix';
        if (label.includes('排序')) return 'sort';
        if (label.includes('多选')) return 'checkbox';
        if (label.includes('单选')) return 'radio';
        if (label.includes('填空')) return 'fill';
        if (question.querySelector('table.table-ques')) return 'matrix';
        if (question.querySelector('.sortnum')) return 'sort';
        if (question.querySelector('.el-radio-group')) return 'radio';
        if (question.querySelector('.el-checkbox-group')) return 'checkbox';
        if (question.querySelector('textarea')) return 'fill';
        return '';
    }

    function optionLabel(control) {
        const label = control.closest('label') || control.labels?.[0];
        if (!label) return '';
        const source = label.querySelector('.el-radio__label, .el-checkbox__label') || label;
        const copy = source.cloneNode(true);
        copy.querySelectorAll('.optionblank, input, textarea').forEach(node => node.remove());
        return normalize(copy.textContent);
    }

    function optionId(control) {
        return optionLabel(control) || normalize(control.getAttribute('value') || '');
    }

    function choiceFields(question, type) {
        return Array.from(question.querySelectorAll('input[type="' + type + '"]'))
            .filter(control => visible(control.closest('label') || control.labels?.[0] || control))
            .map(control => ({ id: optionId(control), control })).sort(orderById);
    }

    function matrixRows(question) {
        const rows = Array.from(question.querySelector('table.table-ques')?.rows || []);
        const header = rows.find(row => !row.querySelector('input[type="radio"]'));
        return rows.filter(row => visible(row) && row.querySelector('input[type="radio"]')).map(row => {
            const headers = header?.cells.length === row.cells.length &&
                Array.from(header.cells).every(cell => cell.colSpan === 1 && cell.rowSpan === 1)
                ? Array.from(header.cells, cell => normalize(cell.textContent)) : [];
            const options = Array.from(row.querySelectorAll('input[type="radio"]'), control => {
                const cell = control.closest('td, th');
                const column = cell?.parentElement === row ? headers[cell.cellIndex] : '';
                return { id: column || optionId(control), control };
            }).sort(orderById);
            return { id: normalize(row.cells[0]?.textContent || ''), options };
        }).sort(orderById);
    }

    function sortFields(question) {
        return Array.from(question.querySelectorAll('.sortnum')).filter(visible).map(control => {
            const container = control.closest('.el-col > div[style*="display: flex"]');
            const label = container?.querySelector('div[style*="color: rgb(96, 98, 102)"]');
            return { id: normalize(label?.textContent || ''), control };
        }).sort(orderById);
    }

    function describe(element) {
        if (!visible(element)) return null;
        const title = getTitle(element);
        const type = getType(element);
        if (!title || !type) return null;

        let fields;
        let layout;
        if (type === 'matrix') {
            fields = matrixRows(element);
            if (fields.some(row => !unique(row.options.map(option => option.id)))) return null;
            layout = fields.map(row => [row.id, row.options.map(option => option.id)]);
        } else if (type === 'fill') {
            fields = Array.from(element.querySelectorAll(TEXT_FIELD)).filter(visible);
            layout = fields.map(field => [
                field.type,
                normalize(field.getAttribute('aria-label') || field.labels?.[0]?.textContent || ''),
                normalize(field.placeholder || '')
            ]);
        } else {
            fields = type === 'sort' ? sortFields(element) : choiceFields(element, type);
            layout = fields.map(field => field.id);
        }

        if (fields.length === 0 || (type !== 'fill' &&
            !unique(fields.map(field => field.id)))) return null;
        return { element, type, title, fields, key: JSON.stringify([origin, type, title, layout]) };
    }

    function optionBlank(question, control) {
        const column = control.closest('.el-col');
        const blanks = column && question.contains(column)
            ? Array.from(column.querySelectorAll('.optionblank input, .optionblank textarea')) : [];
        const textFields = blanks.filter(field => field.matches(TEXT_FIELD) && visible(field));
        const choices = column?.querySelectorAll('input[type="' + control.type + '"]');
        return choices?.length === 1 && textFields.length === 1 ? textFields[0] : null;
    }

    function rankOf(control) {
        const text = normalize(control.textContent);
        if (!text || text === '0' || /^[-–—]$/.test(text)) return 0;
        if (!/^[1-9]\d*$/.test(text)) return NaN;
        return Number(text);
    }

    function snapshot(question) {
        const { element, fields, type } = question;
        if (type === 'fill') return fields.map(field => field.value);
        if (type === 'matrix') {
            return fields.map(row => row.options.find(option => option.control.checked)?.id || '');
        }
        if (type === 'sort') {
            const ranked = fields.map(field => ({ id: field.id, rank: rankOf(field.control) }));
            if (ranked.some(field => !Number.isSafeInteger(field.rank))) return null;
            const selected = ranked.filter(field => field.rank).sort((a, b) => a.rank - b.rank);
            if (selected.some((field, index) => field.rank !== index + 1)) return null;
            return selected.map(field => field.id);
        }
        return fields.filter(field => field.control.checked).map(({ id, control }) =>
            [id, optionBlank(element, control)?.value || '']);
    }

    function isAnswerValid(key, answer) {
        if (typeof key !== 'string' || !Array.isArray(answer)) return false;
        let signature;
        try {
            signature = JSON.parse(key);
            if (!Array.isArray(signature) || signature.length !== 4 || JSON.stringify(signature) !== key) {
                return false;
            }
            if (!isSiteOrigin(signature[0])) return false;
        } catch {
            return false;
        }
        const [, type, title, layout] = signature;
        const strings = values => Array.isArray(values) && values.every(value => typeof value === 'string');
        const identities = values => strings(values) && values.length > 0 && unique(values);
        if (typeof title !== 'string' || !title || !Array.isArray(layout) || !layout.length) return false;

        switch (type) {
            case 'fill':
                return layout.every(field => strings(field) && field.length === 3 &&
                    ['text', 'textarea', 'number'].includes(field[0])) &&
                    answer.length === layout.length && strings(answer);
            case 'matrix':
                return layout.every(row => Array.isArray(row) && row.length === 2 &&
                    typeof row[0] === 'string' && identities(row[1])) &&
                    unique(layout.map(row => row[0])) && answer.length === layout.length &&
                    answer.every((value, index) => value === '' || layout[index][1].includes(value));
            case 'sort':
                return identities(layout) && strings(answer) && unique(answer) &&
                    answer.every(value => layout.includes(value));
            case 'radio':
            case 'checkbox':
                return identities(layout) && (type !== 'radio' || answer.length <= 1) &&
                    answer.every(pair => strings(pair) && pair.length === 2 && layout.includes(pair[0])) &&
                    unique(answer.map(pair => pair[0]));
            default:
                return false;
        }
    }

    function populated(answer) {
        return answer?.some(value => value !== '') || false;
    }

    function visibleQuestions() {
        return Array.from(document.querySelectorAll(QUESTION), describe).filter(Boolean);
    }

    function questionCounts(questions) {
        const counts = new Map();
        for (const { key } of questions) counts.set(key, (counts.get(key) || 0) + 1);
        return counts;
    }

    function setStatus(message) {
        if (!panel?.host.isConnected) return false;
        panel.status.textContent = message;
        return true;
    }

    function persistEdit(element) {
        const edit = pending.get(element);
        if (!edit) return;
        clearTimeout(edit.timer);
        pending.delete(element);
        const current = describe(element);
        const answer = (current?.key === edit.key ? snapshot(current) : null) ?? edit.answer;
        if (answer === null) return;
        try {
            if (saveAnswer(edit.key, answer)) setStatus('已记录手填答案');
        } catch {
            setStatus('无法保存答案，请检查脚本存储');
        }
    }

    function record(event) {
        if (!event.isTrusted || !(event.target instanceof Element)) return;
        const target = event.target;
        const element = target.closest(QUESTION);
        if (!element || (activeQuestion === element && !stopped)) return;
        if (event.type === 'click' ? !target.closest('.sortnum') :
            !target.matches(TEXT_FIELD + ', input[type="radio"], input[type="checkbox"]')) return;
        const question = describe(element);
        if (!question) return;
        const title = getTitle(element);
        const duplicate = Array.from(document.querySelectorAll(QUESTION)).some(other =>
            other !== element && visible(other) && getTitle(other) === title &&
            describe(other)?.key === question.key);
        if (duplicate) return;
        edited.set(element, question.key);
        const previous = pending.get(element);
        if (previous?.key !== question.key) persistEdit(element);
        else clearTimeout(previous.timer);
        const edit = { key: question.key, answer: snapshot(question) };
        edit.timer = setTimeout(() => persistEdit(element), event.type === 'input' ? 160 : 0);
        pending.set(element, edit);
    }

    function flushEdits() {
        for (const element of pending.keys()) persistEdit(element);
    }

    function setText(control, value) {
        const prototype = control instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(control, value);
        control.dispatchEvent(new Event('input', { bubbles: true }));
        if (control.isConnected) control.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function hasCurrentAnswer(question) {
        const answer = snapshot(question);
        if (answer === null || populated(answer)) return true;
        return (question.type === 'radio' || question.type === 'checkbox') &&
            question.fields.some(field => optionBlank(question.element, field.control)?.value);
    }

    // Legacy rules have no option fingerprints. Resolve them against the live question.
    function legacyAnswer(question, questions, rules) {
        const { type, title, fields } = question;
        const sameType = rules.filter(rule => rule.type === type);
        const exact = sameType.filter(rule => titleText(rule.question) === title);
        const matches = exact.length ? exact : sameType.filter(rule => legacyTitleMatches(rule, title));
        if (matches.length !== 1) return;
        const rule = matches[0];
        const competingQuestions = questions.filter(candidate => candidate.type === type &&
            (exact.length ? candidate.title === title : legacyTitleMatches(rule, candidate.title)));
        if (competingQuestions.length !== 1) return;

        const { value } = rule;
        if (type === 'fill') return fields.length === 1 ? [value] : undefined;
        if (type === 'radio') {
            const option = legacyField(value, fields, true);
            return option ? [[option.id, '']] : undefined;
        }
        if (type === 'sort') {
            const ordered = value.map(label => legacyField(label, fields)?.id);
            return unique(ordered) ? ordered : undefined;
        }
        if (type === 'matrix') {
            const answer = fields.map(() => '');
            for (const [rowLabel, choice] of Object.entries(value)) {
                const row = legacyField(rowLabel, fields);
                const option = row && legacyField(choice, row.options, true);
                if (!option || answer[fields.indexOf(row)]) return;
                answer[fields.indexOf(row)] = option.id;
            }
            return answer;
        }

        const selected = new Map();
        for (const item of value) {
            const label = typeof item === 'string' ? item : item.option;
            const option = legacyField(label, fields);
            if (!option || selected.has(option.id)) return;
            selected.set(option.id, typeof item === 'string' ? '' : (item.fill || ''));
        }
        for (const label of rule.inverse || []) {
            const option = legacyField(label, fields);
            if (option) selected.delete(option.id);
        }
        return [...selected].sort(([a], [b]) => a < b ? -1 : Number(a > b));
    }

    function legacyTitleMatches(rule, title) {
        // Only plain keyword patterns are reusable; imported regular expressions never run.
        if ((rule.flags !== '' && rule.flags !== 'i') || /[\\^$.*+?()[\]{}|]/.test(rule.pattern)) return false;
        const keyword = normalize(rule.pattern).toLowerCase();
        return Boolean(keyword) && title.toLowerCase().includes(keyword);
    }

    function legacyField(label, fields, allowValue = false) {
        const expected = normalize(label).toLowerCase();
        if (!expected) return;
        const byTitle = fields.filter(field => field.id.toLowerCase() === expected);
        if (byTitle.length) return byTitle.length === 1 ? byTitle[0] : undefined;
        if (!allowValue || expected === 'on') return;
        const byValue = fields.filter(field =>
            normalize(field.control.getAttribute('value') || '').toLowerCase() === expected);
        return byValue.length === 1 ? byValue[0] : undefined;
    }

    async function applyAnswer(question, answer) {
        const { element, type, key } = question;
        let steps;
        switch (type) {
            case 'fill':
                steps = answer.flatMap((text, index) => text ? [{ index, text }] : []);
                break;
            case 'matrix':
                steps = answer.flatMap((id, index) => id ? [{ index, id }] : []);
                break;
            case 'sort':
                steps = answer.map(id => ({ id }));
                break;
            default:
                steps = answer.map(([id, blank]) => ({ id, blank }));
        }

        function target(fields, step) {
            if (type === 'fill') return fields[step.index];
            const options = type === 'matrix' ? fields[step.index].options : fields;
            return options.find(option => option.id === step.id)?.control;
        }

        function liveTarget(step) {
            const current = describe(element);
            return current?.key === key ? target(current.fields, step) : null;
        }

        if (steps.some(step => {
            const control = target(question.fields, step);
            return !control || !enabled(control);
        })) return false;

        for (const [index, step] of steps.entries()) {
            const control = liveTarget(step);
            if (stopped || !control || !enabled(control)) return false;

            if (step.text !== undefined) {
                if (control.value) return false;
                setText(control, step.text);
            } else if (type === 'sort') {
                const action = control.closest('a[href], button, input');
                if (rankOf(control) !== 0 || action?.matches('a[href]') ||
                    (action?.form && ['submit', 'image'].includes(action.type))) return false;
                control.click();
                await wait(100);
                const updated = liveTarget(step);
                if (!updated || rankOf(updated) !== index + 1) return false;
            } else if (!control.checked) {
                control.click();
            }

            if (step.blank) {
                const getBlank = () => {
                    const choice = liveTarget(step);
                    return choice?.checked ? optionBlank(element, choice) : null;
                };
                let field = getBlank();
                for (let attempt = 0; !field && !stopped && attempt < 8; attempt++) {
                    await wait(60);
                    field = getBlank();
                }
                if (stopped || !field || !enabled(field) || (field.value && field.value !== step.blank)) {
                    return false;
                }
                if (field.value !== step.blank) setText(field, step.blank);
            }
            await wait(45);
        }
        const current = describe(element);
        if (current?.key !== key) return false;
        return JSON.stringify(snapshot(current)) === JSON.stringify(answer);
    }

    async function fill() {
        if (running) return;
        flushEdits();
        running = true;
        stopped = false;
        panel.fill.disabled = true;
        panel.stop.disabled = false;
        setStatus('正在填写');
        const attempted = new Set();
        let filled = 0;
        let failed = 0;
        try {
            const legacy = readLegacyRules(origin);
            let idlePasses = 0;
            while (!stopped && idlePasses < 2) {
                const questions = visibleQuestions();
                const counts = questionCounts(questions);
                const question = questions.find(({ key }) => !attempted.has(key) && counts.get(key) === 1);
                if (!question) {
                    idlePasses++;
                    if (idlePasses < 2) await wait(200);
                    continue;
                }
                idlePasses = 0;
                attempted.add(question.key);
                if (edited.get(question.element) === question.key || hasCurrentAnswer(question)) continue;
                const recorded = readAnswer(question.key);
                const answer = recorded ?? legacyAnswer(question, questions, legacy);
                if (!populated(answer)) continue;
                activeQuestion = question.element;
                if (await applyAnswer(question, answer)) {
                    filled++;
                    if (recorded === undefined && !stopped) saveAnswer(question.key, answer);
                } else if (!stopped) {
                    failed++;
                }
                activeQuestion = null;
            }
            const result = '已填写 ' + filled + ' 题' +
                (failed ? '，有 ' + failed + ' 题需要检查' : '');
            setStatus(stopped ? '已停止，' + result : result);
        } catch {
            setStatus('填写中断，请检查当前问卷');
        } finally {
            activeQuestion = null;
            running = false;
            panel.fill.disabled = false;
            panel.stop.disabled = true;
        }
    }

    function mountPanel() {
        if (panel?.host.isConnected || !document.body || !document.querySelector(QUESTION) ||
            !document.querySelector(QUESTION + ' .original_subject, ' + QUESTION + ' .el-form-item__label')) return;
        const host = document.createElement('div');
        host.id = 'auto-fill-panel';
        host.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999';
        const root = host.attachShadow({ mode: 'open' });
        const bar = document.createElement('div');
        bar.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 12px;' +
            'border:1px solid #409eff;border-radius:8px;background:#fff;color:#233045;' +
            'box-shadow:0 3px 12px #0002;font:14px sans-serif';
        const fillButton = document.createElement('button');
        fillButton.type = 'button';
        fillButton.textContent = '填写已记录答案';
        fillButton.addEventListener('click', fill);
        const stopButton = document.createElement('button');
        stopButton.type = 'button';
        stopButton.textContent = '停止';
        stopButton.disabled = true;
        stopButton.addEventListener('click', () => { stopped = true; });
        const status = document.createElement('span');
        status.setAttribute('role', 'status');
        status.textContent = '手填时自动记录';
        const backup = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = '备份';
        const exportButton = document.createElement('button');
        exportButton.type = 'button';
        exportButton.textContent = '导出';
        exportButton.addEventListener('click', () => {
            flushEdits();
            exportAnswerBackup(setStatus);
        });
        const importButton = document.createElement('button');
        importButton.type = 'button';
        importButton.textContent = '导入';
        importButton.addEventListener('click', () => {
            flushEdits();
            chooseAnswerBackup(setStatus);
        });
        backup.append(summary, exportButton, importButton);
        bar.append(fillButton, stopButton, backup, status);
        root.append(bar);
        document.body.append(host);
        panel = { host, fill: fillButton, stop: stopButton, status };
        scheduleAutomaticBackup();
    }

    function stopForManualEdit(event) {
        if (running && event.isTrusted && event.target instanceof Element && event.target.closest(QUESTION)) {
            stopped = true;
        }
    }

    // Answer storage and file backup are initialized before questionnaire events.
    const answerKeyPrefix = 'survey-answer:';
    const answerBackupFormat = 'survey-answer-backup';
    const legacyRulesPrefix = 'survey-legacy:';
    const legacyBackupFormat = 'survey-legacy-rules';
    const automaticBackupKey = 'survey-automatic-backup';
    const lastAutomaticBackupKey = 'survey-last-automatic-backup';
    const lastManualBackupKey = 'survey-last-manual-backup';
    const lastChangeKey = 'survey-last-change';
    const backedUpChangeKey = 'survey-backed-up-change';
    const automaticBackupInterval = 60_000;
    let automaticBackupTimer;
    let automaticBackupRunning = false;
    let lastBackupAttempt = 0;

    function isStoredAnswerValid(key, record) {
        return record !== null && typeof record === 'object' &&
            Number.isSafeInteger(record.updatedAt) && record.updatedAt > 0 &&
            isAnswerValid(key, record.answer);
    }

    function readAnswer(key) {
        const record = GM_getValue(answerKeyPrefix + key, null);
        return isStoredAnswerValid(key, record) ? record.answer : undefined;
    }

    function saveAnswer(key, answer) {
        if (!isAnswerValid(key, answer)) return;
        const storageKey = answerKeyPrefix + key;
        const previous = GM_getValue(storageKey, null);
        if (isStoredAnswerValid(key, previous) && JSON.stringify(previous.answer) === JSON.stringify(answer)) return;
        GM_setValue(storageKey, { answer, updatedAt: Date.now() });
        markAnswerChanges();
        return true;
    }

    function markAnswerChanges() {
        GM_setValue(lastChangeKey, Math.max(Date.now(), GM_getValue(lastChangeKey, 0) + 1));
        scheduleAutomaticBackup();
    }

    function isLegacyRules(records) {
        const strings = list => Array.isArray(list) && list.every(item => typeof item === 'string');
        return Array.isArray(records) && records.every(rule => {
            if (typeof rule?.question !== 'string' || typeof rule?.pattern !== 'string' ||
                !rule.pattern || typeof rule.flags !== 'string') return false;
            const { type, value, inverse } = rule;
            switch (type) {
                case 'radio':
                case 'fill':
                    return typeof value === 'string';
                case 'sort':
                    return strings(value);
                case 'matrix':
                    return value && typeof value === 'object' && !Array.isArray(value) &&
                        Object.values(value).every(label => typeof label === 'string');
                case 'checkbox':
                    return (inverse === undefined || strings(inverse)) && Array.isArray(value) &&
                        value.every(item => typeof item === 'string' ||
                            (typeof item?.option === 'string' &&
                                (item.fill === undefined || typeof item.fill === 'string')));
                default:
                    return false;
            }
        });
    }

    function readLegacyRules(site) {
        const records = GM_getValue(legacyRulesPrefix + site, []);
        return isLegacyRules(records) ? records : [];
    }

    function mergeLegacyRules(site, records, preferIncoming = false) {
        const current = readLegacyRules(site);
        const identity = rule => JSON.stringify([rule.type, rule.question, rule.pattern, rule.flags]);
        const ordered = preferIncoming ? [...current, ...records] : [...records, ...current];
        const merged = [...new Map(ordered.map(rule => [identity(rule), rule])).values()];
        if (JSON.stringify(current) === JSON.stringify(merged)) return false;
        GM_setValue(legacyRulesPrefix + site, merged);
        return true;
    }

    function isSiteOrigin(site) {
        if (typeof site !== 'string') return false;
        try {
            const url = new URL(site);
            return ['https:', 'http:'].includes(url.protocol) && url.origin === site;
        } catch {
            return false;
        }
    }

    function createAnswerBackup() {
        const records = [];
        const legacy = [];

        for (const storageKey of GM_listValues()) {
            if (storageKey.startsWith(legacyRulesPrefix)) {
                const site = storageKey.slice(legacyRulesPrefix.length);
                const rules = readLegacyRules(site);
                if (isSiteOrigin(site) && rules.length) legacy.push({ site, rules });
                continue;
            }
            if (!storageKey.startsWith(answerKeyPrefix)) continue;
            const key = storageKey.slice(answerKeyPrefix.length);
            const record = GM_getValue(storageKey, null);
            if (isStoredAnswerValid(key, record)) {
                records.push({ key, answer: record.answer, updatedAt: record.updatedAt });
            }
        }

        const date = new Date();
        const backup = { format: answerBackupFormat, version: 1, exportedAt: date.toISOString(), records };
        if (legacy.length) backup.legacy = legacy;
        const filename = `survey-answers-${backup.exportedAt.replace(/[:.]/g, '-')}.json`;
        return {
            filename,
            count: records.length + legacy.reduce((total, entry) => total + entry.rules.length, 0),
            blob: new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
        };
    }

    function exportAnswerBackup(setStatus) {
        try {
            const backup = createAnswerBackup();
            if (!backup.count) {
                setStatus('暂无可备份的答案。');
                return;
            }

            const url = URL.createObjectURL(backup.blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = backup.filename;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 30_000);

            GM_setValue(lastManualBackupKey, Date.now());
            setStatus(`已请求下载 ${backup.count} 条记录，请在浏览器下载列表确认文件已保存。`);
        } catch {
            setStatus('无法导出答案，请重试。');
        }
    }

    async function importAnswerBackup(file, setStatus) {
        let records;
        let legacy;
        try {
            const backup = JSON.parse(await file.text());
            if (backup?.format === legacyBackupFormat) {
                if (backup.version !== 1 || !isLegacyRules(backup.records)) throw new Error();
                if (!panel?.host.isConnected || !isSiteOrigin(origin)) {
                    setStatus('请在要使用旧答案的问卷页面导入。');
                    return;
                }
                if (mergeLegacyRules(origin, backup.records, true)) markAnswerChanges();
                setStatus(`已导入 ${backup.records.length} 条旧规则。点击「填写已记录答案」进行匹配。`);
                return;
            }
            if (backup?.format !== answerBackupFormat || backup.version !== 1 || !Array.isArray(backup.records)) {
                throw new Error();
            }
            const seen = new Set();
            for (const record of backup.records) {
                if (typeof record?.key !== 'string' || seen.has(record.key) ||
                        !isStoredAnswerValid(record.key, record)) {
                    throw new Error();
                }
                seen.add(record.key);
            }
            records = backup.records;
            legacy = backup.legacy === undefined ? [] : backup.legacy;
            if (!Array.isArray(legacy) ||
                !legacy.every(entry => isSiteOrigin(entry?.site) && isLegacyRules(entry.rules)) ||
                new Set(legacy.map(entry => entry.site)).size !== legacy.length) throw new Error();
        } catch {
            setStatus('无法读取这份备份，请选择脚本导出的有效 JSON 文件。');
            return;
        }

        let imported = 0;
        let legacyChanged = false;
        try {
            for (const record of records) {
                const storageKey = answerKeyPrefix + record.key;
                const current = GM_getValue(storageKey, null);
                if (isStoredAnswerValid(record.key, current) && current.updatedAt >= record.updatedAt) continue;
                GM_setValue(storageKey, { answer: record.answer, updatedAt: record.updatedAt });
                imported++;
            }
            for (const { site, rules } of legacy) {
                if (mergeLegacyRules(site, rules)) legacyChanged = true;
            }
        } catch {
            if (imported || legacyChanged) markAnswerChanges();
            setStatus(`已导入 ${imported} 条，存储写入中断。可重新导入同一份文件继续。`);
            return;
        }

        if (imported || legacyChanged) markAnswerChanges();
        const restored = legacy.length ? ` 已合并 ${legacy.length} 个网站的旧规则。` : '';
        setStatus(`已导入 ${imported} 条答案，跳过 ${records.length - imported} 条已有或更新的记录。${restored}`);
    }

    function chooseAnswerBackup(setStatus) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.addEventListener('change', () => {
            const [file] = input.files;
            if (file) void importAnswerBackup(file, setStatus);
        }, { once: true });

        try {
            if (typeof input.showPicker === 'function') {
                input.showPicker();
            } else {
                input.click();
            }
        } catch {
            setStatus('浏览器未打开文件选择器，请在问卷页面点击导入。');
        }
    }

    function supportsAutomaticBackup() {
        return typeof GM_download === 'function' &&
            typeof GM_info !== 'undefined' && GM_info.downloadMode === 'browser';
    }

    function scheduleAutomaticBackup() {
        if (!GM_getValue(automaticBackupKey, false) ||
            GM_getValue(lastChangeKey, 0) <= GM_getValue(backedUpChangeKey, 0)) return;
        if (automaticBackupTimer || automaticBackupRunning) return;
        const lastCompleted = GM_getValue(lastAutomaticBackupKey, 0);
        const delay = Math.max(2500, Math.max(lastCompleted, lastBackupAttempt) + automaticBackupInterval - Date.now());
        automaticBackupTimer = setTimeout(runAutomaticBackup, delay);
    }

    function runAutomaticBackup() {
        automaticBackupTimer = undefined;
        if (!GM_getValue(automaticBackupKey, false)) return;
        const change = GM_getValue(lastChangeKey, 0);
        if (change <= GM_getValue(backedUpChangeKey, 0)) return;
        if (GM_getValue(lastAutomaticBackupKey, 0) + automaticBackupInterval > Date.now()) {
            scheduleAutomaticBackup();
            return;
        }

        lastBackupAttempt = Date.now();
        if (!supportsAutomaticBackup()) {
            setStatus('自动备份需要油猴的浏览器下载模式。也可手动导出。');
            return;
        }

        const finish = (saved) => {
            automaticBackupRunning = false;
            if (saved) {
                GM_setValue(lastAutomaticBackupKey, Date.now());
                GM_setValue(backedUpChangeKey, Math.max(change, GM_getValue(backedUpChangeKey, 0)));
                setStatus('自动备份已下载，可在浏览器下载列表查看。');
                scheduleAutomaticBackup();
            } else {
                setStatus('自动备份未完成。请检查油猴下载权限和 JSON 白名单，或手动导出。');
                if (GM_getValue(lastChangeKey, 0) > change) scheduleAutomaticBackup();
            }
        };

        try {
            const backup = createAnswerBackup();
            if (!backup.count) return;
            automaticBackupRunning = true;
            GM_download({
                url: backup.blob,
                name: backup.filename,
                saveAs: false,
                conflictAction: 'uniquify',
                onload: () => finish(true),
                onerror: () => finish(false),
                ontimeout: () => finish(false)
            });
        } catch {
            finish(false);
        }
    }

    function registerBackupMenus() {
        const menuStatus = message => {
            if (!setStatus(message)) window.alert(message);
        };
        GM_registerMenuCommand('导出答案 JSON', () => {
            flushEdits();
            exportAnswerBackup(menuStatus);
        });
        GM_registerMenuCommand('导入答案 JSON', () => {
            flushEdits();
            chooseAnswerBackup(menuStatus);
        });
        GM_registerMenuCommand('切换自动文件备份', () => {
            const enabled = GM_getValue(automaticBackupKey, false);
            if (!enabled && !supportsAutomaticBackup()) {
                menuStatus('自动备份需要油猴的浏览器下载模式。也可手动导出。');
                return;
            }
            GM_setValue(automaticBackupKey, !enabled);
            if (enabled) {
                clearTimeout(automaticBackupTimer);
                automaticBackupTimer = undefined;
                menuStatus('已关闭自动文件备份。');
            } else {
                scheduleAutomaticBackup();
                menuStatus('已开启自动文件备份。页面打开且有变化时，会将 JSON 下载到本机。');
            }
        });
        GM_registerMenuCommand('查看答案备份状态', () => {
            const automatic = GM_getValue(automaticBackupKey, false) ? '开启' : '关闭';
            const lastAutomatic = GM_getValue(lastAutomaticBackupKey, 0);
            const lastManual = GM_getValue(lastManualBackupKey, 0);
            const displayTime = (time) => time ? new Date(time).toLocaleString() : '无';
            menuStatus(`自动备份${automatic}。最近自动下载 ${displayTime(lastAutomatic)}。最近手动导出请求 ${displayTime(lastManual)}。`);
        });
    }

    for (const type of ['input', 'change', 'click']) {
        document.addEventListener(type, record, true);
    }
    for (const type of ['pointerdown', 'keydown']) {
        document.addEventListener(type, stopForManualEdit, true);
    }
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushEdits();
    });
    document.addEventListener('focusout', event => {
        if (event.target instanceof Element) persistEdit(event.target.closest(QUESTION));
    }, true);
    window.addEventListener('pagehide', flushEdits);
    mountPanel();
    new MutationObserver(mountPanel).observe(document.documentElement, { childList: true, subtree: true });
    if (window.top === window) registerBackupMenus();
})();
