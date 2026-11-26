/**
 * Event Subscription Controller
 *
 * REST API for managing outbound webhook subscriptions.
 * All endpoints require super-admin role.
 */

import { Controller, Get, Post, Patch, Delete, Param, Body, Query, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { Request } from 'express';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { ParseObjectIdPipe } from '@shared/pipes/parse-object-id.pipe';
import { EventSubscriptionService } from './event-subscription.service';
import { EventDeliveryService, WebhookTestResult } from './event-delivery.service';
import { DeliveryAttempt, DeliveryAttemptDocument } from './schemas/delivery-attempt.schema';
import { ListDeliveriesQuerySchema } from './dtos/list-deliveries-query.dto';

/** Every answer with a subscription: what it carries and what it never does. */
const SUBSCRIPTION_ANSWER =
  'The subscription: _id, name, status, filters, webhook { url, headerNames, hasSigningSecret }, createdBy, createdAt, updatedAt. Never the signing secret (not even encrypted) or a custom header value.';
/** What filters.severityMin does (subscription-filters.ts meetsSeverityMin). */
const SEVERITY_MIN =
  'filters.severityMin (LOW, MEDIUM, HIGH, CRITICAL, optional): an event whose payload carries a lower severity is not delivered (drift.detected carries LOW..CRITICAL, anomaly.detected low..critical; case is ignored). An event type without a severity, or with one outside that scale, is always delivered.';
const HEADER_RULES =
  'Invalid input. Custom header names must be HTTP tokens without "." or a leading "$", and cannot be Host, Content-Type, Content-Length or start with X-EuroID-; values hold no line break and at most 2000 characters. A webhook URL the SSRF guard refuses (https only, no private, loopback, link-local, metadata or reserved address) is 400 as well.';

@ApiTags('Event Subscriptions')
@ApiBearerAuth('jwt')
@Controller('event-subscriptions')
export class EventSubscriptionController {
  constructor(
    private readonly service: EventSubscriptionService,
    @InjectModel(DeliveryAttempt.name)
    private readonly deliveryModel: Model<DeliveryAttemptDocument>,
    private readonly delivery: EventDeliveryService,
  ) {}

  @Post()
  @Roles('super-admin')
  @ApiOperation({ summary: 'Create a webhook subscription', description: SEVERITY_MIN })
  @ApiResponse({ status: 201, description: SUBSCRIPTION_ANSWER })
  @ApiResponse({ status: 400, description: HEADER_RULES })
  @ApiResponse({ status: 409, description: 'Another subscription of the tenant has this name.' })
  async create(@Body() body: unknown, @Req() req: Request) {
    const actor = (req as Request & { user?: { email?: string } }).user?.email ?? 'system';
    return this.service.create(body, actor);
  }

  @Get()
  @Roles('super-admin')
  @ApiOperation({ summary: 'List webhook subscriptions' })
  @ApiResponse({ status: 200, description: `Newest first. Each: ${SUBSCRIPTION_ANSWER}` })
  async list() {
    return this.service.findAll();
  }

  @Get(':id')
  @Roles('super-admin')
  @ApiOperation({ summary: 'Get a webhook subscription by ID' })
  @ApiResponse({ status: 200, description: SUBSCRIPTION_ANSWER })
  @ApiResponse({ status: 404, description: 'No such subscription in this tenant.' })
  async getOne(@Param('id', ParseObjectIdPipe) id: string) {
    return this.service.findOne(id);
  }

  @Patch(':id')
  @Roles('super-admin')
  @ApiOperation({
    summary: 'Update a webhook subscription',
    description: `Send only what changes. webhook.headers is the complete set of custom headers after the edit: a header sent as null keeps its stored value, a stored header left out is removed. filters replaces the whole filters object. ${SEVERITY_MIN}`,
  })
  @ApiResponse({ status: 200, description: SUBSCRIPTION_ANSWER })
  @ApiResponse({
    status: 400,
    description: `${HEADER_RULES} A header sent as null that is not stored is 400 too.`,
  })
  @ApiResponse({ status: 404, description: 'No such subscription in this tenant.' })
  @ApiResponse({ status: 409, description: 'Another subscription of the tenant has this name.' })
  async update(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const actor = (req as Request & { user?: { email?: string } }).user?.email ?? 'system';
    return this.service.update(id, body, actor);
  }

  @Delete(':id')
  @Roles('super-admin')
  @ApiOperation({ summary: 'Delete a webhook subscription' })
  async remove(@Param('id', ParseObjectIdPipe) id: string, @Req() req: Request) {
    const actor = (req as Request & { user?: { email?: string } }).user?.email ?? 'system';
    await this.service.remove(id, actor);
    return { success: true, id };
  }

  @Post(':id/test')
  @Roles('super-admin')
  @ApiOperation({ summary: 'Send a test event to the webhook subscription' })
  async test(@Param('id', ParseObjectIdPipe) id: string): Promise<WebhookTestResult> {
    // The stored subscription: the test signs with its secret and sends its headers.
    const sub = await this.service.findStored(id);
    // One signed webhook.test POST now, whatever the status; the receiver's answer, not stored.
    return this.delivery.sendTestDelivery(sub);
  }

  @Get(':id/deliveries')
  @Roles('super-admin')
  @ApiOperation({
    summary: 'List delivery attempts for a subscription',
    description:
      "Newest first. status PENDING: being sent (first time or a retry), nextRetryAt the end of the sender's lease; FAILED: nextRetryAt the next retry, absent once the attempts ran out; DELIVERED: a 2xx answer.",
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max items (default 50, max 100)',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: 'Pagination offset',
  })
  async deliveries(
    @Param('id', ParseObjectIdPipe) id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    // 400 for an offset or limit that is not a whole number in range (ZodErrorFilter).
    const paging = ListDeliveriesQuerySchema.parse({ limit, offset });
    // Verify subscription exists and belongs to tenant
    await this.service.findOne(id);

    return this.deliveryModel
      .find({ subscriptionId: id })
      .sort({ createdAt: -1 })
      .skip(paging.offset)
      .limit(paging.limit)
      .lean()
      .exec();
  }
}
