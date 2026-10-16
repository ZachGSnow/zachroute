// User-Agent sent with every upstream API request (aviationweather.gov, FAA, Wikipedia
// ask callers to identify themselves). Built from package.json so a fork only has to change
// "name"/"homepage" there.
import pkg from '../package.json';

export const USER_AGENT = `ZachRoute/${pkg.version} (${pkg.homepage})`;
