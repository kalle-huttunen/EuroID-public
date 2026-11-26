# Frontend Architecture - The Command Center (2026)

> **Module:** Frontend (React + Vite)
> **Cross-cutting:** [Data Flows](../../docs/architecture/core/DATAFLOWS.md) | [UI Guide](../../.ai/UI_GUIDE.md)

## Design Philosophy

**"Complexity in the Backend, Simplicity in the Frontend."**

The user should feel like they are "Drawing" access, not "Coding" it.

* **Framework:** React + Vite
* **State Management:** React Query (Server State) + Zustand (Client State)
* **Visuals:** React Flow (Policy Canvas) + Ant Design (Components)

---

## Brand & Design System

### Brand Positioning

EuroID communicates **trust, precision, and modern security** — professional without being cold or corporate-generic. Clean dashboards with strong visual hierarchy for complex IAM data.

### Color Palette

All colors are defined in `src/theme/themeConfig.ts` (the "passport" theme). Never hardcode hex values (`scripts/check-hex-colors.sh` enforces it): import from `BRAND` (layout, light mode), `DARK` (dark mode), `SEMANTIC` (meaning), `LIVE` (the gold LIVE mark) or `OVERLAY` (backdrop and floating shadows), or use `theme.useToken()`.

#### Primary: Deep EU Blue (`BRAND`)

| Token | Hex | Usage |
|-------|-----|-------|
| `primary` | `#0B3D91` | Primary buttons, links, focus (`colorPrimary` in light mode) |
| `primaryHover` / `primaryActive` | `#1E4FA3` / `#082D6B` | Hover and pressed primary |
| `primaryOnDark` | `#6B9BF2` | Primary in dark mode and in the sidebar |
| `primaryTint` / `primaryTintHover` | `#E8EEF8` / `#DCE5F4` | Selected and brand-tinted surfaces (`colorPrimaryBg`) |

#### Accent: EU Gold

| Token | Hex | Usage |
|-------|-----|-------|
| `gold` (`LIVE.color`) | `#FFCC00` | LIVE / ACTIVE only: the active nav item, a deployed pipeline. Never decorative, never text on light |

#### Sidebar (`BRAND`, always dark)

| Token | Hex | Usage |
|-------|-----|-------|
| `siderBg` | `#0E2A47` | Passport navy sidebar background (also `theme-color` in `index.html`) |
| `siderBgSecondary` | `#133457` | Elevated surfaces in the sidebar |
| `siderText` / `siderTextActive` | `#B7C4D6` / `#FFFFFF` | Item text; active and hover text |
| `siderBorder` | `#1C3B5E` | Sidebar dividers |
| `siderLogoColor` | `#FFFFFF` | "EuroID" wordmark |

#### Semantic Colors

| Token | Light (`BRAND`) | Dark (`DARK`) | Usage |
|-------|-----------------|---------------|-------|
| `success` | `#1E7A4C` | `#3FB27F` | Approved, synced, active (`SEMANTIC.statusSynced`, `actionCreate`) |
| `warning` | `#B7791F` | `#E0A33A` | Icons, strokes and large numerals only (`SEMANTIC.statusDrift`) |
| `warningText` | `#8A5A12` | `#E0A33A` | Warning as small text, or the fill behind small white text (`colorWarningText`, `SEMANTIC.statusDriftText`) |
| `error` | `#B42318` | `#F2665A` | Revoked, failed, destructive (`SEMANTIC.statusError`, `actionDestructive`) |
| `info` | `#2563A6` | `#5FA0E8` | Informational alerts |

`SEMANTIC.statusRunning` and `actionUpdate` are `BRAND.primary`; `SEMANTIC.statusInactive` is `#8A94A3`.

#### Neutrals

