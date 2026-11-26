import { Controller, Get, Post, Param, Body, Query, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiParam } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { PolicySuggestionService } from './policy-suggestions.service';
import type { SuggestionFilter } from './policy-suggestions.types';
import { ListSuggestionsQueryDto } from './dtos/list-suggestions-query.dto';
import { DismissBodyDto } from './dtos/dismiss-body.dto';
import { ParsePublicIdPipe } from '@shared/pipes/parse-public-id.pipe';

/** `:id` is the suggestion's `suggestionId` (UUID), the id the Policy suggestions page sends. */
const SUGGESTION_ID = new ParsePublicIdPipe();
const SUGGESTION_ID_PARAM = { name: 'id', description: "The suggestion's suggestionId (UUID)" };

/**
 * REST API for policy suggestions.
 * List, detail, accept, dismiss, and trigger analysis.
 */
@ApiTags('Policy Suggestions')
@ApiBearerAuth('jwt')
@Controller('policy-suggestions')
export class PolicySuggestionsController {
  private readonly logger = new Logger(PolicySuggestionsController.name);

  constructor(private readonly suggestionService: PolicySuggestionService) {}

  @Get()
  @Roles('viewer')
  @ApiOperation({ summary: 'List policy suggestions (paginated)' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  async list(@Query() query: ListSuggestionsQueryDto) {
    const filter: SuggestionFilter = {
      type: query.type,
      status: query.status ? [query.status] : undefined,
      confidenceMin: query.confidenceMin,
      page: query.page,
      limit: query.limit,
    };
    return this.suggestionService.findAll(filter);
  }

  @Get(':id')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get a single suggestion detail' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  @ApiResponse({ status: 404, description: 'Suggestion not found' })
  @ApiParam(SUGGESTION_ID_PARAM)
  findOne(@Param('id', SUGGESTION_ID) id: string) {
    return this.suggestionService.findOne(id);
  }

  @Post(':id/accept')
  @Roles('policy-admin')
  @ApiOperation({
    summary: 'Accept suggestion and create DRAFT policy',
    description: 'Answers the accepted suggestion; `resultingPolicyId` is the draft policy id.',
  })
  @ApiParam(SUGGESTION_ID_PARAM)
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  @ApiResponse({ status: 404, description: 'Suggestion not found' })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  accept(@Param('id', SUGGESTION_ID) id: string, @AuthUser() user?: AuthUserType) {
    return this.suggestionService.accept(id, user?.email || 'admin');
  }

  @Post(':id/dismiss')
  @Roles('policy-admin')
  @ApiOperation({ summary: 'Dismiss suggestion with optional reason' })
  @ApiParam(SUGGESTION_ID_PARAM)
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  @ApiResponse({ status: 404, description: 'Suggestion not found' })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  dismiss(
    @Param('id', SUGGESTION_ID) id: string,
    @Body() body: DismissBodyDto,
    @AuthUser() user?: AuthUserType,
  ) {
    return this.suggestionService.dismiss(id, user?.email || 'admin', body.reason);
  }

  @Post('analyze')
  @Roles('super-admin')
  @ApiOperation({ summary: 'Trigger analysis (super-admin only)' })
  @ApiResponse({
    status: 201,
    description:
      '{ analyzed, suggestionsCreated, skipped }. `analyzed` counts the candidate suggestions found; `skipped` lists each analyzer that did not run with its reason ({ analyzer, reason }), for example the birthright and orphan analyzers when Entra ID is not configured for the tenant.',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  async analyze() {
    this.logger.log('Policy suggestion analysis triggered');
    return this.suggestionService.runAnalysis();
  }
}
