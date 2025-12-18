import React, { useState, useRef, useCallback, useEffect } from 'react';
import styles from './styles.module.css';

interface ResizableImageProps {
  /** 图片源地址 */
  src: string;
  /** 图片替代文本 */
  alt?: string;
  /** 默认宽度（像素） */
  defaultWidth?: number;
  /** 最小宽度（像素） */
  minWidth?: number;
  /** 最大宽度（像素） */
  maxWidth?: number;
}

/**
 * 可拖动调整大小的图片组件
 * 通过拖动右下角的手柄来调整图片大小，自动保持宽高比
 */
export default function ResizableImage({
  src,
  alt = '',
  defaultWidth = 500,
  minWidth = 100,
  maxWidth = 1200,
}: ResizableImageProps): React.JSX.Element {
  const [width, setWidth] = useState<number>(defaultWidth);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef<number>(0);
  const startWidthRef = useRef<number>(0);

  // 处理鼠标按下事件
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    startXRef.current = e.clientX;
    startWidthRef.current = width;
  }, [width]);

  // 处理鼠标移动事件
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging) return;
    
    const deltaX = e.clientX - startXRef.current;
    let newWidth = startWidthRef.current + deltaX;
    
    // 限制在最小和最大宽度之间
    newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
    setWidth(newWidth);
  }, [isDragging, minWidth, maxWidth]);

  // 处理鼠标释放事件
  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // 添加和移除全局事件监听器
  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      // 拖动时禁止选择文本
      document.body.style.userSelect = 'none';
    }
    
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
    };
  }, [isDragging, handleMouseMove, handleMouseUp]);

  return (
    <div 
      ref={containerRef}
      className={`${styles.container} ${isDragging ? styles.dragging : ''}`}
      style={{ width: `${width}px` }}
    >
      <img 
        src={src} 
        alt={alt} 
        className={styles.image}
        draggable={false}
      />
      <div 
        className={styles.resizeHandle}
        onMouseDown={handleMouseDown}
        title="拖动调整大小"
      >
        <svg 
          width="10" 
          height="10" 
          viewBox="0 0 10 10" 
          fill="currentColor"
        >
          <circle cx="8" cy="2" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="2" cy="8" r="1.5" />
        </svg>
      </div>
      <div className={styles.widthIndicator}>
        {Math.round(width)}px
      </div>
    </div>
  );
}
