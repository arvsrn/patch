<script lang="ts">
	import { workspace } from '../workspace.ts';

	const open = workspace.issues.filter((i) => i.status !== 'done').length;
</script>

<main style={{ width: 'fill', height: 'fill', alignItems: 'center', justifyContent: 'center', gap: 10, color: '#1b1b1f', fontSize: 13 }}>
	<p style={{ fontSize: 22, fontWeight: 600 }}>Northwind</p>
	<a href="/issues" style={{ padding: [6, 12], borderRadius: 7, background: '#5e6ad2', color: '#ffffff', fontWeight: 500 }}>
		Engineering board · {open} open
	</a>
</main>
