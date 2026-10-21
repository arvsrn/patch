<script lang="ts">
	type Task = { id: number; title: string; done: boolean };

	let tasks: Task[] = $state([
		{ id: 1, title: 'Sketch the layout', done: true },
		{ id: 2, title: 'Wire up reactivity', done: false },
		{ id: 3, title: 'Snapshot into Figma', done: false }
	]);
	let draft = $state('');
	let filter: 'all' | 'active' | 'done' = $state('all');
	let loading = $state(false);
	let error = $state('');
	let nextId = $state(4);

	let remaining = $derived(tasks.filter((t) => !t.done).length);
	let progress = $derived(tasks.length === 0 ? 0 : (tasks.length - remaining) / tasks.length);
	let visible = $derived(
		tasks.filter((t) => (filter === 'all' ? true : filter === 'done' ? t.done : !t.done))
	);

	// Browser-only side effects. They never run in a snapshot.
	$effect(() => {
		const saved = localStorage.getItem('patch-tasks');
		if (saved) {
			const parsed = JSON.parse(saved);
			tasks = parsed.tasks;
			nextId = parsed.nextId;
		}
	});

	$effect(() => {
		localStorage.setItem('patch-tasks', JSON.stringify({ tasks, nextId }));
		document.title = remaining === 0 ? 'All done' : `${remaining} left`;
	});

	function add(title: string) {
		const trimmed = title.trim();
		if (!trimmed) return;
		tasks = [...tasks, { id: nextId, title: trimmed, done: false }];
		nextId += 1;
		draft = '';
	}

	function toggle(id: number) {
		tasks = tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
	}

	function remove(id: number) {
		tasks = tasks.filter((t) => t.id !== id);
	}

	const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	async function suggest() {
		loading = true;
		error = '';
		try {
			await wait(900);
			const ideas = ['Write the README', 'Ship v0', 'Add keyed lists', 'Celebrate'];
			add(ideas[Math.floor(Math.random() * ideas.length)]);
		} catch (e) {
			error = String(e);
		} finally {
			loading = false;
		}
	}

	const page = $style({
		width: 'fill',
		height: 'fill',
		background: '#f4f4f5',
		alignItems: 'center',
		padding: [48, 24]
	});
	const card = $style({
		width: 480,
		gap: 16,
		padding: 24,
		background: '#ffffff',
		borderRadius: 16,
		borderWidth: 1,
		borderColor: '#e4e4e7',
		shadow: { x: 0, y: 8, blur: 24, spread: -8, color: '#18181b1f' }
	});
	const row = $style({ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, width: 'fill' });
	const title = $style({ fontSize: 24, fontWeight: 700, letterSpacing: -0.5, color: '#18181b' });
	const muted = $style({ fontSize: 14, color: '#71717a' });
	const button = $style({
		flexDirection: 'row',
		alignItems: 'center',
		padding: [8, 14],
		borderRadius: 8,
		background: '#18181b',
		color: '#fafafa',
		fontSize: 14,
		fontWeight: 600
	});
	const ghost = $style({ background: '#f4f4f5', color: '#3f3f46' });
	const selected = $style({ background: '#2563eb', color: '#ffffff' });
	const disabled = $style({ opacity: 0.5 });
	const field = $style({
		width: 'fill',
		padding: [8, 12],
		borderRadius: 8,
		borderWidth: 1,
		borderColor: '#d4d4d8',
		fontSize: 14,
		lineHeight: 20,
		color: '#18181b'
	});
	const item = $style({
		flexDirection: 'row',
		alignItems: 'center',
		gap: 12,
		width: 'fill',
		padding: [10, 12],
		borderRadius: 10,
		background: '#fafafa'
	});
	const check = $style({
		width: 20,
		height: 20,
		borderRadius: 6,
		borderWidth: 2,
		borderColor: '#a1a1aa',
		alignItems: 'center',
		justifyContent: 'center'
	});
	const checked = $style({ background: '#16a34a', borderColor: '#16a34a' });
</script>

<main style={page}>
	<div style={card}>
		<div style={[row, { justifyContent: 'space-between', gap: 0 }]}>
			<p style={title}>Tasks</p>
			<span style={muted}>{remaining} of {tasks.length} left</span>
		</div>

		<div style={{ width: 'fill', height: 6, borderRadius: 3, background: '#e4e4e7', overflow: 'hidden' }}>
			<div style={{ width: progress * 432, height: 6, background: progress === 1 ? '#16a34a' : '#2563eb' }}></div>
		</div>

		<div style={row}>
			<input
				style={field}
				placeholder="What needs doing?"
				value={draft}
				oninput={(event: Event) => (draft = (event.currentTarget as HTMLInputElement).value)}
				onkeydown={(event: KeyboardEvent) => event.key === 'Enter' && add(draft)}
			/>
			<button style={[button, !draft.trim() && disabled]} disabled={!draft.trim()} onclick={() => add(draft)}>
				Add
			</button>
		</div>

		<div style={row}>
			{#each ['all', 'active', 'done'] as name (name)}
				<button style={[button, ghost, filter === name && selected]} onclick={() => (filter = name as typeof filter)}>
					{name[0].toUpperCase() + name.slice(1)}
				</button>
			{/each}
			<div style={{ width: 'fill' }}></div>
			<button style={[button, ghost, loading && disabled]} disabled={loading} onclick={suggest}>
				{loading ? 'Thinking…' : 'Suggest'}
			</button>
		</div>

		{#if error}
			<p style={{ color: '#dc2626', fontSize: 14 }}>{error}</p>
		{/if}

		<div style={{ gap: 8, width: 'fill' }}>
			{#each visible as task (task.id)}
				<div style={item}>
					<button style={[check, task.done && checked]} onclick={() => toggle(task.id)}>
						{#if task.done}
							<span style={{ color: '#ffffff', fontSize: 12, fontWeight: 700 }}>✓</span>
						{/if}
					</button>
					<p style={{ width: 'fill', fontSize: 15, color: task.done ? '#a1a1aa' : '#18181b' }}>
						{task.title}
					</p>
					<button style={[button, ghost, { padding: [4, 8], fontSize: 12 }]} onclick={() => remove(task.id)}>
						Remove
					</button>
				</div>
			{/each}
		</div>

		{#if visible.length === 0}
			<div style={{ width: 'fill', padding: 24, alignItems: 'center', borderRadius: 10, background: '#fafafa' }}>
				<p style={muted}>
					{loading ? 'Thinking of something…' : 'Nothing here.'} <span style={{ fontWeight: 600 }}>Add a task</span> above.
				</p>
			</div>
		{/if}
	</div>
</main>
