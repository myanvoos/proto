















const SRC = new URL("cache/qwen3.8.tokenizer.json", import.meta.url).pathname;
const OUT = new URL("../data/qwen3.bin.zst", import.meta.url).pathname;

const VOCAB_SIZE = 248_044;

const tj = await Bun.file(SRC).json();
const model = tj.model;
if (model.type !== "BPE") throw new Error(`unexpected model.type ${model.type}`);
if (model.byte_fallback || model.ignore_merges) throw new Error("unexpected model flags");
if (tj.normalizer?.type !== "NFC") throw new Error("expected NFC normalizer");

const vocab: Record<string, number> = model.vocab;
const merges: (string | [string, string])[] = model.merges;


const u2b: Record<string, number> = {};
{
	const bs: number[] = [];
	for (let b = 0x21; b <= 0x7e; b++) bs.push(b);
	for (let b = 0xa1; b <= 0xac; b++) bs.push(b);
	for (let b = 0xae; b <= 0xff; b++) bs.push(b);
	const seen = new Set(bs);
	const cs = bs.slice();
	let n = 0;
	for (let b = 0; b < 256; b++) {
		if (!seen.has(b)) {
			bs.push(b);
			cs.push(256 + n++);
		}
	}
	for (let i = 0; i < bs.length; i++) u2b[String.fromCodePoint(cs[i])] = bs[i];
}


const reachable = new Set<string>();
for (const m of merges) {
	const [a, b] = typeof m === "string" ? [m.slice(0, m.indexOf(" ")), m.slice(m.indexOf(" ") + 1)] : m;
	reachable.add(a + b);
}


const entries: (Uint8Array | null)[] = new Array(Object.keys(vocab).length).fill(null);
let dead = 0;
for (const tok in vocab) {
	const rank = vocab[tok];
	if (entries[rank] !== null) throw new Error(`duplicate rank ${rank}`);
	const chars = [...tok];
	if (chars.length > 1 && !reachable.has(tok)) {
		dead++;
		entries[rank] = new Uint8Array(0);
		continue;
	}
	const bytes = new Uint8Array(chars.length);
	for (let i = 0; i < chars.length; i++) {
		const b = u2b[chars[i]];
		if (b === undefined) throw new Error(`non-alphabet char in vocab entry ${rank}: ${tok}`);
		bytes[i] = b;
	}
	entries[rank] = bytes;
}


if (entries.length !== VOCAB_SIZE) throw new Error(`vocab size ${entries.length}, expected ${VOCAB_SIZE}`);
for (let r = 0; r < entries.length; r++) {
	if (entries[r] === null) throw new Error(`rank gap at ${r}: ranks not contiguous`);
}


const parts: Uint8Array[] = [new TextEncoder().encode("UTOK1\n")];
const count = new Uint8Array(4);
new DataView(count.buffer).setUint32(0, entries.length, true);
parts.push(count);
for (const bytes of entries as Uint8Array[]) {
	let len = bytes.length;
	const varint: number[] = [];
	do {
		varint.push(len >= 0x80 ? (len & 0x7f) | 0x80 : len);
		len >>>= 7;
	} while (len > 0);
	parts.push(new Uint8Array(varint), bytes);
}
const raw = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
{
	let off = 0;
	for (const p of parts) {
		raw.set(p, off);
		off += p.length;
	}
}

const packed = Bun.zstdCompressSync(raw, { level: 19 });
await Bun.write(OUT, packed);
console.log(`qwen3: ${entries.length} entries (${dead} dead slots emptied), raw ${raw.length} B -> ${packed.length} B zstd`);
