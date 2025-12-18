/**
 * 代码块增强脚本 - 为代码块添加复制按钮和语言标签
 * 支持 Docusaurus 默认的 Prism 代码块和 Shiki 代码块
 * 通过 clientModules 在客户端加载执行
 */

import './shiki-enhancer.css';

// 增强代码块
function enhanceCodeBlocks(): void {
    // 查找所有 potential code blocks (pre elements)
    // 排除掉已经增强过的
    const allPres = document.querySelectorAll('pre:not([data-enhanced])');

    allPres.forEach((pre) => {
        pre.setAttribute('data-enhanced', 'true');

        // Check if it's a Docusaurus/Prism block
        // Docusaurus 默认代码块通常被包裹在 .theme-code-block 中
        const themeCodeBlock = pre.closest('.theme-code-block');

        if (themeCodeBlock) {
            enhancePrismBlock(themeCodeBlock, pre);
        } else {
            // It's likely a standalone block (Shiki, etc.)
            enhanceStandaloneBlock(pre);
        }
    });
}

// 处理 Prism/Docusaurus 默认代码块
function enhancePrismBlock(container: Element, preElement: Element): void {
    // 获取语言信息
    let language = '';
    const preClasses = preElement.className.split(' ');
    const langClass = preClasses.find(c => c.startsWith('language-'));
    if (langClass) {
        language = langClass.replace('language-', '');
    }

    // 检查是否已经有复制按钮 (Docusaurus 自带)
    if (container.querySelector('.buttonGroup__atx, .buttonGroup, [class*="buttonGroup"]')) {
        // 已有按钮组，只添加语言标签到现有的工具栏（如果需要且没有）
        const codeBlockTitle = container.querySelector('.codeBlockTitle, [class*="codeBlockTitle"]');
        if (codeBlockTitle && language && !codeBlockTitle.querySelector('.shiki-language-label')) {
            const langLabel = document.createElement('span');
            langLabel.className = 'shiki-language-label';
            langLabel.textContent = language.toUpperCase();
            codeBlockTitle.insertBefore(langLabel, codeBlockTitle.firstChild);
        }
        return;
    }

    // 如果没有自带按钮，添加我们的工具栏
    addToolbar(container, preElement, language);
}

// 处理独立的 Shiki 代码块
function enhanceStandaloneBlock(preElement: Element): void {
    // 如果父元素已经是增强容器，跳过
    if (preElement.parentElement?.classList.contains('shiki-code-block-container')) return;

    // 获取语言信息
    let language = '';
    // 1. 尝试从 pre class 获取
    const classes = preElement.className.split(' ');
    let langClass = classes.find(c => c.startsWith('language-'));

    // 2. 如果 pre 没有，尝试从内部 code 元素获取
    if (!langClass) {
        const codeElement = preElement.querySelector('code');
        if (codeElement) {
            const codeClasses = codeElement.className.split(' ');
            langClass = codeClasses.find(c => c.startsWith('language-'));
        }
    }

    if (langClass) {
        language = langClass.replace('language-', '');
    }

    // 创建包装容器
    const container = document.createElement('div');
    container.className = 'shiki-code-block-container';

    // 将容器插入到代码块前面
    if (preElement.parentElement) {
        preElement.parentElement.insertBefore(container, preElement);
        // 将代码块移动到容器内
        container.appendChild(preElement);
        // 添加工具栏
        addToolbar(container, preElement, language);
    }
}

// 添加工具栏到代码块
function addToolbar(container: Element, codeElement: Element, language: string): void {
    // 检查是否已有工具栏
    if (container.querySelector('.shiki-code-block-toolbar')) return;

    const toolbar = document.createElement('div');
    toolbar.className = 'shiki-code-block-toolbar';

    // 语言标签
    const langLabel = document.createElement('span');
    langLabel.className = 'shiki-language-label';
    langLabel.textContent = language ? language.toUpperCase() : 'CODE';
    toolbar.appendChild(langLabel);

    // 复制按钮
    const copyBtn = document.createElement('button');
    copyBtn.className = 'shiki-copy-button';
    copyBtn.setAttribute('title', '复制代码');
    copyBtn.innerHTML = `
        <svg class="shiki-copy-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
        </svg>
        <span class="shiki-copy-text">复制</span>
    `;

    copyBtn.addEventListener('click', async () => {
        const code = codeElement.querySelector('code') || codeElement;
        try {
            await navigator.clipboard.writeText(code.textContent || '');
            copyBtn.classList.add('copied');
            const copyText = copyBtn.querySelector('.shiki-copy-text') as HTMLElement;
            if (copyText) copyText.textContent = '已复制!';

            setTimeout(() => {
                copyBtn.classList.remove('copied');
                if (copyText) copyText.textContent = '复制';
            }, 2000);
        } catch (err) {
            console.error('复制失败:', err);
        }
    });

    toolbar.appendChild(copyBtn);

    // 找到正确的位置插入工具栏
    const codeBlockContent = container.querySelector('.codeBlockContent, [class*="codeBlockContent"]');
    if (codeBlockContent) {
        codeBlockContent.insertBefore(toolbar, codeBlockContent.firstChild);
    } else {
        container.insertBefore(toolbar, container.firstChild);
    }
}

// 页面加载后执行
if (typeof window !== 'undefined') {
    const run = () => setTimeout(enhanceCodeBlocks, 300);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run);
    } else {
        run();
    }

    // 监听 SPA 路由变化
    let lastUrl = location.href;
    new MutationObserver(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            setTimeout(enhanceCodeBlocks, 300);
        }
    }).observe(document.body, { childList: true, subtree: true });
}

export default function onClientEntry() { }