| Token (`BRAND` / `DARK`) | Light | Dark | Usage |
|-------|-------|------|-------|
| `bgLayout` | `#F3F5F8` | `#0A1626` | Page canvas |
| `bgContainer` | `#FFFFFF` | `#0F1E33` | Cards, tables |
| `bgElevated` | `#FFFFFF` | `#15263F` | Modals, popovers |
| `borderBase` / `border` | `#DDE3EA` | `#22344F` | Borders (`colorBorder`) |
| `borderHairline` | `#E7EBF0` | `#1B2C45` | Dividers, table lines (`colorBorderSecondary`) |
| `textPrimary` / `text` | `#17202B` | `#E6ECF4` | Primary text |
| `textSecondary` | `#5B6675` | `#9AA8BB` | Secondary text, labels, table headers |
| `textTertiary` | `#6B7585` | (antd default) | Tertiary text |
| `rowHover` | `#F7F9FB` | `#132541` | Table row hover |
| `edgeStroke` | `#8A94A3` | `#8A94A3` | Canvas edges |

### Typography

| Element | Font | Size | Weight |
|---------|------|------|--------|
| Text and headings | IBM Plex Sans (`FONT_SANS`) | 14px base (`fontSize`); headings use antd's heading sizes | 400, 500, 600 loaded |
| Card titles | IBM Plex Sans | 15px (`Card.headerFontSize`) | antd default |
| Statistic value / title | IBM Plex Sans | 28px / 13px (`Statistic`) | antd default |
| Code / IDs | IBM Plex Mono (`FONT_MONO`) | antd default | 400, 500 loaded |

Both fonts are loaded via Google Fonts in `index.html`. Ant Design picks them up through the `fontFamily` and `fontFamilyCode` tokens in the theme config.

### Spacing System (4px grid)

The theme sets antd's margin and padding tokens to the same values (`sharedTokens` in `themeConfig.ts`):

| Token | Value |
|-------|-------|
| `marginXS` / `paddingXS` | 8px |
| `marginSM` / `paddingSM` | 16px |
| `margin` / `padding` | 20px |
| `marginMD` / `paddingMD` | 24px |
| `marginLG` / `paddingLG` | 32px |
| `marginXL` / `paddingXL` | 40px |

### Using Colors in Code

```typescript
// Pattern 1: Semantic meaning (preferred for components)
import { SEMANTIC } from '@theme/themeConfig';
<Tag color={isSynced ? SEMANTIC.statusSynced : SEMANTIC.statusDrift}>
  {isSynced ? 'Synced' : 'Drift Detected'}
</Tag>

// Pattern 2: Brand layout colors (for structural elements)
import { BRAND } from '@theme/themeConfig';
<div style={{ background: BRAND.primaryTint }}>...</div>

// Pattern 3: Ant Design tokens (auto-adapts to light/dark mode)
import { theme } from 'antd';
const { token } = theme.useToken();
<div style={{ color: token.colorText, background: token.colorBgContainer }} />
```

---

## Layout Architecture

### Navigation Structure

```
┌────────────┬──────────────────────────────────────────────┐
│ Sidebar    │ TopBar (desktop, 48px): breadcrumb | search, │
│ (passport  │ connection status, notifications, theme      │
│ navy       │ toggle, user menu. Below 768px MobileHeader  │
│ #0E2A47,   │ (56px) instead                               │
│            ├──────────────────────────────────────────────┤
│ always     │                                              │
│ dark)      │ Main content (bgLayout: #F3F5F8 light,       │
│            │ #0A1626 dark)                                │
│ EuroID     │                                              │
│ wordmark,  │ Cards: bgContainer, 1px hairline border,     │
│ tenant name│ 8px radius, no shadow                        │
│            │                                              │
│ Section    │ Tables: header on the surface color,         │
│ labels,    │ textSecondary header text, hairline          │
│ items      │ borders, hover rowHover                      │
│ (#B7C4D6)  │                                              │
│            │                                              │
│ Active:    │                                              │
│ white text,│                                              │
│ 2px EU-gold│                                              │
│ bar at the │                                              │
│ left edge  │                                              │
├────────────┤                                              │
│ Collapse   │                                              │
└────────────┴──────────────────────────────────────────────┘
```

