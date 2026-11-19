import { z } from 'zod';
const metadata = z.object({
  meta: z.object({ items: z.array(z.record(z.string(), z.unknown())).max(500) }),
});
export function displayedMembershipBenefits(cart: unknown): boolean | null {
  const parsed = metadata.safeParse(cart);
  if (!parsed.success) return null;
  const matches = parsed.data.meta.items.filter((item) => item.name === 'exclusive_user');
  if (matches.length > 1) return null;
  if (!matches.length) return false;
  const active = matches[0]?.active;
  return typeof active === 'boolean' ? active : null;
}
