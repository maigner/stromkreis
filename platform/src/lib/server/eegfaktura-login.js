// Abbildung einer EEG-Faktura-Identitaet auf Stromkreis-Mandanten.
//
// Beim OIDC-Login traegt das Access-Token die RC-Nummern des Benutzers (Claim
// tenant). Je RC-Nummer wird ein Mandant sichergestellt (Slug = RC-Nummer klein,
// Name und Gemeinschafts-ID aus GET /api/eeg der EEG-Faktura-Instanz), eine
// eegfaktura_source-Zeile (auth_mode oidc), eine member-Zeile mit Rolle operator
// fuer den Benutzer, das Refresh-Token fuer den Hintergrund-Import und ein
// Import-Auftrag, falls fuer den Mandanten noch nie importiert wurde.
//
// Standort des Mandanten: EEG-Faktura liefert nur die Adresse (PLZ, Ort,
// teils Strasse). Sie wird in tenant.address abgelegt, der Worker geokodiert
// sie (geocode.py, Nominatim); bis dahin steht der Mandant als Platzhalter
// auf der Mitte Oesterreichs. Keine Ortstabelle und keine Vorgabe "Bad Ischl"
// mehr (Befund S7 der Sicherheitspruefung 9/2026).
import { env } from '$env/dynamic/private';
import { sql } from './db.js';
import { encrypt } from './secrets.js';

/** Platzhalter bis zur Geokodierung: geographische Mitte Oesterreichs (lat, lon). */
export const AUSTRIA_CENTER = /** @type {[number, number]} */ ([47.59, 14.14]);

export function eegfakturaBaseUrl() {
    return (env.EEGFAKTURA_BASE_URL || 'https://eegfaktura.at').replace(/\/$/, '');
}

/**
 * EEG-Stammsatz aus EEG-Faktura (GET /api/eeg, Header tenant).
 * @param {string} rc
 * @param {string} accessToken
 */
export async function fetchEeg(rc, accessToken) {
    const res = await fetch(`${eegfakturaBaseUrl()}/api/eeg`, {
        headers: { Authorization: `Bearer ${accessToken}`, tenant: rc, 'X-Tenant': rc }
    });
    if (!res.ok) throw new Error(`GET /api/eeg fuer ${rc}: HTTP ${res.status}`);
    const eeg = await res.json();
    return {
        name: /** @type {string} */ (eeg?.name || `EEG ${rc}`),
        communityId: /** @type {string | null} */ (eeg?.communityId ? String(eeg.communityId).toUpperCase() : null),
        rcNumber: /** @type {string} */ (String(eeg?.rcNumber || rc).toUpperCase()),
        city: /** @type {string | null} */ (eeg?.city || eeg?.contact?.city || eeg?.address?.city || null),
        zip: /** @type {string | null} */ (eeg?.zip || eeg?.contact?.zip || eeg?.address?.zip || null),
        street: /** @type {string | null} */ (eeg?.street || eeg?.contact?.street || eeg?.address?.street || null)
    };
}

/**
 * Adresse fuer die Geokodierung ("Strasse 1, 4820 Bad Ischl" bzw. "4820 Bad
 * Ischl"); null, wenn EEG-Faktura weder PLZ noch Ort liefert.
 * @param {{ city: string | null, zip: string | null, street?: string | null } | null} eeg
 */
export function tenantAddress(eeg) {
    const place = [eeg?.zip, eeg?.city].filter(Boolean).join(' ').trim();
    if (!place) return null;
    const street = (eeg?.street ?? '').trim();
    return street ? `${street}, ${place}` : place;
}

/**
 * Mandant, Quelle, Betreiber-Mitglied, Refresh-Token und Import-Auftrag
 * fuer eine RC-Nummer sicherstellen. Rueckgabe: { tenant_id, member_id, tenant_name, created }.
 * @param {{ rc: string, eeg: Awaited<ReturnType<typeof fetchEeg>> | null, claims: { sub: string, email?: string, name: string, username: string }, refreshToken?: string, scope?: string, issuer: string, clientId: string }} p
 */
