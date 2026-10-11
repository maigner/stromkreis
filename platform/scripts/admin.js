#!/usr/bin/env node
// Provider-CLI: Mandanten und Betreiber anlegen, Einmal-Login-Links erzeugen.
// Läuft gegen DATABASE_URL, am Server z.B.:
//   docker compose exec platform node scripts/admin.js tenant:list
import postgres from 'postgres';
import { createHash, randomBytes } from 'node:crypto';
import { encrypt, readSecret } from './secrets.js';

const INVITE_DAYS = 7;

const usage = `Verwendung: node scripts/admin.js <befehl> [argumente]

  tenant:list
  tenant:create <slug> <name> <breite> <laenge>
  operator:create <tenant-slug> <name> <email>   legt Betreiber an und druckt Login-Link
  invite <tenant-slug> <email>                   neuer Login-Link fuer bestehendes Mitglied
  secrets:encrypt                                Klartext-Geheimnisse der Anlagen verschluesseln (idempotent, deploy.sh)
  site:password <anlagen-id>                     Linux-Passwort einer Anlage (fuer deploy/pi-ssh.sh, wg-ssh.sh)
`;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL ist nicht gesetzt.');
	process.exit(1);
}
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });
const origin = process.env.PUBLIC_ORIGIN ?? 'http://localhost:4000';

async function requireTenant(slug) {
	const [tenant] = await sql`select id, slug, name from tenant where slug = ${slug}`;
	if (!tenant) {
		console.error(`Mandant '${slug}' nicht gefunden.`);
		process.exit(1);
	}
	return tenant;
}

async function loginLink(tenantId, memberId) {
	const token = randomBytes(32).toString('base64url');
	const hash = createHash('sha256').update(token).digest('hex');
	await sql`
		insert into login_token (tenant_id, member_id, token_hash, expires_at)
		values (${tenantId}, ${memberId}, ${hash}, now() + ${`${INVITE_DAYS} days`}::interval)
	`;
	return `${origin}/anmelden/${token}`;
}

const [cmd, ...args] = process.argv.slice(2);
try {
	switch (cmd) {
		case 'tenant:list': {
			const tenants = await sql`
				select t.slug, t.name, count(m.id) as members
				from tenant t
				left join member m on m.tenant_id = t.id
				group by t.id
				order by t.slug
			`;
			for (const t of tenants) console.log(`${t.slug}\t${t.name}\t${t.members} Mitglieder`);
			break;
		}
		case 'tenant:create': {
			const [slug, name, lat, lon] = args;
			if (!slug || !name || !lat || !lon) throw new Error(usage);
			const [tenant] = await sql`
				insert into tenant (slug, name, latitude, longitude)
				values (${slug}, ${name}, ${Number(lat)}, ${Number(lon)})
				returning slug, name
			`;
			console.log(`Mandant angelegt: ${tenant.slug} (${tenant.name})`);
			break;
		}
		case 'operator:create': {
			const [slug, name, email] = args;
			if (!slug || !name || !email) throw new Error(usage);
			const tenant = await requireTenant(slug);
			const [operator] = await sql`
				insert into member (tenant_id, name, email, role)
				values (${tenant.id}, ${name}, ${email}, 'operator')
				returning id, name, email
			`;
			console.log(`Betreiber angelegt: ${operator.name} <${operator.email}> bei ${tenant.name}`);
			console.log(`Login-Link (einmalig, ${INVITE_DAYS} Tage gueltig):`);
			console.log(await loginLink(tenant.id, operator.id));
			break;
		}
		case 'invite': {
			const [slug, email] = args;
			if (!slug || !email) throw new Error(usage);
			const tenant = await requireTenant(slug);
			const [member] = await sql`
				select id, name from member where tenant_id = ${tenant.id} and email = ${email}
			`;
			if (!member) {
				console.error(`Kein Mitglied mit E-Mail '${email}' bei '${slug}'.`);
				process.exit(1);
			}
			console.log(`Login-Link fuer ${member.name} (einmalig, ${INVITE_DAYS} Tage gueltig):`);
			console.log(await loginLink(tenant.id, member.id));
			break;
		}
		// Nach der Migration battery_site_gateway_secrets liegen Linux- und
		// WLAN-Passwort zunaechst im Klartext in ihren Spalten (dbmate kennt
		// TOKEN_SECRET nicht); hier verschluesseln. Laeuft bei jedem Deploy,
		// tut nichts, wenn alles schon enc1: traegt.
		case 'secrets:encrypt': {
			const rows = await sql`
				select id, tenant_id, linux_secret, wifi_secret, inverter_secret from battery_site
				where (linux_secret is not null and linux_secret not like 'enc1:%')
					or (wifi_secret is not null and wifi_secret not like 'enc1:%')
					or (inverter_secret is not null and inverter_secret not like 'enc1:%')
			`;
			for (const r of rows) {
				const enc = (/** @type {string | null} */ v) => (v && !v.startsWith('enc1:') ? encrypt(v) : v);
				await sql`
					update battery_site set linux_secret = ${enc(r.linux_secret)}, wifi_secret = ${enc(r.wifi_secret)},
						inverter_secret = ${enc(r.inverter_secret)}
					where tenant_id = ${r.tenant_id} and id = ${r.id}
				`;
			}
			console.log(`secrets:encrypt: ${rows.length} Anlage(n) verschluesselt.`);
			break;
		}
		case 'site:password': {
			const id = Number(args[0]);
			if (!Number.isInteger(id)) throw new Error(usage);
			const [site] = await sql`select linux_secret from battery_site where id = ${id}`;
			if (!site) {
				console.error(`Anlage ${id} nicht gefunden.`);
				process.exit(1);
			}
			const pw = readSecret(site.linux_secret);
			if (!pw) {
				console.error(`Anlage ${id} hat kein Linux-Passwort.`);
				process.exit(1);
			}
			console.log(pw);
			break;
		}
		default:
			console.error(usage);
			process.exit(cmd ? 1 : 0);
	}
} finally {
	await sql.end();
}
