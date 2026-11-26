/**
 * A connector config is checked before it is stored (POST /connectors/:name/install, PATCH
 * /connectors/:name). From package R's report: a JSON API HR config could carry any `method`, and
 * ingest sent it; one other than GET is now refused on save (400) as at ingest.
 */
import { BadRequestException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { checkedConnectorConfig } from './connector-config-validation';
import { PluginRegistryService } from './plugin/plugin-registry.service';
import { registerBuiltInConnectors } from './plugin/register-connectors';

const registry = new PluginRegistryService({} as ModuleRef);
registerBuiltInConnectors(registry);
const jsonApiHr = registry.getById('json-api-hr');

describe('checkedConnectorConfig: the JSON API HR method', () => {
  it.each(['POST', 'put', 'DELETE'])('refuses %s', (method) => {
    expect(() =>
      checkedConnectorConfig(jsonApiHr, { url: 'https://hr.example/users', method }),
    ).toThrow(BadRequestException);
  });

  it.each(['GET', 'get', ''])('keeps %p', (method) => {
    expect(
      checkedConnectorConfig(jsonApiHr, { url: 'https://hr.example/users', method }),
    ).toMatchObject({ method });
  });

  it('leaves another connector with a key named method alone', () => {
    expect(() =>
      checkedConnectorConfig(registry.getById('okta'), { orgUrl: 'https://o', method: 'POST' }),
    ).not.toThrow();
  });
});
