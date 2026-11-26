/**
 * Role-based Rules — Policy management and simulation
 *
 * Create, edit, and simulate policies. Full Policy Engine flow:
 * - Policy list, create, edit
 * - Preview impact before saving
 * - Role bundles and group list
 */

import React from 'react';
import { PolicyEngineStudio } from '../../components/policy-engine';
import { PageContainer, PageHeader } from '@shared/PageHeader';

export const RoleBasedRules: React.FC = () => (
  <PageContainer>
    <PageHeader
      title="Role-based rules"
      subtitle="Create and manage access policies. Preview the impact before saving."
    />
    <PolicyEngineStudio />
  </PageContainer>
);