### Sidebar (CustomSider)

- **Menu source:** `NAV_SECTIONS` in `components/layout/navigation.tsx`; `CustomSider` renders it
- **Background:** passport navy `BRAND.siderBg` (`#0E2A47`), always dark (`siderTheme` with `darkAlgorithm`)
- **Section headers:** `rgba(183, 196, 214, 0.72)`, 12px (`Menu.darkGroupTitleColor`, `groupTitleFontSize`)
- **Items:** `siderText` (`#B7C4D6`), 38px high, 15px icon + label
- **Active:** white text on `rgba(255, 255, 255, 0.08)` + a 2px EU-gold bar at the left edge (`.euroid-nav` in `src/styles/app.css`, `LIVE.color`)
- **Hover:** white text on `rgba(255, 255, 255, 0.05)`
- **Responsive:** Full sidebar, 240px (desktop) → icons only, 72px (below 1024px) → drawer opened from MobileHeader (below 768px)

### Mobile Header (MobileHeader)

- **Shown:** below 768px only, 56px high
- **Background:** the surface color (`token.colorBgContainer`) with a hairline bottom border
- **Content:** hamburger (opens the sidebar drawer) | "EuroID" title | notifications + user icon

### Dark Mode

- Sidebar **always dark** in both modes (uses `siderTheme` with `darkAlgorithm`)
- App content respects light/dark toggle via `ColorModeContext` (`darkTheme`: the `DARK` palette, derived from the sidebar navy)
- Persistent choice in `localStorage`, falls back to system preference

---

## Component Patterns

### Buttons

| Type | Background | Text | Border | Usage |
|------|-----------|------|--------|-------|
| Primary | `colorPrimary` (`#0B3D91`; `#6B9BF2` dark) | White | none | Main actions (Save, Approve) |
| Default | `bgContainer` | Text color | 1px `borderBase` | Cancel, secondary actions |
| Success | Success green | White | none | Approve, Grant access |
| Danger | Danger red | White | none | Revoke, Delete |
| Text | Transparent | Text color | none | Tertiary, inline actions |

All buttons: 6px border-radius, font weight 500, no shadow (`components.Button`); height is antd's default (`controlHeight` 32px, not set in the theme).

### Cards

