import { redirect } from '@sveltejs/kit';
import { createSession } from '$lib/server/auth.js';
import { ensureTenantForRc, fetchEeg } from '$lib/server/eegfaktura-login.js';
import { completeLogin, oidcConfig } from '$lib/server/oidc.js';
import { signCookie, verifyCookie } from '$lib/server/secrets.js';

const SESSION_COOKIE = { path: '/', httpOnly: true, sameSite: /** @type {const} */ ('lax'), maxAge: 60 * 60 * 24 * 30 };

/** @param {string} msg @returns {never} */
function fail(msg) {
    throw redirect(303, `/anmelden/fehler?grund=${encodeURIComponent(msg)}`);
}

// Rueckkehr vom Keycloak: Code gegen Tokens tauschen, Mandanten sicherstellen,
// bei genau einer EEG direkt anmelden, sonst Auswahlseite.
export async function GET({ cookies, url }) {
    const pending = verifyCookie(cookies.get('oidc_login'));
    cookies.delete('oidc_login', { path: '/auth/eegfaktura' });
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (url.searchParams.get('error')) fail(url.searchParams.get('error_description') || url.searchParams.get('error') || 'Anmeldung abgebrochen');
    if (!pending || !code || !state || state !== pending.state) fail('Anmeldevorgang abgelaufen, bitte erneut versuchen');

    const cfg = /** @type {NonNullable<ReturnType<typeof oidcConfig>>} */ (oidcConfig());
    /** @type {Awaited<ReturnType<typeof completeLogin>>} */
    let login;
    try {
        login = await completeLogin(/** @type {string} */ (code), pending.verifier, pending.nonce);
    } catch (err) {
        console.error('OIDC-Login fehlgeschlagen:', err);
        fail('Anmeldung bei EEGFaktura fehlgeschlagen');
    }
    const { claims } = login;
    if (!claims.groups.includes('/EEG_ADMIN') && !claims.groups.includes('/EEG_OWNER')) {
        fail('Dieses EEGFaktura-Konto ist kein EEG-Administrator (Gruppe EEG_ADMIN fehlt)');
    }
    if (claims.tenants.length === 0) fail('Dem EEGFaktura-Konto ist keine Energiegemeinschaft zugeordnet');

    /** @type {{ tenant_id: number, member_id: number, tenant_name: string }[]} */
    const tenants = [];
    for (const rc of claims.tenants) {
        let eeg = null;
        try {
            eeg = await fetchEeg(rc, login.accessToken);
        } catch (err) {
            console.warn(`EEG-Stammsatz ${rc} nicht ladbar:`, err);
        }
        try {
            tenants.push(await ensureTenantForRc({
                rc, eeg, claims, refreshToken: login.refreshToken, scope: login.scope, issuer: cfg.issuer, clientId: cfg.clientId
            }));
        } catch (err) {
            console.error(`Mandant ${rc} konnte nicht angelegt werden:`, err, 'claims:', JSON.stringify({ ...claims }));
            fail(`Energiegemeinschaft ${rc} konnte nicht eingerichtet werden`);
        }
    }

    if (tenants.length === 1) {
        const token = await createSession(tenants[0].tenant_id, tenants[0].member_id);
        cookies.set('session', token, { ...SESSION_COOKIE, secure: url.protocol === 'https:' });
        throw redirect(303, '/intern');
    }
    cookies.set('eeg_auswahl', signCookie({ sub: claims.sub, tenants }, 600), {
        path: '/anmelden', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', maxAge: 600
    });
    throw redirect(303, '/anmelden/eeg');
}
