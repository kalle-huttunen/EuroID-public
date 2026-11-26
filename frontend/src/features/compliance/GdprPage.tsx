/**
 * GDPR requests: find a person in the identity list (offboarded people too), export what EuroID
 * holds about them (Articles 15 and 20), record and revoke their consent (Article 6) and, as a
 * super-admin, erase them (Article 17). The tenant's consent report sits below. Route and nav
 * entry need operator, like the export, the consent changes and the report.
 */
import React, { useState } from 'react';
import { Button, Card, Col, Row } from 'antd';
import { ReloadOutlined, UserOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { identityKeys, type IdentityOption } from '@api/identity-api';
import { gdprKeys } from '@api/gdpr-api';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { EmptyState } from '@shared/EmptyState';
import { GdprPersonPicker } from './GdprPersonPicker';
import { GdprExportCard } from './GdprExportCard';
import { GdprErasureCard } from './GdprErasureCard';
import { GdprConsentCard } from './GdprConsentCard';
import { GdprConsentReport } from './GdprConsentReport';

export const GdprPage: React.FC = () => {
  const qc = useQueryClient();
  // The picked person is kept as listed: after an erasure the list no longer has them, but the
  // erasure modal still shows its attestation until it is closed.
  const [selected, setSelected] = useState<IdentityOption | undefined>();

  return (
    <PageContainer>
      <PageHeader
        title="GDPR requests"
        subtitle="Export what EuroID holds about a person, record their consent, or erase them."
        actions={
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              qc.invalidateQueries({ queryKey: gdprKeys.all });
              qc.invalidateQueries({ queryKey: identityKeys.all() });
            }}
          >
            Refresh
          </Button>
        }
      />
      <Card size="small" title="Person" style={{ marginBottom: 16 }}>
        <GdprPersonPicker selected={selected} onSelect={setSelected} />
      </Card>
      {selected ? (
        <div key={selected.id}>
          <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
            <Col xs={24} lg={12}>
              <GdprExportCard identity={selected} />
            </Col>
            <Col xs={24} lg={12}>
              <GdprErasureCard identity={selected} onErased={() => setSelected(undefined)} />
            </Col>
          </Row>
          <GdprConsentCard identity={selected} />
        </div>
      ) : (
        <Card size="small" style={{ marginBottom: 16 }}>
          <EmptyState
            icon={<UserOutlined style={{ fontSize: 32 }} />}
            title="Pick a person"
            description="Search by name or work email. Their access export, consent records and erasure appear here."
          />
        </Card>
      )}
      <GdprConsentReport />
    </PageContainer>
  );
};
