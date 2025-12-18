import type { ReactNode } from 'react';
import Link from '@docusaurus/Link';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

type LinkItem = {
    title: string;
    icon: string;
    description: string;
    to: string;
};

const LinkList: LinkItem[] = [
    {
        title: 'Java 基础',
        icon: '☕',
        description: 'Java 核心知识点整理',
        to: '/docs/Java/Java基础',
    },
    {
        title: 'MySQL 数据库',
        icon: '🗄️',
        description: '索引、事务、锁等原理',
        to: '/docs/MySQL/锁',
    },
    {
        title: 'JUC 并发编程',
        icon: '⚡',
        description: '多线程与并发控制',
        to: '/docs/JUC/AQS',
    },
];

export default function QuickLinks(): ReactNode {
    return (
        <section className={styles.quickLinks}>
            <div className="container">
                <div className="text--center margin-bottom--lg">
                    <Heading as="h2">🚀 快速导航</Heading>
                    <p className="text--secondary">直达知识库核心内容</p>
                </div>
                <div className={styles.linkGrid}>
                    {LinkList.map((item, idx) => (
                        <Link key={idx} to={item.to} className={styles.linkCard}>
                            <div className={styles.linkIcon}>{item.icon}</div>
                            <div className={styles.linkContent}>
                                <Heading as="h3" className={styles.linkTitle}>
                                    {item.title}
                                </Heading>
                                <p className={styles.linkDescription}>{item.description}</p>
                            </div>
                            <div className={styles.linkArrow}>→</div>
                        </Link>
                    ))}
                </div>
            </div>
        </section>
    );
}
