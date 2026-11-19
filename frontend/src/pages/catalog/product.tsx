import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import type { Principal } from '../../api/types';
import { request } from '../../api/client';
import { ErrorState, Loading, PageTitle } from '../../components/common';
import { useOnline } from '../../hooks/use-pos';
import { catalogDetail, type CatalogDetail } from './contracts';
import { CatalogPagination } from './table';
import { ProductTroubleshooting } from './maintenance';
import './style.css';

/** Render stored legacy HTML as readable text; scripts, handlers and remote embeds never enter the DOM. */
export function productDescriptionText(value: string | null) {
  if (!value) return '';
  const parsed = new DOMParser().parseFromString(value, 'text/html');
  parsed
    .querySelectorAll('script,style,template,iframe,object,embed,svg,math')
    .forEach((node) => node.remove());
  parsed.querySelectorAll('br,p,div,li,h1,h2,h3,h4,section').forEach((node) => node.append('\n'));
  return parsed.body.textContent?.trim() || '';
}
type StockRow = CatalogDetail['stock'][number];
export function StockEditor({
  user,
  storeId,
  productId,
  current,
  parentProductId,
  enabled,
  stockEnabled,
  onRefresh,
}: {
  user: Principal;
  storeId: string;
  productId: string;
  current: StockRow | undefined;
  parentProductId: string | null;
  enabled: boolean;
  stockEnabled: boolean;
  onRefresh: () => Promise<unknown>;
}) {
  const [stock, setStock] = useState(String(current?.stock || 0));
  const [visibility, setVisibility] = useState({
    available: current?.available || false,
    listed: current?.listed || false,
  });
  const action = useMutation({
    mutationFn: async (
      value: { kind: 'stock'; stock: number } | { kind: 'available' | 'listed'; checked: boolean },
    ) =>
      request(
        `/api/v1/admin/stores/${storeId}/inventory/${productId}/${value.kind === 'stock' ? 'stock' : 'visibility'}`,
        {
          method: value.kind === 'stock' ? 'PUT' : 'PATCH',
          operatorId: user.id,
          body: JSON.stringify(
            value.kind === 'stock'
              ? { stock: value.stock, expectedStock: current?.stock || 0 }
              : { kind: value.kind, checked: value.checked, parentProductId },
          ),
        },
        z.object({ status: z.string(), message: z.string() }),
      ),
    onSuccess: onRefresh,
    onError: () =>
      setVisibility({ available: current?.available || false, listed: current?.listed || false }),
  });
  return (
    <div className="catalog-stock-editor">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (/^\d+$/.test(stock) && Number(stock) <= 2147483647)
            action.mutate({ kind: 'stock', stock: Number(stock) });
        }}
      >
        <label>
          Stock
          <input
            aria-label={`Stock ${productId} at ${storeId}`}
            className="catalog-stock-input"
            type="number"
            min="0"
            max="2147483647"
            step="1"
            required
            value={stock}
            disabled={!stockEnabled || action.isPending}
            onChange={(event) => setStock(event.target.value)}
          />
        </label>
        <button
          className="button secondary"
          disabled={
            !stockEnabled || action.isPending || (!!current && stock === String(current.stock))
          }
        >
          Save stock
        </button>
      </form>
      <label>
        <input
          type="checkbox"
          checked={visibility.available}
          disabled={!enabled || !current || action.isPending}
          onChange={(event) => {
            setVisibility({ ...visibility, available: event.target.checked });
            action.mutate({ kind: 'available', checked: event.target.checked });
          }}
        />
        Available{parentProductId ? ' (family)' : ''}
      </label>
      <label>
        <input
          type="checkbox"
          checked={visibility.listed}
          disabled={!enabled || !current || action.isPending}
          onChange={(event) => {
            setVisibility({ ...visibility, listed: event.target.checked });
            action.mutate({ kind: 'listed', checked: event.target.checked });
          }}
        />
        Listed{parentProductId ? ' (family)' : ''}
      </label>
      {action.isError && (
        <>
          <ErrorState error={action.error} />
          <button className="button secondary" onClick={() => void onRefresh()}>
            Refresh current stock
          </button>
        </>
      )}
      {action.isSuccess && <small role="status">{action.data.message}</small>}
    </div>
  );
}
export function CatalogProductPage({ user, productId }: { user: Principal; productId: string }) {
  const online = useOnline(),
    client = useQueryClient(),
    [selectedImage, setSelectedImage] = useState(''),
    [editing, setEditing] = useState(false),
    [variantStart, setVariantStart] = useState(0),
    [variantLength, setVariantLength] = useState(25),
    [tab, setTab] = useState<'description' | 'material'>('description');
  const data = useQuery({
    queryKey: [user.id, 'catalog-product-detail', productId],
    queryFn: ({ signal }) =>
      request(`/api/v1/catalog/products/${productId}`, { signal }, catalogDetail),
    retry: false,
  });
  const canEdit = user.userType === 1 && [1, 2, 3].includes(user.role),
    capabilities = useQuery({
      queryKey: [user.id, 'catalog-inventory-capabilities'],
      enabled: canEdit,
      queryFn: () =>
        request(
          '/api/v1/admin/inventory-imports/capabilities',
          {},
          z.object({ visibilityEnabled: z.boolean(), stockEnabled: z.boolean() }),
        ),
      retry: false,
      staleTime: 30000,
    });
  const stockMap = useMemo(
    () => new Map(data.data?.stock.map((row) => [row.productId + ':' + row.storeId, row]) || []),
    [data.data],
  );
  if (data.isPending) return <Loading />;
  if (data.isError) return <ErrorState error={data.error} retry={() => void data.refetch()} />;
  const detail = data.data,
    product = detail.product,
    images = [...product.male, ...product.female],
    parentProductId =
      product.parentId !== '0' ? product.parentId : product.type === '3' ? product.id : null;
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: [user.id, 'catalog-product-detail', productId] });
  };
  return (
    <>
      <PageTitle title={`${product.name} [${product.id}]`}>
        <Link className="button secondary" to="/catalog">
          Catalog
        </Link>
        <Link className="button secondary" to={`/catalog/products/${product.id}/audit`}>
          Inventory logs
        </Link>
      </PageTitle>
      {!online && (
        <p role="status">Offline. Stock is from the last refresh; reconnect before changing it.</p>
      )}
      <section className="surface catalog-product-top">
        <div>
          {images.length ? (
            <>
              <img
                className="catalog-hero"
                alt={product.name}
                src={images.includes(selectedImage) ? selectedImage : images[0]}
              />
              <div className="catalog-thumbs">
                {images.map((image, index) => (
                  <button
                    key={`${image}:${index}`}
                    aria-label={`View product image ${index + 1}`}
                    onClick={() => setSelectedImage(image)}
                  >
                    <img src={image} alt="" loading="lazy" />
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="muted">No product image available.</p>
          )}
        </div>
        <div>
          <h2>ERP name: {product.erpName || 'Not available'}</h2>
          <p className="catalog-rich-text">{productDescriptionText(product.shortDescription)}</p>
          <h2>Rs. {product.price}</h2>
          {!!product.exclusivePrice && <p>Exclusive price: Rs. {product.exclusivePrice}</p>}
          {Number(product.specialPrice) !== 0 && <p>Special price: Rs. {product.specialPrice}</p>}
          <Link to="/inventory">Stock overview</Link>
        </div>
      </section>
      <section className="surface catalog-detail-block">
        <div className="catalog-table-toolbar">
          <h2>Store stock</h2>
          {canEdit && (
            <label>
              <input
                type="checkbox"
                checked={editing}
                disabled={!online}
                onChange={(event) => setEditing(event.target.checked)}
              />
              Edit stock and visibility
            </label>
          )}
        </div>
        {editing && (
          <>
            {capabilities.isError && <ErrorState error={capabilities.error} />}{' '}
            {!capabilities.data?.stockEnabled && (
              <p role="status">
                Stock changes are unavailable until the stock procedure and product synchronization
                are verified and configured.
              </p>
            )}
            {!capabilities.data?.visibilityEnabled && (
              <p>Visibility changes require product synchronization.</p>
            )}
            {parentProductId && (
              <p>
                Visibility controls apply to every linked variant and its parent. Stock saves apply
                to the selected SKU.
              </p>
            )}
          </>
        )}
        {detail.checkInRequired ? (
          <p role="alert">You are not checked in to an assigned store. Check in to view stock.</p>
        ) : (
          <div className="catalog-scroll">
            <table>
              <thead>
                <tr>
                  <th className="catalog-stock-frozen">SKU ID</th>
                  <th className="catalog-stock-frozen-second">Product / barcode</th>
                  {detail.stores.map((store) => (
                    <th key={store.id}>{store.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detail.variants
                  .slice(variantStart, variantStart + variantLength)
                  .map((variant) => (
                    <tr key={variant.id}>
                      <td className="catalog-stock-frozen">
                        {variant.id}
                        <br />
                        <Link to={`/catalog/products/${variant.id}/audit?kind=held`}>
                          Hold logs
                        </Link>
                      </td>
                      <td className="catalog-stock-frozen-second">
                        {variant.name}
                        <br />
                        {variant.barcode || 'Barcode missing'}
                      </td>
                      {detail.stores.map((store) => {
                        const current = stockMap.get(variant.id + ':' + store.id),
                          permitted = user.role === 1 || user.storeIds.includes(store.id);
                        return (
                          <td key={store.id}>
                            {editing && permitted ? (
                              <StockEditor
                                key={`${variant.id}:${store.id}:${current?.stock}:${current?.available}:${current?.listed}`}
                                user={user}
                                storeId={store.id}
                                productId={variant.id}
                                current={current}
                                parentProductId={parentProductId}
                                enabled={online && !!capabilities.data?.visibilityEnabled}
                                stockEnabled={
                                  online &&
                                  !!capabilities.data?.stockEnabled &&
                                  !(product.type === '3' && variant.id === product.id)
                                }
                                onRefresh={refresh}
                              />
                            ) : (
                              current?.stock || 0
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
        {detail.variants.length > 25 && (
          <CatalogPagination
            start={variantStart}
            total={detail.variants.length}
            length={variantLength}
            busy={data.isFetching}
            onStart={setVariantStart}
            onLength={(value) => {
              setVariantLength(value);
              setVariantStart(0);
            }}
          />
        )}
      </section>
      <section className="surface catalog-detail-block">
        <div className="catalog-table-toolbar">
          <button
            className={`button ${tab === 'description' ? 'primary' : 'secondary'}`}
            onClick={() => setTab('description')}
          >
            Description
          </button>
          <button
            className={`button ${tab === 'material' ? 'primary' : 'secondary'}`}
            onClick={() => setTab('material')}
          >
            Material
          </button>
        </div>
        {tab === 'description' ? (
          <>
            <h3>{productDescriptionText(product.description.name)}</h3>
            <div className="catalog-rich-text">
              {productDescriptionText(product.description.description)}
            </div>
          </>
        ) : (
          <div className="catalog-rich-text">
            {productDescriptionText(product.description.material)}
          </div>
        )}
      </section>
      <ProductTroubleshooting key={user.id + ':' + productId} user={user} productId={productId} />
    </>
  );
}
