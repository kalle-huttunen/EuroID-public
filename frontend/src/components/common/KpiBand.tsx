/**
 * KpiBand — one flat band of key figures separated by hairlines.
 * Large tabular numerals; optional one-time count-up (reduced-motion safe).
 * Cells with `onClick` render as buttons so they are keyboard reachable.
 */
import React, { useEffect, useState } from 'react';
import { Grid, Skeleton, Typography, theme } from 'antd';

const { Text } = Typography;
const { useBreakpoint } = Grid;

export interface KpiItem {
  key: string;
  label: string;
  /** null renders an em dash (data unavailable). */
  value: number | null;
  decimals?: number;
  suffix?: string;
  /** One short line under the value. */
  context?: React.ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'error';
  onClick?: () => void;
  /** Accessible name for the clickable cell. */
  actionLabel?: string;
}

interface KpiBandProps {
  items: KpiItem[];
  loading?: boolean;
  /** Animate numbers from 0 (callers decide when: first load only). Ignored under reduced motion. */
  countUp?: boolean;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

const COUNT_UP_MS = 700;

const CountUp: React.FC<{ value: number; decimals: number; animate: boolean }> = ({
  value,
  decimals,
  animate,
}) => {
  const [display, setDisplay] = useState(animate ? 0 : value);

  useEffect(() => {
    if (!animate) return;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / COUNT_UP_MS);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(value * eased);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, animate]);

  const shown = animate ? display : value;
  return <>{shown.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</>;
};

export const KpiBand: React.FC<KpiBandProps> = ({ items, loading, countUp = false }) => {
  const { token } = theme.useToken();
  const screens = useBreakpoint();
  const columns = screens.md ? items.length : 2;
  const [animate] = useState(() => countUp && !prefersReducedMotion());

  const toneColor: Record<NonNullable<KpiItem['tone']>, string> = {
    default: token.colorText,
    success: token.colorSuccess,
    warning: token.colorWarning,
    error: token.colorError,
  };

  return (
    <div
      role="group"
      aria-label="Key figures"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        overflow: 'hidden',
      }}
    >
      {items.map((item, i) => {
        const col = i % columns;
        const row = Math.floor(i / columns);
        const cellStyle: React.CSSProperties = {
          padding: '18px 20px 16px',
          // Longhands only: mixing `border` with side borders breaks on re-render.
          borderTop: row > 0 ? `1px solid ${token.colorBorderSecondary}` : 'none',
          borderLeft: col > 0 ? `1px solid ${token.colorBorderSecondary}` : 'none',
          borderRight: 'none',
          borderBottom: 'none',
          textAlign: 'left',
          minWidth: 0,
        };
        const body = (
          <>
            <Text type="secondary" style={{ fontSize: 13, display: 'block' }}>
              {item.label}
            </Text>
            {loading ? (
              <Skeleton.Input active size="small" style={{ marginTop: 10, width: 72, height: 30 }} />
            ) : (
              <div
                className="tabular-nums"
                style={{
                  fontSize: 32,
                  lineHeight: '40px',
                  fontWeight: 600,
                  letterSpacing: '-0.02em',
                  marginTop: 4,
                  color: item.value == null ? token.colorTextTertiary : toneColor[item.tone ?? 'default'],
                }}
              >
                {item.value == null ? (
                  '—'
                ) : (
                  <CountUp value={item.value} decimals={item.decimals ?? 0} animate={animate} />
                )}
                {item.value != null && item.suffix && (
                  <span style={{ fontSize: 15, fontWeight: 500, color: token.colorTextSecondary, marginLeft: 4 }}>
                    {item.suffix}
                  </span>
                )}
              </div>
            )}
            {item.context && (
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>
                {item.context}
              </Text>
            )}
          </>
        );

        if (item.onClick) {
          return (
            <button
              key={item.key}
              type="button"
              className="euroid-row-action"
              onClick={item.onClick}
              aria-label={item.actionLabel}
              style={{
                ...cellStyle,
                background: 'transparent',
                font: 'inherit',
                color: 'inherit',
                cursor: 'pointer',
              }}
            >
              {body}
            </button>
          );
        }
        return (
          <div key={item.key} style={cellStyle}>
            {body}
          </div>
        );
      })}
    </div>
  );
};
