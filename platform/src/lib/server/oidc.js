// OIDC-Client fuer "Anmelden mit EEGFaktura": Authorization Code + PKCE gegen die
// EEG-Faktura-Keycloak (Realm EEGFaktura), oeffentlicher Client ohne Secret.
// Konfiguration aus der Server-.env: OIDC_ISSUER (z.B.
// https://auth.eegfaktura-test.stromkreis.net/realms/EEGFaktura), OIDC_CLIENT_ID
// (net.stromkreis.platform), PUBLIC_ORIGIN (Redirect-URI = <origin>/auth/eegfaktura/callback).
//
// Token-Pruefung ohne Bibliothek: RS256/ES256 gegen das JWKS des Issuers mit
// node:crypto (JWKS 10 Minuten gecacht, bei unbekannter kid einmal neu geladen).
// Die fuer uns wichtigen Claims stehen im Access-Token: tenant (Array von
// RC-Nummern, Mapper jsonType JSON) und access_groups (Gruppenpfade, /EEG_ADMIN).
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';

const JWKS_TTL_MS = 10 * 60 * 1000;
const SCOPES = 'openid profile email offline_access';

/** @type {{ issuer: string, data: any, fetchedAt: number } | null} */
let discovery = null;
/** @type {{ keys: any[], fetchedAt: number } | null} */
let jwks = null;

export function oidcConfig() {
    const issuer = env.OIDC_ISSUER;
    const clientId = env.OIDC_CLIENT_ID;
    const origin = publicEnv.PUBLIC_ORIGIN;
    if (!issuer || !clientId || !origin) return null;
    return { issuer: issuer.replace(/\/$/, ''), clientId, redirectUri: `${origin.replace(/\/$/, '')}/auth/eegfaktura/callback` };
}

export function oidcEnabled() {
    return oidcConfig() !== null;
}

async function discover() {
    const cfg = oidcConfig();
    if (!cfg) throw new Error('OIDC nicht konfiguriert (OIDC_ISSUER, OIDC_CLIENT_ID, PUBLIC_ORIGIN)');
    if (discovery && discovery.issuer === cfg.issuer && Date.now() - discovery.fetchedAt < 60 * 60 * 1000) return discovery.data;
    const res = await fetch(`${cfg.issuer}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`OIDC-Discovery fehlgeschlagen (HTTP ${res.status})`);
    const data = await res.json();
    if (data.issuer !== cfg.issuer) throw new Error(`OIDC-Issuer passt nicht: ${data.issuer}`);
    discovery = { issuer: cfg.issuer, data, fetchedAt: Date.now() };
    return data;
}

/** @param {boolean} force */
async function loadJwks(force = false) {
    if (!force && jwks && Date.now() - jwks.fetchedAt < JWKS_TTL_MS) return jwks.keys;
    const disc = await discover();
    const res = await fetch(disc.jwks_uri);
    if (!res.ok) throw new Error(`JWKS nicht ladbar (HTTP ${res.status})`);
    jwks = { keys: (await res.json()).keys || [], fetchedAt: Date.now() };
    return jwks.keys;
}

/** @param {string} s */
function b64url(s) {
    return Buffer.from(s).toString('base64url');
}

/** Startet den Login: liefert die Autorisierungs-URL und den zu speichernden Zwischenstand. */
export async function beginLogin() {
    const cfg = oidcConfig();
    if (!cfg) throw new Error('OIDC nicht konfiguriert');
    const disc = await discover();
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const url = new URL(disc.authorization_endpoint);
    url.searchParams.set('client_id', cfg.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('redirect_uri', cfg.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { url: url.toString(), state, nonce, verifier };
}

/**
 * Tauscht den Code gegen Tokens und prueft das Access-Token.
 * @param {string} code
 * @param {string} verifier
 * @param {string} nonce
 */
export async function completeLogin(code, verifier, nonce) {
    const cfg = oidcConfig();
    if (!cfg) throw new Error('OIDC nicht konfiguriert');
    const disc = await discover();
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: cfg.clientId,
        code,
        redirect_uri: cfg.redirectUri,
        code_verifier: verifier
    });
    const res = await fetch(disc.token_endpoint, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const tokens = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Token-Tausch fehlgeschlagen (HTTP ${res.status}): ${tokens.error_description || tokens.error || ''}`);
    const access = await verifyJwt(tokens.access_token, cfg);
    const id = await verifyJwt(tokens.id_token, cfg);
    if (id.nonce !== nonce) throw new Error('nonce stimmt nicht');
    if (id.azp !== cfg.clientId && !(Array.isArray(id.aud) ? id.aud.includes(cfg.clientId) : id.aud === cfg.clientId)) {
        throw new Error('ID-Token ist nicht fuer diesen Client');
    }
    return {
        accessToken: /** @type {string} */ (tokens.access_token),
        refreshToken: /** @type {string | undefined} */ (tokens.refresh_token),
        scope: /** @type {string | undefined} */ (tokens.scope),
        expiresIn: /** @type {number} */ (tokens.expires_in),
        claims: {
            sub: /** @type {string} */ (id.sub || access.sub),
            email: /** @type {string | undefined} */ (access.email || id.email),
            name: /** @type {string} */ (access.name || [access.given_name, access.family_name].filter(Boolean).join(' ') || access.preferred_username),
            username: /** @type {string} */ (access.preferred_username),
            tenants: normalizeTenants(access.tenant),
            groups: /** @type {string[]} */ (Array.isArray(access.access_groups) ? access.access_groups : [])
        }
    };
}

