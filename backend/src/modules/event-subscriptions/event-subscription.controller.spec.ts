/**
 * POST /event-subscriptions/:id/test answered "Test delivery queued" without sending or queuing
 * anything. It now sends the test to the tenant's subscription and answers how the receiver took
 * it (EventDeliveryService.sendTestDelivery).
 */
import { NotFoundException } from '@nestjs/common';
import type { Model } from 'mongoose';
import { EventSubscriptionController } from './event-subscription.controller';
import type { EventSubscriptionService } from './event-subscription.service';
import type { EventDeliveryService } from './event-delivery.service';
import type { DeliveryAttemptDocument } from './schemas/delivery-attempt.schema';

const ID = '64b7f0c2a1b2c3d4e5f60730';

describe('EventSubscriptionController test delivery', () => {
  const sub = { _id: ID, name: 'SIEM', webhook: { url: 'https://hooks.example/euroid' } };
  let service: { findStored: jest.Mock };
  let delivery: { sendTestDelivery: jest.Mock };
  let controller: EventSubscriptionController;

  beforeEach(() => {
    // The stored subscription (secret and headers included): the test signs and sends with it.
    service = { findStored: jest.fn().mockResolvedValue(sub) };
    delivery = { sendTestDelivery: jest.fn() };
    controller = new EventSubscriptionController(
      service as unknown as EventSubscriptionService,
      {} as Model<DeliveryAttemptDocument>,
      delivery as unknown as EventDeliveryService,
    );
  });

  it("sends the test to the tenant's subscription and answers the receiver's outcome", async () => {
    const outcome = {
      success: false,
      subscriptionId: ID,
      deliveryId: 'd-1',
      eventType: 'webhook.test',
      httpStatus: 500,
      error: 'Request failed with status code 500',
      message: 'Not delivered: Request failed with status code 500',
    };
    delivery.sendTestDelivery.mockResolvedValue(outcome);

    await expect(controller.test(ID)).resolves.toEqual(outcome);
    expect(service.findStored).toHaveBeenCalledWith(ID);
    expect(delivery.sendTestDelivery).toHaveBeenCalledWith(sub);
  });

  it('sends nothing for a subscription the tenant does not have', async () => {
    service.findStored.mockRejectedValue(new NotFoundException(`Subscription ${ID} not found`));

    await expect(controller.test(ID)).rejects.toThrow(NotFoundException);
    expect(delivery.sendTestDelivery).not.toHaveBeenCalled();
  });
});
