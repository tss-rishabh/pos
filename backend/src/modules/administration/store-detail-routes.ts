import QRCode from 'qrcode';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Databases } from '../../db/pools.js';
import { POSFranchise, Store } from '../../db/legacy-schema.js';
import { authenticated } from '../../auth/routes.js';
import { identifier } from '../../domain/validation.js';
import { AppError } from '../../domain/errors.js';
import { assertCurrentStoreAccess } from './authorization.js';
import { storePublicUrl } from './policies.js';

/** Static selected-store marketing QR; never issues an application/login capability. */
export function registerAdministrationStoreDetails(app: FastifyInstance, db: Databases) {
  const params = z.object({ storeId: identifier }).strict();
  const trace = (action: string) => ({
    config: { trace: { module: 'administration', resource: 'store-detail', action } },
  });
  async function read(request: Parameters<typeof authenticated>[0]) {
    const user = authenticated(request),
      { storeId } = params.parse(request.params);
    return db.get('writer').transaction(async (tx) => {
      await assertCurrentStoreAccess(tx, user.id, storeId, [1, 2, 3], 'share');
      const [row] = await tx
        .select({
          id: Store.id,
          name: Store.store_name,
          locationCode: Store.location_code,
          phone: Store.phone,
          email: Store.email,
          address: Store.address,
          alternateAddress: Store.alt_address,
          city: Store.city_name,
          state: Store.state_name,
          pincode: Store.pincode,
          type: Store.type,
          category: Store.category,
          active: Store.is_active,
          latitude: Store.latitude,
          longitude: Store.longitude,
          franchiseId: Store.franchise_id,
          gstin: Store.gstin,
          shortName: Store.short_name,
        })
        .from(Store)
        .where(eq(Store.id, BigInt(storeId)))
        .limit(1);
      if (!row) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Store was not found.');
      const [franchise] = row.franchiseId
        ? await tx
            .select({
              name: POSFranchise.name,
              description: POSFranchise.description,
              cin: POSFranchise.cin_number,
            })
            .from(POSFranchise)
            .where(eq(POSFranchise.id, BigInt(row.franchiseId)))
            .limit(1)
        : [];
      return {
        ...row,
        id: String(row.id),
        franchiseId: row.franchiseId === null ? null : String(row.franchiseId),
        franchise: franchise ?? null,
        publicUrl: storePublicUrl(storeId),
      };
    });
  }
  app.get('/api/v1/admin/stores/:storeId/detail', trace('read'), async (request, reply) => {
    z.object({}).strict().parse(request.query);
    return reply.header('Cache-Control', 'private, no-store').send(await read(request));
  });
  app.get('/api/v1/admin/stores/:storeId/qr', trace('download-qr'), async (request, reply) => {
    z.object({}).strict().parse(request.query);
    const row = await read(request),
      bytes = await QRCode.toBuffer(row.publicUrl, {
        type: 'png',
        errorCorrectionLevel: 'L',
        margin: 0,
        width: 512,
      });
    return reply
      .header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', `attachment; filename="store-${row.id}-qr.png"`)
      .type('image/png')
      .send(bytes);
  });
}
