/**
 * Which files might a bash command write? Best effort, for the write guard.
 *
 * A regex over the raw command text treats markdown in a heredoc ("-> Vector2",
 * "install five palettes") and quoted awk/sed/grep patterns as redirects and
 * write verbs. So this tokenizes the command roughly as the shell would:
 * heredoc bodies are dropped, quotes group words, operators count only outside
 * quotes, and substitutions ($(...), `...`) are scanned as commands of their own.
 * Relative targets resolve against the directory after any `cd`; when that
 * directory cannot be known (`cd "$DIR"`), relative targets are skipped.
 *
 * This is an airbag, not a sandbox: `python -c`, scripts, `find -delete` and
 * anything behind a variable remain invisible, as before.
 */

import * as os from "node:os";
import * as path from "node:path";

interface Word {
	t: "word";
	v: string;
	/** Fully known text: no expansion ($VAR, $(...), `...`) anywhere in it. */
	lit: boolean;
	/** Any part was quoted, so it cannot be an assignment or an fd number. */
	quoted: boolean;
}
interface Op {
	t: "op";
	v: string;
}
type Tok = Word | Op;

const SEPARATORS = new Set([";", "&&", "||", "|", "|&", "&", ";;", "(", ")"]);
/** Redirections whose next word is a file that gets written. */
const WRITE_REDIRS = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
/** Redirections whose next word is read or is an fd, never written. */
const OTHER_REDIRS = new Set(["<", "<<<", "<&"]);

/** Index just past the `close` matching an already-consumed `open`, respecting quotes. */
function skipBalanced(s: string, i: number, open: string, close: string): number {
	let depth = 1;
	while (i < s.length && depth > 0) {
		const c = s[i];
		if (c === "\\") i += 2;
		else if (c === "'") i = s.indexOf("'", i + 1) + 1 || s.length;
		else if (c === '"') {
			i++;
			while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
			i++;
		} else {
			if (c === open) depth++;
			else if (c === close) depth--;
			i++;
		}
	}
	return i;
}

