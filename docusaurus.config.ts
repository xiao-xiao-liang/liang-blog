import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  // title: 'My Site',
  title: '小小亮的个人网站',
  tagline: 'Dinosaurs are cool',
  favicon: 'img/favicon.ico',

  // Future flags, see https://docusaurus.io/docs/api/docusaurus-config#future
  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  // Set the production url of your site here
  // 请根据实际情况修改为你的域名或 IP 地址
  url: 'http://xiaoxiaoliang.com',  // 或者使用你的域名，如 'https://yourdomain.com'
  // Set the /<baseUrl>/ pathname under which your site is served
  // For GitHub pages deployment, it is often '/<projectName>/'
  baseUrl: '/',

  // GitHub pages deployment config.
  // If you aren't using GitHub pages, you don't need these.
  organizationName: 'facebook', // Usually your GitHub org/user name.
  projectName: 'liang-blog', // Usually your repo name.

  onBrokenLinks: 'throw',

  i18n: { // 多语言配置
    defaultLocale: 'zh-Hans',
    locales: ['zh-Hans', 'en'],
    localeConfigs: {
      'zh-Hans': {
        label: '中文',
        htmlLang: 'zh-CN',
      },
      'en': {
        label: 'English',
        htmlLang: 'en-US',
      },
    }
  },

  plugins: [
    [
      require.resolve('@easyops-cn/docusaurus-search-local'),
      {
        // 搜索配置选项
        hashed: true, // 使用哈希值优化搜索索引
        language: ['zh', 'en'], // 支持的语言
        highlightSearchTermsOnTargetPage: true, // 在目标页面高亮搜索词
        explicitSearchResultPath: true, // 显式搜索结果路径
      },
    ],
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts', // 侧边栏配置文件
        },
        blog: {
          showReadingTime: true,
          feedOptions: {
            type: ['rss', 'atom'],
            xslt: true,
          },
          onInlineTags: 'warn',
          onInlineAuthors: 'warn',
          onUntruncatedBlogPosts: 'warn',
        },
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    // Replace with your project's social card
    image: 'img/docusaurus-social-card.jpg',
    colorMode: {
      defaultMode: "light",
      disableSwitch: false,
      respectPrefersColorScheme: false,
    },
    docs: {
      versionPersistence: 'localStorage',
      sidebar: {
        hideable: false, // 在侧边栏底部显示隐藏按钮
        autoCollapseCategories: true, // 自动折叠您导航到的类别的所有同级类别
      },
    },
    blog: {
      sidebar: {
        groupByYear: true, // 按年份对侧边栏博客文章进行分组
      },
    },
    navbar: { // 导航栏
      title: '小小亮的个人网站',
      logo: {
        alt: '小小亮的个人网站',
        src: 'img/logo.svg',
      },
      hideOnScroll: false, // 滚动时导航栏是否隐藏
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'tutorialSidebar',
          position: 'left',
          label: '知识库',
        },
        {
          to: '/blog',
          label: '博客',
          position: 'left'
        },
        {
          type: 'search', // 导航栏搜索
          position: 'right',
        },
        {
          type: 'localeDropdown', // 多语言下拉菜单
          position: 'right',
        },
        {
          href: 'https://github.com/xiao-xiao-liang', // GitHub 链接
          label: 'GitHub',
          position: 'right',
        },
        {
          label: '我的项目',
          type: 'dropdown',
          items: [
            {
              label: '牛券',
              href: 'https://gitee.com/xiao-xiao-liang/onecoupon',
            },
            {
              label: '短链接',
              href: 'https://gitee.com/xiao-xiao-liang/shortlink',
            },
          ]
        },
      ],
    },
    /*footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {
              label: 'Tutorial',
              to: '/docs/intro',
            },
          ],
        },
        {
          title: 'Community',
          items: [
            {
              label: 'Stack Overflow',
              href: 'https://stackoverflow.com/questions/tagged/docusaurus',
            },
            {
              label: 'Discord',
              href: 'https://discordapp.com/invite/docusaurus',
            },
            {
              label: 'X',
              href: 'https://x.com/docusaurus',
            },
          ],
        },
        {
          title: 'More',
          items: [
            {
              label: 'Blog',
              to: '/blog',
            },
            {
              label: 'GitHub',
              href: 'https://github.com/facebook/docusaurus',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} My Project, Inc. Built with Docusaurus.`,
    },*/
    prism: { // 代码块配置
      theme: prismThemes.jettwaveLight,
      darkTheme: prismThemes.dracula,
      defaultLanguage: 'java',
      additionalLanguages: ['bash', 'java', 'properties']
    },
  } satisfies Preset.ThemeConfig,
};

export default config;