import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { render } from '@testing-library/react';
import { getConnectorIcon } from '../connector-icons';

// Every `icon` a backend connector manifest declares, from the fixture that
// backend/src/modules/connectors/plugin/connector-manifests-fixture.spec.ts keeps equal to the
// connectors registerBuiltInConnectors registers. The Marketplace shows a cloud for any name
// missing from the map, so a connector whose icon is not mapped is drawn as if it were a cloud
// service.
const BACKEND: { connectors: Array<{ id: string; icon?: string }> } = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../../backend/test/fixtures/connector-manifests.json'),
    'utf8',
  ),
);
const BACKEND_MANIFEST_ICONS = BACKEND.connectors.map((c) => [c.id, c.icon] as const);

/** Ant Design icons render as <span role="img" aria-label="file-text"> for FileTextOutlined. */
const ariaLabelOf = (iconName: string) =>
  iconName
    .replace(/Outlined$/, '')
    .replace(/(?<=[a-z])(?=[A-Z])/g, '-')
    .toLowerCase();

describe('getConnectorIcon', () => {
  it('reads an icon for every connector the backend registers', () => {
    expect(BACKEND_MANIFEST_ICONS.length).toBeGreaterThan(0);
    for (const [id, icon] of BACKEND_MANIFEST_ICONS) expect(icon, id).toMatch(/Outlined$/);
  });

  it.each(BACKEND_MANIFEST_ICONS)('draws the %s manifest icon %s', (_id, iconName) => {
    const { getByRole } = render(<>{getConnectorIcon(iconName as string)}</>);
    expect(getByRole('img')).toHaveAttribute('aria-label', ariaLabelOf(iconName as string));
  });

  it('falls back to the cloud for a name it does not know', () => {
    const { getByRole } = render(<>{getConnectorIcon('NoSuchOutlined')}</>);
    expect(getByRole('img')).toHaveAttribute('aria-label', 'cloud');
  });
});
