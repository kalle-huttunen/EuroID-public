import { Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Namespace, Server } from 'socket.io';
import { Socket } from 'socket.io';
import { JwtAuthGuard, type AuthenticatedUser } from '../auth/jwt-auth.guard';
import { isDevOrTest } from '../config/runtime-env';

/** How often connected sockets are checked again (REALTIME_SESSION_RECHECK_MS, default 60 s). */
const DEFAULT_RECHECK_MS = 60_000;

const VALID_ROOMS = [
  'anomalies',
  'provisioning',
  'drift',
  'reviews',
  'analytics',
  'system',
  'pipeline',
];

@WebSocketGateway({
  namespace: '/events',
  cors: {
    origin: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
      : isDevOrTest()
        ? ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:3001']
        : [],
    credentials: true,
  },
})
export class EventsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(EventsGateway.name);
  private recheckTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: ConfigService,
    private readonly auth: JwtAuthGuard,
  ) {}

  afterInit(server: Server): void {
    this.server = server;
    this.logger.log('WebSocket gateway initialized on namespace /events');
    const configured = Number(this.config.get('REALTIME_SESSION_RECHECK_MS'));
    const intervalMs =
      Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RECHECK_MS;
    this.recheckTimer = setInterval(() => void this.recheckSessions(), intervalMs);
    this.recheckTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.recheckTimer);
  }

  /**
   * A socket is authenticated once, on connect. Every REALTIME_SESSION_RECHECK_MS each connected
   * socket is checked again (JwtAuthGuard.assertStillAllowed), so one whose admin was revoked
   * (revokeAllSessions, a password change or reset, a deactivation) or whose tenant was suspended
   * stops receiving the tenant's events. The access token's expiry is not checked again: the
   * console does not reconnect a socket the server closed, and a live session refreshes its token
   * over HTTP. While the database cannot answer (503) the socket stays.
   */
  async recheckSessions(): Promise<void> {
    const sockets = [...(this.server as unknown as Namespace).sockets.values()];
    await Promise.all(
      sockets.map(async (client) => {
        const user = client.data.user as AuthenticatedUser | undefined;
        if (!user) return; // AUTH_DISABLED development sockets carry no session
        try {
          await this.auth.assertStillAllowed(user);
        } catch (error: unknown) {
          if (error instanceof ServiceUnavailableException) return;
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Client ${client.id} disconnected on recheck: ${message}`);
          client.disconnect(true);
        }
      }),
    );
  }

  async handleConnection(client: Socket): Promise<void> {
    // FA-1: Check cookie first (httpOnly), then handshake auth/query (API clients)
    const cookieHeader = client.handshake.headers?.cookie as string | undefined;
    const accessTokenFromCookie = cookieHeader
      ?.split(';')
      .map((s) => s.trim().split('='))
      .find(([k]) => k === 'access_token')?.[1];
    const token =
      accessTokenFromCookie ??
      (client.handshake.auth?.token as string) ??
      (client.handshake.query?.token as string);

    const authDisabledAllowed = isDevOrTest(this.config.get<string>('NODE_ENV') ?? '');
    if (authDisabledAllowed && this.config.get('AUTH_DISABLED') === 'true') {
      const devTenantId = this.config.get('DEV_TENANT_ID') || 'dev-tenant';
      client.data.userId = 'dev-user';
      client.data.roles = ['super-admin'];
      client.data.tenantId = devTenantId;
      client.join(`t:${devTenantId}:system`);
      this.logger.debug(`Client connected (auth disabled): ${client.id} tenant=${devTenantId}`);
      return;
    }

    if (!token) {
      this.logger.warn(`Client ${client.id} rejected: no token`);
      client.disconnect();
      return;
    }

    // The checks an API request gets (JwtAuthGuard): a local token of an active admin whose
    // tokenVersion is current, or an OIDC token.
    let user: AuthenticatedUser;
    try {
      user = await this.auth.authenticate(token);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Invalid token';
      this.logger.warn(`Client ${client.id} rejected: ${message}`);
      client.disconnect();
      return;
    }
    // The rooms carry what viewer routes answer: a token with no role (one that can only set up
    // MFA) gets none, as RolesGuard gives it no viewer route.
    if (!user.tenantId || user.roles.length === 0) {
      this.logger.warn(`Client ${client.id} rejected: token without a tenant or a role`);
      client.disconnect();
      return;
    }
    client.data.userId = user.sub;
    client.data.roles = user.roles;
    client.data.tenantId = user.tenantId;
    client.data.user = user;
    client.join(`t:${user.tenantId}:system`);
    this.logger.debug(`Client connected: ${client.id} tenant=${user.tenantId}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('subscribe')
  handleSubscribe(client: Socket, payload: { rooms?: string[] }): void {
    const tenantId = client.data.tenantId;
    if (!tenantId) return;

    const rooms = payload?.rooms ?? [];
    for (const room of rooms) {
      if (VALID_ROOMS.includes(room)) {
        client.join(`t:${tenantId}:${room}`);
      }
    }
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(client: Socket, payload: { rooms?: string[] }): void {
    const tenantId = client.data.tenantId;
    if (!tenantId) return;

    const rooms = payload?.rooms ?? [];
    for (const room of rooms) {
      client.leave(`t:${tenantId}:${room}`);
    }
  }

  broadcastToRoom(room: string, eventType: string, payload: unknown): void {
    this.server.to(room).emit('domain-event', {
      eventType,
      timestamp: new Date().toISOString(),
      payload,
    });
  }
}
