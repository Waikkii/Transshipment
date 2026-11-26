// ==UserScript==
// @name         自动填写
// @namespace    http://tampermonkey.net/
// @version      2.2.1
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

    function clearStatus(target) {
        clearTimeout(target.statusTimer);
        target.status.textContent = '';
        target.dismiss.hidden = true;
        delete target.feedback.dataset.kind;
    }

    function setStatus(message, kind = 'notice', duration = 0) {
        if (!panel?.host.isConnected) return false;
        const target = panel;
        const current = target.feedback.dataset.kind;
        if (kind === 'quiet' && (current === 'warning' || current === 'error' ||
            current === 'notice' || current === 'progress')) return true;

        clearTimeout(target.statusTimer);
        target.feedback.dataset.kind = kind;
        if (target.status.textContent !== message) target.status.textContent = message;
        target.dismiss.hidden = Boolean(duration) || kind === 'progress';
        if (duration) target.statusTimer = setTimeout(() => clearStatus(target), duration);
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
            if (saveAnswer(edit.key, answer)) setStatus('已记录', 'quiet', 2200);
        } catch {
            setStatus('保存失败，请检查油猴存储。', 'error');
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
        const focusStop = panel.host.shadowRoot.activeElement === panel.fill;
        panel.toggleBackup(false);
        panel.stop.hidden = false;
        panel.fill.disabled = true;
        if (focusStop) panel.stop.focus({ preventScroll: true });
        setStatus('正在填写…', 'progress');
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
            const result = !stopped && !filled && !failed ? '没有可填写的题目' :
                (stopped ? '已停止，' : '') + '已填写 ' + filled + ' 题' +
                (failed ? '，' + failed + ' 题需检查' : '');
            setStatus(result, failed ? 'warning' : 'success');
        } catch {
            setStatus('填写中断，请检查当前问卷。', 'error');
        } finally {
            activeQuestion = null;
            running = false;
            panel.fill.disabled = false;
            if (panel.host.shadowRoot.activeElement === panel.stop) panel.fill.focus({ preventScroll: true });
            panel.stop.hidden = true;
        }
    }

    const panelCss = `
        :host {
            all: initial;
            position: fixed;
            inset-block-start: max(var(--edge), env(safe-area-inset-top));
            inset-inline-end: max(var(--edge), env(safe-area-inset-right));
            z-index: 99999;
            font: 13px/1.4 system-ui, "Microsoft YaHei", sans-serif;
            color: var(--ink);
            --edge: clamp(12px, 3vw, 20px);
            --surface: #fff;
            --ink: #172238;
            --muted: #495972;
            --border: #dce4f0;
            --toolbar-border: #409eff;
            --hover: #eef3fa;
            --primary: #1665bd;
            --primary-hover: #1056a5;
            --stop: #b42335;
            --stop-hover: #991b2b;
            --focus: #176ac6;
            --good: #147053;
            --warn: #8c4e06;
            --bad: #a22b38;
            --shadow: 0 8px 24px #152d511c, 0 2px 6px #152d5112;
        }

        *, *::before, *::after { box-sizing: border-box; }
        [hidden] { display: none !important; }
        button {
            appearance: none;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            min-block-size: 34px;
            padding: 0 10px;
            border: 0;
            border-radius: 6px;
            color: var(--muted);
            background: transparent;
            font: inherit;
            font-weight: 600;
            white-space: nowrap;
            cursor: pointer;
        }
        button:hover { background: var(--hover); color: var(--ink); }
        button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
        button:disabled { cursor: default; }

        .bar, .backup-menu, .feedback[data-kind] {
            border: 1px solid var(--border);
            background: var(--surface);
            box-shadow: var(--shadow);
        }
        .bar {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 4px;
            border: 2px solid var(--toolbar-border);
            border-radius: 9px;
        }
        .fill {
            padding-inline: 13px;
            color: #fff;
            background: var(--primary);
        }
        .fill:not(:disabled):hover { color: #fff; background: var(--primary-hover); }
        .fill:disabled { color: var(--muted); background: var(--hover); }
        .stop { color: #fff; background: var(--stop); }
        .stop:hover { color: #fff; background: var(--stop-hover); }
        .backup::after {
            content: "";
            inline-size: 6px;
            block-size: 6px;
            border: solid currentColor;
            border-width: 0 1.5px 1.5px 0;
            transform: translateY(-1px) rotate(45deg);
        }
        .backup[aria-expanded="true"] { color: var(--ink); background: var(--hover); }
        .backup[aria-expanded="true"]::after { transform: translateY(2px) rotate(225deg); }

        .below {
            position: absolute;
            inset-block-start: calc(100% + 8px);
            inset-inline-end: 0;
            display: grid;
            justify-items: end;
            gap: 8px;
            inline-size: max-content;
            max-inline-size: min(280px, calc(100vw - 2 * var(--edge)));
            pointer-events: none;
        }
        .backup-menu {
            display: grid;
            min-inline-size: 108px;
            padding: 4px;
            border-radius: 10px;
            pointer-events: auto;
        }
        .backup-menu button { justify-content: flex-start; }
        .feedback[data-kind] {
            display: flex;
            align-items: flex-start;
            gap: 8px;
            max-inline-size: 100%;
            padding: 9px 10px;
            border-radius: 11px;
        }
        .feedback[data-kind]::before {
            content: "";
            flex: 0 0 7px;
            block-size: 7px;
            margin-block-start: 6px;
            border-radius: 50%;
            background: var(--indicator, var(--focus));
        }
        .feedback[data-kind="success"], .feedback[data-kind="quiet"] { --indicator: var(--good); }
        .feedback[data-kind="warning"] { --indicator: var(--warn); }
        .feedback[data-kind="error"] { --indicator: var(--bad); }
        .feedback[data-kind="progress"]::before {
            flex-basis: 10px;
            block-size: 10px;
            margin-block-start: 4px;
            border: 1.5px solid var(--focus);
            border-inline-end-color: transparent;
            background: transparent;
            animation: spin .8s linear infinite;
        }
        .message { min-inline-size: 0; overflow-wrap: anywhere; white-space: pre-line; }
        .dismiss {
            min-block-size: 24px;
            inline-size: 24px;
            padding: 0;
            margin-block: -3px;
            margin-inline-end: -4px;
            font-size: 17px;
            font-weight: 400;
            pointer-events: auto;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) {
            .feedback[data-kind="progress"]::before { animation: none; }
        }
        @media (prefers-color-scheme: dark) {
            :host {
                --surface: #182235;
                --ink: #f0f4ff;
                --muted: #c2cde2;
                --border: #34445d;
                --toolbar-border: #4d90da;
                --hover: #26354d;
                --primary: #1f63b6;
                --primary-hover: #2157a2;
                --focus: #9ab3ff;
                --good: #73d3b0;
                --warn: #f7be73;
                --bad: #ffa0a9;
                --shadow: 0 8px 24px #02061766, 0 2px 6px #02061744;
            }
        }
    `;

    function mountPanel() {
        if (panel?.host.isConnected || !document.body || !document.querySelector(QUESTION) ||
            !document.querySelector(QUESTION + ' .original_subject, ' + QUESTION + ' .el-form-item__label')) return;
        const host = document.createElement('div');
        host.id = 'auto-fill-panel';
        const root = host.attachShadow({ mode: 'open' });
        if ('adoptedStyleSheets' in root && typeof CSSStyleSheet.prototype.replaceSync === 'function') {
            const style = new CSSStyleSheet();
            style.replaceSync(panelCss);
            root.adoptedStyleSheets = [style];
        } else {
            const style = document.createElement('style');
            style.textContent = panelCss;
            root.append(style);
        }

        const bar = document.createElement('div');
        bar.className = 'bar';
        bar.setAttribute('role', 'group');
        bar.setAttribute('aria-label', '问卷助手');
        const below = document.createElement('div');
        below.className = 'below';

        function makeButton(text, className, onClick) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = text;
            button.className = className;
            button.addEventListener('click', onClick);
            return button;
        }

        const fillButton = makeButton('开始填写', 'fill', fill);
        const stopButton = makeButton('停止', 'stop', () => { stopped = true; });
        stopButton.hidden = !running;
        fillButton.disabled = running;

        const feedback = document.createElement('div');
        feedback.className = 'feedback';
        const status = document.createElement('span');
        status.className = 'message';
        status.setAttribute('role', 'status');
        const dismiss = makeButton('×', 'dismiss', () => {
            (fillButton.disabled ? stopButton : fillButton).focus({ preventScroll: true });
            clearStatus(mounted);
        });
        dismiss.setAttribute('aria-label', '关闭提醒');
        dismiss.hidden = true;
        feedback.append(status, dismiss);

        const backupMenu = document.createElement('div');
        backupMenu.className = 'backup-menu';
        backupMenu.id = 'question-backup-menu';
        backupMenu.hidden = true;
        const backupButton = makeButton('备份', 'backup', () => toggleBackup(backupMenu.hidden));
        backupButton.setAttribute('aria-expanded', 'false');
        backupButton.setAttribute('aria-controls', backupMenu.id);

        function toggleBackup(open, restoreFocus = false) {
            backupMenu.hidden = !open;
            backupButton.setAttribute('aria-expanded', String(open));
            if (restoreFocus) backupButton.focus({ preventScroll: true });
        }
        function runBackupAction(action) {
            toggleBackup(false, true);
            flushEdits();
            action(setStatus);
        }

        backupMenu.append(
            makeButton('导出', '', () => runBackupAction(exportAnswerBackup)),
            makeButton('导入', '', () => runBackupAction(chooseAnswerBackup))
        );
        root.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !backupMenu.hidden) {
                event.stopPropagation();
                toggleBackup(false, true);
            }
        });
        bar.append(fillButton, stopButton, backupButton);
        below.append(backupMenu, feedback);
        root.append(bar, below);
        const mounted = { host, fill: fillButton, stop: stopButton, status, feedback, dismiss, toggleBackup };
        document.body.append(host);
        panel = mounted;
        scheduleAutomaticBackup();
    }

    function stopForManualEdit(event) {
        if (event.type === 'pointerdown' && panel && !event.composedPath().includes(panel.host)) {
            panel.toggleBackup(false);
        }
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
                setStatus('暂无可备份的答案。', 'notice');
                return;
            }

            const url = URL.createObjectURL(backup.blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = backup.filename;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 30_000);

            GM_setValue(lastManualBackupKey, Date.now());
            setStatus(`已请求下载 ${backup.count} 条记录，请检查下载列表。`);
        } catch {
            setStatus('导出失败，请重试。', 'error');
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
                    setStatus('请在要使用旧答案的问卷页面导入。', 'warning');
                    return;
                }
                if (mergeLegacyRules(origin, backup.records, true)) markAnswerChanges();
                setStatus(`已导入 ${backup.records.length} 条旧规则。点「开始填写」回填。`);
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
            setStatus('备份文件无效，请选择脚本导出的 JSON。', 'error');
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
            setStatus(`导入中断，已保存 ${imported} 条。请重新导入同一文件。`, 'warning');
            return;
        }

        if (imported || legacyChanged) markAnswerChanges();
        const restored = legacy.length ? ` 已合并 ${legacy.length} 个网站的旧规则。` : '';
        setStatus(`已导入 ${imported} 条，保留本地 ${records.length - imported} 条。${restored}`, 'success');
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
            setStatus('文件选择器未打开，请在问卷面板点「导入」。', 'warning');
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
            setStatus('请开启油猴的浏览器下载模式，或手动导出。', 'warning');
            return;
        }

        const finish = (saved) => {
            automaticBackupRunning = false;
            if (saved) {
                GM_setValue(lastAutomaticBackupKey, Date.now());
                GM_setValue(backedUpChangeKey, Math.max(change, GM_getValue(backedUpChangeKey, 0)));
                setStatus('自动备份已下载', 'quiet', 3500);
                scheduleAutomaticBackup();
            } else {
                setStatus('自动备份失败。请检查下载权限和 JSON 白名单，或手动导出。', 'warning');
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
        const menuStatus = (message, kind) => {
            if (!setStatus(message, kind)) window.alert(message);
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
                menuStatus('请开启油猴的浏览器下载模式，或手动导出。', 'warning');
                return;
            }
            GM_setValue(automaticBackupKey, !enabled);
            if (enabled) {
                clearTimeout(automaticBackupTimer);
                automaticBackupTimer = undefined;
                menuStatus('已关闭自动备份', 'success');
            } else {
                scheduleAutomaticBackup();
                menuStatus('已开启自动备份', 'success');
            }
        });
        GM_registerMenuCommand('查看答案备份状态', () => {
            const automatic = GM_getValue(automaticBackupKey, false) ? '开启' : '关闭';
            const lastAutomatic = GM_getValue(lastAutomaticBackupKey, 0);
            const lastManual = GM_getValue(lastManualBackupKey, 0);
            const displayTime = (time) => time ? new Date(time).toLocaleString() : '无';
            menuStatus(`自动备份：${automatic}\n最近自动下载：${displayTime(lastAutomatic)}\n最近手动导出请求：${displayTime(lastManual)}`);
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
