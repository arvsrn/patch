<script lang="ts">
	import {
		initialIssues,
		initialLabels,
		labelColors,
		members,
		priorities,
		statuses,
		type Issue,
		type Label,
		type Priority,
		type Status
	} from './data.ts';

	let issues: Issue[] = $state(initialIssues);
	let labels: Label[] = $state(initialLabels);
	let nextId = $state(232);

	let query = $state('');
	let labelFilter: string | null = $state(null);
	let selectedId: number | null = $state(null);
	let hoveredId: number | null = $state(null);
	let hoveredLabel: string | null = $state(null);

	let composerStatus: Status | null = $state(null);
	let draftTitle = $state('');

	let labelPickerOpen = $state(false);
	let labelQuery = $state('');
	let newLabelColor = $state(labelColors[6]);

	const memberById = Object.fromEntries(members.map((m) => [m.id, m]));
	const statusById = Object.fromEntries(statuses.map((s) => [s.id, s]));
	const key = (id: number) => `ENG-${id}`;

	let labelById = $derived(Object.fromEntries(labels.map((l) => [l.id, l])));
	let terms = $derived(query.trim().toLowerCase().split(/\s+/).filter(Boolean));
	let filtering = $derived(terms.length > 0 || labelFilter !== null);

	function matches(issue: Issue) {
		if (labelFilter && !issue.labels.includes(labelFilter)) return false;
		const haystack = [
			key(issue.id),
			issue.title,
			...issue.labels.map((id) => labelById[id]?.name ?? ''),
			issue.assignee ? memberById[issue.assignee].name : 'unassigned'
		]
			.join(' ')
			.toLowerCase();
		return terms.every((term) => haystack.includes(term));
	}

	let visible = $derived(issues.filter(matches));
	let columns = $derived(
		statuses.map((status) => ({
			...status,
			issues: visible.filter((i) => i.status === status.id),
			total: issues.filter((i) => i.status === status.id).length
		}))
	);
	let labelCounts = $derived(
		Object.fromEntries(labels.map((l) => [l.id, issues.filter((i) => i.labels.includes(l.id)).length]))
	);

	let selected = $derived(issues.find((i) => i.id === selectedId) ?? null);
	let pickerLabels = $derived(labels.filter((l) => l.name.toLowerCase().includes(labelQuery.trim().toLowerCase())));
	let canCreateLabel = $derived(
		labelQuery.trim() !== '' && !labels.some((l) => l.name.toLowerCase() === labelQuery.trim().toLowerCase())
	);

	function update(id: number, patch: Partial<Issue>) {
		issues = issues.map((i) => (i.id === id ? { ...i, ...patch } : i));
	}

	function cycleStatus(issue: Issue) {
		const order: Status[] = ['todo', 'progress', 'done'];
		update(issue.id, { status: order[(order.indexOf(issue.status) + 1) % order.length] });
	}

	function toggleLabel(issue: Issue, labelId: string) {
		const labels = issue.labels.includes(labelId)
			? issue.labels.filter((id) => id !== labelId)
			: [...issue.labels, labelId];
		update(issue.id, { labels });
	}

	function select(id: number) {
		selectedId = selectedId === id ? null : id;
		closePicker();
	}

	function openComposer(status: Status) {
		composerStatus = status;
		draftTitle = '';
	}

	function createIssue() {
		const title = draftTitle.trim();
		if (!title || !composerStatus) return;
		const issue: Issue = { id: nextId, title, status: composerStatus, priority: 0, labels: [], assignee: null };
		issues = [issue, ...issues];
		nextId += 1;
		composerStatus = null;
		draftTitle = '';
		selectedId = issue.id;
		closePicker();
	}

	function deleteIssue(id: number) {
		issues = issues.filter((i) => i.id !== id);
		selectedId = null;
		closePicker();
	}

	function closePicker() {
		labelPickerOpen = false;
		labelQuery = '';
	}

	function createLabel(issue: Issue) {
		const name = labelQuery.trim();
		if (!name) return;
		const label: Label = { id: `label-${labels.length + 1}`, name, color: newLabelColor };
		labels = [...labels, label];
		update(issue.id, { labels: [...issue.labels, label.id] });
		labelQuery = '';
		newLabelColor = labelColors[(labelColors.indexOf(newLabelColor) + 3) % labelColors.length];
	}

	function submitLabelQuery(issue: Issue) {
		if (canCreateLabel) createLabel(issue);
		else if (pickerLabels.length === 1) {
			toggleLabel(issue, pickerLabels[0].id);
			labelQuery = '';
		}
	}

	function clearFilters() {
		query = '';
		labelFilter = null;
	}

	// Escape backs out of whatever is open, innermost first.
	$effect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			if (labelPickerOpen) closePicker();
			else if (composerStatus) composerStatus = null;
			else selectedId = null;
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	$effect(() => {
		document.title = selected ? `${key(selected.id)} ${selected.title}` : 'Board · Engineering';
	});

	const ink = '#1b1b1f';
	const muted = '#6b6f76';
	const faint = '#9b9ea6';
	const line = '#e6e6ea';
	const accent = '#5e6ad2';

	const row = $style({ flexDirection: 'row', alignItems: 'center' });
	const spacer = $style({ width: 'fill' });
	const divider = $style({ width: 'fill', height: 1, background: line });

	const button = $style({
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
		padding: [6, 10],
		borderRadius: 7,
		fontSize: 13,
		fontWeight: 500,
		color: '#3c3c43'
	});
	const ghost = $style({ borderWidth: 1, borderColor: line, background: '#ffffff' });
	const primary = $style({ background: accent, color: '#ffffff', shadow: { y: 1, blur: 2, color: '#1b1b1f26' } });
	const iconButton = $style({
		width: 24,
		height: 24,
		borderRadius: 6,
		alignItems: 'center',
		justifyContent: 'center',
		color: muted,
		fontSize: 15
	});

	const chip = $style({
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
		padding: [4, 10],
		borderRadius: 999,
		borderWidth: 1,
		borderColor: line,
		background: '#ffffff',
		fontSize: 12,
		fontWeight: 500,
		color: '#3c3c43'
	});
	const chipActive = $style({ background: '#eef0fc', borderColor: '#c5caf3', color: '#3a43a5' });
	const pill = $style({
		flexDirection: 'row',
		alignItems: 'center',
		gap: 5,
		padding: [2, 8],
		borderRadius: 999,
		borderWidth: 1,
		borderColor: line,
		fontSize: 11.5,
		fontWeight: 500,
		color: '#3c3c43'
	});
	const dot = (color: string) => $style({ width: 8, height: 8, borderRadius: 4, background: color });

	const column = $style({
		width: 'fill',
		minWidth: 240,
		gap: 8,
		padding: 8,
		borderRadius: 12,
		background: '#f6f6f8'
	});
	const card = $style({
		width: 'fill',
		gap: 8,
		padding: [10, 12],
		borderRadius: 9,
		borderWidth: 1,
		borderColor: line,
		background: '#ffffff',
		shadow: { y: 1, blur: 2, color: '#1b1b1f0d' }
	});
	const cardHover = $style({ borderColor: '#d3d4da', shadow: { y: 2, blur: 6, color: '#1b1b1f14' } });
	const cardSelected = $style({
		borderColor: accent,
		shadow: [
			{ spread: 2, color: '#5e6ad22e' },
			{ y: 2, blur: 6, color: '#1b1b1f14' }
		]
	});

	const ring = (status: Status) =>
		$style({
			width: 14,
			height: 14,
			borderRadius: 7,
			borderWidth: 1.5,
			borderColor: statusById[status].color,
			background: status === 'done' ? statusById[status].color : '#ffffff',
			alignItems: 'center',
			justifyContent: 'center'
		});
	const ringCore = $style({ width: 6, height: 6, borderRadius: 3, background: statusById.progress.color });
	const ringCheck = $style({ fontSize: 9, lineHeight: 10, fontWeight: 800, color: '#ffffff' });

	const priorityBox = $style({ width: 14, height: 14, alignItems: 'center', justifyContent: 'center' });
	const urgent = $style({
		width: 14,
		height: 14,
		borderRadius: 3,
		background: '#f2994a',
		alignItems: 'center',
		justifyContent: 'center',
		color: '#ffffff',
		fontSize: 10,
		fontWeight: 800
	});
	const bars = $style({ flexDirection: 'row', alignItems: 'end', gap: 1.5, height: 12 });
	const bar = (priority: Priority, n: number) =>
		$style({
			width: 3,
			height: [6, 9, 12][n - 1],
			borderRadius: 1,
			background: priority !== 0 && n <= 5 - priority ? '#5c5f66' : '#d6d7dc'
		});

	const avatar = (color: string, size: number) =>
		$style({
			width: size,
			height: size,
			borderRadius: size / 2,
			background: color,
			alignItems: 'center',
			justifyContent: 'center',
			color: '#ffffff',
			fontSize: size * 0.42,
			fontWeight: 600
		});
	const noAvatar = (size: number) =>
		$style({
			width: size,
			height: size,
			borderRadius: size / 2,
			borderWidth: 1.5,
			borderColor: '#c9cad0',
			background: '#ffffff'
		});

	const field = $style({
		width: 'fill',
		padding: [7, 10],
		borderRadius: 7,
		borderWidth: 1,
		borderColor: line,
		background: '#ffffff',
		fontSize: 13,
		lineHeight: 18,
		color: ink
	});

	const panel = $style({
		width: 360,
		gap: 18,
		padding: 18,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: line,
		background: '#ffffff',
		shadow: [
			{ y: 1, blur: 2, color: '#1b1b1f0d' },
			{ y: 12, blur: 32, spread: -12, color: '#1b1b1f29' }
		]
	});
	const sectionLabel = $style({ fontSize: 11.5, fontWeight: 600, color: faint, letterSpacing: 0.2 });
	const segment = $style({
		width: 'fill',
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 6,
		padding: [7, 6],
		borderRadius: 7,
		borderWidth: 1,
		borderColor: line,
		background: '#ffffff',
		fontSize: 12,
		fontWeight: 500,
		color: '#3c3c43'
	});
	const segmentActive = $style({ background: '#eef0fc', borderColor: '#c5caf3', color: '#3a43a5' });
	const menu = $style({
		width: 'fill',
		borderRadius: 9,
		borderWidth: 1,
		borderColor: line,
		background: '#ffffff',
		overflow: 'hidden',
		shadow: { y: 6, blur: 18, spread: -6, color: '#1b1b1f29' }
	});
	const menuRow = $style({
		width: 'fill',
		flexDirection: 'row',
		alignItems: 'center',
		gap: 10,
		padding: [7, 12],
		fontSize: 13,
		color: ink
	});
	const checkbox = (on: boolean) =>
		$style({
			width: 14,
			height: 14,
			borderRadius: 4,
			borderWidth: on ? 0 : 1.5,
			borderColor: '#c9cad0',
			background: on ? accent : '#ffffff',
			alignItems: 'center',
			justifyContent: 'center',
			color: '#ffffff',
			fontSize: 9,
			fontWeight: 800
		});
