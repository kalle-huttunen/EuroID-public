/**
 * EuroID Design System — Theme Configuration ("passport")
 *
 * Audience: IT and security admins governing who has access to what.
 * Calm, precise, trustworthy. Cool mist canvas, ink text, deep EU blue,
 * passport-navy sidebar. EU gold is the single highlight and means LIVE / ACTIVE
 * only (active nav item, a deployed pipeline). Never decorative, never text on light.
 *
 * All color values live in this file. Components use BRAND / SEMANTIC / LIVE or
 * `theme.useToken()`; scripts/check-hex-colors.sh enforces it.
 */
import type { ThemeConfig } from 'antd';
import { theme } from 'antd';

// ── Brand Palette ─────────────────────────────────────────────────
export const BRAND = {
  // Primary: deep EU blue (10:1 on white)
  primary: '#0B3D91',
  primaryHover: '#1E4FA3',
  primaryActive: '#082D6B',
  // Lighter seed for dark mode so primary text keeps AA contrast on navy surfaces
  primaryOnDark: '#6B9BF2',

  // Sidebar: passport navy, always dark
  siderBg: '#0E2A47',
  siderBgSecondary: '#133457',
  siderText: '#B7C4D6',
  siderTextActive: '#FFFFFF',
  siderBorder: '#1C3B5E',
  siderLogoColor: '#FFFFFF',

  // EU gold: LIVE / ACTIVE only
  gold: '#FFCC00',

  // Semantic (light surfaces)
  success: '#1E7A4C',
  // Warning amber is 3.6:1 on white: icons, strokes and large numerals only.
  warning: '#B7791F',
  // Warning as small text, or as the fill behind small white text (tags, badges):
  // 5.9:1 on white, 5.4:1 on bgLayout, 5.4:1 on antd's warning tag tint.
  warningText: '#8A5A12',
  error: '#B42318',
  info: '#2563A6',

  // Neutrals (light mode): cool mist canvas, white surfaces, ink text
  bgLayout: '#F3F5F8',
  bgContainer: '#FFFFFF',
  bgElevated: '#FFFFFF',
  borderBase: '#DDE3EA',
  borderHairline: '#E7EBF0',
  textPrimary: '#17202B',
  textSecondary: '#5B6675',
  textTertiary: '#6B7585',
  rowHover: '#F7F9FB',
  // Primary tint for selected / brand-tinted surfaces (antd derives a grey here)
  primaryTint: '#E8EEF8',
  primaryTintHover: '#DCE5F4',

  // Canvas edges (neutral slate, readable on both modes)
  edgeStroke: '#8A94A3',
} as const;

// ── Dark palette (derived from the sider navy, not neutral greys) ──
export const DARK = {
  bgLayout: '#0A1626',
  bgContainer: '#0F1E33',
  bgElevated: '#15263F',
  border: '#22344F',
  borderHairline: '#1B2C45',
  text: '#E6ECF4',
  textSecondary: '#9AA8BB',
  rowHover: '#132541',

  // Semantic seeds lifted for contrast on navy surfaces
  success: '#3FB27F',
  warning: '#E0A33A',
  // Warning as small text on dark surfaces: 6.9:1 or better on every DARK surface.
  // antd's dark algorithm would derive a duller text shade from the seed.
  warningText: '#E0A33A',
  error: '#F2665A',
  info: '#5FA0E8',
} as const;

// ── Semantic Colors (import these instead of hardcoding hex) ───────
export const SEMANTIC = {
  statusSynced: BRAND.success,
  statusDrift: BRAND.warning,
  /** Drift as a tag or badge fill behind small white text (AA); statusDrift stays for icons. */
  statusDriftText: BRAND.warningText,
  statusError: BRAND.error,
  statusRunning: BRAND.primary,
  statusInactive: '#8A94A3',

  actionDestructive: BRAND.error,
  actionCreate: BRAND.success,
  actionUpdate: BRAND.primary,
} as const;

