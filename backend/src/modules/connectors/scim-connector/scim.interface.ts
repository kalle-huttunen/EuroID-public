import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { ProvisioningResult } from '@shared/dtos/provisioning-result.dto';
import { Entitlement } from '@shared/interfaces/provisioning.interface';

/** Auth modes supported by the SCIM connector */
export type SCIMAuthType = 'bearer' | 'basic' | 'oauth2';

/** Configuration for a SCIM connector instance */
export interface SCIMConnectorConfig {
  /** SCIM base URL, e.g. 'https://api.example.com/scim/v2' */
  baseUrl: string;
  authType: SCIMAuthType;

  // Bearer auth
  bearerToken?: string;

  // Basic auth
  username?: string;
  password?: string;

  // OAuth2 client credentials
  oauth2TokenUrl?: string;
  clientId?: string;
  clientSecret?: string;

  /** When deprovisioning: 'deactivate' sets active=false, 'delete' removes the resource */
  deprovisionStrategy?: 'deactivate' | 'delete';
}

/** Health status returned by the SCIM health check */
export interface SCIMHealthStatus {
  healthy: boolean;
  serviceProviderConfig?: Record<string, unknown>;
  error?: string;
}

/** Contract for the SCIM connector service */
export interface ISCIMConnector {
  /** Provision (create or update) a user to a SCIM-compliant target system */
  provision(config: SCIMConnectorConfig, user: StandardUserDto): Promise<ProvisioningResult>;

  /** Deprovision a user (deactivate or delete depending on config) */
  deprovision(config: SCIMConnectorConfig, externalId: string): Promise<void>;

  /** Discover entitlements (SCIM Groups) from the target system */
  discover(config: SCIMConnectorConfig): Promise<Entitlement[]>;

  /** Check connectivity to the SCIM target system */
  healthCheck(config: SCIMConnectorConfig): Promise<SCIMHealthStatus>;
}
