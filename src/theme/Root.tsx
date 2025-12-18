import React from 'react';

/**
 * Root 组件 - Docusaurus 的全局包装组件
 * ShikiEnhancer 现在通过 clientModules 加载，不需要在这里导入
 */
export default function Root({ children }: { children: React.ReactNode }): React.ReactElement {
    return <>{children}</>;
}
