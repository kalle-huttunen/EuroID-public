import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { ParseObjectIdPipe } from '@shared/pipes/parse-object-id.pipe';
import { CreateInviteSchema } from './dto/invite.dto';
import { InviteService } from './invite.service';

/**
 * Invites that bring further admins into the caller's tenant (super-admin). The invitee
 * registers with the code through the public POST /auth/register (auth-local.controller.ts).
 */
@Controller('auth')
export class InviteController {
  constructor(private readonly inviteService: InviteService) {}

  @Roles('super-admin')
  @Post('invites')
  @ApiOperation({ summary: "Invite an admin into the caller's tenant (the code is answered once)" })
  @ApiResponse({ status: 201, description: '{ token, expiresAt }: single use, 72 hours' })
  @ApiResponse({ status: 400, description: 'No valid tenant role, an invalid email' })
  @ApiResponse({ status: 409, description: 'The address has an admin account in this tenant' })
  async createInvite(@Body() body: unknown, @AuthUser() user: { sub: string; tenantId: string }) {
    const parsed = CreateInviteSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten().fieldErrors);
    }
    return this.inviteService.createInvite(
      parsed.data.email,
      parsed.data.roles,
      user.sub,
      user.tenantId,
    );
  }

  @Roles('super-admin')
  @Get('invites')
  @ApiOperation({ summary: "List the caller tenant's pending (unused, unexpired) invites" })
  @ApiResponse({
    status: 200,
    description:
      'Newest first: { id, email, role, createdBy, createdAt, expiresAt }. Never the code or its hash.',
  })
  async listInvites(@AuthUser() user: { tenantId: string }) {
    return this.inviteService.listPending(user.tenantId);
  }

  @Roles('super-admin')
  @Delete('invites/:id')
  @ApiOperation({ summary: "Cancel a pending invite of the caller's tenant (audited)" })
  @ApiResponse({
    status: 200,
    description: '{ success: true }: the code no longer registers anyone',
  })
  @ApiResponse({
    status: 404,
    description: "No pending invite of the caller's tenant with this id",
  })
  async cancelInvite(
    @Param('id', ParseObjectIdPipe) id: string,
    @AuthUser() user: { sub: string; tenantId: string },
  ) {
    if (!(await this.inviteService.cancel(id, user.tenantId, user.sub))) {
      throw new NotFoundException(
        'No pending invite with this id in your tenant: it was used, expired or cancelled.',
      );
    }
    return { success: true };
  }
}
