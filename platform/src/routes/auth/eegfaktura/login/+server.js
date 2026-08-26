import { error, redirect } from '@sveltejs/kit';
import { beginLogin, oidcEnabled } from '$lib/server/oidc.js';
import { signCookie } from '$lib/server/secrets.js';

// Startet "Anmelden mit EEGFaktura": PKCE-Verifier, state und nonce landen
// signiert in einem Kurzzeit-Cookie (10 Minuten), dann Weiterleitung zum Keycloak.
export async function GET({ cookies, url }) {
    if (!oidcEnabled()) throw error(503, 'Anmeldung mit EEGFaktura ist auf diesem System nicht eingerichtet');
    const { url: authUrl, state, nonce, verifier } = await beginLogin();
    cookies.set('oidc_login', signCookie({ state, nonce, verifier }, 600), {
        path: '/auth/eegfaktura',
        httpOnly: true,
        sameSite: 'lax',
        secure: url.protocol === 'https:',
        maxAge: 600
    });
    throw redirect(303, authUrl);
}
