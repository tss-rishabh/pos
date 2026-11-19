import { z } from 'zod';
import { AppError } from '../../domain/errors.js';

/**
 * Legacy `StoreCreateForm` (`stores/forms.py:28-110`) over the `Store` model
 * (`stores/models.py:96-139`), Django 4.2.5. Field names are the legacy POST names and every
 * message is the legacy (Django) text, returned per field as `_form.html` renders them.
 */
const posted = z.string().max(100_000).optional();
export const storeFormInput = z
  .object({
    category: posted,
    store_name: posted,
    short_name: posted,
    location_code: posted,
    type: posted,
    email: posted,
    phone: posted,
    latitude: posted,
    longitude: posted,
    pincode: posted,
    city_name: posted,
    city_id: posted,
    state_name: posted,
    state_id: posted,
    country_id: posted,
    address: posted,
    alt_address: posted,
    gstin: posted,
    slack_group_url: posted,
    per_day_threshold: posted,
    per_hour_threshold: posted,
    franchise_name: posted,
    franchise_description: posted,
    cin_number: posted,
    /** Private upload reserved through `/api/v1/admin/store-image-uploads`. */
    store_image: z.uuid().optional(),
  })
  .strict();
export type StoreFormInput = z.infer<typeof storeFormInput>;
export type FieldErrors = Record<string, string[]>;

/** A rejected legacy form: HTTP 400 with each field's legacy error list. */
export class FormInvalid extends AppError {
  constructor(readonly fields: FieldErrors) {
    super(400, 'FORM_INVALID', 'Please correct the errors below.');
  }
}

export const requiredMessage = 'This field is required.';
const length = (value: string) => [...value].length;
export const maxLengthMessage = (max: number, value: string) =>
  `Ensure this value has at most ${max} characters (it has ${length(value)}).`;
const choiceMessage = (value: string) =>
  `Select a valid choice. ${value} is not one of the available choices.`;

/** Collects errors per field in Django order (form clean, then model clean, then unique). */
export class FormErrors {
  readonly fields: FieldErrors = {};
  add(field: string, message: string) {
    (this.fields[field] ??= []).push(message);
  }
  has(field?: string) {
    return field ? Boolean(this.fields[field]?.length) : Object.keys(this.fields).length > 0;
  }
  throwIfAny() {
    if (this.has()) throw new FormInvalid(this.fields);
  }
}

/** `forms.CharField` (strip=True, empty_value='') with an optional model `max_length`. */
export function cleanText(
  errors: FormErrors,
  field: string,
  raw: string | undefined,
  options: { required?: boolean; max?: number } = {},
): string {
  const value = (raw ?? '').trim();
  if (!value) {
    if (options.required) errors.add(field, requiredMessage);
    return '';
  }
  if (options.max !== undefined && length(value) > options.max)
    errors.add(field, maxLengthMessage(options.max, value));
  return value;
}

/** `request.POST.get(name)` stored as posted, bounded by the column size. */
function unstripped(errors: FormErrors, field: string, raw: string | undefined, max: number) {
  const value = raw ?? '';
  if (length(value) > max) errors.add(field, maxLengthMessage(max, value));
  return value;
}

/** `forms.ChoiceField`. */
export function cleanChoice<T extends string>(
  errors: FormErrors,
  field: string,
  raw: string | undefined,
  choices: readonly T[],
): T | null {
  const value = raw ?? '';
  if (!value) {
    errors.add(field, requiredMessage);
    return null;
  }
  const match = choices.find((choice) => choice === value);
  if (!match) errors.add(field, choiceMessage(value));
  return match ?? null;
}

const int32 = { min: -2_147_483_648, max: 2_147_483_647 };
/**
 * `forms.IntegerField.to_python` (`int(re.sub(r'\.0*\s*$', '', value))`) plus the model
 * `IntegerField` range validators of the MySQL backend.
 */
