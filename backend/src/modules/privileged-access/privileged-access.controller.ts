import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  ForbiddenException,
  HttpStatus,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { PrivilegedAccessService } from './privileged-access.service';
import { IdentityService } from '../identity/identity.service';
import { CreateAdminAccountDto } from './dtos/create-admin-account.dto';

@ApiTags('Privileged Access')
@ApiBearerAuth('jwt')
@Controller('privileged-access')
export class PrivilegedAccessController {
  constructor(
    private readonly privilegedAccessService: PrivilegedAccessService,
    private readonly identityService: IdentityService,
  ) {}

  @Get('admin-accounts')
  @Roles('viewer')
  @ApiOperation({ summary: 'List all admin accounts across identities' })
  @ApiResponse({
    status: 200,
    description:
      'Live admin identities (soft-deleted ones are left out). `status` is the privileged ' +
      'session: PENDING, ACTIVATING, ACTIVE (until `expiresAt`) or INACTIVE; ' +
      '`activationError` says why the last activation failed, `disableError` why disabling the ' +
      'accounts failed (retried hourly). `parentDeleted: true` marks one whose parent identity ' +
      'is deleted or gone: it can be deactivated, not activated.',
  })
  listAllAdminAccounts() {
    return this.privilegedAccessService.listAllAdminAccounts();
  }

  @Get(':parentId/admin-accounts')
  @Roles('viewer')
  @ApiOperation({ summary: 'List linked admin accounts for a parent identity' })
  @ApiResponse({
    status: 200,
    description:
      'Linked admin accounts whose admin identity is live (not soft-deleted), with the session ' +
      'fields of `GET /privileged-access/admin-accounts` (status, expiresAt, activationError, ' +
      'disableError).',
  })
  @ApiResponse({ status: 404, description: 'No live identity with this id.' })
  async getLinkedAdminAccounts(
    @Param('parentId') parentId: string,
    @AuthUser() authUser: AuthUserType,
  ) {
    const identity = await this.identityService.findByEmail(authUser?.email ?? '');
    const requesterIdentityId = identity?._id ? String(identity._id) : undefined;
    return this.privilegedAccessService.getLinkedAdminAccounts(
      parentId,
      requesterIdentityId,
      authUser?.roles ?? [],
    );
  }

  @Post(':parentId/admin-accounts')
  @Roles('operator')
  @ApiOperation({ summary: 'Create linked admin identity' })
  @ApiResponse({
    status: 201,
    description:
      "Admin identity created (or the tier's live one returned). Its UPN is ASCII; when another " +
      "person's live identity holds it, the next numeric suffix is used.",
  })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient tier privileges.' })
  @ApiResponse({
    status: 409,
    description:
      "The admin UPN (ADMIN_UPN_PATTERN) is the UPN of this person's admin account of another " +
      'tier: the pattern needs {tier} to give a person one admin account per tier. Or live ' +
      'identities of other people hold the UPN and every numeric suffix up to ' +
      'ADMIN_UPN_MAX_SUFFIX. A soft-deleted identity does not count: its address can be reused.',
  })
  createLinkedAdminAccount(
    @Param('parentId') parentId: string,
    @Body() body: CreateAdminAccountDto,
    @AuthUser() authUser: AuthUserType,
  ) {
    const roles = authUser?.roles ?? [];

    if (body.adminTier === 'TIER_0') {
      if (!roles.includes('super-admin')) {
        throw new ForbiddenException(
          'TIER_0 admin account creation requires the super-admin role.',
        );
      }
    } else if (body.adminTier === 'TIER_1') {
      if (!roles.includes('super-admin') && !roles.includes('policy-admin')) {
        throw new ForbiddenException(
          'TIER_1 admin account creation requires the policy-admin or super-admin role.',
        );
      }
    } else if (body.adminTier === 'TIER_2') {
      const hasTier2Role =
        roles.includes('super-admin') ||
        roles.includes('policy-admin') ||
        roles.includes('connector-admin');
      if (!hasTier2Role) {
        throw new ForbiddenException(
          'TIER_2 admin account creation requires connector-admin, policy-admin, or super-admin role.',
        );
      }
    }

    return this.privilegedAccessService.createLinkedAdminIdentity(parentId, body.adminTier);
  }

  @Put('admin-accounts/:adminId/activate')
  @Roles('viewer', 'operator')
  @ApiOperation({
    summary: 'Activate admin account (parent identity or connector-admin/super-admin)',
    description:
      'Starts a privileged session: its accounts are enabled in the target systems (Entra ID, ' +
      "AD, SCIM, Okta) for the tier's maximum session length, then disabled again. The call " +
      'waits up to PAM_ACTIVATION_WAIT_MS for the accounts to be enabled.',
  })
  @ApiResponse({
    status: 200,
    description: '`{ state: "ACTIVE", expiresAt }`: every account is enabled until `expiresAt`.',
  })
  @ApiResponse({
    status: 202,
    description:
      '`{ state: "ACTIVATING" }`: still enabling; the entry shows ACTIVE, or INACTIVE with ' +
      '`activationError`, once the session knows.',
  })
  @ApiResponse({
    status: 404,
    description: 'No live linked admin identity with this id (a soft-deleted one is not found).',
  })
  @ApiResponse({
    status: 409,
    description:
      'The parent identity is deleted or gone (activate refused, deactivate works), or a session ' +
      'of this admin account is already running. Nothing was started.',
  })
  @ApiResponse({
    status: 502,
    description:
      'Enabling failed in a target system (the message says where and why); the session ' +
      'disabled every account again, so nothing stays enabled.',
  })
  async activateAdminAccount(
    @Param('adminId') adminId: string,
    @AuthUser() authUser: AuthUserType,
    @Res({ passthrough: true }) res: Response,
  ) {
    const identity = await this.identityService.findByEmail(authUser?.email ?? '');
    const requesterIdentityId = identity?._id ? String(identity._id) : undefined;
    const result = await this.privilegedAccessService.activateAdminAccount(
      adminId,
      requesterIdentityId,
      authUser?.roles ?? [],
    );
    if (result.state === 'ACTIVATING') res.status(HttpStatus.ACCEPTED);
    return result;
  }

  @Put('admin-accounts/:adminId/deactivate')
  @Roles('viewer', 'operator')
  @ApiOperation({
    summary: 'Deactivate admin account (parent identity or connector-admin/super-admin)',
    description:
      'Ends the privileged session, or with none running starts a run that disables the ' +
      'accounts, so they end disabled in the target systems either way. Waits up to ' +
      'PAM_ACTIVATION_WAIT_MS.',
  })
  @ApiResponse({
    status: 200,
    description: '`{ state: "INACTIVE" }` (or `"PENDING"` if it was never active): ended.',
  })
  @ApiResponse({
    status: 202,
    description: '`{ state: "DEACTIVATING" }`: still disabling the accounts.',
  })
  async deactivateAdminAccount(
    @Param('adminId') adminId: string,
    @AuthUser() authUser: AuthUserType,
    @Res({ passthrough: true }) res: Response,
  ) {
    const identity = await this.identityService.findByEmail(authUser?.email ?? '');
    const requesterIdentityId = identity?._id ? String(identity._id) : undefined;
    const result = await this.privilegedAccessService.deactivateAdminAccount(
      adminId,
      requesterIdentityId,
      authUser?.roles ?? [],
    );
    if (result.state === 'DEACTIVATING') res.status(HttpStatus.ACCEPTED);
    return result;
  }
}