- Background: `bgContainer` (white in light mode)
- Border: 1px `borderHairline` (antd's `colorBorderSecondary`)
- Border-radius: 8px
- Shadow: none (`boxShadowTertiary: 'none'`)
- Padding: 20px header and body (16px in small cards); header 48px high (40px small), title 15px
- Hover (if `hoverable`): antd's default card hover shadow (not set in the theme)

### Data Tables

- Header: the surface color (`Table.headerBg`, opaque so fixed columns do not show content scrolling beneath), `textSecondary` text, no split line between header cells
- Rows: no striping
- Hover: `rowHover` (`#F7F9FB` light, `#132541` dark)
- Selected: antd's selected row color, `colorPrimaryBg` (`primaryTint`, `#E8EEF8` in light mode)
- Borders: `borderHairline`
- Cell padding: 12px × 14px (middle 10px × 12px, small 8px × 10px)
- Monospace IDs: IBM Plex Mono

### Status Badges

Status pills are antd `Tag`s. A status tag (`color="success"`, `"processing"`, `"warning"`, `"error"`) draws its text in the theme's semantic color on antd's light tint of it:

- **Success / active:** `#1E7A4C` text (`BRAND.success`)
- **Warning / pending:** `#8A5A12` text (`BRAND.warningText`: the theme sets `Tag.colorWarning` to it for AA contrast)
- **Error / revoked:** `#B42318` text (`BRAND.error`)
- **Processing / info:** `#2563A6` text (`BRAND.info`)

Dark mode uses the `DARK` values. Some pages use antd preset colors instead, e.g. the identity status tag (`getUserStatusColor` in `utils/user-helpers.ts`: green, orange, red, blue).

---

## Core Modules

### 1. The Design Studio (Policy Builder)

* **Goal:** Visual "If This Then That" builder.
* **Tech:** React Flow (Node-based editor).
* **Features:**
  * Drag-and-drop Conditions (`Department = Sales`).
  * Drag-and-drop Actions (`Assign Entra Group`).
  * Real-time "Validation" (Red squiggles if a rule is incomplete).
  * Impact Fleet Integration: Connectors dragged onto the canvas automatically register as targets.

### 2. The Simulation Drawer (The Safety Net)

* **Goal:** Show the "Blast Radius" of a change.
* **Tech:** Recharts (Visualizing impact stats) + Ant Design Table (Data Tables).
* **Experience:**
  1. Admin changes a rule.
  2. A "Simulation Bar" at the bottom updates: "Calculating Impact..."
  3. Result: "15 Users will lose access. View Details."

### 3. The Identity 360 View (The Hub)

* **Goal:** A single view of everything a user is.
* **Tech:** Tabs + Timeline Component.
* **Tabs:**
  * **Profile:** Core Attributes (`StandardUserDto`).
  * **Access:** Calculated Entitlements (What they should have).
  * **Drift:** Discrepancies (What they actually have).
  * **Timeline:** Audit Log (Who changed what, when).

---

## State Management Strategy

### Server State (React Query)

We rely heavily on **Optimistic Updates** to make the UI feel instant.

* **Fetching:** `useQuery(['policy', id])`
* **Mutating:** `useMutation(updatePolicy, { onSuccess: invalidateQueries })`

### Client State (Zustand)

Used for ephemeral UI state (e.g., The "Draft" Policy before saving).

```typescript
interface PolicyDraftStore {
  draftNodes: Node[];
  isDirty: boolean;
  simulationResult: SimulationReport | null;

  addNode: (node: Node) => void;
  runSimulation: () => Promise<void>;
}
```

---

## Component Architecture (Atomic Design)

```
src/components/
├── common/         <-- Atoms (DriftIndicator, LiveBadge, PiiField, EmptyState)
├── policy-engine/  <-- Organisms (PolicyEditor, RoleBundleManager)
├── dashboard/      <-- Templates (ProvisioningProgress)
└── layout/         <-- Page Layouts (CustomSider, TopBar, MobileHeader, navigation.tsx)
```

The Design studio's canvas components are in its feature folder: `ConnectorNode` in `features/blueprints/canvas/`, `ConnectorManager` in `features/blueprints/components/blueprint/`.

---

## Key UX Patterns

### 1. The "Drift" Indicator

Everywhere a user attribute is shown, we indicate if it is "synced" or "drifted."

* **Synced:** Green checkmark.
* **Drifted:** Warning icon. Hovering shows: "Hub says 'Sales', AD says 'Marketing'. Click to Fix."

### 2. The "Time Travel" Slider

In the Audit Log, admins can drag a slider to see: "What did Alice's access look like 3 months ago?" (Powered by the temporal history in the backend).

### 3. Progressive Disclosure

We don't show the raw JSON of a policy unless asked.

* **Default:** "Sales Users get Salesforce."
* **Advanced:** "IF dept=Sales THEN assign group_id=123."
* **Debug:** `{ "condition": { "field": "dept", "op": "eq", "val": "Sales" } }`

---

## Security in the Frontend

* **RBAC:** Routes are protected by role-based guards — e.g. `usePermission('super-admin')`, `usePermission('operator')`. The role hierarchy is: `super-admin > connector-admin / policy-admin > operator > viewer`.
* **PII Sensitivity:** The identity API returns PII fields (`personalEmail`, `mobilePhone`, `workPhone`, `officeExtension`) masked, so the page never holds a clear value until a reveal. `PiiField` / `PiiInput` (`components/common/PiiField.tsx`) show the masked value; reveal (operator) calls `POST /identity/:id/pii/reveal`, which writes the `PII_REVEALED` audit entry and returns the value. A failed reveal keeps the field masked. `PiiInput` requires a reveal before editing, and the profile save omits PII fields that still hold the mask (`utils/pii-fields.ts`).

---

## Testing

Frontend tests run on Vitest in a jsdom environment (`vitest.config.ts`). The setup file `src/test/setup.ts` loads the jest-dom matchers and stubs what jsdom lacks and Ant Design and React Flow need: `matchMedia`, `ResizeObserver`, `DOMMatrixReadOnly`, element `offsetWidth` and `offsetHeight`, `SVGElement.getBBox`, and `import.meta.env` (`VITE_AUTH_DISABLED: 'true'`, a test tenant and OIDC settings). Vitest finds `src/**/*.{test,spec}.{ts,tsx}`; CSS is not processed (`css: false`). Each worker is a forked node process of several hundred MB, so `maxWorkers` is 4.

```bash
npm test                # vitest run
npm run test:coverage   # v8 coverage; thresholds: branches 64, functions 73, lines 79, statements 77
npm run test:watch      # watch mode
```

No git hook runs vitest. It runs in the maintainer's verify script before a push, or by hand.

### Rendering: `renderWithProviders`

`src/test/test-utils.tsx` renders a component inside the providers the app has:

* React Query with `retry: false` and `gcTime: 0`, a new client per render.
* AuthContext with `mockAuthValue`, a `super-admin` (pass `authValue` to test another role).
* MemoryRouter at `initialRoute` (default `/`).
* Ant Design `ConfigProvider` with `hashed: false`, around the `App` component. Without the hashed class scope jsdom matches the style rules much faster; the heavy page tests run about 40 % faster. A test renders one theme, so the scope never told two elements apart.

### `App.useApp()` in tests

Confirmations and toasts come from `App.useApp()` (`modal.confirm`, `message`), which works inside the `App` wrapper that `renderWithProviders` adds. Antd's static `Modal.confirm` and `message` render nothing under React 19 without `src/config/antd-react19.ts`, and they stand outside the app's theme, so a component under test uses the hook. A confirmation from the hook shows its title twice in the same dialog, so the fixtures find it by the first match (`dialog()` in `CredentialLifecyclePage.fixtures.ts`) or by `.ant-modal-confirm-title` (`confirmDialog()` in `GdprPage.fixtures.ts`).

### Page, modal and component tests

* Page tests (a file that renders a `*Page` component or a route component; 44 files, 313 tests) cover user flows: open the page, act, see the request that goes out and the result on screen. They render the whole page with antd tables, forms and modals, so they are the slow files.
* Modal tests cover what a modal shows and does (`DeadLetterDetailModal.test.tsx`, `AnomalyDetailModal.test.tsx`, `IdentityMapModals.test.tsx`). An assertion about the content of a modal belongs in a modal test, out of the page tests: moving six groups of them out of page tests saved about 47.6 s per single-worker pass (DeadLetterPage 15.8 s, SodPoliciesPage.form 8.8 s, AdminUsersPage.invites 6.6 s, WebhooksPage.deliveries 6.5 s, .edit 6.1 s, .create 3.8 s).
* Component and unit tests (the other 92 files, 510 tests) cover a component or logic on its own. Logic a page needs is a plain module with its own test: `webhook-changes.ts` has 8 tests, `nhi-labels.test.ts` covers the backend rules the NHI page mirrors.

A test must fail when the logic it names changes. The audit checked this by changing the line under test and running the test; a test that asserts nothing a change could break is deleted or merged.

### Shared fixtures

A page with many tests is split by subject into `<Page>.<subject>.test.tsx` files and one `<Page>.fixtures.ts` (NHI, Webhooks, AdminUsers, SodPolicies, Gdpr, CredentialLifecycle, DeadLetter, AccessExplorer, AuditIntegrity, access intelligence). The fixtures file holds the request mocks (for example `mockGet`, `mockPost`, `mockPatch`, `mockDelete`), the sample data and helpers such as `confirmDialog`. Each test file still calls `vi.mock('@api/data', ...)` and mocks `usePermission` itself, because `vi.mock` is hoisted per file. A file that runs over 60 s is split by its top-level `describe` blocks in this way.

The frontend reads one fixture from the backend: `backend/test/fixtures/connector-manifests.json` (the connector manifests, with their icons), used by `connector-registry.test.ts` and `connector-icons.test.tsx`. A backend spec, `connector-manifests-fixture.spec.ts`, keeps it equal to `registerBuiltInConnectors`, so a new backend connector or field reaches the frontend check by itself.

### Timeouts

`vitest.config.ts` sets no `testTimeout`, so a test has Vitest's default of 5 s. Many page tests raise it: `{ timeout: 20_000 }` appears in about 150 places, `30_000` in about 40, and `SodPoliciesPage.form.test.tsx` and `App.local-auth.test.tsx` use `60_000`. These are ceilings on render cost. The mocked requests answer at once, and the ceiling absorbs the cost of rendering an antd form or modal in jsdom. That cost grows on a loaded machine: an `AdminUsersPage` test on the default 5 s took 5.2 s and 5.9 s in a loaded run against 4.1 s alone. The ceilings stay until the render cost is cut. A new test starts at the default. A wait for something to appear uses `findBy` or `waitFor`, and a wait for something to be absent probes the request that settles it, in place of a sleep.

### Time budget

The warm run of 2026-11-24 (`main` = `242f4e79`): 136 files, 823 tests, 754.5 file-seconds, 264 s wall on 4 workers (262 s cold). Page files took 416.6 file-seconds and the other files 337.9. The per-file seconds run from the first test start to the last test end; module import, the setup file and the environment are not included. The slowest files:

| File | Tests | Seconds |
|------|-------|---------|
| `features/nhi/__tests__/NhiPage.actions.test.tsx` | 10 | 67.6 |
| `features/users/__tests__/IdentityDetailPage.test.tsx` | 22 | 38.0 |
| `features/sod-policies/__tests__/SodPoliciesPage.form.test.tsx` | 4 | 36.7 |
| `features/compliance/__tests__/GdprPage.consent.test.tsx` | 9 | 26.1 |
| `features/credential-lifecycle/__tests__/CredentialLifecyclePage.policies.test.tsx` | 7 | 24.6 |
| `features/webhooks/__tests__/WebhooksPage.edit.test.tsx` | 7 | 23.6 |

`NhiPage.actions.test.tsx` is over the 60 s split rule. Every other file is under 40 s.

---

## Theme File Reference

| File | Purpose |
|------|---------|
| `src/theme/themeConfig.ts` | Color palettes, token system, light/dark/sider theme objects |
| `src/theme/index.ts` | Re-exports (`BRAND`, `DARK`, `SEMANTIC`, `LIVE`, `OVERLAY`, `FONT_SANS`, `FONT_MONO`, `lightTheme`, `darkTheme`, `siderTheme`) |
| `src/theme/ThemeCssVars.tsx` | Publishes the active theme tokens as CSS custom properties (`--euroid-*`) on `<html>` for plain stylesheets (`src/styles/*.css`) |
| `src/contexts/color-mode/index.tsx` | Light/dark mode toggle context + localStorage persistence |
| `src/components/layout/navigation.tsx` | Menu sections and items (`NAV_SECTIONS`), read by `CustomSider` (sidebar and mobile drawer), `AppBreadcrumbs` and `CommandPalette` |
| `src/components/layout/CustomSider.tsx` | Sidebar navigation (always dark, collapsible, responsive) |
| `src/components/layout/MobileHeader.tsx` | Mobile top bar below 768px (surface color) |
| `src/components/layout/ConnectionStatus.tsx` | WebSocket status badge |
| `index.html` | Google Fonts (IBM Plex Sans + IBM Plex Mono), meta theme-color `#0E2A47` |
