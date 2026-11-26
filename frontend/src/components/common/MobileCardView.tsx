/**
 * Mobile card view — renders table data as stacked cards on small screens.
 * Pass the same dataSource and a renderCard function.
 * On >=768px, renders children (the normal table). On <768px, renders cards.
 */
import React from 'react';
import { Grid, Space } from 'antd';

const { useBreakpoint } = Grid;

interface MobileCardViewProps<T> {
  dataSource: T[];
  renderCard: (item: T, index: number) => React.ReactNode;
  children: React.ReactNode;
  loading?: boolean;
}

export function MobileCardView<T>({
  dataSource,
  renderCard,
  children,
  loading,
}: MobileCardViewProps<T>): React.ReactElement {
  const screens = useBreakpoint();
  const isMobile = !screens.md;

  if (!isMobile || loading) {
    return <>{children}</>;
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {dataSource.map((item, index) => (
        <div key={index} className="content-appear">
          {renderCard(item, index)}
        </div>
      ))}
    </Space>
  );
}
