export function load({ url }) {
    return { grund: url.searchParams.get('grund') || 'Anmeldung fehlgeschlagen' };
}
