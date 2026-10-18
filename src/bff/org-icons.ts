// An organisation's own app icons (arcanum-backend org-icons.ts, console →
// Instellingen → Weergave → App-iconen), served at
//   /icons/org/<org>/<slot>-<96|180|192|512>.png   the org's — else the default (public/icons/)
//   /icons/org/<org>/<slot>.webmanifest?name=      a manifest with those icons
// Public, like /icons/*: they're on people's home screens. The console is
// sent with the icon of the organisation its cookie names (CONSOLE_ORG_COOKIE,
// set by the console when you switch organisation). A page that
// knows its organisation links these instead of the default set; a pairing
// link carries `icon=<org>/<slot>` so the page is sent with them (Safari's
// Add to Dock reads what was sent).
import type { Env } from '../types';

// slot → the default icon set (arcanum-frontends' public/icons/).
const DEFAULT_ICON: Record<string, string> = {
  kassa: 'kassa',
  display: 'display',
  station: 'station',
  pickup: 'station',
  entrance: 'station',
  tap: 'tap',
  waiter: 'waiter',
  selforder: 'selforder',
  console: 'admin',
};
const DEFAULT_NAME: Record<string, string> = {
  kassa: 'Kassa',
  display: 'Klantscherm',
  station: 'Station',
  pickup: 'Afhalen',
  entrance: 'Tafels',
  tap: 'Tap to Pay',
  waiter: 'Bediening',
  selforder: 'Bestellen',
  console: 'Console',
};
const STATION_SLOT = /^station-[A-Za-z0-9_-]{1,64}$/;
// The organisation the console was last working in (set by the console; only its id).
export const CONSOLE_ORG_COOKIE = 'arcanum-console-org';
const ORG_ID = /^[A-Za-z0-9_-]{1,80}$/;

export interface IconRef {
  org: string;
  slot: string;
}

// `<org>/<slot>` (a pairing link's `icon`), or null.
export function iconRef(value: string | null): IconRef | null {
  const [org, slot, more] = (value ?? '').split('/');
  if (more !== undefined || !org || !slot || !ORG_ID.test(org) || !(slot in DEFAULT_ICON || STATION_SLOT.test(slot))) return null;
  return { org, slot };
}

const defaultIcon = (slot: string) => DEFAULT_ICON[slot] ?? 'station';

export const orgIconUrl = (ref: IconRef, size: number) => `/icons/org/${ref.org}/${ref.slot}-${size}.png`;
export const orgManifestUrl = (ref: IconRef, name: string) => `/icons/org/${ref.org}/${ref.slot}.webmanifest?${new URLSearchParams({ name })}`;

// /icons/org/… → the PNG or the manifest; null for any other path.
export async function orgIconRoute(path: string, params: URLSearchParams, env: Env, defaultFile: (path: string) => Promise<Response>): Promise<Response | null> {
  const manifest = path.match(/^\/icons\/org\/([^/]+)\/([^/]+)\.webmanifest$/);
  if (manifest) {
    const ref = iconRef(`${manifest[1]}/${manifest[2]}`);
    return ref ? orgManifest(ref, params.get('name')) : new Response(null, { status: 404 });
  }
  const png = path.match(/^\/icons\/org\/([^/]+)\/(.+)-(96|180|192|512)\.png$/);
  if (!png) return null;
  const ref = iconRef(`${png[1]}/${png[2]}`);
  if (!ref) return new Response(null, { status: 404 });
  const own = await backendIcon(env, ref, png[3]).catch(() => null);
  if (own?.ok) {
    const out = new Response(own.body, own);
    out.headers.set('Cache-Control', 'public, max-age=300');
    return out;
  }
  // None of its own: the default — not cached for long either, the org may set one.
  const fallback = await defaultFile(`/icons/${defaultIcon(ref.slot)}-${png[3]}.png`);
  const out = new Response(fallback.body, fallback);
  out.headers.set('Cache-Control', 'public, max-age=300');
  return out;
}

async function backendIcon(env: Env, ref: IconRef, size: string): Promise<Response> {
  const target = `/public/icons/${encodeURIComponent(ref.org)}/${encodeURIComponent(ref.slot)}/${size}`;
  const isDev = env.FRONTEND_URL?.includes('localhost') || env.FRONTEND_URL?.includes('127.0.0.1');
  if (isDev && env.BANCONTACT_LOCAL_URL) return fetch(`${env.BANCONTACT_LOCAL_URL}${target}`);
  return env.ARCANUM_BACKEND_SERVICE.fetch(new Request(`https://backend${target}`));
}

// A page of the org installed as an app: its name and the org's icons. No
// start_url — the page it was added from; the scope the whole site. Only
// purpose 'any': an uploaded icon may not leave the margin a maskable one needs.
export function orgManifest(ref: IconRef, name: string | null): Response {
  const shown = (name ?? '').trim().slice(0, 60) || DEFAULT_NAME[ref.slot] || 'Station';
  return new Response(
    JSON.stringify({
      name: shown,
      short_name: shown,
      scope: '/',
      display: 'standalone',
      background_color: '#ffffff',
      icons: [192, 512].map((size) => ({ src: orgIconUrl(ref, size), sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' })),
    }),
    { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' } }
  );
}
