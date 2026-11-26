/**
 * Outbound webhooks API (backend `modules/event-subscriptions`): subscriptions, their delivery
 * attempts and a test delivery. Every route needs super-admin and takes the subscription's `_id`.
 * The deliveries list answers a plain array without a total, so a page asks for one row more than
 * it shows to know whether an older page exists.
 */
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { PAGE_SIZES } from '@config/pagination';
import type {
  IWebhookCreate,
  IWebhookDelivery,
  IWebhookSubscription,
  IWebhookTestResult,
  IWebhookUpdate,
} from '../interfaces';

const WEBHOOKS_API = `${API_BASE}/event-subscriptions`;

/** Delivery attempts per page (the backend caps a page at 100). */
export const WEBHOOK_DELIVERIES_PAGE_SIZE = PAGE_SIZES.MEDIUM;

export const webhookKeys = {
  all: ['webhooks'] as const,
  list: () => [...webhookKeys.all, 'list'] as const,
  deliveries: (id: string, page: number) => [...webhookKeys.all, 'deliveries', id, page] as const,
};

const subscriptionUrl = (id: string) => `${WEBHOOKS_API}/${encodeURIComponent(id)}`;

/** The tenant's subscriptions, newest first. */
export function useWebhookSubscriptions(enabled = true) {
  return useQuery({
    queryKey: webhookKeys.list(),
    queryFn: async () => {
      const { data } = await axiosInstance.get<IWebhookSubscription[]>(WEBHOOKS_API);
      return Array.isArray(data) ? data : [];
    },
    enabled,
  });
}

export interface WebhookDeliveriesPage {
  items: IWebhookDelivery[];
  /** An older page exists. */
  hasMore: boolean;
}

export async function fetchWebhookDeliveries(
  id: string,
  page: number,
): Promise<WebhookDeliveriesPage> {
  const { data } = await axiosInstance.get<IWebhookDelivery[]>(
    `${subscriptionUrl(id)}/deliveries`,
    {
      params: {
        limit: WEBHOOK_DELIVERIES_PAGE_SIZE + 1,
        offset: page * WEBHOOK_DELIVERIES_PAGE_SIZE,
      },
    },
  );
  const rows = Array.isArray(data) ? data : [];
  return {
    items: rows.slice(0, WEBHOOK_DELIVERIES_PAGE_SIZE),
    hasMore: rows.length > WEBHOOK_DELIVERIES_PAGE_SIZE,
  };
}

/** One page of a subscription's delivery attempts, newest first. */
export function useWebhookDeliveries(id: string | undefined, page: number) {
  return useQuery({
    queryKey: webhookKeys.deliveries(id ?? '', page),
    queryFn: () => fetchWebhookDeliveries(id as string, page),
    enabled: !!id,
    placeholderData: keepPreviousData,
  });
}

/** Every change reloads the list and any open delivery history (prefix key). */
function useWebhookMutation<TVars, TResult>(mutationFn: (vars: TVars) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: () => qc.invalidateQueries({ queryKey: webhookKeys.all }),
  });
}

export function useCreateWebhook() {
  return useWebhookMutation(async (body: IWebhookCreate) => {
    const { data } = await axiosInstance.post<IWebhookSubscription>(WEBHOOKS_API, body);
    return data;
  });
}

/** PATCH: name, status (pause, resume), filters, URL, headers, a new signing secret. */
export function useUpdateWebhook() {
  return useWebhookMutation(async ({ id, body }: { id: string; body: IWebhookUpdate }) => {
    const { data } = await axiosInstance.patch<IWebhookSubscription>(subscriptionUrl(id), body);
    return data;
  });
}

export function useDeleteWebhook() {
  return useWebhookMutation(async (id: string) => {
    await axiosInstance.delete(subscriptionUrl(id));
  });
}

/** One signed `webhook.test` POST now; answers the receiver's status or the error. Not stored. */
export function useTestWebhook() {
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await axiosInstance.post<IWebhookTestResult>(`${subscriptionUrl(id)}/test`);
      return data;
    },
  });
}
