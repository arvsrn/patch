<script lang="ts">
	import { goto, page } from 'patch';
	import { members, priorities, statuses } from '../../../data.ts';
	import { issueKey, workspace } from '../../../workspace.pat.ts';

	// Moving to another issue keeps this page and changes `page.params`.
	let id = $derived(Number(page.params.id));
	let issues = $derived(workspace.issues);
	let index = $derived(issues.findIndex((i) => i.id === id));
	let issue = $derived(index >= 0 ? issues[index] : null);
	let previous = $derived(index > 0 ? issues[index - 1] : null);
	let next = $derived(index >= 0 && index < issues.length - 1 ? issues[index + 1] : null);

	let labelById = $derived(Object.fromEntries(workspace.labels.map((l) => [l.id, l])));

	function remove() {
		workspace.issues = issues.filter((i) => i.id !== id);
		goto('/issues');
	}

	$effect(() => {
		document.title = issue ? `${issueKey(issue.id)} ${issue.title}` : 'Issue not found';
	});

	const ink = '#1b1b1f';
	const muted = '#6b6f76';
	const faint = '#9b9ea6';
	const line = '#e6e6ea';
	const accent = '#5e6ad2';

	const row = $style({ flexDirection: 'row', alignItems: 'center' });
	const link = $style({ color: accent, fontWeight: 500 });
	const property = $style({ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 });
	const propertyLabel = $style({ width: 76, color: muted });
	const pill = $style({
		flexDirection: 'row',
		alignItems: 'center',
		gap: 5,
		padding: [2, 8],
		borderRadius: 999,
		borderWidth: 1,
		borderColor: line,
		fontSize: 12,
		fontWeight: 500
	});
</script>

<main style={{ width: 'fill', height: 'fill', color: ink, fontSize: 13 }}>
	<div style={[row, { width: 'fill', gap: 8, padding: [12, 24] }]}>
		<a href="/" style={{ fontWeight: 600 }}>Northwind</a>
		<p style={{ color: '#c9cad0' }}>/</p>
		<a href="/issues" style={{ color: muted }}>Board</a>
		<p style={{ color: '#c9cad0' }}>/</p>
		<p style={{ fontWeight: 500 }}>{issueKey(id)}</p>
		<div style={{ width: 'fill' }}></div>
		{#if previous}
			<a href="/issues/{previous.id}" style={link}>← {issueKey(previous.id)}</a>
		{/if}
		{#if next}
			<a href="/issues/{next.id}" style={link}>{issueKey(next.id)} →</a>
		{/if}
	</div>
	<div style={{ width: 'fill', height: 1, background: line }}></div>

	{#if issue}
		<div style={{ width: 640, gap: 20, padding: [28, 24] }}>
			<p style={{ width: 'fill', fontSize: 22, lineHeight: 30, fontWeight: 600 }}>{issue.title}</p>
			<div style={{ gap: 4 }}>
				<div style={property}>
					<p style={propertyLabel}>Status</p>
					<p>{statuses.find((s) => s.id === issue!.status)?.name}</p>
				</div>
				<div style={property}>
					<p style={propertyLabel}>Priority</p>
					<p>{priorities.find((p) => p.id === issue!.priority)?.name}</p>
				</div>
				<div style={property}>
					<p style={propertyLabel}>Assignee</p>
					<p style={{ color: issue.assignee ? ink : muted }}>{members.find((m) => m.id === issue!.assignee)?.name ?? 'Unassigned'}</p>
				</div>
				<div style={property}>
					<p style={propertyLabel}>Labels</p>
					<div style={[row, { gap: 6 }]}>
						{#each issue.labels as labelId (labelId)}
							<div style={pill}>
								<div style={{ width: 8, height: 8, borderRadius: 4, background: labelById[labelId]?.color ?? faint }}></div>
								<span>{labelById[labelId]?.name ?? labelId}</span>
							</div>
						{/each}
						{#if issue.labels.length === 0}
							<p style={{ color: muted }}>None</p>
						{/if}
					</div>
				</div>
			</div>
			<div style={[row, { gap: 12 }]}>
				<a href="/issues?q={encodeURIComponent(issueKey(issue.id))}" style={link}>Find on the board</a>
				<button style={{ color: '#d14343', fontWeight: 500 }} onclick={remove}>Delete issue</button>
			</div>
		</div>
	{:else}
		<div style={{ gap: 8, padding: [28, 24] }}>
			<p style={{ fontSize: 17, fontWeight: 600 }}>No issue {issueKey(id)}</p>
			<a href="/issues" style={link}>Back to the board</a>
		</div>
	{/if}
</main>
