// Puts a Figma payload on the system clipboard as HTML, the type Figma reads
// on paste. `pbcopy` only writes plain text, so on macOS the HTML type
// (`public.html`) is set on the general pasteboard through AppKit, via
// osascript's JavaScript bridge.

const JXA = `
ObjC.import('AppKit');
function run() {
	const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
	const html = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
	const board = $.NSPasteboard.generalPasteboard;
	board.clearContents;
	if (!board.setStringForType(html, $.NSPasteboardTypeHTML)) throw new Error('the pasteboard refused the HTML');
	const back = board.stringForType($.NSPasteboardTypeHTML);
	return back.isNil() ? 0 : back.length;
}
`;

export async function copyFigmaClipboard(html: string) {
	if (process.platform !== 'darwin')
		throw new Error(
			`patch snapshot writes Figma's clipboard format on macOS only; ${process.platform} is not supported yet`
		);
	const proc = Bun.spawn(['osascript', '-l', 'JavaScript', '-e', JXA], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
	proc.stdin.write(html);
	await proc.stdin.end();
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`Could not write the clipboard: ${err.trim() || `osascript exited with ${code}`}`);
	if (Number(out.trim()) !== html.length) throw new Error('The clipboard did not keep the snapshot');
}
