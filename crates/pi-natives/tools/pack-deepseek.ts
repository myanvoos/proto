











const ROOT = new URL("..", import.meta.url).pathname;
const SRC = `${ROOT}tools/cache/deepseek-v4.tokenizer.json`;
const OUT = `${ROOT}data/deepseek3.bin.zst`;
const VOCAB_SIZE = 128_000;


function unicodeToByte(): Map<string, number> {
	const bs: number[] = [];
	for (let i = 0x21; i <= 0x7e; i++) bs.push(i);
	for (let i = 0xa1; i <= 0xac; i++) bs.push(i);
	for (let i = 0xae; i <= 0xff; i++) bs.push(i);
	const cs = bs.slice();
	let n = 0;
	for (let b = 0; b < 256; b++) {
		if (!bs.includes(b)) {
			bs.push(b);
			cs.push(256 + n);
			n++;
		}
	}
	const m = new Map<string, number>();
	for (let i = 0; i < bs.length; i++) m.set(String.fromCodePoint(cs[i]!), bs[i]!);
	return m;
}

const u2b = unicodeToByte();

function decodeToken(tok: string): Uint8Array | null {
	const out: number[] = [];
	for (const ch of tok) {
		const b = u2b.get(ch);
		if (b === undefined) return null;
		out.push(b);
	}
	return Uint8Array.from(out);
}

const json = await Bun.file(SRC).json();
const vocab: Record<string, number> = json.model.vocab;
const added: { id: number; content: string }[] = json.added_tokens;

if (added.length !== 1283) throw new Error(`expected 1283 added_tokens, got ${added.length}`);


const byRank: (Uint8Array | undefined)[] = new Array(VOCAB_SIZE);
let entries = 0;
for (const tok in vocab) {
	const id = vocab[tok]!;
	if (id < 0 || id >= VOCAB_SIZE) throw new Error(`vocab id ${id} out of range for "${tok}"`);
	if (byRank[id] !== undefined) throw new Error(`duplicate rank ${id}`);
	const decoded = decodeToken(tok);
	if (decoded === null && id > 2) {
		throw new Error(`non-byte-level token at unexpected rank ${id}: "${tok}"`);
	}

	byRank[id] = decoded ?? new Uint8Array(0);
	entries++;
}
if (entries !== VOCAB_SIZE) throw new Error(`expected ${VOCAB_SIZE} vocab entries, got ${entries}`);
for (let r = 0; r < VOCAB_SIZE; r++) {
	if (byRank[r] === undefined) throw new Error(`rank ${r} missing — vocab not contiguous`);
}


const seen = new Set<string>();
for (const bytes of byRank as Uint8Array[]) {
	if (bytes.length === 0) continue;
	const key = Buffer.from(bytes).toString("latin1");
	if (seen.has(key)) throw new Error(`duplicate token byte sequence: ${JSON.stringify(key)}`);
	seen.add(key);
}






{


	const merges: string[] = json.model.merges;
	if (merges.length !== 127_741) throw new Error(`expected 127741 merges, got ${merges.length}`);
	const reachable = new Set<string>();
	for (const tok in vocab) if ([...tok].length === 1 && u2b.has(tok)) reachable.add(tok);
	if (reachable.size !== 256) throw new Error(`expected 256 alphabet entries, got ${reachable.size}`);
	for (const m of merges) {
		const parts = m.split(" ");
		if (parts.length !== 2) throw new Error(`malformed merge: ${JSON.stringify(m)}`);
		reachable.add(parts[0]! + parts[1]!);
	}
	const dead: number[] = [];
	for (const tok in vocab) if (!reachable.has(tok)) dead.push(vocab[tok]!);
	dead.sort((x, y) => x - y);
	if (dead.length !== 3 || dead[0] !== 0 || dead[1] !== 1 || dead[2] !== 2) {
		throw new Error(`unexpected merge-unreachable ranks: ${dead.slice(0, 20).join(",")}`);
	}
}


const parts: Uint8Array[] = [new TextEncoder().encode("UTOK1\n")];
const count = new Uint8Array(4);
new DataView(count.buffer).setUint32(0, VOCAB_SIZE, true);
parts.push(count);
for (const bytes of byRank as Uint8Array[]) {
	let len = bytes.length;
	const varint: number[] = [];
	do {
		let b = len & 0x7f;
		len >>>= 7;
		if (len > 0) b |= 0x80;
		varint.push(b);
	} while (len > 0);
	parts.push(Uint8Array.from(varint), bytes);
}
const blob = Buffer.concat(parts);
const zst = Bun.zstdCompressSync(blob, { level: 19 });
await Bun.write(OUT, zst);
console.log(`packed ${VOCAB_SIZE} entries: ${blob.length} raw -> ${zst.length} zst -> ${OUT}`);