export function cleanInteger(
  errors: FormErrors,
  field: string,
  raw: string | undefined,
  options: {
    required?: boolean;
    validators?: { min: number; max: number; message: string };
    /** Model `IntegerField` range; off for `phone` (a model CharField). */
    modelRange?: boolean;
  } = {},
): number | null {
  const value = (raw ?? '').trim();
  if (!value) {
    if (options.required) errors.add(field, requiredMessage);
    return null;
  }
  const digits = value.replace(/\.0*\s*$/, '');
  if (!/^[+-]?\d+(?:_\d+)*$/.test(digits)) {
    errors.add(field, 'Enter a whole number.');
    return null;
  }
  const parsed = BigInt(digits.replaceAll('_', ''));
  const rule = options.validators;
  if (rule && (parsed < BigInt(rule.min) || parsed > BigInt(rule.max))) {
    errors.add(field, rule.message);
    return null;
  }
  if (options.modelRange === false) return Number(parsed);
  if (parsed > BigInt(int32.max)) {
    errors.add(field, `Ensure this value is less than or equal to ${int32.max}.`);
    return null;
  }
  if (parsed < BigInt(int32.min)) {
    errors.add(field, `Ensure this value is greater than or equal to ${int32.min}.`);
    return null;
  }
  return Number(parsed);
}

/**
 * Model `DecimalField(max_digits=22, decimal_places=16)` validation of a required form
 * `CharField`, and the stored text: Django 4.2 `adapt_decimalfield_value` quantizes to the field's
 * decimal places before writing the varchar column.
 */
export function cleanCoordinate(
  errors: FormErrors,
  field: string,
  raw: string | undefined,
): string {
  const value = (raw ?? '').trim();
  if (!value) {
    errors.add(field, requiredMessage);
    return '';
  }
  if (/^[+-]?(?:inf|infinity|s?nan\d*)$/i.test(value)) {
    errors.add(field, 'Enter a number.');
    return '';
  }
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match || !(match[2] || match[3])) {
    errors.add(field, `“${value}” value must be a decimal number.`);
    return '';
  }
  const sign = match[1] === '-' ? '-' : '',
    fraction = match[3] ?? '',
    exponent = Number(match[4] ?? 0) - fraction.length,
    coefficient = ((match[2] ?? '') + fraction).replace(/^0+(?=\d)/, '') || '0';
  // DecimalValidator (django/core/validators.py) over Decimal.as_tuple().
  let digits: number, decimals: number;
  if (exponent >= 0) {
    digits = coefficient.length + (coefficient !== '0' ? exponent : 0);
    decimals = 0;
  } else if (-exponent > coefficient.length) {
    digits = decimals = -exponent;
  } else {
    digits = coefficient.length;
    decimals = -exponent;
  }
  const before = errors.has(field);
  if (digits > 22) errors.add(field, 'Ensure that there are no more than 22 digits in total.');
  if (decimals > 16) errors.add(field, 'Ensure that there are no more than 16 decimal places.');
  if (digits - decimals > 6)
    errors.add(field, 'Ensure that there are no more than 6 digits before the decimal point.');
  if (errors.has(field) && !before) return '';
  let whole: string, part: string;
  if (exponent >= 0) {
    whole = coefficient === '0' ? '0' : coefficient + '0'.repeat(exponent);
    part = '';
  } else {
    const padded = coefficient.padStart(-exponent + 1, '0');
    whole = padded.slice(0, exponent);
    part = padded.slice(exponent);
  }
  return `${sign}${whole.replace(/^0+(?=\d)/, '')}.${part.padEnd(16, '0')}`;
}

export const storeTypes = ['STORE', 'WAREHOUSE', 'CORE_WAREHOUSE', 'BUBBLE_STORE'] as const;
export const storeCategories = ['IN_HOUSE', 'FRANCHISE'] as const;
const gstin = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const phoneRule = { min: 1_111_111_111, max: 9_999_999_999, message: 'Please enter valid number' };

