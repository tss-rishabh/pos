import QRCode from 'qrcode';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Databases } from '../../db/pools.js';
import { POSFranchise, PosMachine, PosPaytmMachine, Store } from '../../db/legacy-schema.js';
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
      // `ShowStoreView` lists every Pine Labs and Paytm terminal of the store
      // (`stores/views.py:166-178`, `show.html:66-122`); secrets are not shown there.
      const pinelab = await tx
          .select({
            id: PosMachine.id,
            machineName: PosMachine.machine_name,
            merchantName: PosMachine.merchant_name,
            clientId: PosMachine.client_id,
            hardwareId: PosMachine.hardware_id,
            imei: PosMachine.imei_no,
            tid: PosMachine.tid,
            merchantId: PosMachine.merchant_id,
            merchantStorePosCode: PosMachine.merchant_store_pos_code,
          })
          .from(PosMachine)
          .where(eq(PosMachine.store_id, Number(storeId)))
          .orderBy(asc(PosMachine.id)),
        paytm = await tx
          .select({
            id: PosPaytmMachine.id,
            machineName: PosPaytmMachine.machine_name,
            merchantName: PosPaytmMachine.merchant_name,
            mid: PosPaytmMachine.paytm_mid,
            tid: PosPaytmMachine.paytm_tid,
            channelId: PosPaytmMachine.channel_id,
            storeName: PosPaytmMachine.store_name,
          })
          .from(PosPaytmMachine)
          .where(eq(PosPaytmMachine.store_id, Number(storeId)))
          .orderBy(asc(PosPaytmMachine.id));
      return {
        ...row,
        pinelabMachines: pinelab.map((machine) => ({ ...machine, id: String(machine.id) })),
        paytmMachines: paytm.map((machine) => ({ ...machine, id: String(machine.id) })),
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
