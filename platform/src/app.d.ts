/// <reference types="vite/client" />
// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		interface User {
			member_id: number;
			tenant_id: number;
			name: string;
			email: string | null;
			role: 'member' | 'board' | 'operator';
			tenant_name: string;
			tenant_slug: string;
		}
		// interface Error {}
		interface Locals {
			user: User | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