export interface CleanStoreForm {
  category: (typeof storeCategories)[number];
  storeName: string;
  shortName: string;
  locationCode: string;
  type: (typeof storeTypes)[number];
  email: string;
  phone: string | null;
  latitude: string;
  longitude: string;
  pincode: string;
  cityName: string;
  cityId: number;
  stateName: string;
  stateId: number | null;
  countryId: number;
  address: string;
  alternateAddress: string;
  gstin: string;
  slackGroupUrl: string;
  perDayThreshold: number | null;
  perHourThreshold: number | null;
  franchise: { name: string; description: string; cin: string };
}

/**
 * Field cleaning of `StoreCreateForm` and model `clean_fields`. Uniqueness and the custom
 * `is_valid` checks (`forms.py:86-104`) need the database and run in the service.
 */
export function cleanStoreForm(
  input: StoreFormInput,
  locationChoices: readonly string[],
  errors = new FormErrors(),
): { form: CleanStoreForm; errors: FormErrors } {
  const category = cleanChoice(errors, 'category', input.category, storeCategories),
    type = cleanChoice(errors, 'type', input.type, storeTypes),
    locationCode = cleanChoice(errors, 'location_code', input.location_code, locationChoices);
  const gstinValue = (input.gstin ?? '').trim();
  if (gstinValue) {
    if (length(gstinValue) > 15) errors.add('gstin', maxLengthMessage(15, gstinValue));
    if (!gstin.test(gstinValue)) errors.add('gstin', 'Enter a valid GSTIN (e.g., 22AAAAA0000A1Z5)');
  }
  const form: CleanStoreForm = {
    category: category ?? 'IN_HOUSE',
    storeName: cleanText(errors, 'store_name', input.store_name, { required: true, max: 100 }),
    shortName: cleanText(errors, 'short_name', input.short_name, { required: true, max: 100 }),
    locationCode: locationCode ?? '',
    type: type ?? 'STORE',
    email: cleanText(errors, 'email', input.email, { max: 55 }),
    phone: (() => {
      const value = cleanInteger(errors, 'phone', input.phone, {
        validators: phoneRule,
        modelRange: false,
      });
      return value === null ? null : String(value);
    })(),
    latitude: cleanCoordinate(errors, 'latitude', input.latitude),
    longitude: cleanCoordinate(errors, 'longitude', input.longitude),
    pincode: cleanText(errors, 'pincode', input.pincode, { max: 10 }),
    cityName: cleanText(errors, 'city_name', input.city_name, { max: 255 }),
    cityId: cleanInteger(errors, 'city_id', input.city_id, { required: true }) ?? 0,
    stateName: cleanText(errors, 'state_name', input.state_name, { max: 255 }),
    stateId: cleanInteger(errors, 'state_id', input.state_id),
    countryId: cleanInteger(errors, 'country_id', input.country_id, { required: true }) ?? 0,
    address: cleanText(errors, 'address', input.address, { required: true }),
    alternateAddress: cleanText(errors, 'alt_address', input.alt_address),
    gstin: gstinValue,
    slackGroupUrl: cleanText(errors, 'slack_group_url', input.slack_group_url, { max: 1000 }),
    perDayThreshold: cleanInteger(errors, 'per_day_threshold', input.per_day_threshold),
    perHourThreshold: cleanInteger(errors, 'per_hour_threshold', input.per_hour_threshold),
    // Posted as-is by the legacy view (`stores/views.py:55-61`, `:201-220`); the
    // `pos_franchise` column sizes are enforced instead of a database error.
    franchise: {
      name: unstripped(errors, 'franchise_name', input.franchise_name, 255),
      description: unstripped(errors, 'franchise_description', input.franchise_description, 255),
      cin: unstripped(errors, 'cin_number', input.cin_number, 55),
    },
  };
  return { form, errors };
}