export async function ensureTenantForRc(p) {
    const rc = p.rc.toUpperCase();
    const slug = rc.toLowerCase();
    const email = (p.claims.email || `${p.claims.username}@eegfaktura.invalid`).toLowerCase();
    const displayName = p.claims.name || p.claims.username;
    const eeg = p.eeg;

    return sql.begin(async (tx) => {
        let created = false;
        let [tenant] = await tx`select id, name from tenant where slug = ${slug}`;
        const address = tenantAddress(eeg);
        if (!tenant) {
            const [lat, lon] = AUSTRIA_CENTER;
            [tenant] = await tx`
                insert into tenant (slug, name, latitude, longitude, address)
                values (${slug}, ${eeg?.name || `EEG ${rc}`}, ${lat}, ${lon}, ${address})
                returning id, name`;
            created = true;
        } else {
            // Name nachziehen; Adresse nur setzen, solange keine da ist (eine
            // geaenderte Adresse wuerde einen von Hand gesetzten Standort ueberschreiben)
            if (eeg?.name && eeg.name !== tenant.name) tenant.name = eeg.name;
            await tx`update tenant set name = ${tenant.name}, address = coalesce(address, ${address}) where id = ${tenant.id}`;
        }

        await tx`
            insert into eegfaktura_source (tenant_id, rc_number, community_id, base_url, auth_mode, token_url, active)
            values (${tenant.id}, ${rc}, ${eeg?.communityId ?? null}, ${eegfakturaBaseUrl()}, 'oidc', ${`${p.issuer}/protocol/openid-connect/token`}, true)
            on conflict (tenant_id) do update set
                rc_number = excluded.rc_number,
                community_id = coalesce(excluded.community_id, eegfaktura_source.community_id),
                base_url = excluded.base_url,
                auth_mode = 'oidc',
                token_url = excluded.token_url,
                active = true`;

        let [member] = await tx`
            select id, role from member where tenant_id = ${tenant.id} and (oidc_sub = ${p.claims.sub} or email = ${email})
            order by (oidc_sub = ${p.claims.sub}) desc limit 1`;
        if (!member) {
            [member] = await tx`
                insert into member (tenant_id, name, email, role, oidc_sub)
                values (${tenant.id}, ${displayName}, ${email}, 'operator', ${p.claims.sub})
                returning id, role`;
        } else {
            await tx`update member set oidc_sub = ${p.claims.sub}, role = 'operator', email = coalesce(email, ${email})
                where tenant_id = ${tenant.id} and id = ${member.id}`;
        }

        if (p.refreshToken) {
            await tx`
                insert into eegfaktura_oidc_token (tenant_id, member_id, issuer, client_id, refresh_token_enc, scope, refreshed_at, last_error)
                values (${tenant.id}, ${member.id}, ${p.issuer}, ${p.clientId}, ${encrypt(p.refreshToken)}, ${p.scope ?? null}, now(), null)
                on conflict (tenant_id) do update set
                    member_id = excluded.member_id, issuer = excluded.issuer, client_id = excluded.client_id,
                    refresh_token_enc = excluded.refresh_token_enc, scope = excluded.scope, refreshed_at = now(), last_error = null`;
        }

        // Erster Import nach dem ersten Login; spaeter nur, wenn kein Auftrag laeuft
        // und der letzte Lauf laenger als 6 Stunden zurueckliegt (Inkrement).
        const [{ open, recent }] = await tx`
            select count(*) filter (where phase in ('queued', 'masterdata', 'energy')) as open,
                   count(*) filter (where finished_at > now() - interval '6 hours') as recent
            from eegfaktura_sync_job where tenant_id = ${tenant.id}`;
        if (Number(open) === 0 && Number(recent) === 0 && p.refreshToken) {
            const [{ n }] = await tx`select count(*) as n from measurement where tenant_id = ${tenant.id}`;
            await tx`insert into eegfaktura_sync_job (tenant_id, full_import, requested_by)
                values (${tenant.id}, ${Number(n) === 0}, ${member.id})`;
        }

        return { tenant_id: Number(tenant.id), member_id: Number(member.id), tenant_name: /** @type {string} */ (tenant.name), created };
    });
}

/**
 * Mandanten, in denen eine E-Mail bzw. Identitaet als Betreiber existiert (fuer "EEG wechseln").
 * @param {string} sub
 * @param {string | null} email
 */
export async function operatorTenants(sub, email) {
    return sql`
        select t.id as tenant_id, t.name as tenant_name, t.slug as tenant_slug, m.id as member_id
        from member m join tenant t on t.id = m.tenant_id
        where m.role = 'operator' and (m.oidc_sub = ${sub} or (${email}::text is not null and m.email = ${email}))
        order by t.name`;
}
