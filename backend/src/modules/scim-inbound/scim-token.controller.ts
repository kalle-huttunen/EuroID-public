import { Controller, Get, Post, Delete, Body, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiBody } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import { ScimTokenService } from './scim-token.service';
import { CreateScimTokenDto } from './dto/create-scim-token.dto';
import { ParseObjectIdPipe } from '@shared/pipes/parse-object-id.pipe';

// AuthModule's global guards (JwtAuthGuard, RolesGuard) check it; declaring them here ran them twice.
@Controller('scim-tokens')
@Roles('super-admin')
@ApiTags('SCIM Tokens')
@ApiBearerAuth('jwt')
export class ScimTokenController {
  constructor(private readonly scimTokenService: ScimTokenService) {}

  /**
   * POST /api/v1/scim-tokens — Generate a new SCIM token
   */
  @Post()
  @ApiOperation({ summary: 'Generate SCIM bearer token (super-admin only)' })
  @ApiBody({
    type: CreateScimTokenDto,
    description: 'Token name, scopes (optional), expiration (optional)',
  })
  @ApiResponse({
    status: 201,
    description: 'Token generated. Plaintext token returned once — store securely.',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — super-admin role required' })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  async create(@Body() body: CreateScimTokenDto, @AuthUser() user: { sub: string }) {
    const { name, scopes, expiresAt } = body;
    const expiresAtDate = expiresAt ? new Date(expiresAt) : undefined;
    const result = await this.scimTokenService.generateToken(name, user.sub, scopes, expiresAtDate);

    return {
      id: result.id,
      name: result.name,
      token: result.token,
    };
  }

  /**
   * GET /api/v1/scim-tokens — List active tokens (metadata only)
   */
  @Get()
  @ApiOperation({ summary: 'List SCIM tokens (metadata only)' })
  @ApiResponse({
    status: 200,
    description: 'List of token metadata (id, name, createdBy, createdAt, lastUsedAt, scopes)',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — super-admin role required' })
  async list() {
    return this.scimTokenService.listTokens();
  }

  /**
   * DELETE /api/v1/scim-tokens/:id — Revoke a token
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke a SCIM token' })
  @ApiResponse({ status: 204, description: 'Token revoked successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — super-admin role required' })
  @ApiResponse({ status: 400, description: 'The id is not an ObjectId' })
  @ApiResponse({ status: 404, description: 'Token not found' })
  async revoke(@Param('id', ParseObjectIdPipe) id: string) {
    await this.scimTokenService.revokeToken(id);
  }
}
