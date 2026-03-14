const OLD_PKG = '0x936313e502e9cbf6e7a04fe2aeb4c60bc0acd69729acc7a19921b33bebf72d03';
const NEW_PKG = '0xaff30ff9a4b40845d8bdc91522a2b8e8e542ee41c0855f5cb21a652a00c45e96';
const GQL = 'https://graphql.testnet.sui.io/graphql';

interface PlayerInfo {
	total: number;
	sources: { [source: string]: number };
}
interface OwnerCounts {
	[address: string]: PlayerInfo;
}

async function queryFlags(pkg: string, counts: OwnerCounts) {
	let cursor: string | null = null;
	let hasNext = true;
	const flagType = `${pkg}::flag::Flag`;

	while (hasNext) {
		const after = cursor ? `"${cursor}"` : 'null';
		const query = `{
			objects(filter: { type: "${flagType}" }, first: 50, after: ${after}) {
				nodes {
					owner {
						... on AddressOwner {
							address { address }
						}
					}
					asMoveObject {
						contents { json }
					}
				}
				pageInfo { hasNextPage endCursor }
			}
		}`;

		const res = await fetch(GQL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ query }),
		});
		const json = await res.json() as any;

		if (json.errors) {
			console.error('GraphQL errors:', json.errors);
			break;
		}

		const data = json.data.objects;
		for (const node of data.nodes) {
			const addr = node.owner?.address?.address;
			if (!addr) continue;
			if (!counts[addr]) counts[addr] = { total: 0, sources: {} };
			counts[addr].total++;

			const source = node.asMoveObject?.contents?.json?.source ?? 'unknown';
			counts[addr].sources[source] = (counts[addr].sources[source] ?? 0) + 1;
		}

		hasNext = data.pageInfo.hasNextPage;
		cursor = data.pageInfo.endCursor;
		process.stdout.write('.');
	}
}

(async () => {
	const counts: OwnerCounts = {};

	process.stdout.write('Fetching flags from both packages');
	await Promise.all([queryFlags(OLD_PKG, counts), queryFlags(NEW_PKG, counts)]);
	console.log(' done!\n');

	const sorted = Object.entries(counts).sort((a, b) => b[1].total - a[1].total);
	const totalFlags = sorted.reduce((s, [, v]) => s + v.total, 0);

	console.log('═══════════════════════════════════════════════════════════');
	console.log(`  CTF LEADERBOARD  (${sorted.length} players, ${totalFlags} total flags)`);
	console.log('═══════════════════════════════════════════════════════════');

	sorted.forEach(([addr, info], i) => {
		const rank = String(i + 1).padStart(3);
		const short = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
		const bar = '█'.repeat(Math.min(Math.ceil(info.total / Math.max(sorted[0][1].total / 40, 1)), 40));
		const srcStr = Object.entries(info.sources)
			.sort((a, b) => b[1] - a[1])
			.map(([s, n]) => `${s}:${n}`)
			.join('  ');
		console.log(`${rank}. ${short}  ${String(info.total).padStart(6)} flags  ${bar}`);
		console.log(`      └─ ${srcStr}`);
	});

	console.log('═══════════════════════════════════════════════════════════');
})();
