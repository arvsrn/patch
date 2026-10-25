<script lang="ts">
	import { page } from 'patch';
</script>

<main style={{ width: 'fill', height: 'fill', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#18181b' }}>
	<p style={{ fontSize: 24, fontWeight: 600 }}>404</p>
	<p style={{ color: '#71717a' }}>No page at {page.url.pathname}</p>
	<a href="/" style={{ color: '#2563eb' }}>Go to /</a>
</main>
