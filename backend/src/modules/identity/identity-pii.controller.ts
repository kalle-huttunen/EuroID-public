import { Body, Controller, Header, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { ParseObjectIdPipe } from '@shared/pipes/parse-object-id.pipe';
import { PiiRevealDto } from './dtos/pii-reveal.dto';
import { IdentityPiiService } from './identity-pii.service';

/**
 * Audited PII reveal. Kept out of IdentityController so its response is not run
 * through MaskPiiInterceptor.
 */
@ApiTags('Identity')
@ApiBearerAuth('jwt')
@Controller('identity')
export class IdentityPiiController {
  constructor(private readonly identityPiiService: IdentityPiiService) {}

  @Post(':id/pii/reveal')
  @HttpCode(200)
  @Roles('operator')
  @Throttle({
    short: { limit: parseInt(process.env.PII_REVEAL_THROTTLE_SHORT_LIMIT ?? '5', 10), ttl: 1000 },
    medium: {
      limit: parseInt(process.env.PII_REVEAL_THROTTLE_MEDIUM_LIMIT ?? '30', 10),
      ttl: 60000,
    },
  })
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Reveal one masked PII field of an identity in clear; writes a PII_REVEALED audit entry first',
  })
  @ApiResponse({
    status: 200,
    description: '{ identityId, field, value } (value null when empty).',
  })
  @ApiResponse({ status: 400, description: 'field is not on the PII allow-list.' })
  @ApiResponse({ status: 403, description: 'Forbidden — requires operator role' })
  @ApiResponse({ status: 404, description: "Identity not found in the caller's tenant." })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  async reveal(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() body: PiiRevealDto,
    @AuthUser() authUser?: AuthUserType,
  ) {
    const result = await this.identityPiiService.reveal(
      id,
      body.field,
      authUser?.email ?? 'unknown',
    );
    if (!result) throw new NotFoundException('User not found');
    return result;
  }
}
