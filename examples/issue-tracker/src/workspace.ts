// What the pages share. A page's $state is destroyed when another page is
// shown, so the board keeps its edits here and every page starts from them.

import { initialIssues, initialLabels, type Issue, type Label } from './data.ts';

export const workspace: { issues: Issue[]; labels: Label[]; nextId: number } = {
	issues: initialIssues,
	labels: initialLabels,
	nextId: 232
};

export const issueKey = (id: number) => `ENG-${id}`;
