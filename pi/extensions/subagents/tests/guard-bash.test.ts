import assert from "node:assert/strict";
import { test } from "node:test";
import { extractWriteTargets } from "../guard.ts";
import { matchesAny } from "../registry.ts";

const CWD = "/repo";
const targets = (cmd: string, cwd = CWD) => extractWriteTargets(cmd, cwd).sort();

// ---- false positives observed live (c-b54b, c-2d8d) -------------------------

test("heredoc bodies are data, not commands", () => {
	const doc = [
		"cat > /repo/docs/a.md <<'DOC'",
		"Returns `-> Vector2`, see <br> and a > b.",
		"The cheapest place to install five palettes — no new material.",
		"Then mkdir later and rm -rf nothing; tee off at 3 > 2.",
		"DOC",
	].join("\n");
	assert.deepEqual(targets(doc), ["/repo/docs/a.md"]);
});

test("unquoted and <<- heredocs end at their delimiter, and commands after it count", () => {
	const cmd = "cat > a.md <<-EOF && echo ok\n\tinstall five palettes > x\n\tEOF\ntouch b.txt";
	assert.deepEqual(targets(cmd), ["/repo/a.md", "/repo/b.txt"]);
});

test("quoted text is never a redirect or a write verb", () => {
	assert.deepEqual(targets("cd /repo && awk 'NR>=600 && NR<=625' scripts/config.gd | cat -n"), []);
	assert.deepEqual(targets(`grep -rn "position.y >\\\\|y < -[0-9]" --include=*.gd scripts/`), []);
	assert.deepEqual(targets(`curl -sSL x | sed 's/<[^>]*>//g' | grep -iE "fog"`), []);
	assert.deepEqual(targets(`echo "install five palettes" "mkdir foo"`), []);
	assert.deepEqual(targets(`python3 -c "open('x','w').write('>')"`), []);
});

test("variables and substitutions are not literal paths", () => {
	assert.deepEqual(targets(`for id in A B; do r=$(curl -sS "u?id=$id"); echo "$id => $(echo "$r" | head -1)"; done`), []);
	assert.deepEqual(targets(`echo hi > "$OUT"`), []);
	assert.deepEqual(targets("x=$(( 3 > 2 )); (( n > 1 )) && echo big"), []);
	assert.deepEqual(targets(`[[ "$a" > "$b" ]] && echo sorted`), []);
});

test("fd redirects and dups are not files", () => {
	assert.deepEqual(targets("cmd 2>/dev/null 1>&2 2>&1 >&- < in.txt"), []);
	assert.deepEqual(targets("cmd &> all.log"), ["/repo/all.log"]);
	assert.deepEqual(targets("cmd 2> err.log"), ["/repo/err.log"]);
});

// ---- relative targets after cd -----------------------------------------------

test("relative targets resolve against the directory after cd", () => {
	assert.deepEqual(targets("cd /repo/docs/x && printf 'p\\n' > probe.txt"), ["/repo/docs/x/probe.txt"]);
	assert.deepEqual(targets("cd /tmp && cat > urls.txt <<'EOF'\nhttps://a\nEOF"), ["/tmp/urls.txt"]);
	assert.deepEqual(targets("cd sub; touch a; cd ..; touch b"), ["/repo/b", "/repo/sub/a"]);
	assert.deepEqual(targets("cd ~/w && touch f"), [`${process.env.HOME}/w/f`]);
});

test("after an unresolvable cd, relative targets are skipped but absolute ones still count", () => {
	assert.deepEqual(targets(`cd "$DIR" && touch rel.txt && touch /repo/abs.txt`), ["/repo/abs.txt"]);
	assert.deepEqual(targets("cd - && touch rel.txt"), []);
});

// ---- real writes are still caught ---------------------------------------------