/** @param {unknown} raw */
function normalizeTenants(raw) {
    // Mapper jsonType JSON liefert ein Array; falls das Attribut roh als String
    // '["TE100200"]' durchkommt, hier parsen.
    let list = raw;
    if (typeof raw === 'string') {
        try { list = JSON.parse(raw); } catch { list = [raw]; }
    }
    if (!Array.isArray(list)) return [];
    return [...new Set(list.map((t) => String(t).trim().toUpperCase()).filter((t) => /^[A-Z0-9]{2,8}$/.test(t)))];
}

/**
 * Signatur, Issuer und Ablauf eines JWT pruefen. Rueckgabe: Payload.
 * @param {string} token
 * @param {{ issuer: string }} cfg
 */
export async function verifyJwt(token, cfg) {
    if (typeof token !== 'string' || token.split('.').length !== 3) throw new Error('Kein JWT');
    const [h, p, s] = token.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    let keys = await loadJwks();
    let jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) {
        keys = await loadJwks(true);
        jwk = keys.find((k) => k.kid === header.kid);
    }
    if (!jwk) throw new Error('Signaturschluessel unbekannt');
    const algos = { RS256: 'sha256', RS384: 'sha384', RS512: 'sha512', ES256: 'sha256', ES384: 'sha384' };
    const digest = algos[/** @type {keyof typeof algos} */ (header.alg)];
    if (!digest) throw new Error(`Algorithmus ${header.alg} nicht unterstuetzt`);
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const ok = cryptoVerify(digest, Buffer.from(`${h}.${p}`), header.alg.startsWith('ES') ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(s, 'base64url'));
    if (!ok) throw new Error('Signatur ungueltig');
    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== cfg.issuer) throw new Error('Issuer passt nicht');
    if (typeof payload.exp === 'number' && payload.exp + 5 < now) throw new Error('Token abgelaufen');
    if (typeof payload.nbf === 'number' && payload.nbf - 5 > now) throw new Error('Token noch nicht gueltig');
    return payload;
}

/**
 * Logout-URL des Keycloak (RP-initiated), damit die SSO-Sitzung dort auch endet.
 * @param {string} postLogoutRedirect
 */
export async function endSessionUrl(postLogoutRedirect) {
    const cfg = oidcConfig();
    if (!cfg) return null;
    try {
        const disc = await discover();
        if (!disc.end_session_endpoint) return null;
        const url = new URL(disc.end_session_endpoint);
        url.searchParams.set('client_id', cfg.clientId);
        url.searchParams.set('post_logout_redirect_uri', postLogoutRedirect);
        return url.toString();
    } catch {
        return null;
    }
}

export { b64url };
