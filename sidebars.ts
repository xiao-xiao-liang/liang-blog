import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  // 手动定义侧边栏结构以支持多级目录
  tutorialSidebar: [
    'intro',
    {
      type: 'category',
      label: 'Java',
      collapsed: true,
      collapsible: true,
      link: {
        type: 'doc',
        id: 'Java/index',
      },
      items: [
        'Java/Java基础',
        'Java/Java集合',
      ],
    },
    {
      type: 'category',
      label: 'JUC',
      collapsed: true,
      collapsible: true,
      link: {
        type: 'doc',
        id: 'JUC/index',
      },
      items: [
        'JUC/ThreadLocal',
        'JUC/线程池',
        'JUC/AQS',
      ],
    },
    {
      type: 'category',
      label: 'MySQL',
      collapsed: true,
      collapsible: true,
      link: {
        type: 'doc',
        id: 'MySQL/index',
      },
      items: [
        'MySQL/MVCC',
        'MySQL/锁',
        'MySQL/日志文件',
        'MySQL/存储引擎',
        'MySQL/索引',
      ],
    },
  ],
};

export default sidebars;