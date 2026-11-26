/**
 * Page chrome shared by every routed page.
 *
 *   <PageContainer>
 *     <PageHeader title="Audit & compliance" subtitle="…" actions={<Button>…</Button>} />
 *     …content…
 *   </PageContainer>
 *
 * PageContainer: 24px padding, 1440px max width, centered. `fill` makes it a
 * full-height flex column without padding or max width (canvas pages).
 */
import React from 'react';
import { Typography, Grid } from 'antd';

const { Title, Text } = Typography;
const { useBreakpoint } = Grid;

const PAGE_MAX_WIDTH = 1440;

interface PageHeaderProps {
  title: React.ReactNode;
  /** One line of context under the title. */
  subtitle?: React.ReactNode;
  /** Right-aligned actions (buttons, filters). */
  actions?: React.ReactNode;
  /** Inline element after the title, e.g. a status tag. */
  titleExtra?: React.ReactNode;
  style?: React.CSSProperties;
}

export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  subtitle,
  actions,
  titleExtra,
  style,
}) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      flexWrap: 'wrap',
      gap: 16,
      marginBottom: 20,
      ...style,
    }}
  >
    <div style={{ minWidth: 0, flex: '1 1 320px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Title level={3} style={{ margin: 0, fontWeight: 600, letterSpacing: '-0.01em' }}>
          {title}
        </Title>
        {titleExtra}
      </div>
      {subtitle && (
        <Text type="secondary" style={{ display: 'block', marginTop: 4 }}>
          {subtitle}
        </Text>
      )}
    </div>
    {actions && (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{actions}</div>
    )}
  </div>
);

interface PageContainerProps {
  children: React.ReactNode;
  /** Full-height, edge-to-edge layout for canvas pages. */
  fill?: boolean;
  style?: React.CSSProperties;
}

export const PageContainer: React.FC<PageContainerProps> = ({ children, fill, style }) => {
  const screens = useBreakpoint();
  if (fill) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: 'calc(100vh - var(--euroid-chrome-height, 48px))',
          minHeight: 480,
          ...style,
        }}
      >
        {children}
      </div>
    );
  }
  return (
    <div
      style={{
        padding: screens.md ? 24 : 16,
        maxWidth: PAGE_MAX_WIDTH,
        margin: '0 auto',
        width: '100%',
        boxSizing: 'border-box',
        ...style,
      }}
    >
      {children}
    </div>
  );
};