test("genuine writes are still detected", () => {
	assert.deepEqual(targets("echo x > out.txt"), ["/repo/out.txt"]);
	assert.deepEqual(targets("echo x >> 'my file.txt'"), ["/repo/my file.txt"]);
	assert.deepEqual(targets("echo x>out.txt"), ["/repo/out.txt"]);
	assert.deepEqual(targets("ls | tee -a log1 log2"), ["/repo/log1", "/repo/log2"]);
	assert.deepEqual(targets("mkdir -p a/b c && touch d"), ["/repo/a/b", "/repo/c", "/repo/d"]);
	assert.deepEqual(targets("rm -rf build dist"), ["/repo/build", "/repo/dist"]);
	assert.deepEqual(targets("mv src/a.ts src/b.ts"), ["/repo/src/a.ts", "/repo/src/b.ts"]);
	assert.deepEqual(targets("cp -r src/ dest/"), ["/repo/dest"]);
	assert.deepEqual(targets("install -D /dev/null /repo/docs/a.md"), ["/repo/docs/a.md"]);
	assert.deepEqual(targets("sed -i 's/a/b/' f1.ts f2.ts"), ["/repo/f1.ts", "/repo/f2.ts"]);
	assert.deepEqual(targets("sed -i.bak -e 's/a/b/' f.ts"), ["/repo/f.ts"]);
	assert.deepEqual(targets("dd if=/dev/zero of=disk.img bs=1"), ["/repo/disk.img"]);
	assert.deepEqual(targets("truncate -s 0 log.txt"), ["/repo/log.txt"]);
	assert.deepEqual(targets("sudo rm x"), ["/repo/x"]);
	assert.deepEqual(targets("FOO=1 touch y"), ["/repo/y"]);
	assert.deepEqual(targets("(cd /repo/sub && touch z)"), ["/repo/sub/z"]);
	assert.deepEqual(targets("echo $(touch inner)"), ["/repo/inner"]);
	assert.deepEqual(targets("echo `rm bq`"), ["/repo/bq"]);
	assert.deepEqual(targets("true && \\\n  touch cont"), ["/repo/cont"]);
});

test("cat into a heredoc file, then append chunks, is one target each", () => {
	const cmd = "cat >> /repo/d/a.raw <<'P'\n## 4. x -> y\nP\necho chunk2 ok; wc -l /repo/d/a.raw";
	assert.deepEqual(targets(cmd), ["/repo/d/a.raw"]);
});

// ---- claims cover their own directory ---------------------------------------------

test("a dir/** claim covers the directory itself, not its siblings", () => {
	assert.equal(matchesAny("docs/research/layers-art", ["docs/research/layers-art/**"]), true);
	assert.equal(matchesAny("docs/research/layers-art/a.md", ["docs/research/layers-art/**"]), true);
	assert.equal(matchesAny("docs/research/layers-artx", ["docs/research/layers-art/**"]), false);
	assert.equal(matchesAny("docs/research", ["docs/research/layers-art/**"]), false);
	// A bare directory claim is its subtree, and now also itself.
	assert.equal(matchesAny("docs/research/layers-arch", ["docs/research/layers-arch"]), true);
});

// ---- scratch space ----------------------------------------------------------------

test("writes to the temp folder are allowed; other paths outside the project are not", async () => {
	const { evaluateWrite, evaluateBash } = await import("../guard.ts");
	const { tmpdir } = await import("node:os");
	const opts = { root: "/home/u/project", writes: ["src/**"], shared: [] };
	assert.equal(evaluateWrite("/tmp/urls.txt", opts), undefined);
	assert.equal(evaluateWrite(`${tmpdir()}/scratch/a.json`, opts), undefined);
	assert.equal(evaluateBash("cd /tmp && cat > urls.txt <<'EOF'\nhttps://a\nEOF", opts), undefined);
	assert.equal(evaluateWrite("/home/u/.bashrc", opts)?.kind, "outside_root");
	// A lookalike prefix is not the temp folder.
	assert.equal(evaluateWrite("/tmpfoo/x", opts)?.kind, "outside_root");
	// `..` cannot escape through it.
	assert.equal(evaluateWrite("/tmp/../home/u/.bashrc", opts)?.kind, "outside_root");
	// The project's own claims still apply inside it.
	assert.equal(evaluateWrite("/home/u/project/other.ts", opts)?.kind, "outside_claim");
});

test("a project that itself lives in the temp folder is still guarded by claims", async () => {
	const { evaluateWrite } = await import("../guard.ts");
	const opts = { root: "/tmp/proj", writes: ["src/**"], shared: [] };
	assert.equal(evaluateWrite("/tmp/proj/src/a.ts", opts), undefined);
	assert.equal(evaluateWrite("/tmp/proj/other.ts", opts)?.kind, "outside_claim");
	assert.equal(evaluateWrite("/tmp/elsewhere.txt", opts), undefined);
});