/** LIVE state (deployed pipeline, active nav). Alpha variants are precomputed here. */
export const LIVE = {
  color: BRAND.gold,
  glow: 'rgba(255, 204, 0, 0.35)',
  glowSoft: 'rgba(255, 204, 0, 0.16)',
} as const;

/** Shared overlay / shadow values used by floating UI (palette, trays, bars). */
export const OVERLAY = {
  backdrop: 'rgba(10, 22, 38, 0.45)',
  shadowFloating: '0 12px 32px rgba(10, 22, 38, 0.16)',
  shadowRaised: '0 4px 12px rgba(10, 22, 38, 0.10)',
} as const;

// ── Typography ─────────────────────────────────────────────────────
export const FONT_SANS =
  "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
export const FONT_MONO =
  "'IBM Plex Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

// ── Shared token base ──────────────────────────────────────────────
const sharedTokens = {
  fontFamily: FONT_SANS,
  fontFamilyCode: FONT_MONO,
  fontSize: 14,

  borderRadius: 6,
  borderRadiusLG: 8,
  borderRadiusSM: 4,

  lineWidthFocus: 2,
  controlOutlineWidth: 2,

  marginXS: 8,
  marginSM: 16,
  margin: 20,
  marginMD: 24,
  marginLG: 32,
  marginXL: 40,

  paddingXS: 8,
  paddingSM: 16,
  padding: 20,
  paddingMD: 24,
  paddingLG: 32,
  paddingXL: 40,
};

function buildComponents(p: {
  hairline: string;
  rowHover: string;
  textSecondary: string;
  surface: string;
  warningText: string;
}): ThemeConfig['components'] {
  return {
    Menu: {
      itemHeight: 40,
      itemMarginInline: 8,
      itemBorderRadius: 6,
    },
    Button: {
      borderRadius: 6,
      fontWeight: 500,
      primaryShadow: 'none',
      defaultShadow: 'none',
      dangerShadow: 'none',
    },
    Card: {
      borderRadiusLG: 8,
      boxShadowTertiary: 'none',
      headerFontSize: 15,
      headerHeight: 48,
      headerHeightSM: 40,
      headerPadding: 20,
      bodyPadding: 20,
      headerPaddingSM: 16,
      bodyPaddingSM: 16,
    },
    Input: {
      borderRadius: 6,
    },
    Select: {
      borderRadius: 6,
    },
    Modal: {
      borderRadiusLG: 8,
    },
    Table: {
      borderRadius: 8,
      // Opaque (same as the surface) so fixed columns do not show content scrolling beneath.
      headerBg: p.surface,
      headerColor: p.textSecondary,
      headerSplitColor: 'transparent',
      headerBorderRadius: 0,
      borderColor: p.hairline,
      rowHoverBg: p.rowHover,
      cellPaddingBlock: 12,
      cellPaddingInline: 14,
      cellPaddingBlockMD: 10,
      cellPaddingInlineMD: 12,
      cellPaddingBlockSM: 8,
      cellPaddingInlineSM: 10,
    },
    Tabs: {
      titleFontSize: 14,
      horizontalItemPadding: '10px 0',
      horizontalItemGutter: 28,
    },
    Tag: {
      borderRadiusSM: 4,
      // <Tag color="warning"> draws its text in colorWarning; use the AA text shade.
      colorWarning: p.warningText,
    },
    Statistic: {
      titleFontSize: 13,
      contentFontSize: 28,
    },
    Breadcrumb: {
      fontSize: 13,
    },
  };
}