/** Tokenize into a stream; command substitutions become separate streams. */
function lex(s: string, streams: Tok[][]): Tok[] {
	const out: Tok[] = [];
	let word: Word | null = null;
	const heredocs: { delim: string; strip: boolean }[] = [];
	const cur = () => (word ??= { t: "word", v: "", lit: true, quoted: false });
	const end = () => {
		if (word) out.push(word);
		word = null;
	};
	const op = (v: string) => {
		end();
		out.push({ t: "op", v });
	};
	const sub = (inner: string) => {
		streams.push(lex(inner, streams));
		cur().lit = false;
	};

	let i = 0;
	while (i < s.length) {
		const c = s[i];
		const next = s[i + 1];

		if (c === "\n") {
			op(";");
			i++;
			// Heredoc bodies start on the line after their operator: skip them whole.
			for (const h of heredocs.splice(0)) {
				while (i < s.length) {
					const eol = s.indexOf("\n", i);
					const line = s.slice(i, eol === -1 ? s.length : eol);
					i = eol === -1 ? s.length : eol + 1;
					if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
				}
			}
			continue;
		}
		if (c === " " || c === "\t") {
			end();
			i++;
			continue;
		}
		if (c === "#" && !word) {
			while (i < s.length && s[i] !== "\n") i++;
			continue;
		}
		if (c === "\\") {
			if (next === "\n") i += 2; // line continuation
			else {
				if (next !== undefined) cur().v += next;
				i += 2;
			}
			continue;
		}
		if (c === "'") {
			const close = s.indexOf("'", i + 1);
			const w = cur();
			w.v += s.slice(i + 1, close === -1 ? s.length : close);
			w.quoted = true;
			i = close === -1 ? s.length : close + 1;
			continue;
		}
		if (c === '"') {
			const w = cur();
			w.quoted = true;
			i++;
			while (i < s.length && s[i] !== '"') {
				if (s[i] === "\\" && i + 1 < s.length) {
					w.v += s[i + 1];
					i += 2;
					continue;
				}
				// Substitutions still run inside double quotes; scan them as commands.
				if (s[i] === "$" && s[i + 1] === "(" && s[i + 2] !== "(") {
					const stop = skipBalanced(s, i + 2, "(", ")");
					sub(s.slice(i + 2, stop - 1));
					i = stop;
					continue;
				}
				if (s[i] === "`") {
					let j = i + 1;
					while (j < s.length && s[j] !== "`") j += s[j] === "\\" ? 2 : 1;
					sub(s.slice(i + 1, j));
					i = j + 1;
					continue;
				}
				if (s[i] === "$") w.lit = false;
				w.v += s[i++];
			}
			i++;
			continue;
		}
		if (c === "$") {
			if (next === "(" && s[i + 2] === "(") {
				i = skipBalanced(s, i + 3, "(", ")"); // $(( arithmetic ))
				cur().lit = false;
				if (s[i] === ")") i++;
				continue;
			}
			if (next === "(") {
				const stop = skipBalanced(s, i + 2, "(", ")");
				sub(s.slice(i + 2, stop - 1));
				i = stop;
				continue;
			}
			const w = cur();
			w.lit = false;
			w.v += "$";
			if (next === "{") {
				const stop = skipBalanced(s, i + 2, "{", "}");
				w.v += s.slice(i + 1, stop);
				i = stop;
			} else i++;
			continue;
		}
		if (c === "`") {
			let j = i + 1;
			while (j < s.length && s[j] !== "`") j += s[j] === "\\" ? 2 : 1;
			sub(s.slice(i + 1, j));
			i = j + 1;
			continue;
		}
		if (c === "(" && next === "(" && !word) {
			i = skipBalanced(s, i + 2, "(", ")"); // (( arithmetic command ))
			if (s[i] === ")") i++;
			op(";");
			continue;
		}
		if (c === "(" || c === ")") {
			op(c);
			i++;
			continue;
		}
		if (c === ";") {
			op(next === ";" ? ";;" : ";");
			i += next === ";" ? 2 : 1;
			continue;
		}
		if (c === "|") {
			const v = next === "|" ? "||" : next === "&" ? "|&" : "|";
			op(v);
			i += v.length;
			continue;
		}
		if (c === "&") {
			if (next === "&") {
				op("&&");
				i += 2;
			} else if (next === ">") {
				const v = s[i + 2] === ">" ? "&>>" : "&>";
				op(v);
				i += v.length;
			} else {
				op("&");
				i++;
			}
			continue;
		}
		if (c === ">" || c === "<") {
			// `2>`, `1>&2`: a bare unquoted number glued to the operator is an fd.
			if (word && !word.quoted && word.lit && /^\d+$/.test(word.v)) word = null;
			let v = c;
			if (c === ">") {
				if (next === ">" || next === "|" || next === "&") v += next;
			} else if (next === "<") {
				v = s[i + 2] === "<" ? "<<<" : s[i + 2] === "-" ? "<<-" : "<<";
			} else if (next === ">" || next === "&") v += next;
			op(v);
			i += v.length;
			if (v === "<<" || v === "<<-") {
				// The delimiter is the next word, quotes removed.
				while (s[i] === " " || s[i] === "\t") i++;
				let delim = "";
				while (i < s.length && !/[\s;&|<>()]/.test(s[i])) {
					if (s[i] === "'" || s[i] === '"') {
						const q = s[i];
						const close = s.indexOf(q, i + 1);
						delim += s.slice(i + 1, close === -1 ? s.length : close);
						i = close === -1 ? s.length : close + 1;
					} else if (s[i] === "\\") {
						delim += s[i + 1] ?? "";
						i += 2;
					} else delim += s[i++];
				}
				heredocs.push({ delim, strip: v === "<<-" });
			}
			continue;
		}
		cur().v += c;
		i++;
	}
	end();
	return out;
}

