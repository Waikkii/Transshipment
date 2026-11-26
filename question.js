// ==UserScript==
// @name         自动填写
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  自动填写问卷，支持单选、多选、矩阵单选、填空，根据关键词匹配预设答案
// @author       You
// @match        *
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // ==================== 预设答案配置（可自行修改） ====================
    // 每条规则包含：
    //   regex: 正则表达式，用于匹配题目文本（不区分大小写）
    //   type: 题型（'radio'单选, 'checkbox'多选, 'fill'填空, 'matrix'矩阵单选）
    //   value: 期望的答案
    //   inverse: 取消勾选的答案
    const ANSWER_RULES = [
        {
            regex: /确认是否/,
            type: 'radio',
            value: '是',
            question: '请您确认是否xxxx',
        },
        {
            regex: /当前使用/,
            type: 'checkbox',
            value: [
                { option: 'a', fill: 'qqqq' },
                { option: 'v', fill: 'dddd' }
            ],
            question: '您当前使用的xxxxx',
        },
        {
            regex: /占用多少/,
            type: 'fill',
            value: '480G',
            question: '您现有占用多少？',
        },
        {
            regex: /选择厂商/,
            type: 'matrix',
            value: {
                '主': '1',
                '副': '2'
            },
            question: '请选择厂商',
        },
        {
            regex: /哪些游戏/,
            type: 'checkbox',
            value: [
                { option: '王者荣耀'},
                { option: '其他_', fill: '原神; 异环' },
            ],
            question: '您平时玩哪些游戏',
        },
        {
            regex: /行为的频率/,
            type: 'sort',
            values: [
                '22',
                'hdf',
                'hjsae',
            ],
            question: '您平时进行以下行为的频率是？'
        },
    ];

    // ==================== 界面UI ====================
    const container = document.createElement('div');
    container.id = 'auto-fill-panel';
    container.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 99999;
        background: #ffffff;
        border: 2px solid #409EFF;
        border-radius: 8px;
        padding: 12px 16px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        display: flex;
        align-items: center;
        gap: 12px;
        font-family: Arial, sans-serif;
    `;

    const startBtn = document.createElement('button');
    startBtn.textContent = '开始填写';
    startBtn.style.cssText = `
        padding: 6px 16px;
        background: #409EFF;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
    `;

    const stopBtn = document.createElement('button');
    stopBtn.textContent = '停止';
    stopBtn.disabled = true;
    stopBtn.style.cssText = `
        padding: 6px 16px;
        background: #F56C6C;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
        disabled: #ccc;
    `;

    const statusText = document.createElement('span');
    statusText.textContent = '就绪';
    statusText.style.cssText = 'color: #67C23A; font-size: 13px;';

    container.appendChild(startBtn);
    container.appendChild(stopBtn);
    container.appendChild(statusText);
    document.body.appendChild(container);

    // ==================== 核心逻辑 ====================
    let running = false;
    let stopRequested = false;

    // 工具函数：等待ms毫秒
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // 判断元素是否真正可见（包括自身display及祖先隐藏）
    function isVisible(element) {
        if (!element) return false;
        // 检查元素自身style.display
        if (element.style.display === 'none') return false;
        // 检查计算样式
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        // 检查offsetParent（对于隐藏元素为null）
        return element.offsetParent !== null;
    }

    // 获取所有题目容器（.ques-all），且当前可见
    function getVisibleQuestions() {
        const all = document.querySelectorAll('.ques-all');
        return Array.from(all).filter(q => isVisible(q));
    }

    // 从题目容器中提取纯文本描述（题目文本）
    function getQuestionText(quesElement) {
        // 尝试从 .original_subject 内获取，如果不存在则取整个容器的文本
        const subjectDiv = quesElement.querySelector('.original_subject');
        if (subjectDiv) {
            return subjectDiv.textContent.trim();
        }
        // 备选：span.questionType 前面的文本？
        const label = quesElement.querySelector('.el-form-item__label');
        if (label) return label.textContent.trim();
        return quesElement.textContent.replace(/\s+/g, ' ').trim();
    }

    // 获取题目类型（通过 .questionType 文本）
    function getQuestionType(quesElement) {
        const typeSpan = quesElement.querySelector('.questionType');
        if (typeSpan) {
            const t = typeSpan.textContent.trim();
            if (t.includes('矩阵单选')) return 'matrix';
            if (t.includes('多选')) return 'checkbox';
            if (t.includes('单选')) return 'radio';
            if (t.includes('填空')) return 'fill';
            if (t.includes('排序')) return 'sort';
        }
        // 通过DOM结构推断
        if (quesElement.querySelector('.el-radio-group')) return 'radio';
        if (quesElement.querySelector('.el-checkbox-group')) return 'checkbox';
        if (quesElement.querySelector('table.table-ques')) return 'matrix';
        if (quesElement.querySelector('textarea')) return 'fill';
        return 'unknown';
    }

    // 判断题目是否已经填写过（我们添加了标记）
    function isFilled(quesElement) {
        return quesElement.getAttribute('data-auto-filled') === 'true' ||
            quesElement.getAttribute('data-auto-skipped') === 'true';
    }

    function markAsFilled(quesElement) {
        quesElement.setAttribute('data-auto-filled', 'true');
    }

    // 模拟点击事件，用于Vue等框架
    function simulateClick(element) {
        if (!element) return;
        let targetInput = null;
        // 如果点击的是 label，尝试找到内部的 radio/checkbox input
        if (element.tagName === 'LABEL') {
            targetInput = element.querySelector('input[type="radio"], input[type="checkbox"]');
        } else if (element.tagName === 'INPUT' && (element.type === 'radio' || element.type === 'checkbox')) {
            targetInput = element;
        }

        // 同步原生属性（确保 Vue/Element UI 能感知变化）
        if (targetInput) {
            if (targetInput.type === 'radio') {
                targetInput.checked = true; // 单选直接设为 true
            } else if (targetInput.type === 'checkbox') {
                targetInput.checked = !targetInput.checked; // 切换勾选状态
            }
            targetInput.dispatchEvent(new Event('change', { bubbles: true }));
            targetInput.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // 在目标元素上触发 click 事件（冒泡）
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }

    // 设置textarea的值并触发input事件，让Vue等框架感知变化
    function setTextareaValue(textarea, value) {
        // 使用原生value设置
        textarea.value = value;
        // 触发input事件
        const inputEvent = new Event('input', { bubbles: true });
        textarea.dispatchEvent(inputEvent);
        // 有些框架使用change
        const changeEvent = new Event('change', { bubbles: true });
        textarea.dispatchEvent(changeEvent);
    }

    // 根据规则和题目文本匹配，返回规则对象或null
    function matchRule(questionText) {
        const lowerText = questionText.toLowerCase();
        for (let rule of ANSWER_RULES) {
            if (rule.regex.test(lowerText) || rule.regex.test(questionText)) {
                return rule;
            }
        }
        return null;
    }

    // 填写单选题
    function fillRadio(quesElement, rule) {
        const radioInputs = Array.from(quesElement.querySelectorAll('input[type="radio"]'));
        if (radioInputs.length === 0) return false;
        if (rule && rule.value) {
            const expected = rule.value.toLowerCase();
            for (let input of radioInputs) {
                const label = input.closest('label');
                if (label) {
                    const labelText = label.textContent.trim().toLowerCase();
                    if (labelText.includes(expected)) {
                        console.log('----[单选] :', label.textContent.trim().toLowerCase());
                        simulateClick(label); // 点击 label，内部会设置 input.checked
                        return true;
                    }
                }
                // 备用：通过 value 匹配
                if (input.value.toLowerCase().includes(expected)) {
                    const label = input.closest('label');
                    if (label) {
                        console.log('----[单选] :', input.value.toLowerCase());
                        simulateClick(label);
                        return true;
                    }
                }
            }
        }
        return false;
    }

    // 填写多选题
    async function fillCheckbox(quesElement, rule) {
        const getCheckboxInputs = () => Array.from(quesElement.querySelectorAll('input[type="checkbox"]'));
        let checkboxInputs = getCheckboxInputs();
        if (checkboxInputs.length === 0) return false;

        // 1. 取消所有勾选
        for (let input of checkboxInputs) {
            if (input.checked) {
                const label = input.closest('label');
                if (label) {
                    simulateClick(label);
                    await sleep(80);
                }
            }
        }

        if (!rule || !rule.value || rule.value.length === 0) return false;

        // 2. 勾选 value 中匹配的选项
        for (let item of rule.value) {
            const optionText = typeof item === 'string' ? item : item.option;
            if (!optionText) continue;
            checkboxInputs = getCheckboxInputs();
            const targetInput = checkboxInputs.find(input => {
                const label = input.closest('label');
                return label && label.textContent.trim().toLowerCase().includes(optionText.toLowerCase());
            });
            if (!targetInput) continue;
            const label = targetInput.closest('label');
            if (!label) continue;
            if (!targetInput.checked) {
                console.log('----[多选] :', label.textContent.trim().toLowerCase());
                simulateClick(label);
                await sleep(80);
            }
        }

        // 3. 处理 inverse：取消匹配的已勾选项
        if (rule.inverse && Array.isArray(rule.inverse) && rule.inverse.length > 0) {
            checkboxInputs = getCheckboxInputs(); // 获取最新状态
            for (let inverseText of rule.inverse) {
                if (!inverseText) continue;
                const targetInput = checkboxInputs.find(input => {
                    const label = input.closest('label');
                    return label && label.textContent.trim().toLowerCase().includes(inverseText.toLowerCase());
                });
                if (targetInput && targetInput.checked) {
                    const label = targetInput.closest('label');
                    if (label) {
                        console.log('----[多选（取消）] :', label.textContent.trim().toLowerCase());
                        simulateClick(label);
                        await sleep(80);
                    }
                }
            }
        }

        // 4. 填写填空（仅处理 value 中需要填空的项）
        for (let item of rule.value) {
            const optionText = typeof item === 'string' ? item : item.option;
            const fillText = typeof item === 'object' ? (item.fill || '') : '';
            if (!optionText || !fillText) continue;

            const updatedInputs = getCheckboxInputs();
            const updatedInput = updatedInputs.find(input => {
                const lbl = input.closest('label');
                return lbl && lbl.textContent.trim().toLowerCase().includes(optionText.toLowerCase());
            });
            if (!updatedInput) continue;
            const updatedLabel = updatedInput.closest('label');
            if (!updatedLabel) continue;

            let fillInput = null;
            for (let attempt = 0; attempt < 5; attempt++) {
                const col = updatedLabel.closest('.el-col');
                if (col) {
                    const optionBlank = col.querySelector('.optionblank');
                    if (optionBlank) {
                        const input = optionBlank.querySelector('input[type="text"], textarea');
                        if (input) {
                            fillInput = input;
                            break;
                        }
                    }
                }
                await sleep(200);
            }
            if (fillInput) {
                console.log('----[多选（填写）] :', fillText);
                setTextareaValue(fillInput, fillText);
            }
        }

        return true;
    }

    // 填写矩阵单选
    function fillMatrix(quesElement, rule) {
        const table = quesElement.querySelector('table.table-ques');
        if (!table) return false;

        const rows = Array.from(table.querySelectorAll('tr'));
        if (rows.length < 2) return false;

        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const cells = row.querySelectorAll('td');
            if (cells.length < 2) continue;
            const rowTitle = cells[0].textContent.trim();
            const radioInputs = Array.from(row.querySelectorAll('input[type="radio"]'));

            if (rule && rule.value && rule.value[rowTitle]) {
                const expected = rule.value[rowTitle].toLowerCase();
                let selected = false;
                for (let input of radioInputs) {
                    const label = input.closest('label');
                    if (label && label.textContent.trim().toLowerCase().includes(expected)) {
                        console.log('----[矩阵单选] :', label.textContent.trim().toLowerCase());
                        simulateClick(input);
                        selected = true;
                        break;
                    }
                    if (!selected && input.value.toLowerCase().includes(expected)) {
                        console.log('----[矩阵单选] :', input.value.toLowerCase());
                        simulateClick(input);
                        selected = true;
                        break;
                    }
                }
            }
            // 无规则匹配的行不填
        }
        return true; // 至少处理了表格结构
    }

    // 填写填空题
    async function fillText(quesElement, rule) {
        const textarea = quesElement.querySelector('textarea');
        if (!textarea) return false;

        if (rule && rule.value) {
            console.log('----[填空] :', rule.value);
            setTextareaValue(textarea, rule.value);
            await sleep(80);
            return true;
        }
        // 无规则不填
        return false;
    }

    // 填写排序题
    async function fillSort(quesElement, rule) {
        // 获取所有选项容器（flex 布局的外层 div）
        const optionContainers = Array.from(quesElement.querySelectorAll('.el-col > div[style*="display: flex"]'));
        if (optionContainers.length === 0) return false;

        if (rule && rule.values && rule.values.length > 0) {
            for (let expectedText of rule.values) {
                if (!expectedText) continue;
                const lowerExpected = expectedText.toLowerCase();

                // 1. 在容器中查找包含目标文本的选项
                const targetContainer = optionContainers.find(container => {
                    const textEl = container.querySelector('div[style*="color: rgb(96, 98, 102)"]');
                    return textEl && textEl.textContent.trim().toLowerCase().includes(lowerExpected);
                });
                if (!targetContainer) continue;

                // 2. 在容器内找到 .sortnum 并点击
                const sortNum = targetContainer.querySelector('.sortnum');
                const textEl = targetContainer.querySelector('div[style*="color: rgb(96, 98, 102)"]');
                if (sortNum) {
                    console.log('----[排序多选] :', textEl.textContent.trim());
                    simulateClick(sortNum);
                    await sleep(500); // 等待排序动画/数字更新
                }
            }
            return true;
        }
        return false;
    }

    // 填写一个题目
    async function fillQuestion(quesElement) {
        if (isFilled(quesElement)) return false;

        const questionText = getQuestionText(quesElement);
        const questionType = getQuestionType(quesElement);
        const rule = matchRule(questionText);

        if (!rule) {
            console.log(`[问卷助手] ⏭️跳过题目: ${questionText.substring(0, 30)} -> (无匹配规则)`);
            quesElement.setAttribute('data-auto-skipped', 'true');
            return true; // 返回 true 表示已处理（跳过了）
        }

        console.log(`[问卷助手] ✅填写题目: ${questionText.substring(0, 30)} -> 类型: ${questionType} -> 匹配: ${rule.regex}`);

        let success = false;
        switch (questionType) {
            case 'radio':
                success = fillRadio(quesElement, rule);
                break;
            case 'checkbox':
                success = await fillCheckbox(quesElement, rule);
                break;
            case 'matrix':
                success = fillMatrix(quesElement, rule);
                break;
            case 'fill':
                success = await fillText(quesElement, rule);
                break;
            case 'sort':
                success = await fillSort(quesElement, rule);
                break;
            default:
                console.warn('[问卷助手] ⏭️未知题型，跳过');
                quesElement.setAttribute('data-auto-skipped', 'true');
                return true;
        }

        if (success) {
            markAsFilled(quesElement);
            await sleep(800);
        } else {
            // 填写失败也标记跳过，避免卡在同一题
            quesElement.setAttribute('data-auto-skipped', 'true');
        }
        return success;
    }

    // 主循环：不断寻找第一个未填写且可见的题目，填写，直到没有新题目或停止
    async function autoFillLoop() {
        stopRequested = false;
        running = true;
        startBtn.disabled = true;
        stopBtn.disabled = false;
        statusText.textContent = '运行中...';
        statusText.style.color = '#E6A23C';

        try {
            while (running && !stopRequested) {
                const visibleQuestions = getVisibleQuestions();
                // 找到第一个未填写的可见题目
                const unfilled = visibleQuestions.find(q => !isFilled(q));

                if (!unfilled) {
                    // 没有未填写的可见题目，结束循环
                    statusText.textContent = '填写完成（无更多可见题目）';
                    statusText.style.color = '#67C23A';
                    break;
                }

                await fillQuestion(unfilled);

                // 如果填写了题目，再次循环；如果fillQuestion失败，也短暂等待防止死循环
                if (!running || stopRequested) break;
            }
        } catch (e) {
            console.error('[问卷助手] ❌出错:', e);
            statusText.textContent = '出错: ' + e.message;
            statusText.style.color = '#F56C6C';
        } finally {
            running = false;
            startBtn.disabled = false;
            stopBtn.disabled = true;
            if (!stopRequested) {
                statusText.textContent = '完成';
                statusText.style.color = '#67C23A';
            }
        }
    }

    // 绑定按钮事件
    startBtn.addEventListener('click', () => {
        if (running) return;
        // 重置所有题目的填写标记（以便重新填写）
        document.querySelectorAll('.ques-all[data-auto-filled="true"]').forEach(el => {
            el.removeAttribute('data-auto-filled');
            el.removeAttribute('data-auto-skipped');
        });
        autoFillLoop();
    });

    stopBtn.addEventListener('click', () => {
        if (running) {
            stopRequested = true;
            running = false;
            statusText.textContent = '已停止';
            statusText.style.color = '#909399';
            startBtn.disabled = false;
            stopBtn.disabled = true;
        }
    });

})();
