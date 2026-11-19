// Where the sun stands over the flat, for the real place and the real way the house faces.
// `site` comes from the model: latitude and longitude in degrees, and `plan_north`, the
// compass bearing (degrees clockwise from true north) that plan +Y points to.
// Good to a fraction of a degree, which is finer than the month slider.
import * as THREE from 'three';

const rad = d => d * Math.PI / 180;

// month 1-12 (its 15th day is used), hour in local clock time. Returns the direction
// towards the sun in scene coordinates, its height above the horizon and its compass
// bearing, both in degrees.
export function sunPosition(month, hour, site) {
  const dayOfYear = Math.round((month - 1) * 30.44 + 15);
  const year = rad(360 / 365 * (dayOfYear - 81));
  const declination = rad(23.44) * Math.sin(year);
  // The sun runs up to a quarter of an hour ahead of or behind the clock over the year.
  const ahead = (9.87 * Math.sin(2 * year) - 7.53 * Math.cos(year) - 1.5 * Math.sin(year)) / 60;     // hours
  const summerTime = month >= 4 && month <= 10;           // on the 15th of each month
  const solarHour = hour - (summerTime ? 2 : 1) + site.longitude / 15 + ahead;
  const H = rad(15 * (solarHour - 12)), lat = rad(site.latitude);
  const elevation = Math.asin(Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(H));
  const azimuth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(lat) - Math.tan(declination) * Math.cos(lat)) + Math.PI;  // from north, clockwise
  const east = Math.sin(azimuth) * Math.cos(elevation), north = Math.cos(azimuth) * Math.cos(elevation);
  // Turned into the plan: +Y of the plan points to the bearing `plan_north`, +X a quarter turn clockwise from it.
  const turn = rad(site.plan_north);
  const x = east * Math.cos(turn) - north * Math.sin(turn), y = east * Math.sin(turn) + north * Math.cos(turn);
  return { direction: new THREE.Vector3(x, Math.sin(elevation), -y), elevation: elevation * 180 / Math.PI, bearing: (azimuth * 180 / Math.PI) % 360 };
}
