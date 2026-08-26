import { fail, redirect } from '@sveltejs/kit';
import { createSession, deleteSession } from '$lib/server/auth.js';
import { operatorTenants } from '$lib/server/eegfaktura-login.js';
import { sql } from '$lib/server/db.js';

// "EEG wechseln": alle Mandanten, in denen dieselbe Identitaet (Keycloak-sub oder
// E-Mail) Betreiber ist. Der Wechsel tauscht die Session gegen eine neue im
// gewaehlten Mandanten.

/** @param {App.User} user */
async function identity(user) {
    const [row] = await sql`select oidc_sub, email from member where tenant_id = ${user.tenant_id} and id = ${user.member_id}`;
    return { sub: /** @type {string} */ (row?.oidc_sub || ''), email: /** @type {string | null} */ (row?.email ?? null) };
}

export async function load({ locals }) {
    if (!locals.user) throw redirect(303, '/');
    const id = await identity(locals.user);
    const tenants = await operatorTenants(id.sub, id.email);
    return {
        current: locals.user.tenant_id,
        tenants: tenants.map((t) => ({ id: Number(t.tenant_id), name: t.tenant_name, slug: t.tenant_slug }))
    };
}

export const actions = {
    default: async ({ locals, request, cookies, url }) => {
        if (!locals.user) throw redirect(303, '/');
        const id = await identity(locals.user);
        const tenants = await operatorTenants(id.sub, id.email);
        const form = await request.formData();
        const chosen = tenants.find((t) => Number(t.tenant_id) === Number(form.get('tenant_id')));
        if (!chosen) return fail(400, { error: 'Ungueltige Auswahl' });
        const old = cookies.get('session');
        if (old) await deleteSession(old);
        const token = await createSession(Number(chosen.tenant_id), Number(chosen.member_id));
        cookies.set('session', token, { path: '/', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', maxAge: 60 * 60 * 24 * 30 });
        throw redirect(303, '/intern');
    }
};