// ── Light Theme ────────────────────────────────────────────────────
export const lightTheme: ThemeConfig = {
  algorithm: theme.defaultAlgorithm,
  token: {
    ...sharedTokens,
    colorPrimary: BRAND.primary,
    colorPrimaryBg: BRAND.primaryTint,
    colorPrimaryBgHover: BRAND.primaryTintHover,
    colorSuccess: BRAND.success,
    colorWarning: BRAND.warning,
    // Typography type="warning" and any small warning copy read this token.
    colorWarningText: BRAND.warningText,
    colorError: BRAND.error,
    colorInfo: BRAND.info,
    colorTextBase: BRAND.textPrimary,
    colorText: BRAND.textPrimary,
    colorTextSecondary: BRAND.textSecondary,
    colorTextTertiary: BRAND.textTertiary,
    colorTextDescription: BRAND.textSecondary,
    colorBgLayout: BRAND.bgLayout,
    colorBgContainer: BRAND.bgContainer,
    colorBgElevated: BRAND.bgElevated,
    colorBorder: BRAND.borderBase,
    colorBorderSecondary: BRAND.borderHairline,
    colorSplit: BRAND.borderHairline,
    controlOutline: 'rgba(11, 61, 145, 0.22)',
    boxShadow: '0 1px 2px 0 rgba(10, 22, 38, 0.05)',
    boxShadowSecondary: OVERLAY.shadowFloating,
  },
  components: {
    ...buildComponents({
      hairline: BRAND.borderHairline,
      rowHover: BRAND.rowHover,
      textSecondary: BRAND.textSecondary,
      surface: BRAND.bgContainer,
      warningText: BRAND.warningText,
    }),
    Layout: {
      siderBg: BRAND.siderBg,
      bodyBg: BRAND.bgLayout,
      headerBg: BRAND.bgContainer,
    },
  },
};

// ── Dark Theme ─────────────────────────────────────────────────────
export const darkTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    ...sharedTokens,
    colorPrimary: BRAND.primaryOnDark,
    colorSuccess: DARK.success,
    colorWarning: DARK.warning,
    colorWarningText: DARK.warningText,
    colorError: DARK.error,
    colorInfo: DARK.info,
    colorBgBase: DARK.bgLayout,
    colorTextBase: DARK.text,
    colorText: DARK.text,
    colorTextSecondary: DARK.textSecondary,
    colorTextDescription: DARK.textSecondary,
    colorBgLayout: DARK.bgLayout,
    colorBgContainer: DARK.bgContainer,
    colorBgElevated: DARK.bgElevated,
    colorBorder: DARK.border,
    colorBorderSecondary: DARK.borderHairline,
    colorSplit: DARK.borderHairline,
    controlOutline: 'rgba(107, 155, 242, 0.32)',
    boxShadow: 'none',
    boxShadowSecondary: '0 12px 32px rgba(0, 0, 0, 0.45)',
  },
  components: {
    ...buildComponents({
      hairline: DARK.borderHairline,
      rowHover: DARK.rowHover,
      textSecondary: DARK.textSecondary,
      surface: DARK.bgContainer,
      warningText: DARK.warningText,
    }),
    Layout: {
      siderBg: BRAND.siderBg,
      bodyBg: DARK.bgLayout,
      headerBg: DARK.bgContainer,
    },
  },
};

// ── Sidebar Theme (always dark, passport navy) ─────────────────────
export const siderTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    fontFamily: FONT_SANS,
    colorPrimary: BRAND.primaryOnDark,
    colorBgContainer: BRAND.siderBg,
    colorBgElevated: BRAND.siderBgSecondary,
    colorBgLayout: BRAND.siderBg,
    colorText: BRAND.siderText,
    colorTextSecondary: BRAND.siderText,
    colorBorder: BRAND.siderBorder,
    colorBorderSecondary: BRAND.siderBorder,
  },
  components: {
    Menu: {
      darkItemBg: 'transparent',
      darkSubMenuItemBg: 'transparent',
      darkItemSelectedBg: 'rgba(255, 255, 255, 0.08)',
      darkItemHoverBg: 'rgba(255, 255, 255, 0.05)',
      darkItemSelectedColor: BRAND.siderTextActive,
      darkItemColor: BRAND.siderText,
      darkItemHoverColor: BRAND.siderTextActive,
      darkGroupTitleColor: 'rgba(183, 196, 214, 0.72)',
      groupTitleFontSize: 12,
      itemHeight: 38,
      itemMarginInline: 8,
      itemMarginBlock: 2,
      itemBorderRadius: 6,
      iconSize: 15,
      collapsedIconSize: 16,
    },
    Divider: {
      colorSplit: BRAND.siderBorder,
    },
  },
};
