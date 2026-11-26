/**
 * Erasure (DELETE /identity/:id/gdpr-erase): super-admin only, like the route. The button opens
 * GdprErasureModal, which previews the counts, asks for the person's identifier and shows the
 * attestation. Closing it after an erasure clears the picked person (they no longer exist).
 */
import React, { useState } from 'react';
import { Button, Card, Typography } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import type { IdentityOption } from '@api/identity-api';
import { usePermission } from '../../auth/usePermission';
import { GdprErasureModal } from './GdprErasureModal';

const { Paragraph, Text } = Typography;

export const GdprErasureCard: React.FC<{ identity: IdentityOption; onErased: () => void }> = ({
  identity,
  onErased,
}) => {
  const isSuperAdmin = usePermission('super-admin');
  const [open, setOpen] = useState(false);

  return (
    <Card size="small" title="Erasure (Article 17)" style={{ height: '100%' }}>
      <Paragraph>
        Deletes the person&apos;s identity record and the EuroID data filed under it, for good. A
        preview shows what would be deleted and what stays; the erasure itself needs the
        person&apos;s identifier typed in.
      </Paragraph>
      {isSuperAdmin ? (
        <Button danger icon={<DeleteOutlined />} onClick={() => setOpen(true)}>
          Erase personal data
        </Button>
      ) : (
        <Text type="secondary">Erasure needs the super-admin role.</Text>
      )}
      {open && (
        <GdprErasureModal
          identity={identity}
          onClose={(erased) => {
            setOpen(false);
            if (erased) onErased();
          }}
        />
      )}
    </Card>
  );
};