</script>

<main style={{ width: 'fill', color: ink, fontSize: 13 }}>
	<!-- Top bar -->
	<div style={[row, { width: 'fill', gap: 12, padding: [12, 24] }]}>
		<div style={[row, { gap: 8 }]}>
			<div style={[avatar(accent, 22), { borderRadius: 6, fontSize: 12, fontWeight: 700 }]}>N</div>
			<p style={{ fontWeight: 600 }}>Northwind</p>
			<p style={{ color: '#c9cad0' }}>/</p>
			<p style={{ color: muted }}>Engineering</p>
			<p style={{ color: '#c9cad0' }}>/</p>
			<p style={{ fontWeight: 500 }}>Board</p>
		</div>
		<div style={spacer}></div>
		<div style={[row, field, { width: 320, padding: [0, 4, 0, 10], gap: 4, height: 32 }]}>
			<input
				style={{ width: 'fill', fontSize: 13, color: ink }}
				placeholder="Search issues, labels, people…"
				bind:value={query}
			/>
			{#if query}
				<button style={[iconButton, { width: 22, height: 22, fontSize: 13 }]} onclick={() => (query = '')}>✕</button>
			{/if}
		</div>
		<button style={[button, primary]} onclick={() => openComposer('todo')}>
			<span style={{ fontSize: 15, lineHeight: 16 }}>+</span>
			<span>New issue</span>
		</button>
	</div>
	<div style={divider}></div>

	<!-- Label filters -->
	<div style={[row, { width: 'fill', gap: 6, padding: [12, 24], flexWrap: 'wrap' }]}>
		<button style={[chip, labelFilter === null && chipActive]} onclick={() => (labelFilter = null)}>
			All issues
			<span style={{ color: faint }}>{issues.length}</span>
		</button>
		{#each labels as label (label.id)}
			<button
				style={[chip, labelFilter === label.id && chipActive]}
				onclick={() => (labelFilter = labelFilter === label.id ? null : label.id)}
			>
				<div style={dot(label.color)}></div>
				<span>{label.name}</span>
				<span style={{ color: faint }}>{labelCounts[label.id]}</span>
			</button>
		{/each}
		<div style={spacer}></div>
		{#if filtering}
			<p style={{ color: muted, fontSize: 12 }}>
				Showing <span style={{ color: ink, fontWeight: 600 }}>{visible.length}</span> of {issues.length} issues
			</p>
			<button style={[button, { padding: [4, 8], fontSize: 12, color: accent }]} onclick={clearFilters}>Clear filters</button>
		{/if}
	</div>

	<div style={[row, { width: 'fill', gap: 16, padding: [0, 24, 32, 24], alignItems: 'start' }]}>
		<!-- Board -->
		<div style={[row, { width: 'fill', gap: 12, alignItems: 'start' }]}>
			{#each columns as col (col.id)}
				<div style={column}>
					<div style={[row, { width: 'fill', gap: 8, padding: [4, 4, 2, 6] }]}>
						<div style={ring(col.id)}>
							{#if col.id === 'progress'}
								<div style={ringCore}></div>
							{:else if col.id === 'done'}
								<span style={ringCheck}>✓</span>
							{/if}
						</div>
						<p style={{ fontWeight: 600 }}>{col.name}</p>
						<p style={{ color: faint }}>{filtering ? `${col.issues.length} of ${col.total}` : col.total}</p>
						<div style={spacer}></div>
						<button style={iconButton} onclick={() => openComposer(col.id)}>+</button>
					</div>

					{#if composerStatus === col.id}
						<div style={[card, cardSelected, { gap: 10 }]}>
							<input
								style={[field, { borderWidth: 0, padding: 0, fontWeight: 500 }]}
								placeholder="Issue title"
								bind:value={draftTitle}
								onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && createIssue()}
							/>
							<div style={[row, { width: 'fill', gap: 6 }]}>
								<p style={{ color: faint, fontSize: 11.5 }}>Enter to create · Esc to cancel</p>
								<div style={spacer}></div>
								<button style={[button, { padding: [4, 8], fontSize: 12 }]} onclick={() => (composerStatus = null)}>
									Cancel
								</button>
								<button
									style={[button, primary, { padding: [4, 10], fontSize: 12 }, !draftTitle.trim() && { opacity: 0.5 }]}
									disabled={!draftTitle.trim()}
									onclick={createIssue}
								>
									Create
								</button>
							</div>
						</div>
					{/if}

					{#each col.issues as issue (issue.id)}
						<div
							style={[card, hoveredId === issue.id && cardHover, selectedId === issue.id && cardSelected]}
							onclick={() => select(issue.id)}
							onpointerenter={() => (hoveredId = issue.id)}
							onpointerleave={() => hoveredId === issue.id && (hoveredId = null)}
						>
							<div style={[row, { width: 'fill', gap: 8 }]}>
								<button
									style={[iconButton, { width: 16, height: 16 }]}
									onclick={(e: Event) => {
										e.stopPropagation();
										cycleStatus(issue);
									}}
								>
									<div style={ring(issue.status)}>
										{#if issue.status === 'progress'}
											<div style={ringCore}></div>
										{:else if issue.status === 'done'}
											<span style={ringCheck}>✓</span>
										{/if}
									</div>
								</button>
								<p style={{ color: faint, fontSize: 12, fontWeight: 500 }}>{key(issue.id)}</p>
								<div style={spacer}></div>
								{#if issue.assignee}
									<div style={avatar(memberById[issue.assignee].color, 20)}>{memberById[issue.assignee].initials}</div>
								{:else}
									<div style={noAvatar(20)}></div>
								{/if}
							</div>
							<p
								style={{
									width: 'fill',
									fontWeight: 500,
									lineHeight: 18,
									color: issue.status === 'done' ? muted : ink
								}}
							>
								{issue.title}
							</p>
							<div style={[row, { width: 'fill', gap: 6, flexWrap: 'wrap' }]}>
								<div style={[pill, { padding: [3, 5] }]}>
									{#if issue.priority === 1}
										<div style={urgent}>!</div>
									{:else}
										<div style={priorityBox}>
											<div style={bars}>
												{#each [1, 2, 3] as n (n)}
													<div style={bar(issue.priority, n)}></div>
												{/each}
											</div>
										</div>
									{/if}
								</div>
								{#each issue.labels as labelId (labelId)}
									<div style={[pill, labelFilter === labelId && chipActive]}>
										<div style={dot(labelById[labelId].color)}></div>
										<span>{labelById[labelId].name}</span>
									</div>
								{/each}
							</div>
						</div>
					{/each}

					{#if col.issues.length === 0 && composerStatus !== col.id}
						<div style={{ width: 'fill', padding: [20, 12], alignItems: 'center', gap: 4 }}>
							<p style={{ color: muted, fontWeight: 500 }}>{filtering ? 'No matching issues' : 'No issues'}</p>
							<p style={{ color: faint, fontSize: 12 }}>
								{filtering ? 'Try a different search or label.' : 'Press + to add one.'}
							</p>
						</div>
					{/if}
				</div>
			{/each}
		</div>

		<!-- Issue details -->
		{#if selected}
			<div style={panel}>
				<div style={[row, { width: 'fill', gap: 8 }]}>
					<p style={{ color: muted, fontWeight: 500 }}>{key(selected.id)}</p>
					<div style={spacer}></div>
					<button style={[button, { padding: [4, 8], fontSize: 12, color: '#d14343' }]} onclick={() => deleteIssue(selected!.id)}>
						Delete
					</button>
					<button style={iconButton} onclick={() => (selectedId = null)}>✕</button>
				</div>

				<textarea
					style={{ width: 'fill', height: 48, fontSize: 17, lineHeight: 24, fontWeight: 600, color: ink }}
					value={selected.title}
					placeholder="Issue title"
					oninput={(e: Event) => update(selected!.id, { title: (e.currentTarget as HTMLTextAreaElement).value })}
				></textarea>

				<div style={{ width: 'fill', gap: 8 }}>
					<p style={sectionLabel}>STATUS</p>
					<div style={[row, { width: 'fill', gap: 6 }]}>
						{#each statuses as status (status.id)}
							<button
								style={[segment, selected.status === status.id && segmentActive]}
								onclick={() => update(selected!.id, { status: status.id })}
							>
								<div style={ring(status.id)}>
									{#if status.id === 'progress'}
										<div style={ringCore}></div>
									{:else if status.id === 'done'}
										<span style={ringCheck}>✓</span>
									{/if}
								</div>
								<span>{status.name}</span>
							</button>
						{/each}
					</div>
				</div>

				<div style={{ width: 'fill', gap: 8 }}>
					<div style={[row, { width: 'fill', gap: 6 }]}>
						<p style={sectionLabel}>PRIORITY</p>
						<div style={spacer}></div>
						<p style={{ color: muted, fontSize: 12 }}>{priorities.find((p) => p.id === selected!.priority)?.name}</p>
					</div>
					<div style={[row, { width: 'fill', gap: 6 }]}>
						{#each priorities as priority (priority.id)}
							<button
								style={[segment, { padding: [8, 6] }, selected.priority === priority.id && segmentActive]}
								onclick={() => update(selected!.id, { priority: priority.id })}
							>
								{#if priority.id === 1}
									<div style={urgent}>!</div>
								{:else}
									<div style={priorityBox}>
										<div style={bars}>
											{#each [1, 2, 3] as n (n)}
												<div style={bar(priority.id, n)}></div>
											{/each}
										</div>
									</div>
								{/if}
							</button>
						{/each}
					</div>
				</div>

				<div style={{ width: 'fill', gap: 8 }}>
					<div style={[row, { width: 'fill', gap: 6 }]}>
						<p style={sectionLabel}>ASSIGNEE</p>
						<div style={spacer}></div>
						<p style={{ color: muted, fontSize: 12 }}>{selected.assignee ? memberById[selected.assignee].name : 'Unassigned'}</p>
					</div>
					<div style={[row, { gap: 8 }]}>
						<button
							style={[{ padding: 2, borderRadius: 16 }, selected.assignee === null && { borderWidth: 2, borderColor: accent }]}
							onclick={() => update(selected!.id, { assignee: null })}
						>
							<div style={noAvatar(26)}></div>
						</button>
						{#each members as member (member.id)}
							<button
								style={[{ padding: 2, borderRadius: 16 }, selected.assignee === member.id && { borderWidth: 2, borderColor: accent }]}
								onclick={() => update(selected!.id, { assignee: member.id })}
							>
								<div style={avatar(member.color, 26)}>{member.initials}</div>
							</button>
						{/each}
					</div>
				</div>

				<div style={{ width: 'fill', gap: 8 }}>
					<p style={sectionLabel}>LABELS</p>
					<div style={[row, { width: 'fill', gap: 6, flexWrap: 'wrap' }]}>
						{#each selected.labels as labelId (labelId)}
							<div style={[pill, { padding: [3, 4, 3, 9], gap: 6, fontSize: 12 }]}>
								<div style={dot(labelById[labelId].color)}></div>
								<span>{labelById[labelId].name}</span>
								<button
									style={[iconButton, { width: 16, height: 16, fontSize: 10, borderRadius: 8 }]}
									onclick={() => toggleLabel(selected!, labelId)}
								>
									✕
								</button>
							</div>
						{/each}
						<button
							style={[pill, { padding: [3, 9], fontSize: 12, color: muted }, labelPickerOpen && chipActive]}
							onclick={() => (labelPickerOpen ? closePicker() : (labelPickerOpen = true))}
						>
							{labelPickerOpen ? 'Done' : '+ Add label'}
						</button>
					</div>

					{#if labelPickerOpen}
						<div style={menu}>
							<div style={{ width: 'fill', padding: [8, 12] }}>
								<input
									style={{ width: 'fill', fontSize: 13, lineHeight: 18, color: ink }}
									placeholder="Change or create label…"
									bind:value={labelQuery}
									onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && submitLabelQuery(selected!)}
								/>
							</div>
							<div style={divider}></div>
							<div style={{ width: 'fill', padding: [4, 0] }}>
								{#each pickerLabels as label (label.id)}
									<button
										style={[menuRow, hoveredLabel === label.id && { background: '#f6f6f8' }]}
										onclick={() => toggleLabel(selected!, label.id)}
										onpointerenter={() => (hoveredLabel = label.id)}
										onpointerleave={() => hoveredLabel === label.id && (hoveredLabel = null)}
									>
										<div style={checkbox(selected.labels.includes(label.id))}>
											{selected.labels.includes(label.id) ? '✓' : ''}
										</div>
										<div style={dot(label.color)}></div>
										<span style={{ width: 'fill' }}>{label.name}</span>
										<span style={{ color: faint, fontSize: 12 }}>{labelCounts[label.id]}</span>
									</button>
								{/each}
								{#if pickerLabels.length === 0 && !canCreateLabel}
									<div style={{ padding: [6, 12] }}><p style={{ color: faint }}>No labels</p></div>
								{/if}
							</div>
							{#if canCreateLabel}
								<div style={divider}></div>
								<div style={{ width: 'fill', gap: 10, padding: [10, 12] }}>
									<button style={[menuRow, { padding: 0 }]} onclick={() => createLabel(selected!)}>
										<div style={dot(newLabelColor)}></div>
										<p>Create label <span style={{ fontWeight: 600 }}>“{labelQuery.trim()}”</span></p>
									</button>
									<div style={[row, { gap: 6 }]}>
										{#each labelColors as color (color)}
											<button
												style={[
													{ width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
													color === newLabelColor && { borderWidth: 1.5, borderColor: color }
												]}
												onclick={() => (newLabelColor = color)}
											>
												<div style={[dot(color), { width: 12, height: 12, borderRadius: 6 }]}></div>
											</button>
										{/each}
									</div>
								</div>
							{/if}
						</div>
					{/if}
				</div>
			</div>
		{/if}
	</div>
</main>
