import { z } from 'zod';
export const adminShipmentsOverviewRequestSchema = z.object({
  shippedFilter: z.enum(['today', '7d', '30d', 'all']).default('7d'),
});
