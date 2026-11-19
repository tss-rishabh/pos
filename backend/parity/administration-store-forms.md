# Store, location-code, counter and storage forms (W8a)

Legacy (pinned 78d5b63, Django 4.2.5): `stores/forms.py:28-127`, `stores/views.py:26-537`,
`stores/models.py:96-176`, `stores/templates/stores/{_form,create,edit,show}.html`,
`stores/datatables/*.py`, `helpers/helpers.py:778-824, 1386-1392`. Spec rows: phase-d S1–S25,
admin forms F1–F15.

## Store create/edit
- `POST /api/v1/admin/stores` / `PUT /api/v1/admin/stores/:storeId` take the legacy POST names
  (`category, store_name, short_name, location_code, type, email, phone, latitude, longitude,
  pincode, city_name, city_id, state_name, state_id, country_id, address, alt_address, gstin,
  slack_group_url, per_day_threshold, per_hour_threshold, franchise_name, franchise_description,
  cin_number`, plus `store_image` = upload id). Field cleaning mirrors the form and model
  (`store-form.ts`); errors return as HTTP 400
  `{error:{code:"FORM_INVALID", message:"Please correct the errors below.", fields:{name:[...]}}}` and
  the UI shows each list under its field (F1).
- Stored values as Django writes them: blank email/pincode/city/state/alt address/GSTIN/slack →
  `''` (F7, F3); blank thresholds/state_id → NULL (columns are nullable, DEFAULT 0); negative
  thresholds allowed (F14); latitude/longitude quantized to 16 decimals (`adapt_decimalfield_value`);
  phone stored as `str(int)`; `city_id` posted as `1111` by the shared partial on create and edit
  (F9); franchise fields stored as posted, blank allowed; non-franchise category sets
  `franchise_id=0`; a missing franchise row keeps the dangling id (legacy).
- Removed rewrite-only features: franchise association mode and `GET /api/v1/admin/franchises` (F5),
  write-only Slack webhook / "remove" (F3), separate image dialog (F6), manual country picker (F8).
- Kept hardening (security decisions): role 1/3 plus store scope on edit; franchise users only
  manage FRANCHISE stores they are assigned; editing a franchise record requires scope over every
  store using it.

| Field / case | Legacy message | Rewrite |
|---|---|---|
| Any required field blank | "This field is required." | same, per field (400) |
| Invalid choice (category/type/location) | "Select a valid choice. X is not one of the available choices." | same |
| store_name/short_name > 100, email > 55, pincode > 10, city/state > 255, gstin > 15, slack > 1000 | "Ensure this value has at most N characters (it has M)." | same |
| Phone outside 1111111111–9999999999 | "Please enter valid number" | same |
| Phone / integer not a number | "Enter a whole number." | same |
| Phone blank (form otherwise valid) | "Phone cant be empty" | same |
| Latitude/longitude not decimal | "“X” value must be a decimal number." | same |
| Latitude/longitude digits | "Ensure that there are no more than 22 digits in total." / "… 16 decimal places." / "… 6 digits before the decimal point." | same |
| Integer outside INT | "Ensure this value is less than or equal to 2147483647." | same |
| GSTIN pattern | "Enter a valid GSTIN (e.g., 22AAAAA0000A1Z5)" | same |
| Duplicate location code | "Store with this Location code already exists." | same |
| Duplicate phone | "Store with this Phone already exists." | same |
| Duplicate active name | "Store name must be unique" | same; also for an archived store's name (legacy: DB unique-key 500) |
| Franchise name/description > 255, CIN > 55 | DB error (500) | "Ensure this value has at most N characters (it has M)." |
| Edit of missing/archived store | flash "Store does not exists." | 404 "Store does not exists." |
| Success | flash "Store has been created!" / "Store has been updated!" → list | same text, dialog closes, list refreshes |

## Store list and status (S1–S3, S6, S8, S9)
- Lists show `type='STORE'` only, search store_name/address/phone/pincode, legacy columns
  (Store ID, Location Code, Store Name, Address, Pincode, City, Phone, Type, Email, Latitude,
  Longitude, Created At). Internal users see all stores (legacy); franchise users see their
  assigned franchise stores (security decision; legacy exempted franchise role 1). Cursor paging
  replaces DataTables offsets.
- Delete/activate (role 1): "The Store has been deleted" / "The Store has been activated"; the
  rewrite-only duplicate-name check on activation is removed (S9). Missing → 404 "Store does not exist".
- Detail (`View`) lists the store's Pine Labs and Paytm terminals as `show.html:66-122` (no secrets).

## Location code (S5)
| Case | Legacy (200 JSON) | Rewrite |
|---|---|---|
| Blank | "Location Code is required." | 400 same |
| Pattern | "Location Code must be 1-4 characters, letters and numbers only." | 400 same |
| Duplicate | "Location Code already exists." | 409 same |
| DB failure / capacity | "Failed to add Location Code." | 503/422 same |
| Success | "Location Code added successfully." (alert "Location Code added successfully!") | same |
Stored as Python `json.dumps(sorted(set(...)))` (`", "` separators).

## Counters and storages (S12–S25, F4, F10, F11)
- Cross-store lists (`POST /api/v1/admin/counters/search`, `/storages/search`) with the store name,
  search on name/description; per-store routes remain. Create offers active `type='STORE'` stores
  (`GET /api/v1/admin/resource-stores`).
- Counter create (role 1): description required, client and server "Provide a valid message";
  `C{count incl. archived + 1}`; "The Counter has been created".
- Storage create: raw `storage_name` ≤100 ("Ensure this value has at most 100 characters (it has N).")
  then `"{first word of store}-strg-{name}".upper()`; "Storage has been created!". Edit saves the
  name as posted, no store move (F4 removed); "Storage has been updated!"; missing → 404
  "Store does not exists.".
- Storage delete with stock: 409 "This Storage contains some stock, Release all stock from the
  storage before deletion" (legacy flash; JSON said "This Storage can't be deleted").
- Status: "The Counter has been deleted/activated", "The Storage has been deleted/activated";
  missing → 404 "Counter does not exist" / "Storage does not exist".

## Out of scope
F15 Django admin `Store` ModelAdmin (raw franchise_id/city_id/ecom edits, bulk physical delete) is
not reproduced; needs a recorded scope decision.
