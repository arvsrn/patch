// What the pages share. A page's $state ends with the page; module state
// lives as long as the app, so every page reads and edits the same issues.

import { initialIssues, initialLabels, type Issue, type Label } from './data.ts';

export const workspace = $state<{ issues: Issue[]; labels: Label[]; nextId: number }>({
	issues: initialIssues,
	labels: initialLabels,
	nextId: 232
});

export const issueKey = (id: number) => `ENG-${id}`;
