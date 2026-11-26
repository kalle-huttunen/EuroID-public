/**
 * RawDataTab: the identity as JSON, for debugging. The profile and metadata as GET /identity/:id
 * returns them, with the sources and provisioning state of the full identity record the page also
 * loads (GET /identity/v2/by-email). The API masks both responses (MaskPiiInterceptor); controls
 * and the other internal layers are not shown.
 */

import React from 'react';
import { Typography, theme } from 'antd';
import type { IStandardUser } from '../../../interfaces';

const { Text } = Typography;

/** The parts of the full identity record (GET /identity/v2/by-email) this tab shows. */
export interface RawIdentityRecord {
  _id?: unknown;
  sources?: unknown;
  provisioning?: unknown;
}

interface RawDataTabProps {
  user: IStandardUser;
  /** The full identity record; used only when it is this identity (by-email can match another). */
  identity?: RawIdentityRecord | null;
}

export const RawDataTab: React.FC<RawDataTabProps> = ({ user, identity }) => {
  const { token } = theme.useToken();
  const record =
    identity && user._id && String(identity._id) === String(user._id) ? identity : null;
  const shown = record
    ? { ...user, sources: record.sources, provisioning: record.provisioning }
    : user;

  return (
    <div>
      <Text type="secondary">
        {record
          ? "Profile and metadata as the API returns them, with the identity's sources and provisioning state."
          : 'Profile and metadata as the API returns them.'}{' '}
        Values the API masks stay masked here.
      </Text>
      <pre
        style={{
          marginTop: 16,
          padding: 16,
          backgroundColor: token.colorFillQuaternary,
          borderRadius: 4,
          overflow: 'auto',
          maxHeight: 'calc(100vh - 300px)',
        }}
      >
        {JSON.stringify(shown, null, 2)}
      </pre>
    </div>
  );
};
