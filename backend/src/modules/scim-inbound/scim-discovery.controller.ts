import { Controller, Get, Logger } from '@nestjs/common';
import { UseFilters, UseInterceptors } from '@nestjs/common';
import { Public } from '@infrastructure/auth/public.decorator';
import { ScimResponseInterceptor } from './interceptors/scim-response.interceptor';
import { SCIMErrorFilter, SCIM_SCHEMAS } from '@shared/scim';

const APP_BASE_URL = process.env.APP_BASE_URL || '';
if (!APP_BASE_URL) {
  const logger = new Logger('ScimDiscoveryController');
  logger.warn(
    '[SECURITY] APP_BASE_URL is not configured. SCIM discovery documentationUri will be empty. ' +
      'Set APP_BASE_URL to your production base URL (e.g. https://app.example.com).',
  );
}

/**
 * SCIM 2.0 discovery endpoints. Public (no auth) per RFC 7644.
 * Clients use these to discover capabilities before authenticating.
 */
@Controller('scim/v2')
@Public()
@UseFilters(SCIMErrorFilter)
@UseInterceptors(ScimResponseInterceptor)
export class ScimDiscoveryController {
  /**
   * GET /scim/v2/ServiceProviderConfig
   * Declares which SCIM features are supported.
   */
  @Get('ServiceProviderConfig')
  getServiceProviderConfig() {
    return {
      schemas: [SCIM_SCHEMAS.SERVICE_PROVIDER_CONFIG],
      documentationUri: APP_BASE_URL ? `${APP_BASE_URL.replace(/\/$/, '')}/docs/scim` : '',
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          name: 'OAuth Bearer Token',
          description: 'Authentication using bearer tokens',
          specUri: 'http://www.rfc-editor.org/info/rfc6750',
          type: 'oauthbearertoken',
          primary: true,
        },
      ],
    };
  }

  /**
   * GET /scim/v2/Schemas
   * Returns the User and Group schema definitions per RFC 7643.
   */
  @Get('Schemas')
  getSchemas() {
    return {
      schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
      totalResults: 3,
      Resources: [
        this.getUserSchema(),
        this.getGroupSchema(),
        this.getEnterpriseUserSchema(),
      ],
    };
  }

  /**
   * GET /scim/v2/ResourceTypes
   * Returns User and Group resource type metadata.
   */
  @Get('ResourceTypes')
  getResourceTypes() {
    return {
      schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
      totalResults: 2,
      Resources: [
        {
          schemas: [SCIM_SCHEMAS.RESOURCE_TYPE],
          id: 'User',
          name: 'User',
          endpoint: '/scim/v2/Users',
          schema: SCIM_SCHEMAS.USER,
          schemaExtensions: [
            {
              schema: SCIM_SCHEMAS.ENTERPRISE_USER,
              required: false,
            },
          ],
        },
        {
          schemas: [SCIM_SCHEMAS.RESOURCE_TYPE],
          id: 'Group',
          name: 'Group',
          endpoint: '/scim/v2/Groups',
          schema: SCIM_SCHEMAS.GROUP,
        },
      ],
    };
  }

  private getUserSchema() {
    return {
      id: SCIM_SCHEMAS.USER,
      name: 'User',
      description: 'User Account',
      attributes: [
        { name: 'userName', type: 'string', required: true, mutability: 'readWrite', uniqueness: 'server' },
        { name: 'name', type: 'complex', mutability: 'readWrite', subAttributes: [
          { name: 'formatted', type: 'string', mutability: 'readWrite' },
          { name: 'familyName', type: 'string', mutability: 'readWrite' },
          { name: 'givenName', type: 'string', mutability: 'readWrite' },
          { name: 'middleName', type: 'string', mutability: 'readWrite' },
        ]},
        { name: 'displayName', type: 'string', mutability: 'readWrite' },
        { name: 'emails', type: 'complex', multiValued: true, mutability: 'readWrite', subAttributes: [
          { name: 'value', type: 'string', mutability: 'readWrite' },
          { name: 'type', type: 'string', mutability: 'readWrite' },
          { name: 'primary', type: 'boolean', mutability: 'readWrite' },
        ]},
        { name: 'phoneNumbers', type: 'complex', multiValued: true, mutability: 'readWrite', subAttributes: [
          { name: 'value', type: 'string', mutability: 'readWrite' },
          { name: 'type', type: 'string', mutability: 'readWrite' },
        ]},
        { name: 'active', type: 'boolean', mutability: 'readWrite' },
        { name: 'title', type: 'string', mutability: 'readWrite' },
        { name: 'externalId', type: 'string', mutability: 'readWrite' },
        { name: 'id', type: 'string', mutability: 'readOnly', returned: 'always' },
        { name: 'meta', type: 'complex', mutability: 'readOnly', returned: 'default' },
      ],
      meta: { resourceType: 'Schema', location: `/scim/v2/Schemas/${SCIM_SCHEMAS.USER}` },
    };
  }

  private getGroupSchema() {
    return {
      id: SCIM_SCHEMAS.GROUP,
      name: 'Group',
      description: 'Group',
      attributes: [
        { name: 'displayName', type: 'string', required: true, mutability: 'readWrite' },
        { name: 'members', type: 'complex', multiValued: true, mutability: 'readWrite', subAttributes: [
          { name: 'value', type: 'string', mutability: 'readWrite', referenceTypes: ['User'] },
          { name: '$ref', type: 'reference', mutability: 'readOnly', referenceTypes: ['User'] },
          { name: 'type', type: 'string', mutability: 'readOnly', canonicalValues: ['User', 'Group'] },
        ]},
        { name: 'externalId', type: 'string', mutability: 'readWrite' },
        { name: 'id', type: 'string', mutability: 'readOnly', returned: 'always' },
        { name: 'meta', type: 'complex', mutability: 'readOnly', returned: 'default' },
      ],
      meta: { resourceType: 'Schema', location: `/scim/v2/Schemas/${SCIM_SCHEMAS.GROUP}` },
    };
  }

  private getEnterpriseUserSchema() {
    return {
      id: SCIM_SCHEMAS.ENTERPRISE_USER,
      name: 'EnterpriseUser',
      description: 'Enterprise User Extension',
      attributes: [
        { name: 'employeeNumber', type: 'string', mutability: 'readWrite' },
        { name: 'department', type: 'string', mutability: 'readWrite' },
        { name: 'division', type: 'string', mutability: 'readWrite' },
        { name: 'organization', type: 'string', mutability: 'readWrite' },
        { name: 'manager', type: 'complex', mutability: 'readWrite', subAttributes: [
          { name: 'value', type: 'string', mutability: 'readWrite' },
          { name: 'displayName', type: 'string', mutability: 'readOnly' },
        ]},
      ],
      meta: { resourceType: 'Schema', location: `/scim/v2/Schemas/${SCIM_SCHEMAS.ENTERPRISE_USER}` },
    };
  }
}
