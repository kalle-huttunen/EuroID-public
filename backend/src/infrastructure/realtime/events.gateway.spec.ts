import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { EventsGateway } from './events.gateway';

jest.mock('jose', () => ({
  jwtVerify: jest.fn(),
  createRemoteJWKSet: jest.fn(() => ({})),
}));

describe('EventsGateway', () => {
  let gateway: EventsGateway;
  let configService: jest.Mocked<ConfigService>;
  let mockServer: { to: jest.Mock; sockets?: Map<string, unknown> };
  let mockSocket: {
    join: jest.Mock;
    leave: jest.Mock;
    disconnect: jest.Mock;
    data: Record<string, unknown>;
    id: string;
    handshake: Record<string, unknown>;
  };

  beforeEach(() => {
    configService = { get: jest.fn() } as any;
    mockServer = {
      to: jest.fn().mockReturnThis(),
      sockets: new Map(),
    };
    mockSocket = {
      id: 'socket-1',
      join: jest.fn(),
      leave: jest.fn(),
      disconnect: jest.fn(),
      data: {},
      handshake: { auth: {}, query: {} },
    };

    // The token check is JwtAuthGuard's (events.gateway.integration.spec.ts covers local tokens).
    type GuardArgs = ConstructorParameters<typeof JwtAuthGuard>;
    const guard = new JwtAuthGuard(
      configService,
      new Reflector(),
      {} as GuardArgs[2],
      {} as GuardArgs[3],
      {} as GuardArgs[4],
      { assertActive: async () => undefined } as unknown as GuardArgs[5],
    );
    gateway = new EventsGateway(configService, guard);
    (gateway as any).server = mockServer;
  });

  it('should initialize and store server reference', () => {
    gateway.afterInit(mockServer as any);
    expect(gateway.server).toBe(mockServer);
  });

  it('handleSubscribe: client joins tenant-prefixed rooms', () => {
    (mockSocket as any).data = { tenantId: 'tenant-1' };
    gateway.handleSubscribe(mockSocket as any, { rooms: ['anomalies', 'provisioning'] });
    expect(mockSocket.join).toHaveBeenCalledWith('t:tenant-1:anomalies');
    expect(mockSocket.join).toHaveBeenCalledWith('t:tenant-1:provisioning');
  });

  it('handleSubscribe: client does NOT join when no tenantId', () => {
    (mockSocket as any).data = {};
    gateway.handleSubscribe(mockSocket as any, { rooms: ['anomalies'] });
    expect(mockSocket.join).not.toHaveBeenCalled();
  });

  it('handleSubscribe: client does NOT join invalid room', () => {
    (mockSocket as any).data = { tenantId: 'tenant-1' };
    gateway.handleSubscribe(mockSocket as any, { rooms: ['anomalies', 'invalid-room'] });
    expect(mockSocket.join).toHaveBeenCalledWith('t:tenant-1:anomalies');
    expect(mockSocket.join).toHaveBeenCalledTimes(1);
  });

  it('handleUnsubscribe: client leaves tenant-prefixed rooms', () => {
    (mockSocket as any).data = { tenantId: 'tenant-1' };
    gateway.handleUnsubscribe(mockSocket as any, { rooms: ['anomalies', 'drift'] });
    expect(mockSocket.leave).toHaveBeenCalledWith('t:tenant-1:anomalies');
    expect(mockSocket.leave).toHaveBeenCalledWith('t:tenant-1:drift');
  });

  it('broadcastToRoom: emits to room with expected payload shape', () => {
    const chain = { emit: jest.fn() };
    (mockServer.to as jest.Mock).mockReturnValue(chain);

    gateway.broadcastToRoom('anomalies', 'anomaly.detected', { identityId: 'u1', type: 'TEST' });

    expect(mockServer.to).toHaveBeenCalledWith('anomalies');
    expect(chain.emit).toHaveBeenCalledWith(
      'domain-event',
      expect.objectContaining({
        eventType: 'anomaly.detected',
        payload: { identityId: 'u1', type: 'TEST' },
      }),
    );
    expect(chain.emit.mock.calls[0][1]).toHaveProperty('timestamp');
  });

  it('handleConnection with AUTH_DISABLED=true (dev): allows connection and joins tenant room', async () => {
    configService.get.mockImplementation((key: string) => {
      if (key === 'NODE_ENV') return 'development';
      if (key === 'AUTH_DISABLED') return 'true';
      if (key === 'DEV_TENANT_ID') return 'dev-tenant';
      return undefined;
    });

    await gateway.handleConnection(mockSocket as any);

    expect(mockSocket.data.userId).toBe('dev-user');
    expect(mockSocket.data.roles).toContain('super-admin');
    expect(mockSocket.data.tenantId).toBe('dev-tenant');
    expect(mockSocket.join).toHaveBeenCalledWith('t:dev-tenant:system');
    expect(mockSocket.disconnect).not.toHaveBeenCalled();
  });

  it('handleConnection with AUTH_DISABLED=true but NODE_ENV=production: requires token', async () => {
    configService.get.mockImplementation((key: string) => {
      if (key === 'NODE_ENV') return 'production';
      if (key === 'AUTH_DISABLED') return 'true';
      return undefined;
    });

    await gateway.handleConnection(mockSocket as any);

    expect(mockSocket.disconnect).toHaveBeenCalled();
    expect(mockSocket.data.userId).toBeUndefined();
  });

  it('handleConnection with auth enabled + invalid token: disconnects client', async () => {
    configService.get.mockImplementation((key: string) => {
      if (key === 'AUTH_DISABLED') return undefined;
      if (key === 'OIDC_ISSUER') return 'https://issuer.example.com';
      if (key === 'OIDC_AUDIENCE') return 'audience';
      return undefined;
    });
    mockSocket.handshake.auth = { token: 'bad-token' };

    const jose = await import('jose');
    (jose.jwtVerify as jest.Mock).mockRejectedValueOnce(new Error('Invalid token'));

    await gateway.handleConnection(mockSocket as any);

    expect(mockSocket.disconnect).toHaveBeenCalled();
  });

  it('handleConnection with no token when auth enabled: disconnects client', async () => {
    configService.get.mockReturnValue(undefined);
    mockSocket.handshake.auth = {};
    mockSocket.handshake.query = {};

    await gateway.handleConnection(mockSocket as any);

    expect(mockSocket.disconnect).toHaveBeenCalled();
  });

  it('handleConnection with valid token but no tenantId: disconnects client', async () => {
    configService.get.mockImplementation((key: string) => {
      if (key === 'AUTH_DISABLED') return undefined;
      if (key === 'OIDC_ISSUER') return 'https://issuer.example.com';
      if (key === 'OIDC_AUDIENCE') return 'audience';
      return undefined;
    });
    mockSocket.handshake.auth = { token: 'valid-token' };

    const jose = await import('jose');
    (jose.jwtVerify as jest.Mock).mockResolvedValueOnce({
      payload: { sub: 'user-1', roles: ['operator'] /* no tenantId */ },
    });

    await gateway.handleConnection(mockSocket as any);

    expect(mockSocket.disconnect).toHaveBeenCalled();
  });

  it('handleConnection with valid token and tenantId: joins tenant system room', async () => {
    configService.get.mockImplementation((key: string) => {
      if (key === 'AUTH_DISABLED') return undefined;
      if (key === 'OIDC_ISSUER') return 'https://issuer.example.com';
      if (key === 'OIDC_AUDIENCE') return 'audience';
      return undefined;
    });
    mockSocket.handshake.auth = { token: 'valid-token' };

    const jose = await import('jose');
    (jose.jwtVerify as jest.Mock).mockResolvedValueOnce({
      payload: { sub: 'user-1', roles: ['operator'], tenantId: 'acme-corp' },
    });

    await gateway.handleConnection(mockSocket as any);

    expect(mockSocket.data.userId).toBe('user-1');
    expect(mockSocket.data.tenantId).toBe('acme-corp');
    expect(mockSocket.join).toHaveBeenCalledWith('t:acme-corp:system');
    expect(mockSocket.disconnect).not.toHaveBeenCalled();
  });
});
