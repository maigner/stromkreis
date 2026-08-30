// ============================================================================
// Cloud-Konten der Stromkreis-Anlagen anlegen, Passwort setzen, loeschen.
//
// Laeuft IM openHAB-Cloud-Image (Dienst cloud-sync im Compose-Stack, alle
// 60 s eine Runde) und benutzt die kompilierten Modelle des Images
// (/opt/openhabcloud/dist) samt dessen config.json - also genau das, was
// die laufende Cloud selbst nutzt. Portiert aus dem ISCHLSTROM-Repo
// (scripts/ibm-provision/cloud-makeuser.js); statt psql auf dem Host holt
// sich das Skript die offenen Konten von der Plattform:
//
//   GET  <PLATFORM_URL>/api/gateway/sync/cloud-accounts   (Bearer GATEWAY_SYNC_TOKEN)
//   POST <PLATFORM_URL>/api/gateway/sync/cloud-result     {id, ok, mode, action|error}
//
// Idempotent: existiert der Benutzer, wird nur das Passwort gesetzt und die
// Anlage (UUID/Secret) am Konto abgeglichen. verifiedEmail wird auf true
// gesetzt (die Adressen sind keine echten Postfaecher).
// ============================================================================
'use strict';

const PLATFORM_URL = (process.env.PLATFORM_URL || 'http://platform:3000').replace(/\/$/, '');
const TOKEN = process.env.GATEWAY_SYNC_TOKEN || '';

function log(msg) {
	console.log(`[cloud-sync] ${new Date().toISOString().slice(0, 19)} ${msg}`);
}

async function api(path, options = {}) {
	const res = await fetch(`${PLATFORM_URL}${path}`, {
		...options,
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			'Content-Type': 'application/json',
			...(options.headers || {})
		}
	});
	if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
	return res.json();
}

async function upsert(models, account) {
	const { User, Openhab } = models;
	const username = account.username.trim().toLowerCase();
	if (!account.password || account.password.length < 8) throw new Error('Passwort leer oder zu kurz');
	if (!account.secret) throw new Error('Secret leer');

	let user = await User.findOne({ username }).exec();
	let action;
	if (user) {
		user.password = account.password; // Virtual: erzeugt salt/hash
		user.verifiedEmail = true;
		user.active = true;
		await user.save();
		action = 'password_set';
	} else {
		user = await User.register(username, account.password);
		user.verifiedEmail = true;
		await user.save();
		action = 'created';
	}

	// Anlage am Konto: genau eine openHAB-Instanz je Konto (Cloud-Modell).
	const byUuid = await Openhab.findOne({ uuid: account.uuid }).exec();
	if (byUuid && String(byUuid.account) !== String(user.account)) {
		throw new Error(`UUID ${account.uuid} gehoert bereits zu einem anderen Konto`);
	}
	let openhab = await Openhab.findOne({ account: user.account }).exec();
	if (openhab) {
		if (openhab.uuid !== account.uuid || openhab.secret !== account.secret) {
			openhab.uuid = account.uuid;
			openhab.secret = account.secret;
			await openhab.save();
			action += '+openhab_updated';
		}
	} else {
		openhab = new Openhab({ account: user.account, uuid: account.uuid, secret: account.secret });
		await openhab.save();
		action += '+openhab_created';
	}
	return action;
}

async function remove(models, account) {
	const { User, UserAccount, Openhab } = models;
	const username = account.username.trim().toLowerCase();
	const user = await User.findOne({ username }).exec();
	if (!user) return 'not_found';
	const others = await User.countDocuments({ account: user.account, _id: { $ne: user._id } }).exec();
	await Openhab.deleteMany({ account: user.account }).exec();
	await User.deleteOne({ _id: user._id }).exec();
	if (others === 0 && UserAccount) await UserAccount.deleteOne({ _id: user.account }).exec();
	return 'deleted';
}

async function main() {
	if (!TOKEN) {
		log('FEHLER: GATEWAY_SYNC_TOKEN fehlt.');
		process.exit(1);
	}
	const { accounts } = await api('/api/gateway/sync/cloud-accounts');
	if (!Array.isArray(accounts) || accounts.length === 0) return;

	const dbConnect = require('/opt/openhabcloud/dist/cli/db-connect');
	const models = require('/opt/openhabcloud/dist/models');
	await dbConnect.connectToDatabase();
	try {
		for (const account of accounts) {
			const mode = account.mode === 'delete' ? 'delete' : 'upsert';
			try {
				const action = mode === 'delete' ? await remove(models, account) : await upsert(models, account);
				await api('/api/gateway/sync/cloud-result', {
					method: 'POST',
					body: JSON.stringify({ id: account.id, ok: true, mode, action })
				});
				log(`Konto ${account.username}: ${action}`);
			} catch (e) {
				const error = e && e.message ? e.message : String(e);
				await api('/api/gateway/sync/cloud-result', {
					method: 'POST',
					body: JSON.stringify({ id: account.id, ok: false, mode, error })
				}).catch(() => {});
				log(`Konto ${account.username} FEHLER: ${error}`);
			}
		}
	} finally {
		await dbConnect.disconnectFromDatabase().catch(() => {});
	}
}

// Explizit beenden: die Cloud-Module (models/db-connect) halten auch nach
// dem Mongo-Disconnect Handles offen (z. B. Redis), node wuerde also nie von
// selbst enden - und die Minutenschleife in cloud-sync.sh haengt dann fest
// (so geschehen 28.-30.8.: ein Passwort-Reset blieb 2 Tage liegen).
main().then(
	() => process.exit(0),
	(e) => {
		log(`FEHLER: ${e && e.message ? e.message : e}`);
		process.exit(1);
	}
);
