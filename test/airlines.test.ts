// Airline names for Live track: the table built from real OpenFlights airlines.dat lines (duplicates,
// stale "inactive" flags, a code reused by a newer airline) and names worked out from callsigns.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readFixture, jsonFixture } from './helpers';
import { airlinesByIcao, CORRECTIONS } from '../shared/airlines.js';
import { flightName, splitCallsign, isRegistrationCallsign, airlineShort, type AirlineTable } from '../src/ts/airlineCallsign';
import built from '../src/data/airline-icao.json';

const sample = readFixture('openflights-airlines-sample.dat');
const table = built as unknown as AirlineTable;

describe('airline table', () => {
  it('keeps active airlines and ones with an IATA code, and applies corrections', () => {
    const t = airlinesByIcao(sample);
    expect(t.DAL).toEqual(['Delta Air Lines', 'DL']);
    expect(t.BAW).toEqual(['British Airways', 'BA']);
    expect(t.GNL).toBeUndefined(); // inactive and no IATA code
    expect(t.UPS).toEqual(CORRECTIONS.UPS); // listed as inactive "United Parcel Service"
    expect(t.VXP).toEqual(['Avelo Airlines', 'XP']); // OpenFlights still has Mali Air Express
    expect(t.ABX).toEqual(['ABX Air', 'GB']); // two inactive rows
  });

  it('is built, ASCII and covers every airline in the captured O\u2019Hare traffic', () => {
    const raw = fs.readFileSync('src/data/airline-icao.json', 'utf8');
    expect(Object.keys(table).length).toBeGreaterThan(1000);
    expect(/[^\x00-\x7f]/.test(raw)).toBe(false);
    const circle = jsonFixture('adsblol-reapi-circle-ord.json');
    const codes = [...new Set(circle.aircraft.map((a: any) => splitCallsign(a.flight)?.icao).filter(Boolean))] as string[];
    expect(codes.length).toBeGreaterThan(3);
    expect(codes.filter((c) => !table[c])).toEqual([]);
  });
});

describe('names from callsigns', () => {
  it('splits airline callsigns and spots registrations', () => {
    expect(splitCallsign('DAL1234 ')).toEqual({ icao: 'DAL', number: '1234' });
    expect(splitCallsign('BAW2PD')).toEqual({ icao: 'BAW', number: '2PD' });
    expect(splitCallsign('N170PT')).toBeNull();
    expect(isRegistrationCallsign('N170PT', 'N170PT')).toBe(true);
    expect(isRegistrationCallsign('GABCD', 'G-ABCD')).toBe(true);
    expect(isRegistrationCallsign('UAL485', 'N12345')).toBe(false);
  });

  it('names mainline airlines the way the app does and regionals by their operator', () => {
    expect(flightName('DAL1234', 'N123DN', table).label).toBe('Delta 1234');
    expect(flightName('UAL485', 'N37502', table).label).toBe('United 485');
    expect(flightName('UPS2911', 'N405UP', table).label).toBe('UPS 2911');
    expect(flightName('FDX1407', 'N123FE', table).label).toBe('FedEx 1407');
    expect(flightName('SKW5521', 'N123SY', table).airline).toBe('SkyWest Airlines');
    expect(flightName('ENY3580', 'N769KW', table).airline).toBe('Envoy Air');
    expect(flightName('EDV5011', 'N123EV', table).airline).toBe('Endeavor Air');
    expect(airlineShort(['Hyannis Air Service', '9K'])).toBe('Hyannis Air Service');
  });

  it('marks private flights and leaves unknown callsigns as reported', () => {
    expect(flightName('N170PT', 'N170PT', table)).toEqual({ label: 'Private', private: true });
    expect(table.QQX).toBeUndefined();
    expect(flightName('QQX12', 'N1', table).label).toBe('QQX12');
    expect(flightName(undefined, 'C-GABC', table).label).toBe('C-GABC');
  });
});