/** Words before the real verb: wrappers, and keywords that open a compound command. */
const WRAPPERS = new Set([
	"sudo", "doas", "command", "builtin", "nohup", "time", "exec", "env",
	"if", "then", "else", "elif", "while", "until", "do", "!", "{",
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/** Non-option operands. `--` ends options; `valued` options consume the next word. */
function operands(args: Word[], valued: string[] = []): Word[] {
	const out: Word[] = [];
	let opts = true;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (opts && a.v === "--") {
			opts = false;
			continue;
		}
		if (opts && a.v.startsWith("-") && a.v !== "-") {
			if (valued.includes(a.v)) i++;
			continue;
		}
		out.push(a);
	}
	return out;
}

/** Files one simple command may write, as raw words (not yet resolved). */
function commandTargets(argv: Word[]): Word[] {
	const verb = path.basename(argv[0]?.v ?? "");
	const args = argv.slice(1);
	switch (verb) {
		case "mkdir":
		case "touch":
		case "rm":
		case "rmdir":
		case "shred":
			return operands(args, ["-m"]);
		case "truncate":
			return operands(args, ["-s", "-r"]);
		case "tee":
			return operands(args);
		case "mv":
		case "cp":
		case "ln":
		case "install": {
			const t = args.findIndex((a) => a.v === "-t");
			if (t >= 0 && args[t + 1]) return [args[t + 1]];
			const long = args.find((a) => a.v.startsWith("--target-directory="));
			if (long) return [{ ...long, v: long.v.slice("--target-directory=".length) }];
			const ops = operands(args, ["-S", "-m", "-o", "-g", "--suffix"]);
			// install -d: every operand is a directory to create.
			if (verb === "install" && args.some((a) => a.v === "-d")) return ops;
			// mv removes its sources, so they are written too.
			if (verb === "mv") return ops;
			return ops.slice(-1);
		}
		case "sed": {
			if (!args.some((a) => /^(-i|--in-place)/.test(a.v) || /^-[a-zA-Z]*i/.test(a.v))) return [];
			const explicitScript = args.some((a) => a.v === "-e" || a.v === "-f" || a.v.startsWith("--expression"));
			const ops = operands(args, ["-e", "-f", "-l"]);
			return explicitScript ? ops : ops.slice(1);
		}
		case "dd":
			return args.filter((a) => a.v.startsWith("of=")).map((a) => ({ ...a, v: a.v.slice(3) }));
		default:
			return [];
	}
}

/**
 * Absolute paths `cmd` may write when run in `cwd`. Words that depend on
 * expansion are skipped rather than guessed.
 */
export function bashWriteTargets(cmd: string, cwd: string): string[] {
	const streams: Tok[][] = [];
	const main = lex(cmd, streams);
	const found = new Set<string>();

	for (const toks of [main, ...streams]) {
		let dir: string | null = cwd;
		const stack: (string | null)[] = [];
		const resolve = (w: Word) => {
			if (!w.lit || !w.v) return;
			const p = expandHome(w.v);
			if (path.isAbsolute(p)) found.add(path.normalize(p));
			else if (dir !== null) found.add(path.resolve(dir, p));
		};

		let simple: Tok[] = [];
		const flush = () => {
			const redirs: Word[] = [];
			let argv: Word[] = [];
			for (let i = 0; i < simple.length; i++) {
				const t = simple[i];
				if (t.t === "op") {
					const w = simple[i + 1];
					if (w?.t !== "word") continue;
					if (WRITE_REDIRS.has(t.v)) redirs.push(w);
					else if (t.v === ">&" && !/^(\d+|-)$/.test(w.v)) redirs.push(w);
					else if (!OTHER_REDIRS.has(t.v) && t.v !== ">&") continue;
					i++; // the redirection's word is not an argument
				} else argv.push(t);
			}
			// Leading assignments and wrappers (sudo, env, …) are not the verb.
			for (;;) {
				const first = argv[0];
				if (!first) break;
				if (!first.quoted && ASSIGNMENT.test(first.v)) argv = argv.slice(1);
				else if (WRAPPERS.has(first.v)) {
					argv = argv.slice(1);
					while (argv[0]?.v.startsWith("-")) argv = argv.slice(1);
				} else break;
			}
			const verb = argv[0]?.v;
			// `[[ a > b ]]` compares strings; nothing is redirected.
			if (verb !== "[[") for (const w of redirs) resolve(w);
			if (verb === "cd") {
				const target = operands(argv.slice(1))[0];
				if (!target) dir = os.homedir();
				else if (!target.lit || target.v === "-") dir = null;
				else {
					const p = expandHome(target.v);
					dir = path.isAbsolute(p) ? path.normalize(p) : dir === null ? null : path.resolve(dir, p);
				}
			} else for (const w of commandTargets(argv)) resolve(w);
			simple = [];
		};

		for (const t of toks) {
			if (t.t === "op" && SEPARATORS.has(t.v)) {
				flush();
				// A subshell's cd does not leak out of it.
				if (t.v === "(") stack.push(dir);
				else if (t.v === ")" && stack.length) dir = stack.pop() ?? null;
			} else simple.push(t);
		}
		flush();
	}

	return [...found].filter((p) => !p.startsWith("/dev/"));
}
