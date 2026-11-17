FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY compatibility/upstream/whole-order-status ./compatibility/upstream/whole-order-status
RUN npm run build

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS runtime-base
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4410
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY resources ./resources
COPY src/modules/administration/*.sql ./src/modules/administration/
COPY src/modules/administration/barcodes/*.sql ./src/modules/administration/barcodes/
COPY src/modules/administration/parent-store-imports/*.sql ./src/modules/administration/parent-store-imports/
COPY src/modules/administration/ecommerce-sync/*.sql ./src/modules/administration/ecommerce-sync/
COPY src/modules/application-links/*.sql ./src/modules/application-links/
COPY src/modules/gift-card-batches/*.sql ./src/modules/gift-card-batches/
COPY src/modules/customer-insights/*.sql ./src/modules/customer-insights/
COPY src/modules/customer-contacts/*.sql ./src/modules/customer-contacts/
COPY src/modules/customer-otp/*.sql ./src/modules/customer-otp/
COPY src/modules/customer-website-handoff/*.sql ./src/modules/customer-website-handoff/
COPY src/modules/global-vouchers/*.sql ./src/modules/global-vouchers/
COPY src/modules/checkout-performance/*.sql ./src/modules/checkout-performance/
COPY compatibility/customer-contacts/migration.sql ./compatibility/customer-contacts/migration.sql
COPY src/modules/checkout/migrations ./src/modules/checkout/migrations
COPY src/modules/checkout/order-messages/*.sql ./src/modules/checkout/order-messages/
COPY src/modules/checkout/order-copy/*.sql ./src/modules/checkout/order-copy/
COPY src/modules/checkout/payment-reversals/*.sql ./src/modules/checkout/payment-reversals/
COPY src/modules/checkout/payments/*.sql ./src/modules/checkout/payments/
COPY src/modules/checkout/screening-writer/*.sql ./src/modules/checkout/screening-writer/
COPY src/modules/checkout/cancellations/*.sql ./src/modules/checkout/cancellations/
COPY src/modules/legacy-order-imports/*.sql ./src/modules/legacy-order-imports/
COPY src/modules/legacy-order-imports/screening-counter/*.sql ./src/modules/legacy-order-imports/screening-counter/
COPY src/modules/legacy-order-imports/authority-succession/*.sql ./src/modules/legacy-order-imports/authority-succession/
COPY src/modules/legacy-order-imports/membership-profile/*.sql ./src/modules/legacy-order-imports/membership-profile/
COPY compatibility/upstream/legacy-order-imports/benefit-profile/migration.sql ./compatibility/upstream/legacy-order-imports/benefit-profile/migration.sql
COPY compatibility/upstream/ordinary/migration.sql ./compatibility/upstream/ordinary/migration.sql
COPY compatibility/upstream/screening-origins/migration.sql ./compatibility/upstream/screening-origins/migration.sql
COPY compatibility/upstream/screening-origins/history-versions-migration.sql ./compatibility/upstream/screening-origins/history-versions-migration.sql
COPY compatibility/upstream/screening-origins/system-migration.sql ./compatibility/upstream/screening-origins/system-migration.sql
COPY compatibility/upstream/screening-origins/legacy-effects-migration.sql ./compatibility/upstream/screening-origins/legacy-effects-migration.sql
COPY compatibility/upstream/screening-origins/assets-migration.sql ./compatibility/upstream/screening-origins/assets-migration.sql
COPY compatibility/upstream/screening-origins/effects-migration.sql ./compatibility/upstream/screening-origins/effects-migration.sql
COPY compatibility/upstream/screening-origins/system-preparation-migration.sql ./compatibility/upstream/screening-origins/system-preparation-migration.sql
COPY compatibility/upstream/screening-origins/legacy-assets-migration.sql ./compatibility/upstream/screening-origins/legacy-assets-migration.sql
COPY compatibility/upstream/screening-origins/system-successor-migration.sql ./compatibility/upstream/screening-origins/system-successor-migration.sql
COPY compatibility/upstream/screening-origins/origin-coupon-migration.sql ./compatibility/upstream/screening-origins/origin-coupon-migration.sql
COPY compatibility/upstream/screening-origins/origin-coupon-generation-migration.sql ./compatibility/upstream/screening-origins/origin-coupon-generation-migration.sql
COPY compatibility/upstream/screening-origins/screening-counter-generation-migration.sql ./compatibility/upstream/screening-origins/screening-counter-generation-migration.sql
COPY compatibility/upstream/screening-origins/stage-recovery-migration.sql ./compatibility/upstream/screening-origins/stage-recovery-migration.sql
COPY src/modules/screening-origins/*.sql ./src/modules/screening-origins/
COPY src/modules/fulfillment/migration.sql ./src/modules/fulfillment/migration.sql
COPY src/modules/fulfillment/trace-migration.sql ./src/modules/fulfillment/trace-migration.sql
COPY src/modules/legacy-fulfillment/migration.sql ./src/modules/legacy-fulfillment/migration.sql
COPY src/modules/legacy-fulfillment/lifecycle/migration.sql ./src/modules/legacy-fulfillment/lifecycle/migration.sql
COPY src/modules/legacy-order-status/*.sql ./src/modules/legacy-order-status/
COPY compatibility/upstream/whole-order-status/pinned-source.js ./compatibility/upstream/whole-order-status/pinned-source.js
COPY compatibility/upstream/whole-order-status/source-manifest.json ./compatibility/upstream/whole-order-status/source-manifest.json
COPY src/modules/finance/migration.sql ./src/modules/finance/migration.sql
COPY src/modules/operational-reports/*.sql ./src/modules/operational-reports/
COPY src/modules/catalog-details/*.sql ./src/modules/catalog-details/
USER node

FROM runtime-base AS whole-order-status-receiver
ENV WHOLE_ORDER_STATUS_RECEIVER_HOST=0.0.0.0 WHOLE_ORDER_STATUS_RECEIVER_PORT=4422
EXPOSE 4422
HEALTHCHECK --interval=30s --timeout=8s --start-period=30s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:4422/health/live',{signal:AbortSignal.timeout(6000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node","dist/modules/legacy-order-status/receiver-main.js"]

FROM runtime-base AS coupon-history-worker
CMD ["node","dist/modules/legacy-order-imports/benefit-profile/history-generation-worker-main.js"]

FROM runtime-base AS origin-history-receiver
ENV POS_SCREENING_ORIGIN_HISTORY_BRIDGE_HOST=0.0.0.0 POS_SCREENING_ORIGIN_HISTORY_BRIDGE_PORT=4424
EXPOSE 4424
HEALTHCHECK --interval=30s --timeout=8s --start-period=30s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:4424/health/live',{signal:AbortSignal.timeout(6000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node","dist/modules/screening-origins/bridge-main.js"]

FROM runtime-base AS membership-history-worker
CMD ["node","dist/modules/checkout/screening-writer/membership-generation-main.js"]

FROM runtime-base AS screening-counter-worker
CMD ["node","dist/modules/legacy-order-imports/screening-counter/counter-generation-main.js"]

FROM runtime-base AS runtime
EXPOSE 4410
HEALTHCHECK --interval=30s --timeout=8s --start-period=30s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:4410/health/ready',{signal:AbortSignal.timeout(6000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node","dist/server.js"]
