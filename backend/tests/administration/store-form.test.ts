import { describe, expect, it } from 'vitest';
import {
  cleanCoordinate,
  cleanInteger,
  cleanStoreForm,
  FormErrors,
  storeFormInput,
} from '../../src/modules/administration/store-form.js';

const valid = {
  category: 'IN_HOUSE',
  store_name: ' Fixture Store ',
  short_name: 'Fixture',
  location_code: 'MUM',
  type: 'STORE',
  email: '',
  phone: '9876543210',
  latitude: '19.076',
  longitude: '72.8777',
  pincode: '400001',
  city_name: 'Mumbai',
  city_id: '1111',
  state_name: 'Maharashtra',
  state_id: '',
  country_id: '99',
  address: 'Fixture address',
  alt_address: '',
  gstin: '',
  slack_group_url: '',
  per_day_threshold: '',
  per_hour_threshold: '-3',
  franchise_name: '',
  franchise_description: '',
  cin_number: '',
};

describe('legacy StoreCreateForm cleaning (stores/forms.py:28-110)', () => {
  it('cleans a valid form as Django stores it', () => {
    const { form, errors } = cleanStoreForm(storeFormInput.parse(valid), ['MUM']);
    expect(errors.fields).toEqual({});
    expect(form).toMatchObject({
      storeName: 'Fixture Store',
      email: '',
      phone: '9876543210',
      latitude: '19.0760000000000000',
      longitude: '72.8777000000000000',
      stateId: null,
      perDayThreshold: null,
      perHourThreshold: -3,
      slackGroupUrl: '',
      cityId: 1111,
      countryId: 99,
    });
  });
  it('returns the legacy per-field messages', () => {
    const { errors } = cleanStoreForm(
      storeFormInput.parse({
        ...valid,
        category: 'OTHER',
        store_name: 'x'.repeat(101),
        location_code: 'ZZZ',
        type: '',
        phone: '12345',
        latitude: '',
        longitude: 'east',
        city_id: '',
        country_id: '',
        address: ' ',
        gstin: '22AAAAA0000A1Z',
        email: 'e'.repeat(56),
        slack_group_url: 's'.repeat(1001),
      }),
      ['MUM'],
    );
    expect(errors.fields).toEqual({
      category: ['Select a valid choice. OTHER is not one of the available choices.'],
      store_name: ['Ensure this value has at most 100 characters (it has 101).'],
      location_code: ['Select a valid choice. ZZZ is not one of the available choices.'],
      type: ['This field is required.'],
      phone: ['Please enter valid number'],
      latitude: ['This field is required.'],
      longitude: ['“east” value must be a decimal number.'],
      city_id: ['This field is required.'],
      country_id: ['This field is required.'],
      address: ['This field is required.'],
      gstin: ['Enter a valid GSTIN (e.g., 22AAAAA0000A1Z5)'],
      email: ['Ensure this value has at most 55 characters (it has 56).'],
      slack_group_url: ['Ensure this value has at most 1000 characters (it has 1001).'],
    });
  });
  it('applies DecimalValidator(22, 16) and quantizes the stored coordinate', () => {
    const errors = new FormErrors();
    expect(cleanCoordinate(errors, 'a', '-0.5')).toBe('-0.5000000000000000');
    expect(cleanCoordinate(errors, 'b', '1e2')).toBe('100.0000000000000000');
    expect(cleanCoordinate(errors, 'c', '.25')).toBe('0.2500000000000000');
    expect(cleanCoordinate(errors, 'd', '1234567.1')).toBe('');
    expect(cleanCoordinate(errors, 'e', '1.12345678901234567')).toBe('');
    expect(cleanCoordinate(errors, 'f', 'NaN')).toBe('');
    expect(errors.fields).toEqual({
      d: ['Ensure that there are no more than 6 digits before the decimal point.'],
      e: ['Ensure that there are no more than 16 decimal places.'],
      f: ['Enter a number.'],
    });
  });
  it('parses integers as forms.IntegerField does', () => {
    const errors = new FormErrors();
    expect(cleanInteger(errors, 'a', ' 42.00 ')).toBe(42);
    expect(cleanInteger(errors, 'b', '4.2')).toBeNull();
    expect(cleanInteger(errors, 'c', '99999999999')).toBeNull();
    expect(errors.fields).toEqual({
      b: ['Enter a whole number.'],
      c: ['Ensure this value is less than or equal to 2147483647.'],
    });
  });
});
