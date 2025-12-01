import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';

type CardItem = {
  title: string;
  description: string;
  docId?: string; // 文档ID（推荐使用）
  to?: string; // 直接路径（备用）
};

type CategoryCardsProps = {
  items: CardItem[];
};

function Card({title, description, docId, to}: CardItem) {
  // 优先使用docId，构建正确的文档路径
  // Docusaurus的文档路径格式: /docs/docId
  // Link组件会自动处理多语言前缀
  const linkTo = docId
    ? `/docs/${docId}`
    : to!;

  return (
    <Link to={linkTo} className={styles.card}>
      <div className={styles.cardIcon}>
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg">
          <path
            d="M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2Z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M14 2V8H20"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M16 13H8"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M16 17H8"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M10 9H9H8"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div className={styles.cardContent}>
        <h3 className={styles.cardTitle}>{title}</h3>
        <p className={styles.cardDescription}>{description}</p>
      </div>
    </Link>
  );
}

export default function CategoryCards({items}: CategoryCardsProps): ReactNode {
  return (
    <div className={styles.cardsContainer}>
      {items.map((item, idx) => (
        <Card key={idx} {...item} />
      ))}
    </div>
  );
}

