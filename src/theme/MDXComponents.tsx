import React from 'react';
// 导入默认的 MDX 组件
import MDXComponents from '@theme-original/MDXComponents';
// 导入自定义组件
import ResizableImage from '@site/src/components/ResizableImage';

export default {
    // 保留所有默认组件
    ...MDXComponents,
    // 注册自定义组件，可在 MDX 文件中直接使用
    ResizableImage,
};
