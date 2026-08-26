import { fail, redirect } from '@sveltejs/kit';
import { createSession } from '$lib/server/auth.js';
import { verifyCookie } from '$lib/server/secrets.js';

// Auswahl der Energiegemeinschaft nach dem OIDC-Login, wenn das EEGFaktura-Konto
// mehrere EEGs verwaltet. Der Zwischenstand liegt signiert im Cookie eeg_auswahl.

/** @param {import('@sveltejs/kit').Cookies} cookies */
function pending(cookies) {
    const p = verifyCookie(cookies.get('eeg_auswahl'));
    if (!p || !Array.isArray(p.tenants) || p.tenants.length === 0) throw redirect(303, '/');
    return /** @type {{ sub: string, tenants: { tenant_id: number, member_id: number, tenant_name: string }[] }} */ (p);
}

export async function load({ cookies }) {
    const p = pending(cookies);
    return { tenants: p.tenants.map((t) => ({ id: t.tenant_id, name: t.tenant_name })) };
}

export const actions = {
    default: async ({ cookies, request, url }) => {
        const p = pending(cookies);
        const form = await request.formData();
        const tenantId = Number(form.get('tenant_id'));
        const chosen = p.tenants.find((t) => t.tenant_id === tenantId);
        if (!chosen) return fail(400, { error: 'Ungueltige Auswahl' });
        const token = await createSession(chosen.tenant_id, chosen.member_id);
        cookies.delete('eeg_auswahl', { path: '/anmelden' });
        cookies.set('session', token, { path: '/', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', maxAge: 60 * 60 * 24 * 30 });
        throw redirect(303, '/intern');
    }
};
